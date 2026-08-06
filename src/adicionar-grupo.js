// Adição de pessoas a grupos, em ritmo seguro.
//
// POR QUE ISSO NÃO É UM BOTÃO QUE ADICIONA 100 DE UMA VEZ:
// o WhatsApp desconecta e bloqueia números que adicionam gente em rajada — foi
// exatamente o que aconteceu ao fazer manualmente. Não existe truque, biblioteca
// ou API que contorne isso: o limite é de comportamento, não de tecnologia.
//
// O que existe de verdade: enfileirar as 100 pessoas com UM clique e deixar o
// sistema adicionar sozinho, uma por vez, com intervalo aleatório, teto diário,
// horário comercial e parada automática ao primeiro sinal de problema.
// Você clica uma vez; ele trabalha por horas sem te derrubar.

import { db, agora } from './db.js';
import { registrarEvento } from './ingest.js';
import { publicarPessoa } from './firestore.js';

const SEGUNDO = 1000;
const MINUTO = 60 * SEGUNDO;

// Padrões conservadores. Ajustáveis no .env, mas subir muito é pedir bloqueio.
export const LIMITES = {
  intervaloMin: Number(process.env.ADICAO_INTERVALO_MIN || 90),      // segundos
  intervaloMax: Number(process.env.ADICAO_INTERVALO_MAX || 210),
  porDia: Number(process.env.ADICAO_POR_DIA || 50),
  porHora: Number(process.env.ADICAO_POR_HORA || 15),
  horaInicio: Number(process.env.ADICAO_HORA_INICIO || 9),           // 9h
  horaFim: Number(process.env.ADICAO_HORA_FIM || 20),                // 20h
  falhasSeguidasParaPausar: Number(process.env.ADICAO_FALHAS_PAUSA || 3),
  pausaLongaACada: Number(process.env.ADICAO_PAUSA_LONGA_A_CADA || 12), // pessoas
  pausaLongaMin: Number(process.env.ADICAO_PAUSA_LONGA_MIN || 12)       // minutos
};

export const estadoFila = {
  ligada: false,
  pausada: false,
  motivoPausa: null,
  processando: false,
  proximoEm: null,
  falhasSeguidas: 0,
  desdeAPausaLonga: 0
};

let executor = null;      // registrado pelo whatsapp.js quando conecta
let temporizador = null;
const ouvintes = new Set();

export function assinarFila(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}
const emitir = (tipo, dados = {}) => {
  for (const fn of ouvintes) { try { fn({ tipo, ...dados }); } catch { /* ignora */ } }
};

/**
 * O whatsapp.js entrega aqui as funções que realmente falam com o WhatsApp.
 * Assim este módulo não depende do socket e continua testável.
 */
export function registrarExecutor(fns) {
  executor = fns;
  estadoFila.ligada = Boolean(fns);
  if (!fns) {
    estadoFila.proximoEm = null;
  } else if (!temporizador) {
    temporizador = setInterval(() => { girar().catch(() => {}); }, 15 * SEGUNDO);
    temporizador.unref?.();
    agendarProximo();
  }
  emitir('estado');
}

// --------------------------------------------------------------- enfileirar
/** Quem pode entrar na fila: tem telefone, não está no grupo e não saiu dele antes. */
export function elegiveis({ grupoId, filtros = {} }) {
  const onde = [];
  const params = [grupoId];

  if (filtros.abaixo) {
    onde.push(`EXISTS (SELECT 1 FROM assinaturas s JOIN abaixos ab ON ab.id = s.abaixo_id
                        WHERE s.pessoa_id = p.id AND ab.chave = ?)`);
    params.push(filtros.abaixo);
  }
  if (filtros.uf) { onde.push('p.uf = ?'); params.push(filtros.uf); }
  if (filtros.cidade) { onde.push('LOWER(p.cidade) = LOWER(?)'); params.push(filtros.cidade); }
  if (filtros.somenteSemGrupo === true || filtros.somenteSemGrupo === 'sim') {
    onde.push('NOT EXISTS (SELECT 1 FROM membros m2 WHERE m2.pessoa_id = p.id AND m2.saiu_em IS NULL)');
  }
  if (filtros.somenteAssinantes === true || filtros.somenteAssinantes === 'sim') {
    onde.push('EXISTS (SELECT 1 FROM assinaturas s2 WHERE s2.pessoa_id = p.id)');
  }

  return db.prepare(`
    SELECT p.id, p.telefone, p.wa_jid,
           COALESCE(NULLIF(p.nome,''), p.nome_wa, p.telefone) AS nome,
           p.cidade, p.uf
      FROM pessoas p
     WHERE p.telefone IS NOT NULL AND LENGTH(p.telefone) >= 12
       -- nunca esteve neste grupo (inclusive não saiu dele antes)
       AND NOT EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.grupo_id = ?)
       -- nem já está na fila
       AND NOT EXISTS (SELECT 1 FROM fila_adicao f
                        WHERE f.pessoa_id = p.id AND f.grupo_id = ?
                          AND f.situacao IN ('pendente','adicionado','convidado'))
       ${onde.length ? `AND ${onde.join(' AND ')}` : ''}
     ORDER BY (SELECT COUNT(*) FROM assinaturas s3 WHERE s3.pessoa_id = p.id) DESC,
              p.cadastro_em DESC
  `).all(grupoId, grupoId, ...params.slice(1));
}

export function enfileirar({ grupoId, pessoaIds = null, filtros = {}, limite = null }) {
  const grupo = db.prepare('SELECT id, nome FROM grupos WHERE id = ?').get(grupoId);
  if (!grupo) throw new Error('Grupo não encontrado');

  let lista = pessoaIds?.length
    ? elegiveis({ grupoId, filtros: {} }).filter((p) => pessoaIds.includes(p.id))
    : elegiveis({ grupoId, filtros });

  if (limite) lista = lista.slice(0, Number(limite));

  const inserir = db.prepare(`
    INSERT INTO fila_adicao (grupo_id, pessoa_id, criado_em) VALUES (?, ?, ?)
    ON CONFLICT(grupo_id, pessoa_id) DO UPDATE SET
      situacao = CASE WHEN fila_adicao.situacao IN ('falhou','cancelado')
                      THEN 'pendente' ELSE fila_adicao.situacao END,
      erro = NULL
  `);

  db.exec('BEGIN');
  try {
    for (const p of lista) inserir.run(grupoId, p.id, agora());
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  estadoFila.pausada = false;
  estadoFila.motivoPausa = null;
  agendarProximo(5 * SEGUNDO);
  emitir('estado');

  return { enfileirados: lista.length, grupo: grupo.nome, ...resumo(grupoId) };
}

export function cancelarPendentes(grupoId = null) {
  const r = grupoId
    ? db.prepare("UPDATE fila_adicao SET situacao='cancelado' WHERE situacao='pendente' AND grupo_id = ?").run(grupoId)
    : db.prepare("UPDATE fila_adicao SET situacao='cancelado' WHERE situacao='pendente'").run();
  emitir('estado');
  return { cancelados: r.changes };
}

export function pausar(motivo = 'pausada pela equipe') {
  estadoFila.pausada = true;
  estadoFila.motivoPausa = motivo;
  estadoFila.proximoEm = null;
  emitir('estado');
  return estadoFila;
}

export function retomar() {
  estadoFila.pausada = false;
  estadoFila.motivoPausa = null;
  estadoFila.falhasSeguidas = 0;
  agendarProximo(3 * SEGUNDO);
  emitir('estado');
  return estadoFila;
}

// ------------------------------------------------------------------ ritmo
const sorteioIntervalo = () =>
  (LIMITES.intervaloMin + Math.random() * (LIMITES.intervaloMax - LIMITES.intervaloMin)) * SEGUNDO;

function contarDesde(ms) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM fila_adicao
     WHERE processado_em >= ? AND situacao IN ('adicionado','convidado')
  `).get(agora() - ms).n;
}

function agendarProximo(atraso = null) {
  if (estadoFila.pausada || !estadoFila.ligada) { estadoFila.proximoEm = null; return; }
  const pendentes = db.prepare("SELECT COUNT(*) AS n FROM fila_adicao WHERE situacao='pendente'").get().n;
  if (!pendentes) { estadoFila.proximoEm = null; return; }

  let espera = atraso ?? sorteioIntervalo();
  // A cada N pessoas, uma pausa longa: ritmo humano não é metrônomo.
  if (estadoFila.desdeAPausaLonga >= LIMITES.pausaLongaACada) {
    espera = LIMITES.pausaLongaMin * MINUTO + Math.random() * 5 * MINUTO;
    estadoFila.desdeAPausaLonga = 0;
  }
  estadoFila.proximoEm = agora() + espera;
}

/** Por que não podemos processar agora, se for o caso. */
function impedimento() {
  if (!estadoFila.ligada || !executor) return 'WhatsApp desconectado';
  if (estadoFila.pausada) return estadoFila.motivoPausa || 'pausada';
  const hora = new Date().getHours();
  if (hora < LIMITES.horaInicio || hora >= LIMITES.horaFim) {
    return `fora do horário (retoma às ${LIMITES.horaInicio}h)`;
  }
  if (contarDesde(24 * 60 * MINUTO) >= LIMITES.porDia) return 'teto diário atingido';
  if (contarDesde(60 * MINUTO) >= LIMITES.porHora) return 'teto por hora atingido';
  return null;
}

// --------------------------------------------------------------- execução
async function girar() {
  if (estadoFila.processando) return;
  if (estadoFila.proximoEm && agora() < estadoFila.proximoEm) return;

  const bloqueio = impedimento();
  if (bloqueio) {
    if (estadoFila.proximoEm) { estadoFila.proximoEm = null; emitir('estado'); }
    return;
  }

  const item = db.prepare(`
    SELECT f.id, f.grupo_id, f.pessoa_id, f.tentativas,
           g.wa_jid AS grupo_jid, g.nome AS grupo_nome,
           p.wa_jid AS pessoa_jid, COALESCE(NULLIF(p.nome,''), p.nome_wa, p.telefone) AS pessoa_nome
      FROM fila_adicao f
      JOIN grupos g ON g.id = f.grupo_id
      JOIN pessoas p ON p.id = f.pessoa_id
     WHERE f.situacao = 'pendente' ORDER BY f.id LIMIT 1
  `).get();

  if (!item) { estadoFila.proximoEm = null; return; }

  estadoFila.processando = true;
  try {
    await processar(item);
  } catch (erro) {
    marcar(item, 'falhou', null, erro.message);
    registrarFalha(erro.message);
  } finally {
    estadoFila.processando = false;
    estadoFila.desdeAPausaLonga++;
    agendarProximo();
    emitir('estado');
  }
}

async function processar(item) {
  const resposta = await executor.adicionar(item.grupo_jid, item.pessoa_jid);
  const status = String(resposta?.status ?? '');

  if (status === '200') {
    marcar(item, 'adicionado', 'direto');
    estadoFila.falhasSeguidas = 0;
    registrarEvento({
      pessoaId: item.pessoa_id,
      tipo: 'entrou_grupo',
      descricao: `Adicionada ao grupo ${item.grupo_nome} pelo painel`
    });
    publicarPessoa(item.pessoa_id);
    emitir('progresso', { pessoa: item.pessoa_nome, grupo: item.grupo_nome, resultado: 'adicionado' });
    return;
  }

  // 403 = a privacidade dela não permite ser adicionada direto.
  // O jeito certo é mandar o convite; o WhatsApp inclusive devolve o código.
  if (status === '403' || status === '409') {
    const codigo = resposta?.content?.content?.[0]?.attrs?.code
      ?? resposta?.content?.attrs?.code
      ?? await executor.obterConvite(item.grupo_jid);

    if (codigo) {
      await executor.enviarMensagem(item.pessoa_jid, textoDoConvite(item, codigo));
      marcar(item, 'convidado', 'convite');
      estadoFila.falhasSeguidas = 0;
      registrarEvento({
        pessoaId: item.pessoa_id,
        tipo: 'contato_equipe',
        descricao: `Convite do grupo ${item.grupo_nome} enviado no privado (privacidade impede adição direta)`
      });
      publicarPessoa(item.pessoa_id);
      emitir('progresso', { pessoa: item.pessoa_nome, grupo: item.grupo_nome, resultado: 'convidado' });
      return;
    }
    marcar(item, 'falhou', null, 'privacidade impede adicionar e não foi possível gerar convite');
    return;
  }

  // 408 = saiu do grupo há pouco; 401 = bloqueou o número. Não insistir.
  const motivos = {
    408: 'saiu do grupo recentemente — o WhatsApp não deixa readicionar agora',
    401: 'bloqueou o nosso número',
    404: 'número não existe no WhatsApp'
  };
  marcar(item, 'falhou', null, motivos[status] || `resposta ${status || 'desconhecida'}`);
  registrarFalha(`status ${status}`);
}

function textoDoConvite(item, codigo) {
  const link = codigo.startsWith('http') ? codigo : `https://chat.whatsapp.com/${codigo}`;
  const primeiro = String(item.pessoa_nome).trim().split(/\s+/)[0];
  const nome = /^\d+$/.test(primeiro) ? null : primeiro;
  return [
    nome ? `Oi, ${nome}! Tudo bem?` : 'Oi! Tudo bem?',
    '',
    `Você assinou nosso abaixo-assinado e queremos te incluir no grupo *${item.grupo_nome}*, ` +
    'onde a gente organiza as ações e avisa o que está acontecendo.',
    '',
    `Seu WhatsApp não permite que a gente adicione direto, então segue o convite: ${link}`,
    '',
    'Se preferir não participar, é só ignorar esta mensagem 🙏'
  ].join('\n');
}

function marcar(item, situacao, metodo = null, erro = null) {
  db.prepare(`
    UPDATE fila_adicao SET situacao = ?, metodo = ?, erro = ?,
           tentativas = tentativas + 1, processado_em = ?
     WHERE id = ?
  `).run(situacao, metodo, erro, agora(), item.id);
}

function registrarFalha(mensagem) {
  estadoFila.falhasSeguidas++;
  if (estadoFila.falhasSeguidas >= LIMITES.falhasSeguidasParaPausar) {
    pausar(`${estadoFila.falhasSeguidas} falhas seguidas (${mensagem}) — parei sozinho para proteger o número`);
    console.warn(`[adicao] PAUSA AUTOMÁTICA: ${estadoFila.motivoPausa}`);
  }
}

// ------------------------------------------------------------------ leitura
export function resumo(grupoId = null) {
  const onde = grupoId ? 'WHERE grupo_id = ?' : '';
  const p = grupoId ? [grupoId] : [];

  const porSituacao = db.prepare(
    `SELECT situacao, COUNT(*) AS n FROM fila_adicao ${onde} GROUP BY situacao`
  ).all(...p).reduce((acc, r) => ({ ...acc, [r.situacao]: r.n }), {});

  const pendentes = porSituacao.pendente || 0;
  const feitosHoje = contarDesde(24 * 60 * MINUTO);
  const restamHoje = Math.max(0, LIMITES.porDia - feitosHoje);
  const mediaSegundos = (LIMITES.intervaloMin + LIMITES.intervaloMax) / 2;

  // Estimativa realista: respeita o teto diário.
  const hojeAinda = Math.min(pendentes, restamHoje);
  const diasExtras = Math.ceil(Math.max(0, pendentes - restamHoje) / LIMITES.porDia);
  const estimativa = pendentes === 0 ? null
    : diasExtras > 0
      ? `~${diasExtras + 1} dia(s)`
      : `~${Math.max(1, Math.round((hojeAinda * mediaSegundos) / 60))} min`;

  return {
    grupoId,
    porSituacao,
    pendentes,
    adicionados: porSituacao.adicionado || 0,
    convidados: porSituacao.convidado || 0,
    falharam: porSituacao.falhou || 0,
    feitosHoje,
    restamHoje,
    estimativa,
    limites: LIMITES,
    estado: {
      ...estadoFila,
      impedimento: impedimento()
    }
  };
}

export function listarFila({ grupoId = null, situacao = null, limite = 200 } = {}) {
  const onde = [];
  const params = [];
  if (grupoId) { onde.push('f.grupo_id = ?'); params.push(grupoId); }
  if (situacao) { onde.push('f.situacao = ?'); params.push(situacao); }

  return db.prepare(`
    SELECT f.id, f.situacao, f.metodo, f.erro, f.criado_em, f.processado_em,
           f.pessoa_id, f.grupo_id, g.nome AS grupo,
           COALESCE(NULLIF(p.nome,''), p.nome_wa, p.telefone) AS pessoa,
           p.cidade, p.uf, p.telefone
      FROM fila_adicao f
      JOIN grupos g ON g.id = f.grupo_id
      JOIN pessoas p ON p.id = f.pessoa_id
      ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
     ORDER BY CASE f.situacao WHEN 'pendente' THEN 0 ELSE 1 END, f.processado_em DESC, f.id
     LIMIT ?
  `).all(...params, limite);
}

/** Usado pelos testes para rodar um item na hora, sem esperar o relógio. */
export async function processarAgoraParaTeste() {
  estadoFila.proximoEm = null;
  await girar();
  return resumo();
}
