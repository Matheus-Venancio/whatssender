// Conector do WhatsApp real.
//
// Usa Baileys (WhatsApp Web multi-device): você lê um QR Code com o celular
// que já está nos 5 grupos e o sistema passa a receber todas as mensagens
// desses grupos em tempo real.
//
// Instale quando for plugar de verdade:
//     npm install @whiskeysockets/baileys qrcode
//
// Enquanto não instalar, o sistema roda em modo demonstração normalmente.

import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { db, PASTA_DADOS, agora, setConfig } from './db.js';
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

const PASTA_AUTH = join(PASTA_DADOS, 'auth');

export const estado = {
  status: 'desconectado',   // desconectado | conectando | qr | conectado | erro
  qr: null,                 // data URI do QR Code
  qrTexto: null,
  telefone: null,
  erro: null,
  desde: null,
  ultimaMensagem: null,
  recebidas: 0,
  disponivel: null          // null = ainda não checado
};

const ouvintes = new Set();
export function assinar(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}
function emitir(tipo, dados = {}) {
  for (const fn of ouvintes) {
    try { fn({ tipo, ...dados }); } catch { /* ouvinte morto */ }
  }
}

let sock = null;
let baileys = null;
let gerarQrDataUri = null;
let timerRecalculo = null;

/** Verifica se as dependências opcionais estão instaladas. */
export async function checarDependencias() {
  if (estado.disponivel !== null) return estado.disponivel;
  try {
    baileys = await import('@whiskeysockets/baileys');
    estado.disponivel = true;
  } catch {
    estado.disponivel = false;
    return false;
  }
  try {
    const qrcode = await import('qrcode');
    gerarQrDataUri = (texto) => qrcode.default.toDataURL(texto, { margin: 1, width: 320 });
  } catch {
    gerarQrDataUri = null;
  }
  return true;
}

// Recalcula perfis em lote, no máximo uma vez a cada 20s, e só então publica
// no Firestore quem mudou — evita uma escrita por mensagem recebida.
const pessoasTocadas = new Set();

function agendarRecalculo(pessoaId = null) {
  if (pessoaId) pessoasTocadas.add(pessoaId);
  if (timerRecalculo) return;
  timerRecalculo = setTimeout(() => {
    timerRecalculo = null;
    try {
      recomputar();
      for (const id of pessoasTocadas) publicarPessoa(id);
      pessoasTocadas.clear();
      emitir('recalculado');
    } catch (erro) {
      console.error('[whatsapp] falha ao recalcular:', erro.message);
    }
  }, 20_000);
  timerRecalculo.unref?.();
}

const soDigitos = (jid) => String(jid || '').split('@')[0].split(':')[0];

function normalizarJid(jid) {
  if (!jid) return null;
  const id = soDigitos(jid);
  if (!/^\d{10,15}$/.test(id)) return null;   // ignora @lid sem número resolvido
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
  if (typeof bruto === 'string') return normalizarJid(bruto);
  return normalizarJid(bruto.phoneNumber)
    ?? normalizarJid(bruto.jid)
    ?? normalizarJid(bruto.id)
    ?? normalizarJid(bruto.lid);
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
  if (!sock) return [];
  const todos = await sock.groupFetchAllParticipating();
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
  if (!destino || !sock) return;
  const jid = `${String(destino).replace(/\D/g, '')}@s.whatsapp.net`;
  const icone = alerta.gravidade === 'critico' ? '🚨' : '⚠️';
  await sock.sendMessage(jid, {
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
  if (outroLado === normalizarJid(estado.telefone)) return;   // conversa comigo mesmo

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
  estado.recebidas++;
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

  estado.recebidas++;
  estado.ultimaMensagem = { grupo: grupo.nome, ts, previa: (conteudo.texto || conteudo.tipo).slice(0, 60) };
  emitir('mensagem', estado.ultimaMensagem);

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
  if (!destino || !sock) return;
  const jid = `${String(destino).replace(/\D/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, {
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

export async function conectar() {
  const ok = await checarDependencias();
  if (!ok) {
    estado.status = 'erro';
    estado.erro = 'Baileys não instalado. Rode: npm install @whiskeysockets/baileys qrcode';
    emitir('status');
    return estado;
  }
  if (sock) return estado;

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

  mkdirSync(PASTA_AUTH, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);
  const { version } = await fetchLatestBaileysVersion();

  estado.status = 'conectando';
  estado.erro = null;
  emitir('status');

  // Espelhar o histórico existente é opcional: num número novo da campanha vale
  // muito a pena; num número com anos de conversa, é despejo de dado alheio.
  const espelharHistorico = process.env.SINCRONIZAR_HISTORICO === 'true';

  sock = makeWASocket({
    version,
    auth: state,
    syncFullHistory: espelharHistorico,
    shouldSyncHistoryMessage: () => espelharHistorico,
    markOnlineOnConnect: false,              // não rouba as notificações do celular
    browser: ['Rede de Apoio', 'Chrome', '1.0.0']
  });

  if (espelharHistorico) {
    sock.ev.on('messaging-history.set', ({ messages = [], progress, isLatest }) => {
      const antes = db.prepare('SELECT COUNT(*) AS n FROM mensagens').get().n;
      for (const antiga of messages) {
        try { processarMensagem(antiga); } catch { /* mensagem antiga em formato estranho */ }
      }
      const importadas = db.prepare('SELECT COUNT(*) AS n FROM mensagens').get().n - antes;
      estado.historico = { progresso: progress ?? null, concluido: Boolean(isLatest) };
      console.log(`[whatsapp] histórico: +${importadas} mensagens${progress != null ? ` (${progress}%)` : ''}`);
      emitir('historico', estado.historico);
      agendarRecalculo();
    });
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      estado.status = 'qr';
      estado.qrTexto = qr;
      estado.qr = gerarQrDataUri ? await gerarQrDataUri(qr) : null;
      console.log('\n[whatsapp] QR gerado — abra o painel em /conexao para escanear.');
      emitir('status');
    }

    if (connection === 'open') {
      // A fila de adição só funciona com o socket vivo.
      registrarExecutor({
        adicionar: async (grupoJid, pessoaJid) => {
          const [r] = await sock.groupParticipantsUpdate(grupoJid, [pessoaJid], 'add');
          return r;
        },
        obterConvite: async (grupoJid) => {
          try { return await sock.groupInviteCode(grupoJid); } catch { return null; }
        },
        enviarMensagem: (jid, texto) => enviarMensagem(jid, texto)
      });

      estado.status = 'conectado';
      estado.qr = null;
      estado.qrTexto = null;
      estado.desde = agora();
      estado.telefone = soDigitos(sock.user?.id);
      setConfig('whatsapp_telefone', estado.telefone);
      console.log(`[whatsapp] conectado como ${estado.telefone}`);
      emitir('status');
      try {
        await sincronizarGrupos();
      } catch (erro) {
        console.error('[whatsapp] erro ao sincronizar grupos:', erro.message);
      }
    }

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const deslogado = codigo === DisconnectReason.loggedOut;
      sock = null;
      registrarExecutor(null);
      // Queda durante a adição costuma ser sinal de limite do WhatsApp.
      if (!deslogado) pausarFila('a conexão caiu durante a adição — retome quando reconectar');

      estado.status = deslogado ? 'desconectado' : 'conectando';
      estado.erro = deslogado ? 'Sessão encerrada no celular. Escaneie o QR de novo.' : null;
      emitir('status');
      if (!deslogado) {
        console.log('[whatsapp] conexão caiu, reconectando em 3s…');
        setTimeout(() => conectar().catch(() => {}), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const mensagem of messages) {
      try { processarMensagem(mensagem); } catch (erro) {
        console.error('[whatsapp] erro ao processar mensagem:', erro.message);
      }
    }
  });

  sock.ev.on('group-participants.update', (evento) => {
    try { processarParticipantes(evento); } catch (erro) {
      console.error('[whatsapp] erro em participantes:', erro.message);
    }
  });

  return estado;
}

export async function desconectar({ apagarSessao = false } = {}) {
  if (sock) {
    try { await sock.logout(); } catch { /* já caiu */ }
    sock = null;
  }
  if (apagarSessao && existsSync(PASTA_AUTH)) rmSync(PASTA_AUTH, { recursive: true, force: true });
  estado.status = 'desconectado';
  estado.qr = null;
  estado.telefone = null;
  emitir('status');
  return estado;
}

export async function ressincronizar() {
  if (!sock) throw new Error('WhatsApp não está conectado');
  return sincronizarGrupos();
}

/** Resposta enviada pelo painel — cai na mesma conversa do WhatsApp da pessoa. */
export async function enviarMensagem(jid, texto) {
  if (!sock) throw new Error('WhatsApp não está conectado');
  if (!texto?.trim()) throw new Error('Mensagem vazia');

  const enviada = await sock.sendMessage(jid, { text: texto.trim() });
  const ts = agora();

  // Resposta num grupo: grava na timeline do grupo, sem dono.
  if (jid.endsWith('@g.us')) {
    const grupo = grupoConhecido(jid);
    if (grupo) {
      const eu = db.prepare('SELECT id FROM pessoas WHERE wa_jid = ?')
        .get(normalizarJid(estado.telefone) ?? '');
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
  if (!existsSync(join(PASTA_AUTH, 'creds.json'))) return false;
  if (!(await checarDependencias())) return false;
  console.log('[whatsapp] sessão encontrada, reconectando…');
  await conectar();
  return true;
}
