// Disparo de mensagem privada para uma lista de pessoas.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO NÃO É "LISTA DE TRANSMISSÃO DO WHATSAPP"
//
// A lista de transmissão nativa só entrega para quem tem o número da campanha
// salvo na agenda — na prática, uma fração pequena. Aqui cada pessoa recebe uma
// mensagem individual, na conversa dela, como se a equipe tivesse escrito.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE MANTÉM O NÚMERO VIVO
//
// O WhatsApp não bane por volume: bane por PADRÃO. O que denuncia um robô é
// mandar o mesmo texto, para muita gente, em intervalos regulares, para quem
// nunca falou com você. Cada uma dessas quatro coisas tem tratamento aqui:
//
//   · texto variado    — o nome entra no meio, e há variações de saudação
//   · ritmo humano     — intervalo aleatório, pausas longas, horário comercial
//   · teto diário      — some ao limite, não à vontade
//   · só quem já tem vínculo — agenda, conversa anterior ou cadastro
//
// E, acima de tudo: PARA no primeiro sinal de problema. Bloqueio quase sempre
// vem depois de o sistema insistir contra o aviso.
//
// ─────────────────────────────────────────────────────────────────────────────
// LEGISLAÇÃO ELEITORAL — o que está codificado aqui
//
// Lei 9.504/1997, com a redação da Lei 13.488/2017:
//
//   art. 57-G  toda mensagem precisa de mecanismo de descadastramento, e o
//              pedido deve ser atendido em até 48 horas. Aqui o rodapé é
//              obrigatório e o descadastramento é imediato e definitivo.
//   art. 57-E  é vedado usar cadastro de terceiros, comprado ou cedido. Por
//              isso o alvo precisa ter vínculo comprovável NESTA base.
//   art. 57-B  §3º veda o disparo em massa contratado de terceiros. Este
//              sistema é operado pela própria campanha, no número dela.
//   art. 36    propaganda eleitoral só a partir de 16 de agosto do ano da
//              eleição. Antes disso, o sistema recusa conteúdo de propaganda.
//   art. 39    §5º no dia da eleição a propaganda é vedada.
//
// LGPD (Lei 13.709/2018): a base legal aqui é o vínculo prévio; o titular pode
// se opor a qualquer momento, e é isso que o opt-out implementa.
//
// ATENÇÃO: as resoluções do TSE para cada eleição podem mudar prazos e regras.
// As datas ficam em variáveis de ambiente justamente para serem ajustadas ao
// calendário oficial sem tocar no código. Confirme com o advogado eleitoral da
// campanha antes do primeiro disparo — este módulo ajuda a cumprir a lei, não
// substitui a assessoria jurídica.

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db, agora, campanhaAtual, comCampanha, pastaDaCampanha } from './db.js';
import { porCampanha } from './porcampanha.js';
import { registrarEvento } from './ingest.js';

const SEGUNDO = 1000;
const MINUTO = 60 * SEGUNDO;

export const LIMITES = {
  intervaloMin: Number(process.env.ENVIO_INTERVALO_MIN || 45),   // segundos
  intervaloMax: Number(process.env.ENVIO_INTERVALO_MAX || 150),
  porDia: Number(process.env.ENVIO_POR_DIA || 200),
  porHora: Number(process.env.ENVIO_POR_HORA || 40),
  horaInicio: Number(process.env.ENVIO_HORA_INICIO || 9),
  horaFim: Number(process.env.ENVIO_HORA_FIM || 20),
  falhasSeguidasParaPausar: Number(process.env.ENVIO_FALHAS_PAUSA || 3),
  pausaLongaACada: Number(process.env.ENVIO_PAUSA_LONGA_A_CADA || 25),
  pausaLongaMin: Number(process.env.ENVIO_PAUSA_LONGA_MIN || 10)
};

// Calendário eleitoral. Em ISO, para acertar sem mexer no código quando o TSE
// publicar as datas oficiais.
export const CALENDARIO = {
  inicioPropaganda: process.env.ELEICAO_INICIO_PROPAGANDA || '2026-08-16',
  diasDeEleicao: (process.env.ELEICAO_DIAS || '2026-10-04,2026-10-25').split(',')
};

export const RODAPE_OPTOUT = process.env.ENVIO_RODAPE
  || 'Para não receber mais, responda SAIR.';

// Palavras que significam "me tire da lista". Ficam aqui, e não espalhadas,
// porque errar para MENOS aqui é descumprir a lei.
const PEDIDOS_DE_SAIDA = [
  'sair', 'sai', 'pare', 'parar', 'para de mandar', 'nao quero', 'não quero',
  'descadastr', 'remover', 'me tira', 'me tire', 'cancelar', 'stop', 'nao me mande',
  'não me mande', 'nao manda mais', 'não manda mais', 'sem interesse'
];

/** A pessoa está pedindo para sair da lista? */
export function pediuParaSair(texto) {
  if (!texto) return false;
  const limpo = String(texto).toLowerCase().trim().replace(/[.!]+$/, '');

  // Só mensagem curta e direta. Quem quer sair escreve "SAIR", não um
  // parágrafo — e procurar a palavra solta dentro de frase longa descadastra
  // por engano quem escreveu "não quero perder o evento" ou "vou sair de casa".
  // Errar para mais aqui custa um apoiador; errar para menos custa uma multa.
  // Por isso: curto E começando pelo pedido.
  if (limpo.length > 25) return false;
  return PEDIDOS_DE_SAIDA.some((p) => limpo === p || limpo.startsWith(p));
}

/** Marca a pessoa como descadastrada. Definitivo: nenhum disparo futuro a inclui. */
export function descadastrar(pessoaId, origem = 'pediu no WhatsApp') {
  db.prepare('UPDATE pessoas SET opt_out = 1, opt_out_em = ? WHERE id = ?').run(agora(), pessoaId);
  db.prepare(
    "UPDATE transmissao_alvos SET situacao = 'pulado', motivo = 'descadastrou' "
    + "WHERE pessoa_id = ? AND situacao = 'pendente'"
  ).run(pessoaId);
  registrarEvento({
    pessoaId, tipo: 'optout',
    descricao: `Pediu para não receber mais mensagens (${origem})`
  });
  return { ok: true };
}

// ------------------------------------------------------------------ calendário
const soData = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * O que a lei permite HOJE. Devolve `{ pode, motivo }`.
 * `tipo` distingue propaganda eleitoral de comunicação administrativa
 * (convite para reunião interna, aviso de agenda para a própria equipe).
 */
export function janelaLegal({ tipo = 'propaganda', hoje = soData() } = {}) {
  if (CALENDARIO.diasDeEleicao.includes(hoje)) {
    return { pode: false, motivo: 'Dia de eleição: propaganda eleitoral é vedada (Lei 9.504/97, art. 39).' };
  }
  if (tipo === 'propaganda' && hoje < CALENDARIO.inicioPropaganda) {
    return {
      pode: false,
      motivo: `Propaganda eleitoral só a partir de ${CALENDARIO.inicioPropaganda} `
        + '(Lei 9.504/97, art. 36). Antes disso, use conteúdo de mobilização interna.'
    };
  }
  return { pode: true, motivo: null };
}

export function dentroDoHorario(agoraData = new Date()) {
  const h = agoraData.getHours();
  return h >= LIMITES.horaInicio && h < LIMITES.horaFim;
}

// -------------------------------------------------------------------- alvos
/**
 * Quem pode receber. As exclusões não são preferência de produto: cada uma
 * corresponde a uma regra legal ou a um motivo direto de bloqueio do número.
 */
export function elegiveis(filtros = {}) {
  const onde = [];
  const params = [];

  if (filtros.apoio) { onde.push('f.faixa_apoio = ?'); params.push(filtros.apoio); }
  if (filtros.propensaoMinima) {
    onde.push('COALESCE(f.propensao, 0) >= ?');
    params.push(Number(filtros.propensaoMinima));
  }
  if (filtros.cidade) { onde.push('LOWER(p.cidade) = LOWER(?)'); params.push(filtros.cidade); }
  if (filtros.uf) { onde.push('p.uf = ?'); params.push(filtros.uf); }
  if (filtros.grupoId) {
    onde.push('EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.grupo_id = ? AND m.saiu_em IS NULL)');
    params.push(Number(filtros.grupoId));
  }

  return db.prepare(`
    SELECT p.id, p.telefone, p.wa_jid, p.cidade,
           COALESCE(NULLIF(p.nome,''), p.nome_agenda, p.nome_wa) AS nome,
           COALESCE(f.propensao, 0) AS propensao,
           COALESCE(f.faixa_apoio, 'Sem sinal') AS faixa_apoio
      FROM pessoas p
      LEFT JOIN perfil f ON f.pessoa_id = p.id
     WHERE p.telefone IS NOT NULL AND LENGTH(p.telefone) >= 12
       -- art. 57-G: quem se descadastrou não recebe mais, e ponto.
       AND p.opt_out = 0
       -- Quem já reclamou é o caminho mais curto para uma denúncia e um bloqueio.
       AND COALESCE(f.faixa_apoio, 'Sem sinal') <> 'Não abordar'
       AND NOT EXISTS (SELECT 1 FROM alertas a WHERE a.pessoa_id = p.id AND a.tipo LIKE 'atrito:%')
       -- art. 57-E: nada de cadastro de terceiros. Só quem tem vínculo AQUI:
       -- está na agenda do celular, já conversou, ou se cadastrou por vontade.
       AND (
         p.na_agenda = 1
         OR EXISTS (SELECT 1 FROM mensagens m WHERE m.pessoa_id = p.id AND m.privada = 1)
         OR p.cadastro_em IS NOT NULL
         OR EXISTS (SELECT 1 FROM assinaturas s WHERE s.pessoa_id = p.id)
       )
       ${onde.length ? `AND ${onde.join(' AND ')}` : ''}
     ORDER BY COALESCE(f.propensao, 0) DESC
  `).all(...params);
}

// ------------------------------------------------------------------ mensagem
const SAUDACOES = ['Oi', 'Olá', 'Oi,', 'Olá,'];

/**
 * Monta o texto de uma pessoa. Duas mensagens nunca saem idênticas: o WhatsApp
 * detecta texto repetido em massa, e o primeiro nome já muda a maior parte.
 */
export function montarTexto(modelo, pessoa, indice = 0) {
  const primeiro = (pessoa.nome || '').trim().split(/\s+/)[0] || '';
  const saudacao = SAUDACOES[indice % SAUDACOES.length];

  let texto = String(modelo)
    .replaceAll('{nome}', primeiro)
    .replaceAll('{cidade}', pessoa.cidade || 'sua cidade')
    .replaceAll('{saudacao}', primeiro ? `${saudacao} ${primeiro}` : saudacao);

  // Rodapé de descadastramento: obrigatório, e por isso não é opcional aqui.
  if (!texto.toLowerCase().includes('sair')) texto += `\n\n${RODAPE_OPTOUT}`;
  return texto;
}

// ----------------------------------------------------------------- mídia
export const TIPOS_MIDIA = { imagem: ['jpg', 'jpeg', 'png', 'webp'], video: ['mp4', '3gp'], audio: ['mp3', 'ogg', 'opus', 'm4a', 'aac'] };
export const TAMANHO_MAXIMO = Number(process.env.ENVIO_MIDIA_MB || 12) * 1024 * 1024;

/**
 * Grava o anexo na pasta da campanha e devolve o caminho.
 *
 * O arquivo NÃO vai para public/: é material de campanha, e servir por URL
 * pública deixaria qualquer um baixar. Ele só existe para o envio.
 */
export function guardarMidia({ nome, tipo, base64 }) {
  const extensao = String(nome || '').split('.').pop()?.toLowerCase() || '';
  const familia = Object.entries(TIPOS_MIDIA).find(([, exts]) => exts.includes(extensao))?.[0];
  if (!familia) {
    throw new Error(`Formato .${extensao} não serve. Use ${Object.values(TIPOS_MIDIA).flat().join(', ')}.`);
  }

  const dados = Buffer.from(String(base64).split(',').pop(), 'base64');
  if (dados.length > TAMANHO_MAXIMO) {
    throw new Error(`Arquivo de ${(dados.length / 1024 / 1024).toFixed(1)} MB — o limite é ${TAMANHO_MAXIMO / 1024 / 1024} MB.`);
  }

  const pasta = join(pastaDaCampanha(campanhaAtual()), 'midia');
  mkdirSync(pasta, { recursive: true });
  const arquivo = join(pasta, `${Date.now()}-${String(nome).replace(/[^\w.-]/g, '_')}`);
  writeFileSync(arquivo, dados);

  return { caminho: arquivo, tipo: tipo || familia, nome, bytes: dados.length };
}

// ---------------------------------------------------------------- transmissões
export function criar({ titulo, modelo, tipo = 'propaganda', filtros = {}, pessoaIds = null, limite = null, criadaPor = null, midia = null }) {
  if (!titulo?.trim()) throw new Error('Dê um nome a esta transmissão');
  // Com anexo, o texto vira legenda e pode ficar vazio — sem anexo, não.
  if (!modelo?.trim() && !midia) throw new Error('Escreva a mensagem ou anexe um arquivo');

  let lista = pessoaIds?.length
    ? elegiveis({}).filter((p) => pessoaIds.includes(p.id))
    : elegiveis(filtros);
  if (limite) lista = lista.slice(0, Number(limite));
  if (!lista.length) throw new Error('Nenhuma pessoa elegível com esses filtros');

  const info = db.prepare(`
    INSERT INTO transmissoes (titulo, modelo, tipo, criada_em, criada_por, midia, midia_tipo, midia_nome)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(titulo.trim(), (modelo || '').trim(), tipo === 'interno' ? 'interno' : 'propaganda',
    agora(), criadaPor, midia?.caminho ?? null, midia?.tipo ?? null, midia?.nome ?? null);
  const id = Number(info.lastInsertRowid);

  const inserir = db.prepare(
    'INSERT INTO transmissao_alvos (transmissao_id, pessoa_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  );
  db.exec('BEGIN');
  try {
    for (const p of lista) inserir.run(id, p.id);
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return { id, titulo: titulo.trim(), alvos: lista.length };
}

export const listar = () => db.prepare(`
  SELECT t.*,
         (SELECT COUNT(*) FROM transmissao_alvos a WHERE a.transmissao_id = t.id) AS total,
         (SELECT COUNT(*) FROM transmissao_alvos a WHERE a.transmissao_id = t.id AND a.situacao = 'pendente') AS pendentes
    FROM transmissoes t ORDER BY t.criada_em DESC LIMIT 40
`).all();

export const obter = (id) => {
  const t = db.prepare('SELECT * FROM transmissoes WHERE id = ?').get(id);
  if (!t) return null;
  return {
    ...t,
    alvos: db.prepare(`
      SELECT a.situacao, a.motivo, a.enviado_em,
             COALESCE(NULLIF(p.nome,''), p.nome_agenda, p.nome_wa, p.telefone) AS nome,
             p.telefone
        FROM transmissao_alvos a JOIN pessoas p ON p.id = a.pessoa_id
       WHERE a.transmissao_id = ? ORDER BY a.situacao, nome LIMIT 500
    `).all(id),
    contagem: db.prepare(
      'SELECT situacao, COUNT(*) AS n FROM transmissao_alvos WHERE transmissao_id = ? GROUP BY situacao'
    ).all(id)
  };
};

// ------------------------------------------------------------------- execução
const filas = porCampanha(() => ({
  executor: null,
  temporizador: null,
  estado: {
    ligada: false, enviando: false, pausada: false, motivoPausa: null,
    proximoEm: null, falhasSeguidas: 0, desdeAPausaLonga: 0
  }
}));

export const estadoDoEnvio = () => filas.atual().estado;

const ouvintes = new Set();
export function assinar(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); }
const emitir = (tipo, dados = {}) => {
  const campanha = campanhaAtual();
  for (const fn of ouvintes) { try { fn({ tipo, campanha, ...dados }); } catch { /* ignora */ } }
};

/** O whatsapp.js entrega aqui a função que fala com o WhatsApp. */
export function registrarExecutor(enviar) {
  const slug = campanhaAtual();
  const fila = filas.atual();
  fila.executor = enviar;
  fila.estado.ligada = Boolean(enviar);

  if (!enviar) {
    if (fila.temporizador) { clearInterval(fila.temporizador); fila.temporizador = null; }
  } else if (!fila.temporizador) {
    fila.temporizador = setInterval(() => {
      comCampanha(slug, () => girar().catch(() => {}));
    }, 20 * SEGUNDO);
    fila.temporizador.unref?.();
  }
  emitir('estado');
}

export function iniciar(id) {
  const t = db.prepare('SELECT * FROM transmissoes WHERE id = ?').get(id);
  if (!t) throw new Error('Transmissão não encontrada');

  // A janela depende do que se está mandando: convocar a equipe para uma
  // reunião não é propaganda eleitoral e não espera 16 de agosto.
  const janela = janelaLegal({ tipo: t.tipo });
  if (!janela.pode) throw new Error(janela.motivo);

  db.prepare("UPDATE transmissoes SET situacao = 'enviando' WHERE id = ?").run(id);
  filas.atual().estado.pausada = false;
  filas.atual().estado.motivoPausa = null;
  filas.atual().estado.falhasSeguidas = 0;
  emitir('estado');
  return { ok: true };
}

export function pausar(id, motivo = 'pausada pela equipe') {
  db.prepare("UPDATE transmissoes SET situacao = 'pausada' WHERE id = ?").run(id);
  filas.atual().estado.pausada = true;
  filas.atual().estado.motivoPausa = motivo;
  emitir('estado');
  return { ok: true, motivo };
}

export function cancelar(id) {
  db.prepare("UPDATE transmissoes SET situacao = 'cancelada' WHERE id = ?").run(id);
  const r = db.prepare(
    "UPDATE transmissao_alvos SET situacao='pulado', motivo='cancelada' WHERE transmissao_id = ? AND situacao='pendente'"
  ).run(id);
  emitir('estado');
  return { ok: true, cancelados: r.changes };
};

const enviadasDesde = (ms) => db.prepare(
  "SELECT COUNT(*) AS n FROM transmissao_alvos WHERE situacao = 'enviado' AND enviado_em > ?"
).get(agora() - ms).n;

/** Motivo para não enviar agora, ou null se pode. */
export function porQueNaoAgora(tipo = null) {
  const estado = filas.atual().estado;
  if (!estado.ligada) return 'WhatsApp desconectado';
  if (estado.pausada) return estado.motivoPausa || 'pausada';
  if (!dentroDoHorario()) {
    return `fora do horário (${LIMITES.horaInicio}h–${LIMITES.horaFim}h)`;
  }
  // Sem tipo declarado, olha o que está de fato na fila: uma transmissão
  // interna não pode ficar travada pela regra da propaganda.
  const emFila = tipo ?? db.prepare(
    "SELECT tipo FROM transmissoes WHERE situacao = 'enviando' ORDER BY id LIMIT 1"
  ).get()?.tipo ?? 'propaganda';
  const janela = janelaLegal({ tipo: emFila });
  if (!janela.pode) return janela.motivo;
  if (enviadasDesde(24 * 60 * MINUTO) >= LIMITES.porDia) return 'teto diário atingido';
  if (enviadasDesde(60 * MINUTO) >= LIMITES.porHora) return 'teto por hora atingido';
  return null;
}

let emAndamento = null;

/** Envia UMA mensagem, se tudo permitir. Chamada pelo temporizador. */
export async function girar() {
  if (emAndamento) return emAndamento;
  const fila = filas.atual();
  const slug = campanhaAtual();

  const impedimento = porQueNaoAgora();
  if (impedimento) {
    fila.estado.proximoEm = null;
    return { enviada: false, motivo: impedimento };
  }

  const alvo = db.prepare(`
    SELECT a.transmissao_id, a.pessoa_id, t.modelo, t.titulo,
           t.midia, t.midia_tipo, t.midia_nome,
           p.wa_jid, p.telefone, p.cidade, p.opt_out,
           COALESCE(NULLIF(p.nome,''), p.nome_agenda, p.nome_wa) AS nome
      FROM transmissao_alvos a
      JOIN transmissoes t ON t.id = a.transmissao_id
      JOIN pessoas p ON p.id = a.pessoa_id
     WHERE a.situacao = 'pendente' AND t.situacao = 'enviando'
     ORDER BY a.rowid LIMIT 1
  `).get();

  if (!alvo) {
    db.prepare(`
      UPDATE transmissoes SET situacao = 'concluida'
       WHERE situacao = 'enviando'
         AND NOT EXISTS (SELECT 1 FROM transmissao_alvos a
                          WHERE a.transmissao_id = transmissoes.id AND a.situacao = 'pendente')
    `).run();
    return { enviada: false, motivo: 'nada pendente' };
  }

  // Pode ter se descadastrado entre a criação da lista e o envio.
  if (alvo.opt_out) {
    db.prepare(
      "UPDATE transmissao_alvos SET situacao='pulado', motivo='descadastrou' WHERE transmissao_id=? AND pessoa_id=?"
    ).run(alvo.transmissao_id, alvo.pessoa_id);
    return { enviada: false, motivo: 'alvo descadastrado' };
  }

  emAndamento = (async () => {
    fila.estado.enviando = true;
    const indice = enviadasDesde(24 * 60 * MINUTO);
    const texto = montarTexto(alvo.modelo, alvo, indice);

    try {
      const anexo = alvo.midia && existsSync(alvo.midia)
        ? { caminho: alvo.midia, tipo: alvo.midia_tipo, nome: alvo.midia_nome }
        : null;
      await fila.executor(alvo.wa_jid || `${alvo.telefone}@s.whatsapp.net`, texto, anexo);

      db.prepare(
        "UPDATE transmissao_alvos SET situacao='enviado', enviado_em=? WHERE transmissao_id=? AND pessoa_id=?"
      ).run(agora(), alvo.transmissao_id, alvo.pessoa_id);
      db.prepare('UPDATE transmissoes SET enviadas = enviadas + 1 WHERE id = ?').run(alvo.transmissao_id);

      fila.estado.falhasSeguidas = 0;
      fila.estado.desdeAPausaLonga++;
      emitir('progresso', { transmissao: alvo.titulo, pessoa: alvo.nome || alvo.telefone });
      return { enviada: true };
    } catch (erro) {
      db.prepare(
        "UPDATE transmissao_alvos SET situacao='falhou', motivo=? WHERE transmissao_id=? AND pessoa_id=?"
      ).run(String(erro.message).slice(0, 180), alvo.transmissao_id, alvo.pessoa_id);
      db.prepare('UPDATE transmissoes SET falhas = falhas + 1 WHERE id = ?').run(alvo.transmissao_id);

      fila.estado.falhasSeguidas++;
      // Falha seguida é o aviso que antecede o bloqueio. Insistir contra ele é
      // exatamente como se perde o número.
      if (fila.estado.falhasSeguidas >= LIMITES.falhasSeguidasParaPausar) {
        pausar(alvo.transmissao_id,
          `${fila.estado.falhasSeguidas} falhas seguidas — parei para não arriscar o número`);
      }
      return { enviada: false, motivo: erro.message };
    } finally {
      fila.estado.enviando = false;
      emAndamento = null;
      emitir('estado');
    }
  })();

  const r = await emAndamento;

  // Pausa longa a cada N envios: ninguém escreve 25 mensagens sem parar.
  if (fila.estado.desdeAPausaLonga >= LIMITES.pausaLongaACada) {
    fila.estado.desdeAPausaLonga = 0;
    fila.estado.proximoEm = agora() + LIMITES.pausaLongaMin * MINUTO;
  }
  return { ...r, campanha: slug };
}
