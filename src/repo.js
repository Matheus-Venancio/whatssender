import { db } from './db.js';
import { TEMAS, INTENCOES } from './lexicon.js';
import { definicaoDoTipo } from './risco.js';
import { formatarTelefone } from './ingest.js';
import { detalharEngajamento } from './scoring.js';

const DIA = 86_400_000;

const SELECT_BASE = `
  SELECT p.id, p.wa_jid, p.telefone, p.nome_wa, p.nome, p.cidade, p.uf, p.bairro, p.atuacao,
         p.email, p.origem, p.cadastro_em, p.primeiro_visto, p.observacoes, p.cidade_bruta,
         (SELECT COUNT(*) FROM assinaturas s WHERE s.pessoa_id = p.id) AS assinaturas,
         f.engajamento, f.faixa, f.msgs_total, f.msgs_30d, f.msgs_7d,
         f.reacoes_dadas, f.reacoes_recebidas, f.respostas_dadas, f.respostas_recebidas,
         f.midias, f.grupos_count, f.ultima_msg_ts, f.ultima_msg_texto, f.ultima_msg_grupo,
         f.dias_sem_falar, f.tema_principal, f.intencoes, f.completude, f.proxima_acao
    FROM pessoas p
    LEFT JOIN perfil f ON f.pessoa_id = p.id
`;

const ORDENACOES = {
  engajamento: 'f.engajamento DESC, f.msgs_total DESC',
  recentes: 'f.ultima_msg_ts DESC NULLS LAST',
  antigos: 'f.ultima_msg_ts ASC NULLS LAST',
  nome: 'COALESCE(NULLIF(p.nome, \'\'), p.nome_wa) COLLATE NOCASE ASC',
  completude: 'f.completude ASC, f.engajamento DESC',
  novos: 'p.primeiro_visto DESC'
};

function enriquecer(linha) {
  const intencoes = linha.intencoes ? JSON.parse(linha.intencoes) : [];
  return {
    ...linha,
    exibicao: linha.nome || linha.nome_wa || formatarTelefone(linha.telefone) || 'Sem nome',
    telefone_fmt: formatarTelefone(linha.telefone),
    cadastrado: Boolean(linha.cadastro_em),
    intencoes,
    intencoes_rotulos: intencoes.map((i) => ({
      chave: i,
      rotulo: INTENCOES[i]?.rotulo ?? i,
      cor: INTENCOES[i]?.cor ?? '#94a3b8'
    })),
    tema_principal_rotulo: linha.tema_principal ? TEMAS[linha.tema_principal]?.rotulo : null,
    tema_principal_cor: linha.tema_principal ? TEMAS[linha.tema_principal]?.cor : null,
    local: [linha.cidade, linha.uf].filter(Boolean).join('/') || null,
    tags: tagsDaPessoa(linha.id),
    grupos: gruposDaPessoa(linha.id),
    abaixos: abaixosDaPessoa(linha.id)
  };
}

export function abaixosDaPessoa(pessoaId) {
  return db.prepare(`
    SELECT ab.chave, ab.titulo, ab.bandeira, a.criado_em, a.plataforma, a.anuncio
      FROM assinaturas a JOIN abaixos ab ON ab.id = a.abaixo_id
     WHERE a.pessoa_id = ? ORDER BY a.criado_em
  `).all(pessoaId);
}

export function tagsDaPessoa(pessoaId) {
  return db.prepare(
    `SELECT t.id, t.nome, t.cor FROM tags t
       JOIN pessoa_tags pt ON pt.tag_id = t.id
      WHERE pt.pessoa_id = ? ORDER BY t.nome`
  ).all(pessoaId);
}

export function gruposDaPessoa(pessoaId) {
  return db.prepare(
    `SELECT g.id, g.nome, m.admin, m.entrou_em FROM grupos g
       JOIN membros m ON m.grupo_id = g.id
      WHERE m.pessoa_id = ? AND m.saiu_em IS NULL ORDER BY g.nome`
  ).all(pessoaId);
}

export function listarPessoas(filtros = {}) {
  const {
    busca = '', faixa = '', grupo = '', tema = '', intencao = '',
    cadastro = '', tag = '', abaixo = '', uf = '', semGrupo = '',
    ordenar = 'engajamento', pagina = 1, porPagina = 25
  } = filtros;

  const where = [];
  const params = [];

  if (busca.trim()) {
    const alvo = `%${busca.trim().toLowerCase()}%`;
    where.push(`(LOWER(COALESCE(p.nome,'')) LIKE ? OR LOWER(COALESCE(p.nome_wa,'')) LIKE ?
             OR COALESCE(p.telefone,'') LIKE ? OR LOWER(COALESCE(p.cidade,'')) LIKE ?
             OR LOWER(COALESCE(p.atuacao,'')) LIKE ?)`);
    params.push(alvo, alvo, alvo, alvo, alvo);
  }
  if (faixa) { where.push('f.faixa = ?'); params.push(faixa); }
  if (grupo) {
    where.push('EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.grupo_id = ? AND m.saiu_em IS NULL)');
    params.push(Number(grupo));
  }
  if (tema) {
    where.push('EXISTS (SELECT 1 FROM temas_pessoa tp WHERE tp.pessoa_id = p.id AND tp.tema = ?)');
    params.push(tema);
  }
  if (intencao) {
    where.push("f.intencoes LIKE ?");
    params.push(`%"${intencao}"%`);
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM pessoa_tags pt WHERE pt.pessoa_id = p.id AND pt.tag_id = ?)');
    params.push(Number(tag));
  }
  if (abaixo) {
    where.push(`EXISTS (SELECT 1 FROM assinaturas s JOIN abaixos ab ON ab.id = s.abaixo_id
                         WHERE s.pessoa_id = p.id AND ab.chave = ?)`);
    params.push(abaixo);
  }
  if (uf) { where.push('p.uf = ?'); params.push(uf); }
  if (semGrupo === 'sim') {
    where.push('NOT EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.saiu_em IS NULL)');
  }
  if (cadastro === 'sim') where.push('p.cadastro_em IS NOT NULL');
  if (cadastro === 'nao') where.push('p.cadastro_em IS NULL');

  const clausula = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const ordem = ORDENACOES[ordenar] || ORDENACOES.engajamento;

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM pessoas p LEFT JOIN perfil f ON f.pessoa_id = p.id ${clausula}`
  ).get(...params).n;

  const limite = Math.min(200, Math.max(5, Number(porPagina) || 25));
  const offset = (Math.max(1, Number(pagina) || 1) - 1) * limite;

  const linhas = db.prepare(
    `${SELECT_BASE} ${clausula} ORDER BY ${ordem} LIMIT ? OFFSET ?`
  ).all(...params, limite, offset);

  return {
    total,
    pagina: Math.max(1, Number(pagina) || 1),
    porPagina: limite,
    paginas: Math.max(1, Math.ceil(total / limite)),
    itens: linhas.map(enriquecer)
  };
}

export function obterPessoa(id) {
  const linha = db.prepare(`${SELECT_BASE} WHERE p.id = ?`).get(id);
  if (!linha) return null;

  const pessoa = enriquecer(linha);

  pessoa.temas = db.prepare(
    'SELECT tema, score, mencoes FROM temas_pessoa WHERE pessoa_id = ? ORDER BY score DESC'
  ).all(id).map((t) => ({
    ...t,
    rotulo: TEMAS[t.tema]?.rotulo ?? t.tema,
    cor: TEMAS[t.tema]?.cor ?? '#94a3b8'
  }));

  pessoa.score_detalhe = detalharEngajamento(id);

  pessoa.timeline = db.prepare(
    'SELECT tipo, descricao, ts FROM eventos WHERE pessoa_id = ? ORDER BY ts DESC LIMIT 40'
  ).all(id);

  pessoa.mensagens = db.prepare(`
    SELECT m.texto, m.tipo, m.ts, g.nome AS grupo,
           (SELECT COUNT(*) FROM reacoes r WHERE r.mensagem_id = m.id) AS reacoes,
           (SELECT COUNT(*) FROM mensagens r2 WHERE r2.responde_a = m.id) AS respostas
      FROM mensagens m LEFT JOIN grupos g ON g.id = m.grupo_id
     WHERE m.pessoa_id = ? ORDER BY m.ts DESC LIMIT 25
  `).all(id);

  // Atividade por semana nas últimas 12 semanas — sparkline da ficha.
  const inicio = Date.now() - 84 * DIA;
  const semanas = new Array(12).fill(0);
  for (const m of db.prepare('SELECT ts FROM mensagens WHERE pessoa_id = ? AND ts >= ?').all(id, inicio)) {
    const idx = Math.min(11, Math.floor((m.ts - inicio) / (7 * DIA)));
    semanas[idx]++;
  }
  pessoa.atividade_semanal = semanas;

  return pessoa;
}

export function listarGrupos() {
  return db.prepare(`
    SELECT g.id, g.nome, g.descricao, g.criado_em,
           (SELECT COUNT(*) FROM membros m WHERE m.grupo_id = g.id AND m.saiu_em IS NULL) AS membros,
           (SELECT COUNT(*) FROM mensagens m WHERE m.grupo_id = g.id) AS mensagens,
           (SELECT COUNT(*) FROM mensagens m WHERE m.grupo_id = g.id AND m.ts >= ?) AS mensagens_7d,
           (SELECT COUNT(DISTINCT m.pessoa_id) FROM mensagens m WHERE m.grupo_id = g.id AND m.ts >= ?) AS ativos_7d,
           (SELECT MAX(m.ts) FROM mensagens m WHERE m.grupo_id = g.id) AS ultima_msg
      FROM grupos g WHERE g.ativo = 1 ORDER BY g.nome
  `).all(Date.now() - 7 * DIA, Date.now() - 7 * DIA);
}

export function listarAbaixos() {
  return db.prepare(`
    SELECT ab.id, ab.chave, ab.titulo, ab.bandeira, ab.campanha, ab.temas,
           (SELECT COUNT(*) FROM assinaturas s WHERE s.abaixo_id = ab.id) AS assinaturas,
           (SELECT COUNT(DISTINCT s.pessoa_id) FROM assinaturas s WHERE s.abaixo_id = ab.id) AS pessoas,
           (SELECT MIN(s.criado_em) FROM assinaturas s WHERE s.abaixo_id = ab.id) AS primeira,
           (SELECT MAX(s.criado_em) FROM assinaturas s WHERE s.abaixo_id = ab.id) AS ultima,
           (SELECT COUNT(*) FROM assinaturas s WHERE s.abaixo_id = ab.id AND s.plataforma = 'Instagram') AS instagram,
           (SELECT COUNT(DISTINCT s.pessoa_id) FROM assinaturas s
              WHERE s.abaixo_id = ab.id
                AND EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = s.pessoa_id AND m.saiu_em IS NULL)
           ) AS ja_no_grupo
      FROM abaixos ab ORDER BY assinaturas DESC
  `).all().map((a) => ({
    ...a,
    temas: JSON.parse(a.temas || '[]').map((t) => ({
      chave: t, rotulo: TEMAS[t]?.rotulo ?? t, cor: TEMAS[t]?.cor ?? '#94a3b8'
    }))
  }));
}

export function listarAlertas({ limite = 60, apenasNaoLidos = false } = {}) {
  const filtro = apenasNaoLidos ? 'WHERE a.lido = 0' : '';
  return db.prepare(`
    SELECT a.id, a.tipo, a.gravidade, a.titulo, a.detalhe, a.dados, a.lido, a.ts,
           a.pessoa_id, g.nome AS grupo
      FROM alertas a LEFT JOIN grupos g ON g.id = a.grupo_id
      ${filtro}
     ORDER BY a.ts DESC LIMIT ?
  `).all(limite).map((a) => {
    const dados = a.dados ? JSON.parse(a.dados) : null;
    return {
      ...a,
      lido: Boolean(a.lido),
      dados,
      // Ícone, cor e a instrução do que fazer vêm do dicionário de risco.
      def: definicaoDoTipo(a.tipo) ?? DEF_PADRAO[a.tipo] ?? null,
      acao: dados?.acao ?? definicaoDoTipo(a.tipo)?.acao ?? null
    };
  });
}

const DEF_PADRAO = {
  saiu_grupo: { rotulo: 'Saiu do grupo', cor: '#f59e0b', icone: '🚪',
    acao: 'Veja se vale reconvidar — principalmente se participava.' },
  removido_grupo: { rotulo: 'Removida do grupo', cor: '#dc2626', icone: '⛔', acao: null },
  entrou_grupo: { rotulo: 'Entrou no grupo', cor: '#16a34a', icone: '👋',
    acao: 'Boas-vindas no privado e link do cadastro.' }
};

export function contarAlertas() {
  return db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN gravidade = 'critico' THEN 1 ELSE 0 END) AS criticos
       FROM alertas WHERE lido = 0`
  ).get();
}

export function marcarAlertas({ id = null, todos = false }) {
  if (todos) db.prepare('UPDATE alertas SET lido = 1 WHERE lido = 0').run();
  else if (id) db.prepare('UPDATE alertas SET lido = 1 WHERE id = ?').run(Number(id));
  return contarAlertas();
}

// ---------------------------------------------------------------------------
// Caixa de entrada: espelho das conversas do WhatsApp.
// Privadas trazem contador de não lidas (é o que precisa de resposta);
// grupos entram pela atividade, sem contador — senão o painel vira ruído.
// ---------------------------------------------------------------------------
export function listarConversas({ filtro = '', busca = '' } = {}) {
  const privadas = db.prepare(`
    SELECT p.id AS pessoa_id, p.nome, p.nome_wa, p.telefone, p.cidade, p.uf, p.wa_jid,
           f.faixa, f.engajamento, c.situacao, c.sentimento,
           (SELECT COUNT(*) FROM mensagens m
             WHERE m.pessoa_id = p.id AND m.privada = 1 AND m.lida = 0 AND m.de_mim = 0) AS nao_lidas,
           (SELECT m.texto FROM mensagens m
             WHERE m.pessoa_id = p.id AND m.privada = 1 ORDER BY m.ts DESC LIMIT 1) AS ultimo_texto,
           (SELECT m.tipo FROM mensagens m
             WHERE m.pessoa_id = p.id AND m.privada = 1 ORDER BY m.ts DESC LIMIT 1) AS ultimo_tipo,
           (SELECT m.de_mim FROM mensagens m
             WHERE m.pessoa_id = p.id AND m.privada = 1 ORDER BY m.ts DESC LIMIT 1) AS ultimo_de_mim,
           (SELECT MAX(m.ts) FROM mensagens m
             WHERE m.pessoa_id = p.id AND m.privada = 1) AS ts
      FROM pessoas p
      LEFT JOIN perfil f ON f.pessoa_id = p.id
      LEFT JOIN conversas c ON c.pessoa_id = p.id
     WHERE EXISTS (SELECT 1 FROM mensagens m WHERE m.pessoa_id = p.id AND m.privada = 1)
  `).all().map((c) => ({
    ...c,
    tipo: 'privada',
    id: `p${c.pessoa_id}`,
    titulo: c.nome || c.nome_wa || formatarTelefone(c.telefone),
    subtitulo: [c.cidade, c.uf].filter(Boolean).join('/') || formatarTelefone(c.telefone),
    aguardando: !c.ultimo_de_mim,
    previa: c.ultimo_texto || rotuloMidia(c.ultimo_tipo)
  }));

  const grupos = db.prepare(`
    SELECT g.id AS grupo_id, g.nome, g.wa_jid,
           (SELECT COUNT(*) FROM membros m WHERE m.grupo_id = g.id AND m.saiu_em IS NULL) AS membros,
           (SELECT m.texto FROM mensagens m WHERE m.grupo_id = g.id ORDER BY m.ts DESC LIMIT 1) AS ultimo_texto,
           (SELECT m.tipo FROM mensagens m WHERE m.grupo_id = g.id ORDER BY m.ts DESC LIMIT 1) AS ultimo_tipo,
           (SELECT MAX(m.ts) FROM mensagens m WHERE m.grupo_id = g.id) AS ts,
           (SELECT COUNT(*) FROM alertas a
             WHERE a.grupo_id = g.id AND a.lido = 0 AND a.tipo LIKE 'atrito:%') AS atritos
      FROM grupos g WHERE g.ativo = 1
  `).all().map((g) => ({
    ...g,
    tipo: 'grupo',
    id: `g${g.grupo_id}`,
    titulo: g.nome,
    subtitulo: `${g.membros} ${g.membros === 1 ? 'membro' : 'membros'}`,
    nao_lidas: 0,
    aguardando: false,
    previa: g.ultimo_texto || rotuloMidia(g.ultimo_tipo)
  }));

  let itens = [...privadas, ...grupos];

  if (filtro === 'privadas') itens = itens.filter((c) => c.tipo === 'privada');
  if (filtro === 'grupos') itens = itens.filter((c) => c.tipo === 'grupo');
  if (filtro === 'nao_lidas') itens = itens.filter((c) => c.nao_lidas > 0);
  if (filtro === 'aguardando') itens = itens.filter((c) => c.aguardando);
  if (filtro === 'atrito') itens = itens.filter((c) => c.sentimento === 'critico' || c.atritos > 0);

  if (busca.trim()) {
    const alvo = busca.trim().toLowerCase();
    itens = itens.filter((c) =>
      `${c.titulo} ${c.subtitulo} ${c.previa ?? ''}`.toLowerCase().includes(alvo));
  }

  itens.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  return {
    itens,
    contagem: {
      naoLidas: privadas.reduce((s, c) => s + c.nao_lidas, 0),
      aguardando: privadas.filter((c) => c.aguardando).length,
      privadas: privadas.length,
      grupos: grupos.length
    }
  };
}

const rotuloMidia = (tipo) => ({
  imagem: '📷 Foto', video: '🎬 Vídeo', audio: '🎤 Áudio',
  documento: '📄 Documento', sticker: '💬 Figurinha', enquete: '📊 Enquete'
}[tipo] ?? null);

/** Thread de um grupo, no formato do espelho de conversa. */
export function conversaDeGrupo(grupoId, limite = 60) {
  const g = db.prepare('SELECT id, nome, wa_jid, descricao FROM grupos WHERE id = ?').get(grupoId);
  if (!g) return null;
  const mensagens = db.prepare(`
    SELECT m.id, m.texto, m.tipo, m.ts, m.de_mim, m.sentimento,
           COALESCE(NULLIF(p.nome, ''), p.nome_wa, p.telefone) AS autor, p.id AS pessoa_id
      FROM mensagens m LEFT JOIN pessoas p ON p.id = m.pessoa_id
     WHERE m.grupo_id = ? ORDER BY m.ts DESC LIMIT ?
  `).all(grupoId, limite).reverse();

  return {
    tipo: 'grupo',
    grupo: {
      ...g,
      membros: db.prepare(
        'SELECT COUNT(*) AS n FROM membros WHERE grupo_id = ? AND saiu_em IS NULL'
      ).get(grupoId).n
    },
    mensagens,
    alertas: listarAlertas({ limite: 6 }).filter((a) => a.grupo === g.nome)
  };
}

export function marcarConversaLida(pessoaId) {
  db.prepare('UPDATE mensagens SET lida = 1 WHERE pessoa_id = ? AND privada = 1 AND lida = 0')
    .run(pessoaId);
  return { ok: true };
}

export function definirSituacao(pessoaId, situacao) {
  db.prepare(`
    INSERT INTO conversas (pessoa_id, situacao, atualizado_em) VALUES (?, ?, ?)
    ON CONFLICT(pessoa_id) DO UPDATE SET situacao = excluded.situacao, atualizado_em = excluded.atualizado_em
  `).run(pessoaId, situacao, Date.now());
  return { ok: true };
}

export function listarTags() {
  return db.prepare(`
    SELECT t.id, t.nome, t.cor,
           (SELECT COUNT(*) FROM pessoa_tags pt WHERE pt.tag_id = t.id) AS pessoas
      FROM tags t ORDER BY t.nome
  `).all();
}

export function panorama() {
  const hoje = Date.now();
  const contar = (sql, ...p) => db.prepare(sql).get(...p).n;

  const faixas = db.prepare(
    'SELECT faixa, COUNT(*) AS n FROM perfil GROUP BY faixa'
  ).all();

  const temas = db.prepare(`
    SELECT tema, COUNT(*) AS pessoas, SUM(mencoes) AS mencoes
      FROM temas_pessoa GROUP BY tema ORDER BY pessoas DESC
  `).all().map((t) => ({
    ...t,
    rotulo: TEMAS[t.tema]?.rotulo ?? t.tema,
    cor: TEMAS[t.tema]?.cor ?? '#94a3b8'
  }));

  const cidades = db.prepare(`
    SELECT cidade, COUNT(*) AS n FROM pessoas
     WHERE cidade IS NOT NULL AND cidade <> '' GROUP BY cidade ORDER BY n DESC LIMIT 12
  `).all();

  const ufs = db.prepare(`
    SELECT uf, COUNT(*) AS n FROM pessoas
     WHERE uf IS NOT NULL AND uf <> '' GROUP BY uf ORDER BY n DESC
  `).all();

  const atuacoes = db.prepare(`
    SELECT atuacao, COUNT(*) AS n FROM pessoas
     WHERE atuacao IS NOT NULL AND atuacao <> '' GROUP BY atuacao ORDER BY n DESC LIMIT 12
  `).all();

  // Intenções: contadas a partir do JSON gravado no perfil.
  const intencoes = {};
  for (const chave of Object.keys(INTENCOES)) {
    intencoes[chave] = {
      rotulo: INTENCOES[chave].rotulo,
      cor: INTENCOES[chave].cor,
      n: contar("SELECT COUNT(*) AS n FROM perfil WHERE intencoes LIKE ?", `%"${chave}"%`)
    };
  }

  // Mensagens por dia nos últimos 30 dias.
  const inicio = hoje - 30 * DIA;
  const serie = new Array(30).fill(0);
  for (const m of db.prepare('SELECT ts FROM mensagens WHERE ts >= ?').all(inicio)) {
    const idx = Math.min(29, Math.floor((m.ts - inicio) / DIA));
    serie[idx]++;
  }

  const serieAssinaturas = new Array(30).fill(0);
  for (const a of db.prepare('SELECT criado_em FROM assinaturas WHERE criado_em >= ?').all(inicio)) {
    const idx = Math.min(29, Math.max(0, Math.floor((a.criado_em - inicio) / DIA)));
    serieAssinaturas[idx]++;
  }

  return {
    pessoas: contar('SELECT COUNT(*) AS n FROM pessoas'),
    cadastradas: contar('SELECT COUNT(*) AS n FROM pessoas WHERE cadastro_em IS NOT NULL'),
    grupos: contar('SELECT COUNT(*) AS n FROM grupos WHERE ativo = 1'),
    mensagens: contar('SELECT COUNT(*) AS n FROM mensagens'),
    ativos_7d: contar('SELECT COUNT(DISTINCT pessoa_id) AS n FROM mensagens WHERE ts >= ?', hoje - 7 * DIA),
    novos_7d: contar('SELECT COUNT(*) AS n FROM pessoas WHERE primeiro_visto >= ?', hoje - 7 * DIA),
    completude_media: Math.round(
      db.prepare('SELECT AVG(completude) AS m FROM perfil').get().m || 0
    ),
    assinaturas: contar('SELECT COUNT(*) AS n FROM assinaturas'),
    assinantes_sem_grupo: contar(`
      SELECT COUNT(*) AS n FROM pessoas p
       WHERE p.cadastro_em IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.saiu_em IS NULL)`),
    saidas_30d: contar(
      "SELECT COUNT(*) AS n FROM alertas WHERE tipo IN ('saiu_grupo','removido_grupo') AND ts >= ?",
      hoje - 30 * DIA
    ),
    faixas,
    temas,
    cidades,
    ufs,
    atuacoes,
    intencoes,
    abaixos: listarAbaixos(),
    alertas: contarAlertas(),
    serie_mensagens: serie,
    serie_assinaturas: serieAssinaturas
  };
}

/** Fila de trabalho: quem a equipe deve tocar hoje, e por quê. */
export function filaDeAcao(limite = 30) {
  // Assinou o abaixo-assinado e não está em nenhum grupo: é a maior conversão
  // parada da campanha — a pessoa já disse sim e não foi trazida pra rede.
  const foraDoGrupo = db.prepare(`
    ${SELECT_BASE}
    WHERE p.cadastro_em IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.saiu_em IS NULL)
    ORDER BY (SELECT COUNT(*) FROM assinaturas s WHERE s.pessoa_id = p.id) DESC,
             p.cadastro_em DESC
    LIMIT ?
  `).all(limite).map(enriquecer);

  const saidas = db.prepare(`
    ${SELECT_BASE}
    WHERE EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.saiu_em IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM membros m2 WHERE m2.pessoa_id = p.id AND m2.saiu_em IS NULL)
    ORDER BY (SELECT MAX(m.saiu_em) FROM membros m WHERE m.pessoa_id = p.id) DESC
    LIMIT ?
  `).all(limite).map(enriquecer);

  const oportunidades = db.prepare(`
    ${SELECT_BASE}
    WHERE f.intencoes LIKE '%"voluntario"%' OR f.intencoes LIKE '%"lideranca"%'
    ORDER BY f.engajamento DESC LIMIT ?
  `).all(limite).map(enriquecer);

  const semCadastro = db.prepare(`
    ${SELECT_BASE}
    WHERE p.cadastro_em IS NULL AND f.engajamento >= 30
    ORDER BY f.engajamento DESC LIMIT ?
  `).all(limite).map(enriquecer);

  const esfriando = db.prepare(`
    ${SELECT_BASE}
    WHERE f.msgs_total > 5 AND f.dias_sem_falar BETWEEN 15 AND 60
    ORDER BY f.msgs_total DESC LIMIT ?
  `).all(limite).map(enriquecer);

  const demandas = db.prepare(`
    ${SELECT_BASE}
    WHERE f.intencoes LIKE '%"demanda"%'
    ORDER BY f.ultima_msg_ts DESC LIMIT ?
  `).all(limite).map(enriquecer);

  return { foraDoGrupo, oportunidades, semCadastro, esfriando, demandas, saidas };
}

export function exportarCsv(filtros = {}) {
  const { itens } = listarPessoas({ ...filtros, pagina: 1, porPagina: 5000 });
  const colunas = [
    ['nome', (p) => p.exibicao],
    ['telefone', (p) => p.telefone_fmt],
    ['cidade', (p) => p.cidade || ''],
    ['uf', (p) => p.uf || ''],
    ['bairro', (p) => p.bairro || ''],
    ['atuacao', (p) => p.atuacao || ''],
    ['email', (p) => p.email || ''],
    ['classificacao', (p) => p.faixa || ''],
    ['engajamento', (p) => p.engajamento ?? 0],
    ['tema_principal', (p) => p.tema_principal_rotulo || ''],
    ['intencoes', (p) => p.intencoes_rotulos.map((i) => i.rotulo).join(' | ')],
    ['abaixos_assinados', (p) => p.abaixos.map((a) => a.titulo).join(' | ')],
    ['qtd_assinaturas', (p) => p.assinaturas ?? 0],
    ['grupos', (p) => p.grupos.map((g) => g.nome).join(' | ')],
    ['tags', (p) => p.tags.map((t) => t.nome).join(' | ')],
    ['ultima_resposta', (p) => (p.ultima_msg_ts ? new Date(p.ultima_msg_ts).toISOString() : '')],
    ['ultima_resposta_texto', (p) => p.ultima_msg_texto || ''],
    ['dias_sem_falar', (p) => p.dias_sem_falar ?? ''],
    ['mensagens_total', (p) => p.msgs_total ?? 0],
    ['completude_perfil', (p) => `${p.completude ?? 0}%`],
    ['proxima_acao', (p) => p.proxima_acao || ''],
    ['assinou_abaixo_assinado', (p) => (p.cadastrado ? 'sim' : 'nao')]
  ];
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [colunas.map(([c]) => c).join(';')];
  for (const p of itens) linhas.push(colunas.map(([, fn]) => escapar(fn(p))).join(';'));
  return `﻿${linhas.join('\n')}`;
}
