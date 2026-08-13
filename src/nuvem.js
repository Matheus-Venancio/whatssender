// Persistência do "painel de controle" no Firestore.
//
// O PROBLEMA QUE ISTO RESOLVE: no Render sem disco, a pasta data/ é recriada a
// cada deploy e a cada hibernação. O Firestore já guardava os DADOS de cada
// campanha (pessoas, grupos, assinaturas), mas não guardava:
//
//     · quais campanhas existem       · os usuários e suas senhas
//     · a chave do Firebase de cada uma · a sessão do WhatsApp
//
// Sem isso, todo deploy devolvia um servidor em branco: sem login, sem
// campanha, pedindo QR de novo. Agora essas quatro coisas sobem para o
// Firestore e voltam sozinhas no boot seguinte.
//
// A CREDENCIAL DO SISTEMA: existe um ovo-e-galinha — a chave de cada campanha
// fica no banco, que é justamente o que se perdeu. Quebra-se com
// FIREBASE_SERVICE_ACCOUNT_JSON nas variáveis de ambiente, que o Render
// preserva entre deploys. Essa credencial acessa apenas a árvore `sistema/`.
//
// ISOLAMENTO: nada aqui mistura campanhas. Cada sessão de WhatsApp e cada
// chave ficam num documento com o slug no caminho, e o banco de cada candidato
// continua sendo um arquivo separado — ver a nota no topo de db.js.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pastaDeAuth, pastaDaCampanha } from './db.js';
import * as contas from './contas.js';

const RAIZ = 'sistema';
let fs = null;
let projeto = null;

export const nuvemLigada = () => Boolean(fs);
export const projetoDaNuvem = () => projeto;

/**
 * Liga a persistência de controle. Sem a variável de ambiente, o sistema segue
 * funcionando — só não sobrevive a deploy, que é o comportamento antigo.
 */
export async function iniciarNuvem() {
  if (fs) return true;

  const bruto = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!bruto) return false;

  try {
    const conta = JSON.parse(bruto);
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');

    const app = getApps().find((a) => a.name === 'sistema')
      ?? initializeApp({ credential: cert(conta), projectId: conta.project_id }, 'sistema');

    fs = getFirestore(app);
    fs.settings({ ignoreUndefinedProperties: true });
    projeto = conta.project_id;
    console.log(`[nuvem] persistência de controle ativa no projeto ${projeto}`);
    return true;
  } catch (erro) {
    console.error('[nuvem] credencial do sistema inválida:', erro.message);
    fs = null;
    return false;
  }
}

// ------------------------------------------------------------ campanhas/usuários
/**
 * Sobe campanhas e usuários. Chamado depois de toda mudança — são poucos
 * documentos e a escrita precisa ser imediata: um deploy pode vir a seguir.
 */
export async function salvarContas() {
  if (!fs) return { ok: false };

  const campanhas = contas.listarCampanhas();
  const usuarios = contas.admin.prepare('SELECT * FROM usuarios').all();

  const lote = fs.batch();
  for (const c of campanhas) {
    // O caminho da chave é local e não serve noutro servidor; o conteúdo dela
    // vai separado, em salvarChaveFirebase.
    lote.set(fs.collection(`${RAIZ}/controle/campanhas`).doc(c.slug), { ...c, firebase_key: null });
  }
  for (const u of usuarios) {
    // O hash da senha viaja junto: é scrypt com sal, não a senha em claro.
    // Sem ele, todo deploy exigiria redefinir a senha de todo mundo.
    lote.set(fs.collection(`${RAIZ}/controle/usuarios`).doc(String(u.id)), u);
  }
  await lote.commit();
  return { ok: true, campanhas: campanhas.length, usuarios: usuarios.length };
}

/** Traz campanhas e usuários de volta. Não sobrescreve o que já existe aqui. */
export async function restaurarContas() {
  if (!fs) return { ok: false };

  const [cs, us] = await Promise.all([
    fs.collection(`${RAIZ}/controle/campanhas`).get(),
    fs.collection(`${RAIZ}/controle/usuarios`).get()
  ]);

  let campanhas = 0;
  for (const doc of cs.docs) {
    const c = doc.data();
    if (contas.obterCampanha(c.slug)) continue;
    contas.admin.prepare(`
      INSERT INTO campanhas (slug, nome, cargo, cor, ativa, firebase_prefixo, firebase_pasta,
                             alerta_whatsapp, url_cadastro, criada_em)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(c.slug, c.nome, c.cargo ?? null, c.cor ?? '#5b21b6', c.ativa ?? 1,
      c.firebase_prefixo ?? null, c.firebase_pasta ?? null, c.alerta_whatsapp ?? null,
      c.url_cadastro ?? null, c.criada_em ?? Date.now());
    campanhas++;
  }

  let usuarios = 0;
  for (const doc of us.docs) {
    const u = doc.data();
    if (contas.admin.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(u.email)) continue;
    contas.admin.prepare(`
      INSERT INTO usuarios (email, nome, senha_hash, papel, campanha_slug, ativo, criado_em, trocar_senha)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(u.email, u.nome, u.senha_hash, u.papel, u.campanha_slug ?? null,
      u.ativo ?? 1, u.criado_em ?? Date.now(), u.trocar_senha ?? 0);
    usuarios++;
  }

  return { ok: true, campanhas, usuarios };
}

// ---------------------------------------------------------- chave do Firebase
export async function salvarChaveFirebase(slug) {
  if (!fs) return false;
  const caminho = join(pastaDaCampanha(slug), 'firebase-key.json');
  if (!existsSync(caminho)) return false;
  await fs.doc(`${RAIZ}/controle/chaves/${slug}`).set({
    conteudo: readFileSync(caminho, 'utf8'), em: new Date()
  });
  return true;
}

export async function restaurarChaveFirebase(slug) {
  if (!fs) return false;
  const doc = await fs.doc(`${RAIZ}/controle/chaves/${slug}`).get();
  if (!doc.exists) return false;

  const destino = join(pastaDaCampanha(slug), 'firebase-key.json');
  mkdirSync(pastaDaCampanha(slug), { recursive: true });
  writeFileSync(destino, doc.data().conteudo, { mode: 0o600 });
  contas.atualizarCampanha(slug, { firebase_key: destino });
  return true;
}

// ------------------------------------------------------- sessão do WhatsApp
//
// Só o creds.json viaja. As chaves de sessão (pre-keys, sender-keys) são
// centenas de arquivos e o Baileys as renegocia sozinho; o que não se
// renegocia é o pareamento, e ele mora no creds.json. Guardar só esse
// arquivo evita estourar o limite de 1 MB do documento e ainda assim
// dispensa o QR no próximo deploy.

const arquivoDeCreds = (slug) => join(pastaDeAuth(slug), 'creds.json');

export async function salvarSessaoWhatsapp(slug) {
  if (!fs) return false;
  const caminho = arquivoDeCreds(slug);
  if (!existsSync(caminho)) return false;
  await fs.doc(`${RAIZ}/controle/sessoes/${slug}`).set({
    creds: readFileSync(caminho, 'utf8'), em: new Date()
  });
  return true;
}

export async function restaurarSessaoWhatsapp(slug) {
  if (!fs) return false;
  if (existsSync(arquivoDeCreds(slug))) return false;   // já existe aqui, não mexe

  const doc = await fs.doc(`${RAIZ}/controle/sessoes/${slug}`).get();
  if (!doc.exists) return false;

  mkdirSync(pastaDeAuth(slug), { recursive: true });
  writeFileSync(arquivoDeCreds(slug), doc.data().creds, { mode: 0o600 });
  return true;
}

export async function esquecerSessaoWhatsapp(slug) {
  if (!fs) return false;
  await fs.doc(`${RAIZ}/controle/sessoes/${slug}`).delete();
  return true;
}

// ----------------------------------------------------------------- boot
/**
 * Reconstrói o servidor a partir do Firestore. Roda uma vez, no início.
 * Devolve o que trouxe para o log dizer se o deploy nasceu vazio de novo.
 */
export async function restaurarTudo() {
  if (!await iniciarNuvem()) return null;

  const r = await restaurarContas();
  const detalhes = [];
  for (const c of contas.listarCampanhas()) {
    const chave = await restaurarChaveFirebase(c.slug).catch(() => false);
    const sessao = await restaurarSessaoWhatsapp(c.slug).catch(() => false);
    if (chave || sessao) detalhes.push(`${c.slug}${chave ? ' +chave' : ''}${sessao ? ' +sessão' : ''}`);
  }
  return { ...r, detalhes };
}
