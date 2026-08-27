// Coletores de agenda: vários celulares alimentando a mesma base.
//
// POR QUE ISTO EXISTE SEPARADO DO whatsapp.js
//
// A campanha tem UMA linha principal — a que lê grupos, conversas e alertas.
// Mas a agenda de uma campanha está espalhada: o celular do candidato, o da
// coordenação, o do escritório. Conectar os três na linha principal é
// impossível (um socket por campanha) e indesejável (derrubaria a leitura dos
// grupos toda vez que alguém quisesse importar contatos).
//
// Um coletor é um celular que entra, entrega a agenda e pode sair. Cada um tem
// sessão própria em data/campanhas/<slug>/coletores/<id>/ — misturar
// credenciais de números diferentes na mesma pasta derruba o pareamento dos dois.
//
// O QUE UM COLETOR NÃO FAZ: ler mensagem. Nenhuma. Não há ouvinte de
// `messages.upsert` aqui, e do histórico só aproveitamos os contatos que vêm no
// mesmo evento. Isso não é configuração que alguém possa ligar sem querer — é a
// ausência do código. Quem quiser conversas usa a linha principal, na aba
// WhatsApp, conscientemente.
//
// POR QUE PRECISA PAREAR DE NOVO PARA TRAZER AGENDA: o WhatsApp manda a lista
// completa de contatos no pareamento. Reconectar com credencial existente não
// reenvia nada — por isso um coletor já conectado que não trouxe contatos
// precisa ser removido e lido de novo, e a tela diz isso.

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { db, agora, campanhaAtual, comCampanha, pastaDeColetor } from './db.js';
import { porCampanha } from './porcampanha.js';
import { upsertPessoa } from './ingest.js';
import { recomputar } from './scoring.js';

let baileys = null;
let gerarQrDataUri = null;

// Sessões vivas: por campanha, um mapa de id → estado. Não persiste; o que
// persiste é a credencial em disco e a linha na tabela `coletores`.
const vivos = porCampanha(() => new Map());

const ouvintes = new Set();
export function assinar(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); }
const emitir = (tipo, dados = {}) => {
  const campanha = campanhaAtual();
  for (const fn of ouvintes) { try { fn({ tipo, campanha, ...dados }); } catch { /* ignora */ } }
};

async function carregarBaileys() {
  if (baileys) return true;
  try {
    baileys = await import('@whiskeysockets/baileys');
    const qrcode = await import('qrcode').catch(() => null);
    gerarQrDataUri = qrcode
      ? (texto) => qrcode.default.toDataURL(texto, { margin: 1, width: 320 })
      : null;
    return true;
  } catch {
    return false;
  }
}

const soDigitos = (jid) => String(jid || '').split('@')[0].split(':')[0];

/** Mesma regra do whatsapp.js: @lid não é telefone e não pode virar pessoa. */
function normalizarJid(bruto) {
  if (!bruto) return null;
  const texto = String(bruto);
  if (texto.endsWith('@lid')) return null;
  const id = soDigitos(texto);
  if (!/^\d{10,15}$/.test(id) || id.length > 14) return null;
  return `${id}@s.whatsapp.net`;
}

function jidDeContato(contato) {
  if (typeof contato === 'string') return normalizarJid(contato);
  for (const c of [contato?.phoneNumber, contato?.jid, contato?.id]) {
    if (!c || String(c).endsWith('@lid')) continue;
    const jid = normalizarJid(c);
    if (jid) return jid;
  }
  return null;
}

// ------------------------------------------------------------------ registro
export const listar = () => db.prepare(`
  SELECT id, nome, telefone, criado_em, ultimo_em, contatos FROM coletores ORDER BY id
`).all().map((c) => {
  const vivo = vivos.atual().get(c.id);
  return {
    ...c,
    status: vivo?.status ?? 'desconectado',
    qr: vivo?.qr ?? null,
    erro: vivo?.erro ?? null
  };
});

export function criar({ nome }) {
  const limpo = String(nome || '').trim();
  if (!limpo) throw new Error('Dê um nome a este celular (ex.: "Celular da Cláudia")');
  const r = db.prepare('INSERT INTO coletores (nome, criado_em) VALUES (?, ?)')
    .run(limpo, agora());
  return { id: Number(r.lastInsertRowid), nome: limpo };
}

export async function remover(id) {
  await desconectar(id);
  const pasta = pastaDeColetor(campanhaAtual(), id);
  if (existsSync(pasta)) rmSync(pasta, { recursive: true, force: true });
  db.prepare('DELETE FROM coletores WHERE id = ?').run(id);
  emitir('coletores');
  return { ok: true };
}

export async function desconectar(id) {
  const mapa = vivos.atual();
  const vivo = mapa.get(Number(id));
  if (vivo?.sock) {
    // `end()` e não `logout()`: logout apagaria o pareamento no celular, e a
    // pessoa teria que ler o QR outra vez sem necessidade.
    try { vivo.sock.end(undefined); } catch { /* já caiu */ }
  }
  mapa.delete(Number(id));
  emitir('coletores');
  return { ok: true };
}

// ------------------------------------------------------------------- conexão
/**
 * Abre a sessão de um coletor e devolve o QR.
 *
 * `apagarSessao` força pareamento novo — é o caminho para trazer a agenda de um
 * celular já conectado, já que o WhatsApp só a envia ao parear.
 */
export async function conectar(id, { apagarSessao = false } = {}) {
  const slug = campanhaAtual();
  const numero = Number(id);
  const registro = db.prepare('SELECT * FROM coletores WHERE id = ?').get(numero);
  if (!registro) throw new Error('Coletor não encontrado');

  if (!await carregarBaileys()) {
    throw new Error('Baileys não instalado. Rode: npm install @whiskeysockets/baileys qrcode');
  }

  const mapa = vivos.atual();
  if (mapa.get(numero)?.sock && !apagarSessao) return estadoDe(numero);

  const pasta = pastaDeColetor(slug, numero);
  if (apagarSessao && existsSync(pasta)) rmSync(pasta, { recursive: true, force: true });
  mkdirSync(pasta, { recursive: true });

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
  const { state, saveCreds } = await useMultiFileAuthState(pasta);
  const { version } = await fetchLatestBaileysVersion();

  const vivo = { sock: null, status: 'conectando', qr: null, erro: null, qrs: 0 };
  mapa.set(numero, vivo);
  const aqui = (fn) => (...args) => comCampanha(slug, () => fn(...args));

  vivo.sock = makeWASocket({
    version,
    auth: state,
    // Sem histórico: o coletor não quer conversa nenhuma. Os contatos vêm
    // assim mesmo, no evento de history-set.
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    browser: baileys.Browsers?.ubuntu?.('Coletor de agenda') ?? ['Ubuntu', 'Coletor', '22.04.4'],
    qrTimeout: 90_000,
    connectTimeoutMs: 60_000
  });

  vivo.sock.ev.on('creds.update', saveCreds);

  const guardar = (contatos = []) => {
    let novos = 0;
    for (const contato of contatos) {
      const jid = jidDeContato(contato);
      if (!jid) continue;
      // `name` só existe quando a pessoa está salva na agenda; `notify` é o
      // nome que ela mesma pôs e não indica vínculo.
      const nomeAgenda = contato?.name || null;
      const pessoaId = upsertPessoa({
        jid,
        nomeWa: nomeAgenda || contato?.notify || contato?.verifiedName || null,
        origem: 'contato'
      });
      const r = db.prepare(`
        UPDATE pessoas SET na_agenda = MAX(na_agenda, ?),
                           nome_agenda = COALESCE(?, nome_agenda)
         WHERE id = ?
      `).run(nomeAgenda ? 1 : 0, nomeAgenda, pessoaId);
      if (r.changes) novos++;
    }
    if (!novos) return;

    const total = db.prepare("SELECT COUNT(*) AS n FROM pessoas WHERE origem = 'contato'").get().n;
    db.prepare('UPDATE coletores SET contatos = contatos + ?, ultimo_em = ? WHERE id = ?')
      .run(novos, agora(), numero);
    console.log(`[coletor:${slug}/${registro.nome}] +${novos} contato(s) (${total} na base)`);
    emitir('coletores', { coletor: numero, novos, total });
  };

  vivo.sock.ev.on('contacts.set', aqui(({ contacts }) => guardar(contacts)));
  vivo.sock.ev.on('contacts.upsert', aqui((c) => guardar(c)));
  vivo.sock.ev.on('contacts.update', aqui((c) => guardar(c)));
  // Do histórico aproveitamos SÓ os contatos. `messages` é ignorado de
  // propósito: não existe caminho, aqui, por onde uma conversa entre.
  vivo.sock.ev.on('messaging-history.set', aqui(({ contacts = [] }) => guardar(contacts)));

  vivo.sock.ev.on('connection.update', aqui(async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      vivo.qrs++;
      // Mesmo teto da linha principal: QR renovado sem parar acumula pedidos de
      // vínculo e leva a conta ao bloqueio temporário do WhatsApp.
      if (vivo.qrs > 3) {
        vivo.status = 'desconectado';
        vivo.qr = null;
        vivo.erro = 'Gerei 3 códigos e nenhum foi lido. Deixe o celular já na tela '
          + '"Conectar dispositivo" e tente de novo.';
        try { vivo.sock.end(undefined); } catch { /* já morreu */ }
        emitir('coletores');
        return;
      }
      vivo.status = 'qr';
      vivo.qr = gerarQrDataUri ? await gerarQrDataUri(qr) : null;
      vivo.erro = null;
      emitir('coletores');
    }

    if (connection === 'open') {
      vivo.status = 'conectado';
      vivo.qr = null;
      vivo.qrs = 0;
      const telefone = soDigitos(vivo.sock.user?.id);
      db.prepare('UPDATE coletores SET telefone = ? WHERE id = ?').run(telefone, numero);
      console.log(`[coletor:${slug}/${registro.nome}] conectado como ${telefone}`);
      emitir('coletores');

      // A agenda chega em lotes. Depois que assenta, recalcula uma vez — os
      // contatos novos entram na classificação de potencial de apoio.
      setTimeout(aqui(() => {
        try { recomputar(); emitir('coletores'); } catch { /* base ocupada */ }
      }), 45_000).unref?.();
    }

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      vivo.sock = null;
      vivo.qr = null;

      if (codigo === DisconnectReason.loggedOut || codigo === DisconnectReason.badSession) {
        if (existsSync(pasta)) rmSync(pasta, { recursive: true, force: true });
        vivo.status = 'desconectado';
        vivo.erro = 'A sessão foi encerrada no celular. Leia o QR de novo para reconectar.';
      } else if (vivo.status === 'conectado') {
        // Já trouxe a agenda; cair depois não é problema. Coletor não precisa
        // ficar de pé — diferente da linha principal, que ouve os grupos.
        vivo.status = 'desconectado';
        vivo.erro = null;
      } else {
        vivo.status = 'desconectado';
        vivo.erro = vivo.erro || 'A conexão caiu antes de parear. Tente de novo.';
      }
      emitir('coletores');
    }
  }));

  return estadoDe(numero);
}

export function estadoDe(id) {
  const numero = Number(id);
  const registro = db.prepare('SELECT * FROM coletores WHERE id = ?').get(numero);
  const vivo = vivos.atual().get(numero);
  return {
    ...registro,
    status: vivo?.status ?? 'desconectado',
    qr: vivo?.qr ?? null,
    erro: vivo?.erro ?? null
  };
}

/** Fecha tudo no desligamento, sem apagar pareamento. */
export function encerrarTudo() {
  for (const [, mapa] of vivos.todas()) {
    for (const [, vivo] of mapa) {
      try { vivo.sock?.end(undefined); } catch { /* já caiu */ }
    }
    mapa.clear();
  }
}
