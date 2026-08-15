// Banco de dados multi-campanha.
//
// Cada candidato tem o SEU banco, o SEU WhatsApp e a SUA pasta:
//     data/campanhas/<slug>/rede.db
//     data/campanhas/<slug>/auth/
//     data/campanhas/<slug>/leads/
//
// Isolamento por arquivo, não por coluna: é impossível uma consulta esquecer o
// `WHERE campanha_id = ?` e vazar apoiador de um candidato para outro.
//
// O truque que segura isso sem reescrever as ~200 consultas do sistema: `db` é
// um Proxy que resolve, a cada acesso, o banco da campanha ativa no contexto
// (AsyncLocalStorage). Todo `db.prepare(...)` continua igual ao que já era.

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// Em produção (Render), os dados vivem num disco persistente montado fora do
// código — o sistema de arquivos do container é apagado a cada deploy.
// DATA_DIR aponta para esse disco; sem ele, usa ./data como sempre.
const PADRAO = join(RAIZ, 'data');
const pedida = process.env.DATA_DIR
  ? (isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : join(RAIZ, process.env.DATA_DIR))
  : PADRAO;

/**
 * Abrir a pasta de dados, caindo para ./data se DATA_DIR não for gravável.
 *
 * POR QUE NÃO ABORTAR: DATA_DIR apontar para um disco que não existe é um erro
 * de configuração do provedor, não do sistema. Derrubar o processo transforma
 * isso em site fora do ar — e, no Render, o serviço fica preso reiniciando sem
 * ninguém conseguir entrar no painel para corrigir. Servir com dado efêmero e
 * gritar no log é pior que o disco certo, porém muito melhor que não servir.
 */
function escolherPasta() {
  try {
    mkdirSync(join(pedida, 'campanhas'), { recursive: true });
    return pedida;
  } catch (erro) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(erro.code) || pedida === PADRAO) throw erro;
    console.error(`
  ⚠  DATA_DIR IGNORADO — sem permissão para gravar em ${pedida}
     (${erro.code} em ${erro.path})

     Essa pasta não existe e o processo não pode criá-la. No Render isso quer
     dizer que o disco persistente NÃO está montado: um disco montado já chega
     criado e gravável.

     O sistema vai subir gravando em ./data para o painel continuar no ar.
     ATENÇÃO: nesse modo os dados são apagados a cada deploy e a cada
     hibernação, e a sessão do WhatsApp cai junto.

     Para resolver, escolha uma:
       1) serviço → Disk → Add Disk, mount path ${pedida}  (instância paga)
       2) Environment → apague DATA_DIR → Save, rebuild, and deploy
`);
    mkdirSync(join(PADRAO, 'campanhas'), { recursive: true });
    return PADRAO;
  }
}

export const PASTA_DADOS = escolherPasta();
/** Verdadeiro quando os dados estão em pasta efêmera apesar de DATA_DIR pedir disco. */
export const SEM_DISCO = Boolean(process.env.DATA_DIR) && PASTA_DADOS !== pedida;

export const PASTA_PUBLICA = join(RAIZ, 'public');
export const PASTA_CAMPANHAS = join(PASTA_DADOS, 'campanhas');

export const contexto = new AsyncLocalStorage();
const bancos = new Map();

export const pastaDaCampanha = (slug) => join(PASTA_CAMPANHAS, slug);
export const pastaDeAuth = (slug) => join(pastaDaCampanha(slug), 'auth');
export const pastaDeLeads = (slug) => join(pastaDaCampanha(slug), 'leads');

// ---------------------------------------------------------------- esquema
function aplicarEsquema(banco) {
  banco.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pessoas (
  id             INTEGER PRIMARY KEY,
  wa_jid         TEXT UNIQUE,
  telefone       TEXT,
  nome_wa        TEXT,
  nome           TEXT,
  cidade         TEXT,
  uf             TEXT,
  cidade_bruta   TEXT,
  bairro         TEXT,
  atuacao        TEXT,
  email          TEXT,
  origem         TEXT NOT NULL DEFAULT 'grupo',
  cadastro_em    INTEGER,
  primeiro_visto INTEGER,
  ultimo_contato INTEGER,
  firestore_em   INTEGER,
  observacoes    TEXT
);

CREATE TABLE IF NOT EXISTS grupos (
  id         INTEGER PRIMARY KEY,
  wa_jid     TEXT UNIQUE,
  nome       TEXT NOT NULL,
  descricao  TEXT,
  criado_em  INTEGER,
  ativo      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS membros (
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  grupo_id  INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  entrou_em INTEGER,
  admin     INTEGER NOT NULL DEFAULT 0,
  saiu_em   INTEGER,
  PRIMARY KEY (pessoa_id, grupo_id)
);

CREATE TABLE IF NOT EXISTS mensagens (
  id         INTEGER PRIMARY KEY,
  wa_id      TEXT UNIQUE,
  grupo_id   INTEGER REFERENCES grupos(id) ON DELETE CASCADE,
  pessoa_id  INTEGER REFERENCES pessoas(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL DEFAULT 'texto',
  texto      TEXT,
  responde_a INTEGER REFERENCES mensagens(id) ON DELETE SET NULL,
  ts         INTEGER NOT NULL,
  de_mim     INTEGER NOT NULL DEFAULT 0,
  privada    INTEGER NOT NULL DEFAULT 0,
  sentimento TEXT,
  lida       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_msg_pessoa   ON mensagens(pessoa_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_grupo    ON mensagens(grupo_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_privada  ON mensagens(privada, ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_conversa ON mensagens(pessoa_id, privada, ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_nao_lida ON mensagens(lida, privada, ts DESC);

CREATE TABLE IF NOT EXISTS reacoes (
  id          INTEGER PRIMARY KEY,
  mensagem_id INTEGER NOT NULL REFERENCES mensagens(id) ON DELETE CASCADE,
  pessoa_id   INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  emoji       TEXT,
  ts          INTEGER NOT NULL,
  UNIQUE (mensagem_id, pessoa_id)
);

CREATE TABLE IF NOT EXISTS eventos (
  id        INTEGER PRIMARY KEY,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  tipo      TEXT NOT NULL,
  descricao TEXT,
  dados     TEXT,          -- payload estruturado do evento (JSON)
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_pessoa ON eventos(pessoa_id, ts);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL,
  cor  TEXT NOT NULL DEFAULT '#5b21b6'
);

CREATE TABLE IF NOT EXISTS pessoa_tags (
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (pessoa_id, tag_id)
);

CREATE TABLE IF NOT EXISTS temas_pessoa (
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  tema      TEXT NOT NULL,
  score     REAL NOT NULL,
  mencoes   INTEGER NOT NULL,
  PRIMARY KEY (pessoa_id, tema)
);

CREATE TABLE IF NOT EXISTS perfil (
  pessoa_id           INTEGER PRIMARY KEY REFERENCES pessoas(id) ON DELETE CASCADE,
  engajamento         REAL NOT NULL DEFAULT 0,
  faixa               TEXT NOT NULL DEFAULT 'Observador',
  msgs_total          INTEGER NOT NULL DEFAULT 0,
  msgs_30d            INTEGER NOT NULL DEFAULT 0,
  msgs_7d             INTEGER NOT NULL DEFAULT 0,
  reacoes_dadas       INTEGER NOT NULL DEFAULT 0,
  reacoes_recebidas   INTEGER NOT NULL DEFAULT 0,
  respostas_dadas     INTEGER NOT NULL DEFAULT 0,
  respostas_recebidas INTEGER NOT NULL DEFAULT 0,
  midias              INTEGER NOT NULL DEFAULT 0,
  grupos_count        INTEGER NOT NULL DEFAULT 0,
  ultima_msg_ts       INTEGER,
  ultima_msg_texto    TEXT,
  ultima_msg_grupo    TEXT,
  dias_sem_falar      INTEGER,
  tema_principal      TEXT,
  intencoes           TEXT,
  completude          INTEGER NOT NULL DEFAULT 0,
  proxima_acao        TEXT,
  atualizado_em       INTEGER
);

-- Interesses e intenções declarados no formulário de pautas (diferente dos
-- temas inferidos das mensagens, que ficam em temas_pessoa).
CREATE TABLE IF NOT EXISTS interesses (
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  tema      TEXT NOT NULL,
  acertos   INTEGER NOT NULL DEFAULT 0,
  ultimo_em INTEGER,
  PRIMARY KEY (pessoa_id, tema)
);

CREATE TABLE IF NOT EXISTS pessoa_intencoes (
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  intencao  TEXT NOT NULL,
  peso      INTEGER NOT NULL DEFAULT 0,
  ultimo_em INTEGER,
  PRIMARY KEY (pessoa_id, intencao)
);

CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);

CREATE TABLE IF NOT EXISTS abaixos (
  id       INTEGER PRIMARY KEY,
  form_id  TEXT UNIQUE,
  chave    TEXT NOT NULL,
  titulo   TEXT NOT NULL,
  bandeira TEXT,
  temas    TEXT NOT NULL DEFAULT '[]',
  campanha TEXT
);

CREATE TABLE IF NOT EXISTS assinaturas (
  id           INTEGER PRIMARY KEY,
  lead_id      TEXT UNIQUE NOT NULL,
  abaixo_id    INTEGER NOT NULL REFERENCES abaixos(id) ON DELETE CASCADE,
  pessoa_id    INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  criado_em    INTEGER NOT NULL,
  plataforma   TEXT,
  organico     INTEGER NOT NULL DEFAULT 0,
  anuncio      TEXT,
  conjunto     TEXT,
  cidade_bruta TEXT,
  atuacao      TEXT,
  status       TEXT
);
CREATE INDEX IF NOT EXISTS idx_assin_pessoa ON assinaturas(pessoa_id);
CREATE INDEX IF NOT EXISTS idx_assin_abaixo ON assinaturas(abaixo_id);

CREATE TABLE IF NOT EXISTS alertas (
  id        INTEGER PRIMARY KEY,
  tipo      TEXT NOT NULL,
  gravidade TEXT NOT NULL DEFAULT 'aviso',
  pessoa_id INTEGER REFERENCES pessoas(id) ON DELETE CASCADE,
  grupo_id  INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  titulo    TEXT NOT NULL,
  detalhe   TEXT,
  dados     TEXT,
  lido      INTEGER NOT NULL DEFAULT 0,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerta_ts ON alertas(lido, ts DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY,
  colecao    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  operacao   TEXT NOT NULL DEFAULT 'set',
  carga      TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro       TEXT,
  criado_em  INTEGER NOT NULL,
  enviado_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_pendente ON outbox(enviado_em, id);

-- Disparo privado em lista. Uma linha por envio planejado, para haver
-- histórico auditável de quem recebeu o quê e quando — a legislação eleitoral
-- cobra rastreabilidade da propaganda.
CREATE TABLE IF NOT EXISTS transmissoes (
  id          INTEGER PRIMARY KEY,
  titulo      TEXT NOT NULL,
  modelo      TEXT NOT NULL,          -- texto com {nome} e {cidade}
  tipo        TEXT NOT NULL DEFAULT 'propaganda',  -- propaganda|interno
  criada_em   INTEGER NOT NULL,
  criada_por  TEXT,
  situacao    TEXT NOT NULL DEFAULT 'rascunho',  -- rascunho|enviando|pausada|concluida|cancelada
  enviadas    INTEGER NOT NULL DEFAULT 0,
  falhas      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transmissao_alvos (
  transmissao_id INTEGER NOT NULL REFERENCES transmissoes(id) ON DELETE CASCADE,
  pessoa_id      INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  situacao       TEXT NOT NULL DEFAULT 'pendente',  -- pendente|enviado|falhou|pulado
  motivo         TEXT,
  enviado_em     INTEGER,
  PRIMARY KEY (transmissao_id, pessoa_id)
);
CREATE INDEX IF NOT EXISTS idx_alvo_situacao ON transmissao_alvos(situacao);

CREATE TABLE IF NOT EXISTS fila_adicao (
  id            INTEGER PRIMARY KEY,
  grupo_id      INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  pessoa_id     INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  situacao      TEXT NOT NULL DEFAULT 'pendente',
  metodo        TEXT,
  tentativas    INTEGER NOT NULL DEFAULT 0,
  erro          TEXT,
  criado_em     INTEGER NOT NULL,
  processado_em INTEGER,
  UNIQUE (grupo_id, pessoa_id)
);
CREATE INDEX IF NOT EXISTS idx_fila_pendente ON fila_adicao(situacao, id);

CREATE TABLE IF NOT EXISTS conversas (
  pessoa_id     INTEGER PRIMARY KEY REFERENCES pessoas(id) ON DELETE CASCADE,
  situacao      TEXT NOT NULL DEFAULT 'aberta',
  responsavel   TEXT,
  fixada        INTEGER NOT NULL DEFAULT 0,
  sentimento    TEXT,
  resumo        TEXT,
  atualizado_em INTEGER
);
  `);

  // Migrações de bancos criados antes de alguma coluna existir.
  const colunas = (t) => banco.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const [tabela, coluna, tipo] of [
    ['pessoas', 'uf', 'TEXT'],
    ['pessoas', 'cidade_bruta', 'TEXT'],
    ['pessoas', 'firestore_em', 'INTEGER'],
    ['pessoas', 'ultimo_contato', 'INTEGER'],
    ['mensagens', 'de_mim', 'INTEGER NOT NULL DEFAULT 0'],
    ['mensagens', 'privada', 'INTEGER NOT NULL DEFAULT 0'],
    ['mensagens', 'sentimento', 'TEXT'],
    ['mensagens', 'lida', 'INTEGER NOT NULL DEFAULT 1'],
    // Contato salvo na agenda do celular da campanha — sinal de vínculo real.
    ['pessoas', 'na_agenda', 'INTEGER NOT NULL DEFAULT 0'],
    ['pessoas', 'nome_agenda', 'TEXT'],
    // Propensão a apoiar: calculada mesmo sem abaixo-assinado nenhum.
    ['perfil', 'propensao', 'REAL NOT NULL DEFAULT 0'],
    ['perfil', 'faixa_apoio', "TEXT NOT NULL DEFAULT 'Sem sinal'"],
    ['perfil', 'motivos_apoio', 'TEXT'],
    ['eventos', 'dados', 'TEXT'],
    // Pediu para não receber mais. Exigência legal, não preferência: a pessoa
    // que se descadastra não pode voltar a receber disparo nenhum.
    ['pessoas', 'opt_out', 'INTEGER NOT NULL DEFAULT 0'],
    ['pessoas', 'opt_out_em', 'INTEGER']
  ]) {
    if (!colunas(tabela).includes(coluna)) {
      banco.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
    }
  }
}

// ------------------------------------------------------------- abertura
export function abrirBanco(slug) {
  if (bancos.has(slug)) return bancos.get(slug);
  const pasta = pastaDaCampanha(slug);
  mkdirSync(pasta, { recursive: true });
  mkdirSync(pastaDeLeads(slug), { recursive: true });
  const banco = new DatabaseSync(join(pasta, 'rede.db'));
  aplicarEsquema(banco);
  bancos.set(slug, banco);
  return banco;
}

export function fecharBanco(slug) {
  const banco = bancos.get(slug);
  if (banco) { try { banco.close(); } catch { /* já fechado */ } bancos.delete(slug); }
}

/** Roda `fn` com a campanha `slug` ativa. Tudo que usar `db` cai no banco dela. */
export function comCampanha(slug, fn) {
  if (!slug) throw new Error('Campanha não informada');
  abrirBanco(slug);
  return contexto.run({ slug }, fn);
}

export const campanhaAtual = () => contexto.getStore()?.slug ?? null;

/**
 * Fixa a campanha para todo o restante da execução.
 * É o que os scripts de linha de comando e os testes usam — eles rodam de cima
 * para baixo, sem um callback onde envolver tudo.
 */
export function usarCampanha(slug = null) {
  const escolhida = slug || process.env.CAMPANHA || campanhasNoDisco()[0];
  if (!escolhida) {
    throw new Error('Nenhuma campanha encontrada. Rode primeiro: npm run configurar');
  }
  abrirBanco(escolhida);
  contexto.enterWith({ slug: escolhida });
  return escolhida;
}

export function campanhasNoDisco() {
  if (!existsSync(PASTA_CAMPANHAS)) return [];
  return readdirSync(PASTA_CAMPANHAS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// O Proxy: `db.prepare(...)` sempre cai no banco da campanha ativa.
export const db = new Proxy({}, {
  get(_alvo, propriedade) {
    const slug = campanhaAtual();
    if (!slug) {
      throw new Error(
        'Nenhuma campanha ativa. Envolva a operação em comCampanha("<slug>", () => …).'
      );
    }
    const banco = abrirBanco(slug);
    const valor = banco[propriedade];
    return typeof valor === 'function' ? valor.bind(banco) : valor;
  }
});

// ------------------------------------------------------------- utilidades
export function agora() {
  return Date.now();
}

export function setConfig(chave, valor) {
  db.prepare(
    'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'
  ).run(chave, String(valor));
}

export function getConfig(chave, padrao = null) {
  const linha = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return linha ? linha.valor : padrao;
}
