import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tudo é resolvido a partir da raiz do projeto, não do diretório de onde o
// processo foi iniciado — o servidor pode ser chamado de qualquer lugar.
export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_DADOS = join(RAIZ, 'data');
export const PASTA_PUBLICA = join(RAIZ, 'public');

mkdirSync(PASTA_DADOS, { recursive: true });

export const db = new DatabaseSync(join(PASTA_DADOS, 'rede.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Uma pessoa da rede. Nasce do WhatsApp (jid) e vai sendo enriquecida
-- pelo abaixo-assinado, pela conversa e pelo trabalho manual da equipe.
CREATE TABLE IF NOT EXISTS pessoas (
  id             INTEGER PRIMARY KEY,
  wa_jid         TEXT UNIQUE,
  telefone       TEXT,
  nome_wa        TEXT,          -- pushName exibido no WhatsApp
  nome           TEXT,          -- nome declarado no abaixo-assinado
  cidade         TEXT,
  bairro         TEXT,
  atuacao        TEXT,
  email          TEXT,
  origem         TEXT NOT NULL DEFAULT 'grupo',   -- grupo | abaixo-assinado | importacao
  cadastro_em    INTEGER,       -- quando assinou o abaixo-assinado
  primeiro_visto INTEGER,
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
  id            INTEGER PRIMARY KEY,
  wa_id         TEXT UNIQUE,
  grupo_id      INTEGER REFERENCES grupos(id) ON DELETE CASCADE,
  pessoa_id     INTEGER REFERENCES pessoas(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL DEFAULT 'texto',  -- texto|imagem|video|audio|documento|sticker|enquete
  texto         TEXT,
  responde_a    INTEGER REFERENCES mensagens(id) ON DELETE SET NULL,
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_pessoa ON mensagens(pessoa_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_grupo  ON mensagens(grupo_id, ts);

CREATE TABLE IF NOT EXISTS reacoes (
  id          INTEGER PRIMARY KEY,
  mensagem_id INTEGER NOT NULL REFERENCES mensagens(id) ON DELETE CASCADE,
  pessoa_id   INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  emoji       TEXT,
  ts          INTEGER NOT NULL,
  UNIQUE (mensagem_id, pessoa_id)
);

-- Linha do tempo humana: o que aconteceu com essa pessoa.
CREATE TABLE IF NOT EXISTS eventos (
  id        INTEGER PRIMARY KEY,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  tipo      TEXT NOT NULL,   -- entrou_grupo | assinou | mensagem | reagiu | contato_equipe | nota
  descricao TEXT,
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

-- Tabelas derivadas: recalculadas pelo motor de scoring.
CREATE TABLE IF NOT EXISTS temas_pessoa (
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  tema      TEXT NOT NULL,
  score     REAL NOT NULL,
  mencoes   INTEGER NOT NULL,
  PRIMARY KEY (pessoa_id, tema)
);

CREATE TABLE IF NOT EXISTS perfil (
  pessoa_id         INTEGER PRIMARY KEY REFERENCES pessoas(id) ON DELETE CASCADE,
  engajamento       REAL NOT NULL DEFAULT 0,
  faixa             TEXT NOT NULL DEFAULT 'Observador',
  msgs_total        INTEGER NOT NULL DEFAULT 0,
  msgs_30d          INTEGER NOT NULL DEFAULT 0,
  msgs_7d           INTEGER NOT NULL DEFAULT 0,
  reacoes_dadas     INTEGER NOT NULL DEFAULT 0,
  reacoes_recebidas INTEGER NOT NULL DEFAULT 0,
  respostas_dadas   INTEGER NOT NULL DEFAULT 0,
  respostas_recebidas INTEGER NOT NULL DEFAULT 0,
  midias            INTEGER NOT NULL DEFAULT 0,
  grupos_count      INTEGER NOT NULL DEFAULT 0,
  ultima_msg_ts     INTEGER,
  ultima_msg_texto  TEXT,
  ultima_msg_grupo  TEXT,
  dias_sem_falar    INTEGER,
  tema_principal    TEXT,
  intencoes         TEXT,          -- JSON: ["voluntario","demanda"]
  completude        INTEGER NOT NULL DEFAULT 0,
  proxima_acao      TEXT,
  atualizado_em     INTEGER
);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- Abaixo-assinados da campanha (um por formulário do Meta Lead Ads).
CREATE TABLE IF NOT EXISTS abaixos (
  id         INTEGER PRIMARY KEY,
  form_id    TEXT UNIQUE,
  chave      TEXT NOT NULL,
  titulo     TEXT NOT NULL,
  bandeira   TEXT,
  temas      TEXT NOT NULL DEFAULT '[]',   -- JSON
  campanha   TEXT
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

-- Avisos para a equipe: saída de grupo, remoção, liderança nova etc.
CREATE TABLE IF NOT EXISTS alertas (
  id        INTEGER PRIMARY KEY,
  tipo      TEXT NOT NULL,           -- saiu_grupo | removido_grupo | entrou_grupo | atrito
  gravidade TEXT NOT NULL DEFAULT 'aviso',  -- info | aviso | critico
  pessoa_id INTEGER REFERENCES pessoas(id) ON DELETE CASCADE,
  grupo_id  INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  titulo    TEXT NOT NULL,
  detalhe   TEXT,
  dados     TEXT,                    -- JSON com o retrato da pessoa no momento
  lido      INTEGER NOT NULL DEFAULT 0,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerta_ts ON alertas(lido, ts DESC);

-- Fila de sincronização com o Firestore. Funciona offline e reprocessa sozinha.
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY,
  colecao    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  operacao   TEXT NOT NULL DEFAULT 'set',   -- set | delete
  carga      TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro       TEXT,
  criado_em  INTEGER NOT NULL,
  enviado_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_pendente ON outbox(enviado_em, id);
`);

// Migrações leves para bases criadas antes destas colunas existirem.
const colunas = (tabela) => db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
for (const [tabela, coluna, tipo] of [
  ['pessoas', 'uf', 'TEXT'],
  ['pessoas', 'cidade_bruta', 'TEXT'],
  ['pessoas', 'firestore_em', 'INTEGER'],
  // Conversa privada (1:1) além dos grupos.
  ['mensagens', 'de_mim', 'INTEGER NOT NULL DEFAULT 0'],   // enviada pela campanha
  ['mensagens', 'privada', 'INTEGER NOT NULL DEFAULT 0'],  // conversa 1:1
  ['mensagens', 'sentimento', 'TEXT'],
  ['mensagens', 'lida', 'INTEGER NOT NULL DEFAULT 1'],
  ['pessoas', 'ultimo_contato', 'INTEGER']                 // última troca no privado
]) {
  if (!colunas(tabela).includes(coluna)) {
    db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_msg_privada  ON mensagens(privada, ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_conversa ON mensagens(pessoa_id, privada, ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_nao_lida ON mensagens(lida, privada, ts DESC);

-- Fila de adição a grupo. Existe porque adicionar rápido derruba o número:
-- o trabalho é feito devagar, em segundo plano, e sobrevive a reinício.
CREATE TABLE IF NOT EXISTS fila_adicao (
  id            INTEGER PRIMARY KEY,
  grupo_id      INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  pessoa_id     INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  situacao      TEXT NOT NULL DEFAULT 'pendente',
  -- pendente | adicionado | convidado | falhou | cancelado
  metodo        TEXT,             -- direto | convite
  tentativas    INTEGER NOT NULL DEFAULT 0,
  erro          TEXT,
  criado_em     INTEGER NOT NULL,
  processado_em INTEGER,
  UNIQUE (grupo_id, pessoa_id)
);
CREATE INDEX IF NOT EXISTS idx_fila_pendente ON fila_adicao(situacao, id);

-- Estado da conversa privada do ponto de vista da equipe.
CREATE TABLE IF NOT EXISTS conversas (
  pessoa_id     INTEGER PRIMARY KEY REFERENCES pessoas(id) ON DELETE CASCADE,
  situacao      TEXT NOT NULL DEFAULT 'aberta',   -- aberta | aguardando | resolvida
  responsavel   TEXT,
  fixada        INTEGER NOT NULL DEFAULT 0,
  sentimento    TEXT,
  resumo        TEXT,
  atualizado_em INTEGER
);
`);

export function agora() {
  return Date.now();
}

export function setConfig(chave, valor) {
  db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .run(chave, String(valor));
}

export function getConfig(chave, padrao = null) {
  const linha = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return linha ? linha.valor : padrao;
}
