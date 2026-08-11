// Conector do WhatsApp real.
//
// Usa Baileys (WhatsApp Web multi-device): você lê um QR Code com o celular
// que já está nos 5 grupos e o sistema passa a receber todas as mensagens
// desses grupos em tempo real.
//
// Instale quando for plugar de verdade:
//     npm install @whiskeysockets/baileys qrcode
//
//nquanto nã  o instalar, o sistema roda em modo demonstração normalmente.

import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { db, agora, setConfig, campanhaAtual, comCampanha, pastaDeAuth } from './db.js';
import { porCampanha } from './porcampanha.js';
import {
  upsertPessoa, upsertGrupo, vincularMembro,
  registrarMensagem, registrarReacao, registrarEvento,
  registrarAlerta, retratoDaPessoa, formatarTelefone
} from './ingest.js';
import { recomputar } from './scoring.js';
import { analisarMensagem } from './risco.js';
import { analisarSentimento, atualizarConversa } from './conversa.js';
import { registrarExecutor, pausar as pausarFila } from './adicionar-grupo.js';
import { publicarPessoa, publicarGrupo, publicarAlerta, enfileirar, COLECOES } from './firestore.js';

// Cada candidato tem o seu socket, o seu QR e a sua pasta de sessão.
const sessoes = porCampanha(() => ({
  sock: null,
  timerRecalculo: null,
  timerReconexao: null,
  tentativas: 0,
  pessoasTocadas: new Set(),
  estado: {
    status: 'desconectado',   // desconectado | conectando | qr | conectado | erro
    qr: null,
    qrTexto: null,
    qrEm: null,               // quando este QR nasceu — o WhatsApp o expira rápido
    codigo: null,             // código de 8 letras do pareamento por telefone
    codigoPara: null,
    telefone: null,
    erro: null,
    desde: null,
    ultimaMensagem: null,
    recebidas: 0,
    historico: null,
    disponivel: null
  }
}));

const sessao = () => sessoes.atual();

/** Estado do WhatsApp da campanha ativa. */
export const estadoDoWhatsapp = () => sessao().estado;
export const sessoesAtivas = () => sessoes.todas()
  .map(([slug, s]) => ({ slug, status: s.estado.status, telefone: s.estado.telefone }));

const ouvintes = new Set();
export function assinar(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}
function emitir(tipo, dados = {}) {
  const campanha = campanhaAtual();
  for (const fn of ouvintes) {
    try { fn({ tipo, campanha, ...dados }); } catch { /* ouvinte morto */ }
  }
}


let baileys = null;
let gerarQrDataUri = null;

/** Verifica se as dependências opcionais estão instaladas. */
let libDisponivel = null;

export async function checarDependencias() {
  if (libDisponivel !== null) { sessao().estado.disponivel = libDisponivel; return libDisponivel; }
  try {
    baileys = await import('@whiskeysockets/baileys');
    libDisponivel = true;
  } catch {
    libDisponivel = false;
    sessao().estado.disponivel = false;
    return false;
  }
  try {
    const qrcode = await import('qrcode');
    gerarQrDataUri = (texto) => qrcode.default.toDataURL(texto, { margin: 1, width: 320 });
  } catch {
    gerarQrDataUri = null;
  }
  sessao().estado.disponivel = true;
  return true;
}

// Recalcula perfis em lote, no máximo uma vez a cada 20s, e só então publica
// no Firestore quem mudou — evita uma escrita por mensagem recebida.
function agendarRecalculo(pessoaId = null) {
  const s = sessao();
  const slug = campanhaAtual();
  if (pessoaId) s.pessoasTocadas.add(pessoaId);
  if (s.timerRecalculo) return;
  s.timerRecalculo = setTimeout(() => {
    comCampanha(slug, () => {
      s.timerRecalculo = null;
      try {
        recomputar();
        for (const id of s.pessoasTocadas) publicarPessoa(id);
        s.pessoasTocadas.clear();
        emitir('recalculado');
      } catch (erro) {
        console.error(`[whatsapp:${slug}] falha ao recalcular:`, erro.message);
      }
    });
  }, 20_000);
  s.timerRecalculo.unref?.();
}

const soDigitos = (jid) => String(jid || '').split('@')[0].split(':')[0];

function normalizarJid(jid) {
  if (!jid) return null;
  const bruto = String(jid);

  // @lid é o identificador interno de quem esconde o número. Convertê-lo em
  // "@s.whatsapp.net" cria uma pessoa-fantasma com telefone de 15 dígitos:
  // aparece na contagem, suja a classificação e não dá para mandar mensagem.
  // Esta guarda fica aqui, na base, para valer em todos os pontos de entrada.
  if (bruto.endsWith('@lid')) return null;

  const id = soDigitos(bruto);
  if (!/^\d{10,15}$/.test(id)) return null;
  // Nenhum telefone real do WhatsApp passa de 14 dígitos; acima disso é LID
  // que chegou sem o sufixo.
  if (id.length > 14) return null;
  return `${id}@s.whatsapp.net`;
}

/**
 * No Baileys 7 o participante de grupo é um objeto (Contact) e o `id` pode vir
 * em formato LID (@lid), que não é telefone. O número real vem em `phoneNumber`.
 * Esta função aceita as duas formas — objeto ou string — e devolve sempre o
 * JID de telefone, ou null quando o número não é resolvível.
 */
function jidDeParticipante(bruto) {
  if (!bruto) return null;
  if (typeof bruto === 'string') {
    // Um LID nunca é telefone: aceitá-lo cria uma pessoa fantasma na base,
    // com um "número" de 15 dígitos para o qual é impossível mandar mensagem.
    return bruto.endsWith('@lid') ? null : normalizarJid(bruto);
  }
  const candidatos = [bruto.phoneNumber, bruto.jid, bruto.id]
    .filter((c) => c && !String(c).endsWith('@lid'));
  for (const candidato of candidatos) {
    const jid = normalizarJid(candidato);
    if (jid) return jid;
  }
  return null;
}

const nomeDeParticipante = (bruto) =>
  (typeof bruto === 'object' ? (bruto.notify || bruto.name || null) : null);

function extrairConteudo(mensagem) {
  const m = mensagem?.message;
  if (!m) return null;
  const interno = m.ephemeralMessage?.message || m.viewOnceMessage?.message
    || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;

  if (interno.reactionMessage) {
    return { reacao: { alvo: interno.reactionMessage.key?.id, emoji: interno.reactionMessage.text } };
  }
  if (interno.conversation) return { tipo: 'texto', texto: interno.conversation };
  if (interno.extendedTextMessage) {
    return {
      tipo: 'texto',
      texto: interno.extendedTextMessage.text,
      citou: interno.extendedTextMessage.contextInfo?.stanzaId || null
    };
  }
  if (interno.imageMessage) return { tipo: 'imagem', texto: interno.imageMessage.caption || null };
  if (interno.videoMessage) return { tipo: 'video', texto: interno.videoMessage.caption || null };
  if (interno.audioMessage) return { tipo: 'audio', texto: null };
  if (interno.documentMessage) return { tipo: 'documento', texto: interno.documentMessage.fileName || null };
  if (interno.stickerMessage) return { tipo: 'sticker', texto: null };
  if (interno.pollCreationMessage || interno.pollCreationMessageV3) {
    const p = interno.pollCreationMessage || interno.pollCreationMessageV3;
    return { tipo: 'enquete', texto: p.name || null };
  }
  return null;
}

function grupoConhecido(jid) {
  return db.prepare('SELECT id, nome FROM grupos WHERE wa_jid = ?').get(jid);
}

async function sincronizarGrupos() {
  if (!sessao().sock) return [];
  const todos = await sessao().sock.groupFetchAllParticipating();
  const resumo = [];

  for (const meta of Object.values(todos)) {
    const grupoId = upsertGrupo({
      jid: meta.id,
      nome: meta.subject,
      descricao: meta.desc || null,
      criadoEm: meta.creation ? meta.creation * 1000 : agora()
    });

    let novos = 0;
    let semNumero = 0;
    const vistos = new Set();

    for (const participante of meta.participants || []) {
      const jid = jidDeParticipante(participante);
      if (!jid) { semNumero++; continue; }
      vistos.add(jid);
      const pessoaId = upsertPessoa({
        jid,
        nomeWa: nomeDeParticipante(participante),
        origem: 'grupo'
      });
      const entrou = vincularMembro({
        pessoaId,
        grupoId,
        entrouEm: agora(),
        admin: participante.admin != null || participante.isAdmin === true,
        nomeGrupo: meta.subject
      });
      if (entrou) novos++;
      publicarPessoa(pessoaId);
    }

    // Quem estava na base e não veio mais na lista saiu enquanto estávamos offline.
    const sumiram = db.prepare(`
      SELECT m.pessoa_id, p.wa_jid FROM membros m
        JOIN pessoas p ON p.id = m.pessoa_id
       WHERE m.grupo_id = ? AND m.saiu_em IS NULL
    `).all(grupoId).filter((m) => !vistos.has(m.wa_jid));

    for (const ausente of sumiram) {
      marcarSaida({
        pessoaId: ausente.pessoa_id,
        grupoId,
        nomeGrupo: meta.subject,
        motivo: 'ausente_na_sincronizacao'
      });
    }

    publicarGrupo(grupoId);
    resumo.push({
      nome: meta.subject,
      membros: meta.participants?.length || 0,
      novos,
      saidas: sumiram.length,
      semNumero
    });
  }

  recomputar();
  emitir('grupos_sincronizados', { grupos: resumo });
  return resumo;
}

// ---------------------------------------------------------------------------
// Saída de grupo: o evento que a equipe precisa ver na hora.
// ---------------------------------------------------------------------------
const MOTIVOS = {
  saiu: 'saiu por conta própria',
  removido: 'foi removida por um administrador',
  ausente_na_sincronizacao: 'não está mais no grupo (detectado na sincronização)'
};

function marcarSaida({ pessoaId, grupoId, nomeGrupo, motivo = 'saiu', porQuem = null, ts = agora() }) {
  const ja = db.prepare(
    'SELECT saiu_em FROM membros WHERE pessoa_id = ? AND grupo_id = ?'
  ).get(pessoaId, grupoId);
  if (!ja || ja.saiu_em) return null;      // não estava no grupo, ou já registramos

  db.prepare('UPDATE membros SET saiu_em = ? WHERE pessoa_id = ? AND grupo_id = ?')
    .run(ts, pessoaId, grupoId);

  const retrato = retratoDaPessoa(pessoaId) || {};
  const removida = motivo === 'removido';

  // Perder quem participa e assinou dói mais do que perder quem nunca falou.
  const relevante = (retrato.engajamento ?? 0) >= 38
    || (retrato.assinou?.length ?? 0) > 0
    || retrato.cadastrado;
  const gravidade = relevante ? 'critico' : 'aviso';

  const detalhes = [
    retrato.classificacao ? `${retrato.classificacao} (${retrato.engajamento}/100)` : null,
    retrato.mensagens ? `${retrato.mensagens} mensagens` : 'nunca escreveu',
    retrato.cidade ? `${retrato.cidade}${retrato.uf ? `/${retrato.uf}` : ''}` : null,
    retrato.assinou?.length ? `assinou ${retrato.assinou.length} abaixo-assinado(s)` : null,
    retrato.aindaEstaEm?.length
      ? `continua em ${retrato.aindaEstaEm.length} outro(s) grupo(s)`
      : 'saiu de TODOS os grupos'
  ].filter(Boolean).join(' · ');

  const alertaId = registrarAlerta({
    tipo: removida ? 'removido_grupo' : 'saiu_grupo',
    gravidade,
    pessoaId,
    grupoId,
    titulo: `${retrato.nome || 'Alguém'} ${MOTIVOS[motivo] || 'saiu'} — ${nomeGrupo}`,
    detalhe: detalhes,
    dados: { ...retrato, motivo, porQuem, grupo: nomeGrupo },
    ts
  });

  registrarEvento({
    pessoaId,
    tipo: 'saiu_grupo',
    descricao: `Saiu do grupo ${nomeGrupo} (${MOTIVOS[motivo] || motivo})`,
    ts
  });

  publicarAlerta(alertaId);
  publicarPessoa(pessoaId);

  const alerta = db.prepare('SELECT * FROM alertas WHERE id = ?').get(alertaId);
  emitir('alerta', {
    alerta: {
      id: alertaId, tipo: alerta.tipo, gravidade, titulo: alerta.titulo,
      detalhe: detalhes, ts
    }
  });

  avisarEquipe(alerta).catch((erro) => console.error('[whatsapp] aviso não enviado:', erro.message));

  console.log(`[whatsapp] ⚠ ${alerta.titulo}`);
  return alertaId;
}

/**
 * Repassa o alerta por WhatsApp para o número da equipe, se configurado
 * em ALERTA_WHATSAPP (ex.: ALERTA_WHATSAPP=5519999998888).
 */
async function avisarEquipe(alerta) {
  const destino = process.env.ALERTA_WHATSAPP;
  if (!destino || !sessao().sock) return;
  const jid = `${String(destino).replace(/\D/g, '')}@s.whatsapp.net`;
  const icone = alerta.gravidade === 'critico' ? '🚨' : '⚠️';
  await sessao().sock.sendMessage(jid, {
    text: `${icone} *Rede de Apoio*\n\n${alerta.titulo}\n\n${alerta.detalhe || ''}`.trim()
  });
}

function processarMensagem(mensagem) {
  const remoto = mensagem.key?.remoteJid;
  if (!remoto) return;
  if (remoto === 'status@broadcast') return;            // stories, não interessa

  if (remoto.endsWith('@g.us')) return processarMensagemDeGrupo(mensagem, remoto);
  return processarMensagemPrivada(mensagem, remoto);
}

// ---------------------------------------------------------------------------
// Conversa 1:1 — o apoiador chamando no privado.
// ---------------------------------------------------------------------------
function processarMensagemPrivada(mensagem, remoto) {
  const outroLado = normalizarJid(mensagem.key.remoteJidAlt || remoto);
  if (!outroLado) return;                               // @lid sem número, newsletter etc.
  if (outroLado === normalizarJid(sessao().estado.telefone)) return;   // conversa comigo mesmo

  const conteudo = extrairConteudo(mensagem);
  if (!conteudo || conteudo.reacao) return;

  const ts = Number(mensagem.messageTimestamp) * 1000 || agora();
  const deMim = Boolean(mensagem.key.fromMe);

  const pessoaId = upsertPessoa({
    jid: outroLado,
    nomeWa: deMim ? null : (mensagem.pushName || null),
    ts
  });

  const primeiraVez = db.prepare(
    'SELECT COUNT(*) AS n FROM mensagens WHERE pessoa_id = ? AND privada = 1'
  ).get(pessoaId).n === 0;

  const sentimento = conteudo.texto && !deMim ? analisarSentimento(conteudo.texto) : null;

  const id = registrarMensagem({
    waId: mensagem.key.id,
    grupoId: null,
    pessoaId,
    tipo: conteudo.tipo,
    texto: conteudo.texto,
    ts,
    deMim,
    privada: true,
    sentimento
  });
  if (!id) return;                                      // já tínhamos essa mensagem

  atualizarConversa(pessoaId);
  sessao().estado.recebidas++;
  emitir('privada', {
    pessoaId,
    deMim,
    ts,
    sentimento,
    previa: (conteudo.texto || conteudo.tipo).slice(0, 80)
  });

  if (!deMim && conteudo.texto) {
    // Atrito no privado é ainda mais sério: é a pessoa falando direto com a campanha.
    avaliarAtrito({ pessoaId, grupo: { id: null, nome: 'conversa privada' }, texto: conteudo.texto, ts });

    if (primeiraVez) {
      const retrato = retratoDaPessoa(pessoaId) || {};
      const alertaId = registrarAlerta({
        tipo: 'nova_conversa',
        gravidade: sentimento === 'critico' ? 'critico' : 'info',
        pessoaId,
        titulo: `${retrato.nome || 'Alguém'} chamou no privado pela primeira vez`,
        detalhe: `“${conteudo.texto.slice(0, 160)}”`,
        dados: { ...retrato, sentimento, mensagem: conteudo.texto },
        ts
      });
      publicarAlerta(alertaId);
      emitir('alerta', {
        alerta: {
          id: alertaId, tipo: 'nova_conversa', gravidade: 'info',
          titulo: `${retrato.nome || 'Alguém'} chamou no privado`,
          detalhe: conteudo.texto.slice(0, 120), ts
        }
      });
    }
  }

  agendarRecalculo(pessoaId);
}

// ---------------------------------------------------------------------------
// Mensagem de grupo.
// ---------------------------------------------------------------------------
function processarMensagemDeGrupo(mensagem, remoto) {
  const grupo = grupoConhecido(remoto);
  if (!grupo) return;                                   // grupo ainda não sincronizado

  const autorBruto = mensagem.key.participantAlt || mensagem.key.participant || mensagem.participant;
  const autor = normalizarJid(autorBruto);
  if (!autor) return;

  const ts = Number(mensagem.messageTimestamp) * 1000 || agora();
  const conteudo = extrairConteudo(mensagem);
  if (!conteudo) return;

  const pessoaId = upsertPessoa({ jid: autor, nomeWa: mensagem.pushName || null, ts });

  if (conteudo.reacao) {
    const alvo = db.prepare('SELECT id FROM mensagens WHERE wa_id = ?').get(conteudo.reacao.alvo);
    if (alvo && conteudo.reacao.emoji) {
      registrarReacao({ mensagemId: alvo.id, pessoaId, emoji: conteudo.reacao.emoji, ts });
    }
    agendarRecalculo(pessoaId);
    return;
  }

  let respondeA = null;
  if (conteudo.citou) {
    const citada = db.prepare('SELECT id FROM mensagens WHERE wa_id = ?').get(conteudo.citou);
    respondeA = citada?.id ?? null;
  }

  registrarMensagem({
    waId: mensagem.key.id,
    grupoId: grupo.id,
    pessoaId,
    tipo: conteudo.tipo,
    texto: conteudo.texto,
    respondeA,
    ts,
    deMim: Boolean(mensagem.key.fromMe),
    sentimento: conteudo.texto ? analisarSentimento(conteudo.texto) : null
  });

  // Espelho do histórico bruto no Firestore — opcional, desligado por padrão
  // (volume alto). Ligue com FIRESTORE_ESPELHAR_MENSAGENS=true.
  enfileirar(COLECOES.mensagens, mensagem.key.id, {
    grupo: grupo.nome,
    grupoJid: remoto,
    telefone: soDigitos(autor),
    tipo: conteudo.tipo,
    texto: conteudo.texto,
    em: new Date(ts)
  });

  sessao().estado.recebidas++;
  sessao().estado.ultimaMensagem = { grupo: grupo.nome, ts, previa: (conteudo.texto || conteudo.tipo).slice(0, 60) };
  emitir('mensagem', sessao().estado.ultimaMensagem);

  // Atrito é urgente: não pode esperar o recálculo em lote de 20s.
  // Mensagem enviada pela própria campanha não vira alerta.
  if (conteudo.texto && !mensagem.key.fromMe) {
    avaliarAtrito({ pessoaId, grupo, texto: conteudo.texto, ts });
  }

  agendarRecalculo(pessoaId);
}

/** Roda o detector de risco e dispara o alerta na hora. */
function avaliarAtrito({ pessoaId, grupo, texto, ts }) {
  let resultado;
  try {
    resultado = analisarMensagem({
      pessoaId, grupoId: grupo.id, nomeGrupo: grupo.nome, texto, ts
    });
  } catch (erro) {
    console.error('[whatsapp] erro ao analisar atrito:', erro.message);
    return;
  }
  if (!resultado) return;

  const { alertaId, conflitoId, risco, quem, contexto } = resultado;

  publicarAlerta(alertaId);
  if (conflitoId) publicarAlerta(conflitoId);

  for (const id of [alertaId, conflitoId].filter(Boolean)) {
    const a = db.prepare('SELECT * FROM alertas WHERE id = ?').get(id);
    emitir('alerta', {
      alerta: {
        id, tipo: a.tipo, gravidade: a.gravidade, titulo: a.titulo,
        detalhe: a.detalhe, acao: risco.acao, ts: a.ts
      }
    });
  }

  console.log(`[whatsapp] ${risco.icone} ${risco.rotulo}: ${quem} em "${grupo.nome}"`);
  console.log(`           → ${risco.acao}`);

  avisarEquipeSobreAtrito({ risco, quem, grupo, texto, contexto })
    .catch((erro) => console.error('[whatsapp] aviso não enviado:', erro.message));
}

async function avisarEquipeSobreAtrito({ risco, quem, grupo, texto, contexto }) {
  const destino = process.env.ALERTA_WHATSAPP;
  if (!destino || !sessao().sock) return;
  const jid = `${String(destino).replace(/\D/g, '')}@s.whatsapp.net`;
  await sessao().sock.sendMessage(jid, {
    text: [
      `${risco.icone} *${risco.rotulo}*`,
      `_${grupo.nome}_`,
      '',
      `*${quem}*${contexto ? ` — ${contexto}` : ''}`,
      `"${String(texto).trim().slice(0, 200)}"`,
      '',
      `👉 ${risco.acao}`
    ].join('\n')
  });
}

function processarParticipantes({ id, participants, action, author }) {
  const grupo = grupoConhecido(id);
  if (!grupo) return;

  const autorJid = jidDeParticipante(author);

  for (const bruto of participants) {
    const jid = jidDeParticipante(bruto);
    if (!jid) continue;
    const pessoaId = upsertPessoa({ jid, nomeWa: nomeDeParticipante(bruto) });

    if (action === 'add') {
      const novo = vincularMembro({
        pessoaId, grupoId: grupo.id, entrouEm: agora(), nomeGrupo: grupo.nome
      });
      // Reentrada: quem tinha saído e voltou.
      db.prepare('UPDATE membros SET saiu_em = NULL WHERE pessoa_id = ? AND grupo_id = ?')
        .run(pessoaId, grupo.id);
      if (novo) {
        const alertaId = registrarAlerta({
          tipo: 'entrou_grupo',
          gravidade: 'info',
          pessoaId,
          grupoId: grupo.id,
          titulo: `Entrou no grupo ${grupo.nome}`,
          detalhe: formatarTelefone(jid.split('@')[0]),
          dados: retratoDaPessoa(pessoaId)
        });
        publicarAlerta(alertaId);
      }
      publicarPessoa(pessoaId);
    } else if (action === 'remove') {
      // Se quem executou é a própria pessoa, ela saiu; senão, foi removida.
      const saiuSozinha = !autorJid || autorJid === jid;
      marcarSaida({
        pessoaId,
        grupoId: grupo.id,
        nomeGrupo: grupo.nome,
        motivo: saiuSozinha ? 'saiu' : 'removido',
        porQuem: saiuSozinha ? null : formatarTelefone(autorJid.split('@')[0])
      });
    } else if (action === 'promote' || action === 'demote') {
      db.prepare('UPDATE membros SET admin = ? WHERE pessoa_id = ? AND grupo_id = ?')
        .run(action === 'promote' ? 1 : 0, pessoaId, grupo.id);
      publicarPessoa(pessoaId);
    }
  }

  publicarGrupo(grupo.id);
  emitir('membros_alterados', { grupo: grupo.nome, action });
  agendarRecalculo();
}

/**
 * Injeta um evento no mesmo formato que o Baileys entrega.
 * Serve para testar o fluxo de alerta (entrada/saída de grupo) sem precisar
 * mexer num grupo real — veja src/teste-alertas.js.
 */
export function simularEventoDeGrupo(evento) {
  return processarParticipantes(evento);
}

export async function conectar({ parearCom = null } = {}) {
  // O slug é capturado agora: os callbacks do Baileys chegam fora do contexto
  // do AsyncLocalStorage e precisam ser reancorados na campanha certa.
  const slug = campanhaAtual();
  const aqui = (fn) => (...args) => comCampanha(slug, () => fn(...args));

  const ok = await checarDependencias();
  if (!ok) {
    sessao().estado.status = 'erro';
    sessao().estado.erro = 'Baileys não instalado. Rode: npm install @whiskeysockets/baileys qrcode';
    emitir('status');
    return sessao().estado;
  }
  if (sessao().sock) return sessao().estado;

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

  mkdirSync(pastaDeAuth(campanhaAtual()), { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(pastaDeAuth(campanhaAtual()));
  const { version } = await fetchLatestBaileysVersion();

  sessao().estado.status = 'conectando';
  sessao().estado.erro = null;
  emitir('status');

  // Espelhar o histórico existente é opcional: num número novo da campanha vale
  // muito a pena; num número com anos de conversa, é despejo de dado alheio.
  const espelharHistorico = process.env.SINCRONIZAR_HISTORICO === 'true';

  sessao().sock = makeWASocket({
    version,
    auth: state,
    syncFullHistory: espelharHistorico,
    shouldSyncHistoryMessage: () => espelharHistorico,
    markOnlineOnConnect: false,              // não rouba as notificações do celular
    browser: ['Rede de Apoio', 'Chrome', '1.0.0'],

    // Ping a cada 25s. Sem isso, provedores e proxies derrubam a conexão
    // ociosa por inatividade e o sistema só percebe quando chega mensagem.
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    retryRequestDelayMs: 1_000,

    // O QR do WhatsApp vale pouco tempo. Com o padrão baixo, quem está longe do
    // computador — a candidata pegando o celular, destravando, achando o menu —
    // escaneia um código já vencido e recebe "Verifique sua conexão e tente
    // novamente", que culpa a internet por um problema de prazo.
    qrTimeout: 90_000
  });

  // Pareamento por telefone: em vez de escanear, a pessoa digita um código de
  // 8 letras no próprio WhatsApp. Resolve o caso de quem não consegue apontar a
  // câmera para a tela — celular longe, tela pequena, ou a candidata em casa
  // enquanto o painel está aqui.
  //
  // Só vale para número ainda não pareado, e precisa de um instante depois do
  // socket subir para o servidor aceitar o pedido.
  if (parearCom && !state.creds.registered) {
    const numero = String(parearCom).replace(/\D/g, '');
    setTimeout(aqui(async () => {
      try {
        const codigo = await sessao().sock.requestPairingCode(numero);
        sessao().estado.codigo = codigo;
        sessao().estado.codigoPara = numero;
        sessao().estado.status = 'qr';
        console.log(`[whatsapp:${slug}] código de pareamento para ${numero}: ${codigo}`);
        emitir('status');
      } catch (erro) {
        sessao().estado.erro = `Não deu para gerar o código: ${erro.message}`;
        emitir('status');
      }
    }), 3_000);
  }

  // A agenda do celular. Vem em lote no pareamento (`contacts.set`) e depois
  // aos poucos (`contacts.upsert`). Cada contato vira uma pessoa com origem
  // 'contato' — matéria-prima da classificação de propensão a apoiar.
  const guardarContatos = (contatos = []) => {
    let novos = 0;
    for (const contato of contatos) {
      const jid = jidDeParticipante(contato);
      if (!jid) continue;
      // O `name` só existe quando a pessoa está salva na agenda; `notify` é o
      // nome que ela mesma pôs no perfil e não indica vínculo nenhum.
      const nomeAgenda = contato.name || null;
      const pessoaId = upsertPessoa({
        jid,
        nomeWa: nomeAgenda || contato.notify || contato.verifiedName || null,
        origem: 'contato'
      });
      const r = db.prepare(`
        UPDATE pessoas SET na_agenda = ?, nome_agenda = COALESCE(?, nome_agenda)
         WHERE id = ? AND (na_agenda <> ? OR nome_agenda IS NULL)
      `).run(nomeAgenda ? 1 : 0, nomeAgenda, pessoaId, nomeAgenda ? 1 : 0);
      if (r.changes) novos++;
    }
    if (novos) {
      const total = db.prepare("SELECT COUNT(*) AS n FROM pessoas WHERE na_agenda = 1").get().n;
      console.log(`[whatsapp:${slug}] agenda: ${novos} contato(s) atualizados (${total} salvos no celular)`);
      emitir('contatos', { atualizados: novos, naAgenda: total });
      agendarRecalculo();
    }
  };

  if (espelharHistorico) {
    sessao().sock.ev.on('messaging-history.set', aqui(({ messages = [], contacts = [], progress, isLatest }) => {
      guardarContatos(contacts);
      const antes = db.prepare('SELECT COUNT(*) AS n FROM mensagens').get().n;
      for (const antiga of messages) {
        try { processarMensagem(antiga); } catch { /* mensagem antiga em formato estranho */ }
      }
      const importadas = db.prepare('SELECT COUNT(*) AS n FROM mensagens').get().n - antes;
      sessao().estado.historico = { progresso: progress ?? null, concluido: Boolean(isLatest) };
      console.log(`[whatsapp:${slug}] histórico: +${importadas} mensagens${progress != null ? ` (${progress}%)` : ''}`);
      emitir('historico', sessao().estado.historico);
      agendarRecalculo();
    }));
  }

  sessao().sock.ev.on('contacts.set', aqui(({ contacts }) => guardarContatos(contacts)));
  sessao().sock.ev.on('contacts.upsert', aqui((contatos) => guardarContatos(contatos)));
  sessao().sock.ev.on('contacts.update', aqui((contatos) => guardarContatos(contatos)));

  sessao().sock.ev.on('creds.update', saveCreds);   // não toca no banco, dispensa contexto

  sessao().sock.ev.on('connection.update', aqui(async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessao().estado.status = 'qr';
      sessao().estado.qrTexto = qr;
      sessao().estado.qr = gerarQrDataUri ? await gerarQrDataUri(qr) : null;
      sessao().estado.qrEm = Date.now();
      console.log(`\n[whatsapp:${slug}] QR gerado — abra o painel para escanear.`);
      emitir('status');
    }

    if (connection === 'open') {
      // A fila de adição só funciona com o socket vivo.
      registrarExecutor({
        adicionar: async (grupoJid, pessoaJid) => {
          const [r] = await sessao().sock.groupParticipantsUpdate(grupoJid, [pessoaJid], 'add');
          return r;
        },
        obterConvite: async (grupoJid) => {
          try { return await sessao().sock.groupInviteCode(grupoJid); } catch { return null; }
        },
        enviarMensagem: (jid, texto) => enviarMensagem(jid, texto)
      });

      sessao().tentativas = 0;
      clearTimeout(sessao().timerReconexao);
      sessao().estado.reconectandoEm = null;
      sessao().estado.status = 'conectado';
      sessao().estado.qr = null;
      sessao().estado.qrTexto = null;
      sessao().estado.qrEm = null;
      sessao().estado.codigo = null;
      sessao().estado.codigoPara = null;
      sessao().estado.desde = agora();
      sessao().estado.telefone = soDigitos(sessao().sock.user?.id);
      setConfig('whatsapp_telefone', sessao().estado.telefone);
      console.log(`[whatsapp:${slug}] conectado como ${sessao().estado.telefone}`);
      emitir('status');
      try {
        await sincronizarGrupos();
      } catch (erro) {
        console.error(`[whatsapp:${slug}] erro ao sincronizar grupos:`, erro.message);
      }
    }

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const s = sessao();
      s.sock = null;
      registrarExecutor(null);

      // Só estes dois casos exigem ler o QR de novo. Todo o resto é queda
      // temporária — reconectar sozinho é o comportamento certo.
      const precisaNovoQr = codigo === DisconnectReason.loggedOut
        || codigo === DisconnectReason.badSession;

      if (precisaNovoQr) {
        s.tentativas = 0;
        s.estado.status = 'desconectado';
        s.estado.erro = codigo === DisconnectReason.loggedOut
          ? 'Sessão encerrada no celular. Escaneie o QR de novo.'
          : 'Sessão corrompida. Desconecte apagando a sessão e escaneie o QR de novo.';
        console.warn(`[whatsapp:${slug}] ${s.estado.erro}`);
        emitir('status');
        return;
      }

      // Queda durante a adição costuma ser sinal de limite do WhatsApp.
      pausarFila('a conexão caiu durante a adição — volta sozinho ao reconectar');

      s.tentativas = (s.tentativas || 0) + 1;
      // Espera crescente com teto de 5 min: 5s, 10s, 20s, 40s… nunca desiste.
      const espera = Math.min(5 * 60_000, 5000 * 2 ** Math.min(s.tentativas - 1, 6));

      s.estado.status = 'conectando';
      s.estado.erro = null;
      s.estado.reconectandoEm = agora() + espera;
      s.estado.tentativas = s.tentativas;
      emitir('status');

      console.log(`[whatsapp:${slug}] caiu (código ${codigo ?? '?'}), ` +
        `tentativa ${s.tentativas} em ${Math.round(espera / 1000)}s`);

      clearTimeout(s.timerReconexao);
      s.timerReconexao = setTimeout(
        () => comCampanha(slug, () => conectar().catch(() => {})), espera
      );
      s.timerReconexao.unref?.();
    }
  }));

  sessao().sock.ev.on('messages.upsert', aqui(({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const mensagem of messages) {
      try { processarMensagem(mensagem); } catch (erro) {
        console.error(`[whatsapp:${slug}] erro ao processar mensagem:`, erro.message);
      }
    }
  }));

  sessao().sock.ev.on('group-participants.update', aqui((evento) => {
    try { processarParticipantes(evento); } catch (erro) {
      console.error(`[whatsapp:${slug}] erro em participantes:`, erro.message);
    }
  }));

  return sessao().estado;
}

export async function desconectar({ apagarSessao = false } = {}) {
  if (sessao().sock) {
    try { await sessao().sock.logout(); } catch { /* já caiu */ }
    sessao().sock = null;
  }
  if (apagarSessao && existsSync(pastaDeAuth(campanhaAtual()))) rmSync(pastaDeAuth(campanhaAtual()), { recursive: true, force: true });
  sessao().estado.status = 'desconectado';
  sessao().estado.qr = null;
  sessao().estado.telefone = null;
  registrarExecutor(null);
  emitir('status');
  return sessao().estado;
}

export async function ressincronizar() {
  if (!sessao().sock) throw new Error('WhatsApp não está conectado');
  return sincronizarGrupos();
}

/** Resposta enviada pelo painel — cai na mesma conversa do WhatsApp da pessoa. */
export async function enviarMensagem(jid, texto) {
  if (!sessao().sock) throw new Error('WhatsApp não está conectado');
  if (!texto?.trim()) throw new Error('Mensagem vazia');

  const enviada = await sessao().sock.sendMessage(jid, { text: texto.trim() });
  const ts = agora();

  // Resposta num grupo: grava na timeline do grupo, sem dono.
  if (jid.endsWith('@g.us')) {
    const grupo = grupoConhecido(jid);
    if (grupo) {
      const eu = db.prepare('SELECT id FROM pessoas WHERE wa_jid = ?')
        .get(normalizarJid(sessao().estado.telefone) ?? '');
      registrarMensagem({
        waId: enviada?.key?.id ?? `painel-${ts}`,
        grupoId: grupo.id,
        pessoaId: eu?.id ?? null,
        tipo: 'texto',
        texto: texto.trim(),
        ts,
        deMim: true
      });
      emitir('mensagem', { grupo: grupo.nome, ts, previa: texto.slice(0, 60) });
    }
    return true;
  }

  const pessoa = db.prepare('SELECT id FROM pessoas WHERE wa_jid = ?').get(jid);

  if (pessoa) {
    // Grava já: o eco do próprio WhatsApp chega depois e é ignorado pelo wa_id.
    registrarMensagem({
      waId: enviada?.key?.id ?? `painel-${ts}`,
      grupoId: null,
      pessoaId: pessoa.id,
      tipo: 'texto',
      texto: texto.trim(),
      ts,
      deMim: true,
      privada: true,
      lida: true
    });
    // Responder zera as não lidas daquela conversa.
    db.prepare('UPDATE mensagens SET lida = 1 WHERE pessoa_id = ? AND privada = 1 AND lida = 0')
      .run(pessoa.id);
    registrarEvento({
      pessoaId: pessoa.id,
      tipo: 'contato_equipe',
      descricao: `Resposta enviada pelo painel: "${texto.slice(0, 80)}"`
    });
    atualizarConversa(pessoa.id);
    publicarPessoa(pessoa.id);
    emitir('privada', { pessoaId: pessoa.id, deMim: true, ts, previa: texto.slice(0, 80) });
  }
  return true;
}

/** Reconecta sozinho se já existir sessão salva de uma execução anterior. */
export async function autoConectar() {
  const slug = campanhaAtual();
  if (!existsSync(join(pastaDeAuth(slug), 'creds.json'))) return false;
  if (!(await checarDependencias())) return false;
  console.log(`[whatsapp:${slug}] sessão encontrada, reconectando…`);
  await conectar();
  return true;
}

/** Sobe as conexões de todas as campanhas que já têm pareamento salvo. */
export async function autoConectarTodas(slugs) {
  const resultados = [];
  for (const slug of slugs) {
    try {
      const ligou = await comCampanha(slug, () => autoConectar());
      resultados.push({ slug, ligou });
    } catch (erro) {
      resultados.push({ slug, ligou: false, erro: erro.message });
    }
  }
  vigiar(slugs);
  return resultados;
}

/**
 * Vigia de reconexão.
 *
 * O `connection.update` do Baileys resolve 99% das quedas. O 1% restante é o que
 * derruba produção: evento perdido, socket em estado zumbi, container hibernado
 * pelo provedor e acordado depois. Este laço roda a cada minuto e religa quem
 * tem sessão salva no disco mas não está conectado.
 */
let vigia = null;

export function vigiar(slugs) {
  if (vigia) clearInterval(vigia);

  vigia = setInterval(() => {
    for (const slug of slugs) {
      comCampanha(slug, () => {
        const s = sessoes.de(slug);

        // Já conectado, ou já tem religamento agendado: nada a fazer.
        if (s.sock || s.estado.status === 'qr') return;
        if (s.estado.reconectandoEm && agora() < s.estado.reconectandoEm) return;

        // Sem credencial salva não adianta: precisa de QR humano.
        if (!existsSync(join(pastaDeAuth(slug), 'creds.json'))) return;

        console.log(`[whatsapp:${slug}] vigia detectou queda silenciosa, religando…`);
        conectar().catch((erro) =>
          console.error(`[whatsapp:${slug}] vigia falhou:`, erro.message));
      });
    }
  }, 60_000);

  vigia.unref?.();
  return vigia;
}

/** Encerra tudo com elegância — o Render manda SIGTERM antes de cada deploy. */
export async function encerrarTudo() {
  if (vigia) clearInterval(vigia);
  for (const [slug, s] of sessoes.todas()) {
    clearTimeout(s.timerReconexao);
    clearTimeout(s.timerRecalculo);
    if (!s.sock) continue;
    try {
      // `end` fecha o socket SEM deslogar: a sessão no disco continua válida
      // e a próxima subida reconecta sozinha. `logout()` apagaria o pareamento.
      s.sock.end(undefined);
      console.log(`[whatsapp:${slug}] socket encerrado, sessão preservada`);
    } catch { /* já estava caído */ }
  }
}
