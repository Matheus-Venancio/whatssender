// Campanhas, usuários e sessões.
//
// Fica num banco separado (data/admin.db) porque é o único dado que atravessa
// campanhas. Tudo de apoiador continua isolado no banco de cada candidato.
//
// Três papéis:
//   admin      — você. Vê e administra todas as campanhas.
//   equipe     — trabalha numa campanha só: responde, adiciona, edita ficha.
//   candidato  — o próprio candidato. Vê a base dele e usa o formulário de
//                cadastro para preencher com as pessoas. Não mexe em conexão,
//                Firebase, nem dispara adição em massa.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { PASTA_DADOS, abrirBanco, pastaDaCampanha, RAIZ } from './db.js';

export const admin = new DatabaseSync(join(PASTA_DADOS, 'admin.db'));

admin.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campanhas (
  id                INTEGER PRIMARY KEY,
  slug              TEXT UNIQUE NOT NULL,
  nome              TEXT NOT NULL,          -- "Dra. Cláudia Camargo"
  cargo             TEXT,                   -- "Deputada Estadual - SP"
  cor               TEXT NOT NULL DEFAULT '#5b21b6',
  ativa             INTEGER NOT NULL DEFAULT 1,
  firebase_key      TEXT,                   -- caminho do JSON da conta de serviço
  firebase_prefixo  TEXT,                   -- usado quando o projeto é compartilhado
  alerta_whatsapp   TEXT,
  url_cadastro      TEXT,
  criada_em         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usuarios (
  id             INTEGER PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  nome           TEXT NOT NULL,
  senha_hash     TEXT NOT NULL,
  papel          TEXT NOT NULL DEFAULT 'equipe',   -- admin | equipe | candidato
  campanha_slug  TEXT,                             -- null só para admin
  ativo          INTEGER NOT NULL DEFAULT 1,
  criado_em      INTEGER NOT NULL,
  ultimo_acesso  INTEGER,
  trocar_senha   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessoes (
  token      TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criada_em  INTEGER NOT NULL,
  expira_em  INTEGER NOT NULL,
  origem     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessao_exp ON sessoes(expira_em);
`);

// A pasta da campanha no Firestore era sempre o slug. Isso quebra quando a
// árvore no Firebase já existe com outro nome: criar "Dra. Cláudia Camargo"
// pelo painel gera o slug "claudia-camargo", enquanto a base dela está em
// campanhas/claudia — e a restauração volta vazia, sem erro nenhum.
try { admin.exec('ALTER TABLE campanhas ADD COLUMN firebase_pasta TEXT'); } catch { /* já existe */ }

// Provedor de WhatsApp por campanha.
//
//   baileys — socket dentro deste processo. A sessão é nossa, e sobrevive a
//             deploy porque nuvem.js guarda a credencial no Firestore.
//   wacore  — WA-Core2. Quem mantém a conexão é o fornecedor; aqui ficam só os
//             identificadores para endereçar a linha.
//
// A escolha é por campanha, de propósito: dá para migrar um candidato por vez
// e comparar entrega antes de mover o resto.
for (const coluna of [
  "provedor TEXT NOT NULL DEFAULT 'baileys'",
  'wacore_external_id TEXT',   // UUID do team — a campanha
  'wacore_user_id TEXT'        // UUID da linha — o número
]) {
  try { admin.exec(`ALTER TABLE campanhas ADD COLUMN ${coluna}`); } catch { /* já existe */ }
}

const DIA = 86_400_000;
const DURACAO_SESSAO = 30 * DIA;

// ------------------------------------------------------------------- senha
function embaralhar(senha, sal = randomBytes(16).toString('hex')) {
  const derivada = scryptSync(senha, sal, 64).toString('hex');
  return `${sal}:${derivada}`;
}

function conferirSenha(senha, guardada) {
  try {
    const [sal, esperado] = String(guardada).split(':');
    const calculado = scryptSync(senha, sal, 64);
    const alvo = Buffer.from(esperado, 'hex');
    return calculado.length === alvo.length && timingSafeEqual(calculado, alvo);
  } catch {
    return false;
  }
}

export const gerarSenha = (tamanho = 10) =>
  randomBytes(32).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, tamanho);

// --------------------------------------------------------------- campanhas
export const slugificar = (texto) =>
  String(texto).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function criarCampanha({ nome, cargo = null, slug = null, cor = '#5b21b6', firebaseKey = null, urlCadastro = null }) {
  const chave = slug || slugificar(nome);
  if (!chave) throw new Error('Nome da campanha inválido');
  if (admin.prepare('SELECT 1 FROM campanhas WHERE slug = ?').get(chave)) {
    throw new Error(`Já existe uma campanha com o identificador "${chave}"`);
  }
  admin.prepare(`
    INSERT INTO campanhas (slug, nome, cargo, cor, firebase_key, url_cadastro, criada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(chave, nome, cargo, cor, firebaseKey, urlCadastro, Date.now());

  abrirBanco(chave);          // cria a pasta e o banco já com o esquema
  return obterCampanha(chave);
}

export const obterCampanha = (slug) =>
  admin.prepare('SELECT * FROM campanhas WHERE slug = ?').get(slug) ?? null;

export const listarCampanhas = ({ apenasAtivas = false } = {}) =>
  admin.prepare(
    `SELECT * FROM campanhas ${apenasAtivas ? 'WHERE ativa = 1' : ''} ORDER BY nome`
  ).all();

export function atualizarCampanha(slug, campos) {
  const permitidos = ['nome', 'cargo', 'cor', 'ativa', 'firebase_key', 'firebase_prefixo',
    'firebase_pasta', 'alerta_whatsapp', 'url_cadastro',
    'provedor', 'wacore_external_id', 'wacore_user_id'];
  const sets = [];
  const valores = [];
  for (const campo of permitidos) {
    if (campo in campos) { sets.push(`${campo} = ?`); valores.push(campos[campo]); }
  }
  if (!sets.length) return obterCampanha(slug);
  admin.prepare(`UPDATE campanhas SET ${sets.join(', ')} WHERE slug = ?`).run(...valores, slug);
  return obterCampanha(slug);
}

/** Configuração efetiva de uma campanha, com o .env como reserva. */
export function configDaCampanha(slug) {
  const c = obterCampanha(slug);
  if (!c) return null;
  // Sem fallback para o .env: a chave é DA campanha. Se ela não tem a sua,
  // não sincroniza — melhor do que escrever a base de um candidato no
  // projeto Firebase de outro.
  const chave = c.firebase_key
    ? (c.firebase_key.startsWith('/') || /^[A-Za-z]:/.test(c.firebase_key)
        ? c.firebase_key : join(RAIZ, c.firebase_key))
    : null;

  return {
    slug: c.slug,
    nome: c.nome,
    cargo: c.cargo,
    cor: c.cor,
    ativa: Boolean(c.ativa),
    firebaseKey: chave && existsSync(chave) ? chave : null,
    firebasePrefixo: c.firebase_prefixo || null,
    // Onde esta campanha mora dentro do projeto compartilhado. Por padrão é o
    // próprio slug; pode divergir quando a árvore já existia antes.
    firebasePasta: c.firebase_pasta || c.slug,
    provedor: c.provedor || 'baileys',
    wacoreExternalId: c.wacore_external_id || null,
    wacoreUserId: c.wacore_user_id || null,
    alertaWhatsapp: c.alerta_whatsapp || process.env.ALERTA_WHATSAPP || null,
    urlCadastro: c.url_cadastro || `/cadastro/${c.slug}`,
    pasta: pastaDaCampanha(c.slug)
  };
}

// ---------------------------------------------------------------- usuários
export function criarUsuario({ email, nome, senha = null, papel = 'equipe', campanhaSlug = null }) {
  const limpo = String(email || '').trim().toLowerCase();
  if (!limpo.includes('@')) throw new Error('E-mail inválido');
  if (!['admin', 'equipe', 'candidato'].includes(papel)) throw new Error('Papel inválido');
  if (papel !== 'admin' && !campanhaSlug) throw new Error('Informe a campanha do usuário');
  if (admin.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(limpo)) {
    throw new Error('Já existe um usuário com esse e-mail');
  }

  const senhaFinal = senha || gerarSenha();
  admin.prepare(`
    INSERT INTO usuarios (email, nome, senha_hash, papel, campanha_slug, criado_em, trocar_senha)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(limpo, nome, embaralhar(senhaFinal), papel, papel === 'admin' ? null : campanhaSlug,
    Date.now(), senha ? 0 : 1);

  // A senha em texto só existe neste retorno — depois disso, só o hash.
  return { ...obterUsuario(limpo), senhaGerada: senha ? null : senhaFinal };
}

export const obterUsuario = (email) => {
  const u = admin.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(email).toLowerCase());
  return u ? semSenha(u) : null;
};

export const listarUsuarios = ({ campanhaSlug = null } = {}) =>
  admin.prepare(`
    SELECT u.*, c.nome AS campanha_nome FROM usuarios u
      LEFT JOIN campanhas c ON c.slug = u.campanha_slug
     ${campanhaSlug ? 'WHERE u.campanha_slug = ?' : ''}
     ORDER BY u.papel, u.nome
  `).all(...(campanhaSlug ? [campanhaSlug] : [])).map(semSenha);

const semSenha = ({ senha_hash, ...resto }) => resto;

export function redefinirSenha(email, senha = null) {
  const nova = senha || gerarSenha();
  const r = admin.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = ? WHERE email = ?')
    .run(embaralhar(nova), senha ? 0 : 1, String(email).toLowerCase());
  if (!r.changes) throw new Error('Usuário não encontrado');
  admin.prepare('DELETE FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE email = ?)')
    .run(String(email).toLowerCase());
  return { senha: nova };
}

export function definirAtivo(email, ativo) {
  admin.prepare('UPDATE usuarios SET ativo = ? WHERE email = ?')
    .run(ativo ? 1 : 0, String(email).toLowerCase());
  if (!ativo) {
    admin.prepare('DELETE FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE email = ?)')
      .run(String(email).toLowerCase());
  }
  return obterUsuario(email);
}

export function removerUsuario(email) {
  const r = admin.prepare('DELETE FROM usuarios WHERE email = ?').run(String(email).toLowerCase());
  return { removidos: r.changes };
}

// ----------------------------------------------------------------- sessões
export function entrar({ email, senha, origem = null }) {
  const linha = admin.prepare('SELECT * FROM usuarios WHERE email = ?')
    .get(String(email || '').trim().toLowerCase());

  // Mensagem única de propósito: não revela se o e-mail existe.
  if (!linha || !linha.ativo || !conferirSenha(senha, linha.senha_hash)) {
    return { erro: 'E-mail ou senha incorretos' };
  }

  const token = randomBytes(32).toString('base64url');
  const agora = Date.now();
  admin.prepare('INSERT INTO sessoes (token, usuario_id, criada_em, expira_em, origem) VALUES (?, ?, ?, ?, ?)')
    .run(token, linha.id, agora, agora + DURACAO_SESSAO, origem);
  admin.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora, linha.id);

  admin.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(agora);
  return { token, usuario: semSenha(linha), expiraEm: agora + DURACAO_SESSAO };
}

export function sair(token) {
  admin.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
  return { ok: true };
}

export function usuarioDoToken(token) {
  if (!token) return null;
  const linha = admin.prepare(`
    SELECT u.*, s.expira_em FROM sessoes s
      JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token = ? AND s.expira_em > ? AND u.ativo = 1
  `).get(token, Date.now());
  return linha ? semSenha(linha) : null;
}

export function trocarPropriaSenha({ email, senhaAtual, senhaNova }) {
  const linha = admin.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(email).toLowerCase());
  if (!linha || !conferirSenha(senhaAtual, linha.senha_hash)) return { erro: 'Senha atual incorreta' };
  if (String(senhaNova || '').length < 8) return { erro: 'A nova senha precisa de pelo menos 8 caracteres' };
  admin.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?')
    .run(embaralhar(senhaNova), linha.id);
  return { ok: true };
}

// ------------------------------------------------------------- permissões
export const PERMISSOES = {
  admin: {
    verTodasCampanhas: true, gerirUsuarios: true, gerirCampanhas: true,
    conectarWhatsapp: true, configurarFirebase: true, responder: true,
    adicionarEmMassa: true, editarFicha: true, importarLeads: true, exportar: true
  },
  equipe: {
    verTodasCampanhas: false, gerirUsuarios: false, gerirCampanhas: false,
    conectarWhatsapp: true, configurarFirebase: false, responder: true,
    adicionarEmMassa: true, editarFicha: true, importarLeads: true, exportar: true
  },
  candidato: {
    verTodasCampanhas: false, gerirUsuarios: false, gerirCampanhas: false,
    conectarWhatsapp: false, configurarFirebase: false, responder: false,
    adicionarEmMassa: false, editarFicha: true, importarLeads: false, exportar: false
  }
};

export const podeFazer = (usuario, acao) => Boolean(PERMISSOES[usuario?.papel]?.[acao]);

/** Campanhas que este usuário enxerga. */
export function campanhasDoUsuario(usuario) {
  if (!usuario) return [];
  if (usuario.papel === 'admin') return listarCampanhas();
  const c = obterCampanha(usuario.campanha_slug);
  return c ? [c] : [];
}

export function podeAcessarCampanha(usuario, slug) {
  if (!usuario || !slug) return false;
  if (usuario.papel === 'admin') return Boolean(obterCampanha(slug));
  return usuario.campanha_slug === slug;
}

export const temAlgumUsuario = () =>
  admin.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0;

/**
 * Primeiro boot em produção: o disco sobe vazio e ninguém consegue entrar.
 * Cria o administrador a partir de ADMIN_EMAIL/ADMIN_SENHA, uma única vez.
 * Se já existir usuário, não faz nada — nunca sobrescreve.
 */
export function semearAdministrador() {
  if (temAlgumUsuario()) return null;

  const email = process.env.ADMIN_EMAIL?.trim();
  if (!email) {
    console.warn(`
  ⚠  Nenhum usuário cadastrado e ADMIN_EMAIL não definido.
     Ninguém consegue entrar no painel.
     Defina ADMIN_EMAIL e ADMIN_SENHA nas variáveis de ambiente e reinicie.
`);
    return null;
  }

  const senha = process.env.ADMIN_SENHA?.trim() || gerarSenha(14);
  const u = criarUsuario({
    email, nome: process.env.ADMIN_NOME?.trim() || 'Administrador',
    papel: 'admin', senha: process.env.ADMIN_SENHA?.trim() || senha
  });

  console.log(`
  ✅ Administrador criado: ${u.email}
     ${process.env.ADMIN_SENHA ? '(senha definida na variável ADMIN_SENHA)' : `senha gerada: ${senha}`}
`);
  return u;
}
