import { db, agora, setConfig } from './db.js';
import { classificarTexto, TEMAS, INTENCOES } from './lexicon.js';

const DIA = 86_400_000;

// ---------------------------------------------------------------------------
// Pesos do score de engajamento. Tudo somado dá 100.
// Mexer aqui muda a régua da campanha inteira — por isso fica explícito.
// ---------------------------------------------------------------------------
export const PESOS = {
  volume: 30,      // quanto ela fala (30 dias)
  recencia: 22,    // há quanto tempo falou pela última vez
  interacao: 16,   // o quanto ela responde e reage aos outros
  influencia: 20,  // o quanto os outros respondem e reagem a ela
  alcance: 12      // em quantos grupos ela está
};

export const FAIXAS = ['Embaixador', 'Ativo', 'Morno', 'Observador', 'Adormecido'];

export const CORES_FAIXA = {
  Embaixador: '#16a34a',
  Ativo: '#2563eb',
  Morno: '#f59e0b',
  Observador: '#94a3b8',
  Adormecido: '#94a3b8'
};

const teto = (valor, maximo) => Math.min(1, valor / maximo);

// Tetos de saturação: a partir daqui o componente já vale nota cheia.
export const TETOS = { volume: 45, interacao: 32, influencia: 28, alcance: 4, recenciaDias: 30 };

function calcularEngajamento(m) {
  const volume = teto(m.msgs_30d, TETOS.volume) * PESOS.volume;
  const recencia = m.ultima_msg_ts == null
    ? 0
    : Math.max(0, 1 - m.dias_sem_falar / TETOS.recenciaDias) * PESOS.recencia;
  const interacao = teto(m.respostas_dadas + m.reacoes_dadas, TETOS.interacao) * PESOS.interacao;
  const influencia = teto(m.respostas_recebidas + m.reacoes_recebidas, TETOS.influencia) * PESOS.influencia;
  const alcance = teto(m.grupos_count, TETOS.alcance) * PESOS.alcance;
  return {
    total: Math.round(volume + recencia + interacao + influencia + alcance),
    partes: {
      volume: Math.round(volume),
      recencia: Math.round(recencia),
      interacao: Math.round(interacao),
      influencia: Math.round(influencia),
      alcance: Math.round(alcance)
    }
  };
}

function definirFaixa(score, m) {
  if (m.msgs_total === 0) return 'Observador';
  if (m.dias_sem_falar > 45) return 'Adormecido';
  if (score >= 72) return 'Embaixador';
  if (score >= 42) return 'Ativo';
  if (score >= 16) return 'Morno';
  return 'Adormecido';
}

const CAMPOS_PERFIL = [
  { chave: 'nome', peso: 20, rotulo: 'nome completo' },
  { chave: 'cidade', peso: 15, rotulo: 'cidade' },
  { chave: 'atuacao', peso: 15, rotulo: 'atuação' },
  { chave: 'telefone', peso: 10, rotulo: 'telefone' },
  { chave: 'email', peso: 10, rotulo: 'e-mail' }
];

function calcularCompletude(pessoa, temaPrincipal, temTag) {
  let pontos = 0;
  const faltando = [];
  for (const campo of CAMPOS_PERFIL) {
    if (pessoa[campo.chave]) pontos += campo.peso;
    else faltando.push(campo.rotulo);
  }
  if (temaPrincipal) pontos += 15; else faltando.push('tema de interesse');
  if (temTag) pontos += 15; else faltando.push('marcação da equipe');
  return { completude: pontos, faltando };
}

function sugerirAcao({ pessoa, faixa, intencoes, temaPrincipal, faltando }) {
  const rotulo = temaPrincipal ? TEMAS[temaPrincipal].rotulo.toLowerCase() : null;

  // Cadastrou-se (por anúncio ou pelo formulário) e não está em grupo nenhum:
  // é o maior desperdício da campanha.
  if ((pessoa.assinaturas > 0 || pessoa.cadastro_em) && pessoa.grupos_count === 0) {
    return `Convidar para o grupo do WhatsApp — assinou${rotulo ? ` (${rotulo})` : ''} e ainda não está em nenhum`;
  }
  if (intencoes.includes('voluntario')) {
    return 'Ligar/chamar no privado — se ofereceu para ajudar e ainda não foi acionada';
  }
  if (intencoes.includes('lideranca')) {
    return 'Liderança declarada: agendar conversa e mapear a base dela';
  }
  if (!pessoa.nome || !pessoa.cidade || !pessoa.atuacao) {
    const essenciais = faltando.filter((f) => ['nome completo', 'cidade', 'atuação'].includes(f));
    return `Enviar o link do cadastro — falta ${essenciais.join(', ')}`;
  }
  if (intencoes.includes('demanda')) {
    return `Dar retorno sobre a demanda${rotulo ? ` de ${rotulo}` : ''}`;
  }
  if (faixa === 'Observador') {
    return 'Nunca falou no grupo: mandar boas-vindas com pergunta direta';
  }
  if (faixa === 'Adormecido') {
    return `Reativar com conteúdo${rotulo ? ` de ${rotulo}` : ''} no privado`;
  }
  if (faixa === 'Embaixador') {
    return 'Convidar para o núcleo de multiplicadores / abrir grupo próprio';
  }
  if (intencoes.includes('multiplicador')) {
    return 'Enviar material pronto para ela divulgar (card + texto)';
  }
  return `Manter na régua de conteúdo${rotulo ? ` de ${rotulo}` : ''}`;
}

// ---------------------------------------------------------------------------

function agregados(referencia) {
  const corte30 = referencia - 30 * DIA;
  const corte7 = referencia - 7 * DIA;

  const linhas = db.prepare(`
    SELECT p.id,
           p.nome, p.cidade, p.atuacao, p.telefone, p.email, p.cadastro_em,
           (SELECT COUNT(*) FROM mensagens m WHERE m.pessoa_id = p.id) AS msgs_total,
           (SELECT COUNT(*) FROM mensagens m WHERE m.pessoa_id = p.id AND m.ts >= ?) AS msgs_30d,
           (SELECT COUNT(*) FROM mensagens m WHERE m.pessoa_id = p.id AND m.ts >= ?) AS msgs_7d,
           (SELECT COUNT(*) FROM mensagens m WHERE m.pessoa_id = p.id AND m.tipo <> 'texto') AS midias,
           (SELECT COUNT(*) FROM mensagens m WHERE m.pessoa_id = p.id AND m.responde_a IS NOT NULL) AS respostas_dadas,
           (SELECT COUNT(*) FROM mensagens r
              JOIN mensagens o ON o.id = r.responde_a
             WHERE o.pessoa_id = p.id) AS respostas_recebidas,
           (SELECT COUNT(*) FROM reacoes x WHERE x.pessoa_id = p.id) AS reacoes_dadas,
           (SELECT COUNT(*) FROM reacoes x
              JOIN mensagens m ON m.id = x.mensagem_id
             WHERE m.pessoa_id = p.id) AS reacoes_recebidas,
           (SELECT COUNT(*) FROM membros mb WHERE mb.pessoa_id = p.id AND mb.saiu_em IS NULL) AS grupos_count,
           (SELECT MAX(m.ts) FROM mensagens m WHERE m.pessoa_id = p.id) AS ultima_msg_ts,
           (SELECT COUNT(*) FROM pessoa_tags pt WHERE pt.pessoa_id = p.id) AS tags_count,
           (SELECT COUNT(*) FROM assinaturas s WHERE s.pessoa_id = p.id) AS assinaturas
      FROM pessoas p
  `).all(corte30, corte7);

  const ultimas = db.prepare(`
    SELECT m.pessoa_id, m.texto, m.tipo, g.nome AS grupo
      FROM mensagens m
      LEFT JOIN grupos g ON g.id = m.grupo_id
     WHERE m.ts = (SELECT MAX(m2.ts) FROM mensagens m2 WHERE m2.pessoa_id = m.pessoa_id)
     GROUP BY m.pessoa_id
  `).all();
  const mapaUltimas = new Map(ultimas.map((u) => [u.pessoa_id, u]));

  return { linhas, mapaUltimas };
}

const ETIQUETA_MIDIA = {
  imagem: '📷 enviou uma foto',
  video: '🎬 enviou um vídeo',
  audio: '🎤 enviou um áudio',
  documento: '📄 enviou um documento',
  sticker: '💬 mandou uma figurinha',
  enquete: '📊 respondeu a enquete'
};

/** Percorre as mensagens uma vez e monta o mapa de temas/intenções por pessoa. */
function mapearInteresses(referencia) {
  const temasPorPessoa = new Map();   // pessoaId -> Map(tema -> {score, mencoes})
  const intencoesPorPessoa = new Map(); // pessoaId -> Map(intencao -> peso acumulado)

  const msgs = db.prepare(
    `SELECT pessoa_id, texto, ts FROM mensagens WHERE texto IS NOT NULL AND texto <> ''`
  ).all();

  for (const msg of msgs) {
    const { temas, intencoes } = classificarTexto(msg.texto);
    if (!temas.length && !intencoes.length) continue;

    const idadeDias = Math.max(0, (referencia - msg.ts) / DIA);
    const pesoRecencia = 0.4 + 0.6 * (1 - Math.min(1, idadeDias / 120));

    if (temas.length) {
      if (!temasPorPessoa.has(msg.pessoa_id)) temasPorPessoa.set(msg.pessoa_id, new Map());
      const alvo = temasPorPessoa.get(msg.pessoa_id);
      for (const { tema, acertos } of temas) {
        const atual = alvo.get(tema) || { score: 0, mencoes: 0 };
        atual.score += acertos * pesoRecencia;
        atual.mencoes += acertos;
        alvo.set(tema, atual);
      }
    }

    if (intencoes.length) {
      if (!intencoesPorPessoa.has(msg.pessoa_id)) intencoesPorPessoa.set(msg.pessoa_id, new Map());
      const alvo = intencoesPorPessoa.get(msg.pessoa_id);
      for (const { intencao, peso } of intencoes) {
        alvo.set(intencao, (alvo.get(intencao) || 0) + peso * pesoRecencia);
      }
    }
  }

  // Assinar um abaixo-assinado já declara interesse — vale mesmo para quem
  // nunca escreveu no grupo, que é o caso da maioria dos leads de anúncio.
  const assinaturas = db.prepare(`
    SELECT a.pessoa_id, a.criado_em, ab.temas
      FROM assinaturas a JOIN abaixos ab ON ab.id = a.abaixo_id
  `).all();

  for (const assinatura of assinaturas) {
    let temas = [];
    try { temas = JSON.parse(assinatura.temas) || []; } catch { temas = []; }
    if (!temas.length) continue;

    const idadeDias = Math.max(0, (referencia - assinatura.criado_em) / DIA);
    const pesoRecencia = 0.5 + 0.5 * (1 - Math.min(1, idadeDias / 180));

    if (!temasPorPessoa.has(assinatura.pessoa_id)) temasPorPessoa.set(assinatura.pessoa_id, new Map());
    const alvo = temasPorPessoa.get(assinatura.pessoa_id);
    temas.forEach((tema, i) => {
      const atual = alvo.get(tema) || { score: 0, mencoes: 0 };
      atual.score += Math.max(1, 3 - i * 0.5) * pesoRecencia;
      atual.mencoes += 1;
      alvo.set(tema, atual);
    });
  }

  return { temasPorPessoa, intencoesPorPessoa };
}

/**
 * Recalcula perfil + interesses de toda a base.
 * Barato o suficiente para rodar a cada lote de mensagens novas.
 */
export function recomputar({ referencia = agora() } = {}) {
  const { linhas, mapaUltimas } = agregados(referencia);
  const { temasPorPessoa, intencoesPorPessoa } = mapearInteresses(referencia);

  const limparTemas = db.prepare('DELETE FROM temas_pessoa');
  const inserirTema = db.prepare(
    'INSERT INTO temas_pessoa (pessoa_id, tema, score, mencoes) VALUES (?, ?, ?, ?)'
  );
  const gravarPerfil = db.prepare(`
    INSERT INTO perfil (
      pessoa_id, engajamento, faixa, msgs_total, msgs_30d, msgs_7d,
      reacoes_dadas, reacoes_recebidas, respostas_dadas, respostas_recebidas,
      midias, grupos_count, ultima_msg_ts, ultima_msg_texto, ultima_msg_grupo,
      dias_sem_falar, tema_principal, intencoes, completude, proxima_acao, atualizado_em
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pessoa_id) DO UPDATE SET
      engajamento = excluded.engajamento, faixa = excluded.faixa,
      msgs_total = excluded.msgs_total, msgs_30d = excluded.msgs_30d, msgs_7d = excluded.msgs_7d,
      reacoes_dadas = excluded.reacoes_dadas, reacoes_recebidas = excluded.reacoes_recebidas,
      respostas_dadas = excluded.respostas_dadas, respostas_recebidas = excluded.respostas_recebidas,
      midias = excluded.midias, grupos_count = excluded.grupos_count,
      ultima_msg_ts = excluded.ultima_msg_ts, ultima_msg_texto = excluded.ultima_msg_texto,
      ultima_msg_grupo = excluded.ultima_msg_grupo, dias_sem_falar = excluded.dias_sem_falar,
      tema_principal = excluded.tema_principal, intencoes = excluded.intencoes,
      completude = excluded.completude, proxima_acao = excluded.proxima_acao,
      atualizado_em = excluded.atualizado_em
  `);

  db.exec('BEGIN');
  try {
    limparTemas.run();

    for (const p of linhas) {
      const diasSemFalar = p.ultima_msg_ts == null
        ? null
        : Math.floor((referencia - p.ultima_msg_ts) / DIA);
      const metricas = { ...p, dias_sem_falar: diasSemFalar ?? 9999 };

      const { total: engajamento } = calcularEngajamento(metricas);
      const faixa = definirFaixa(engajamento, metricas);

      const temas = temasPorPessoa.get(p.id);
      let temaPrincipal = null;
      if (temas) {
        const ordenados = [...temas.entries()].sort((a, b) => b[1].score - a[1].score);
        temaPrincipal = ordenados[0][0];
        for (const [tema, dados] of ordenados) {
          inserirTema.run(p.id, tema, Number(dados.score.toFixed(2)), dados.mencoes);
        }
      }

      const intencoes = [...(intencoesPorPessoa.get(p.id) || new Map()).entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([chave]) => chave);

      const { completude, faltando } = calcularCompletude(p, temaPrincipal, p.tags_count > 0);
      const proximaAcao = sugerirAcao({ pessoa: p, faixa, intencoes, temaPrincipal, faltando });

      const ultima = mapaUltimas.get(p.id);
      const textoUltima = ultima
        ? (ultima.texto || ETIQUETA_MIDIA[ultima.tipo] || 'mensagem')
        : null;

      gravarPerfil.run(
        p.id, engajamento, faixa, p.msgs_total, p.msgs_30d, p.msgs_7d,
        p.reacoes_dadas, p.reacoes_recebidas, p.respostas_dadas, p.respostas_recebidas,
        p.midias, p.grupos_count, p.ultima_msg_ts, textoUltima, ultima?.grupo ?? null,
        diasSemFalar, temaPrincipal, JSON.stringify(intencoes), completude, proximaAcao,
        referencia
      );
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  setConfig('ultimo_recalculo', referencia);
  return { pessoas: linhas.length, em: referencia };
}

/** Detalhe do score para a tela da pessoa — mostra de onde veio cada ponto. */
export function detalharEngajamento(pessoaId, referencia = agora()) {
  const p = db.prepare(`
    SELECT msgs_total, msgs_30d, respostas_dadas, respostas_recebidas,
           reacoes_dadas, reacoes_recebidas, grupos_count, ultima_msg_ts, dias_sem_falar
      FROM perfil WHERE pessoa_id = ?
  `).get(pessoaId);
  if (!p) return null;
  return calcularEngajamento({ ...p, dias_sem_falar: p.dias_sem_falar ?? 9999 });
}

export { TEMAS, INTENCOES };
