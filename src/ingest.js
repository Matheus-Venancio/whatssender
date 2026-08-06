import { db, agora } from './db.js';
import { classificarTexto } from './lexicon.js';
import { DDD_UF } from './leads.js';

/** "5519999998888@s.whatsapp.net" -> "5519999998888" */
export function telefoneDoJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Formata para leitura humana: +55 (19) 99999-8888 */
export function formatarTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (d.length < 12) return tel || '';
  const pais = d.slice(0, 2);
  const ddd = d.slice(2, 4);
  const resto = d.slice(4);
  const meio = resto.length > 8 ? resto.slice(0, 5) : resto.slice(0, 4);
  const fim = resto.length > 8 ? resto.slice(5) : resto.slice(4);
  return `+${pais} (${ddd}) ${meio}-${fim}`;
}

export function upsertPessoa({ jid, nomeWa = null, origem = 'grupo', ts = agora() }) {
  const telefone = telefoneDoJid(jid);
  const existente = db.prepare('SELECT id, nome_wa FROM pessoas WHERE wa_jid = ?').get(jid);
  if (existente) {
    if (nomeWa && nomeWa !== existente.nome_wa) {
      db.prepare('UPDATE pessoas SET nome_wa = ? WHERE id = ?').run(nomeWa, existente.id);
    }
    return existente.id;
  }
  const r = db.prepare(
    `INSERT INTO pessoas (wa_jid, telefone, nome_wa, origem, primeiro_visto)
     VALUES (?, ?, ?, ?, ?)`
  ).run(jid, telefone, nomeWa, origem, ts);
  return Number(r.lastInsertRowid);
}

export function upsertGrupo({ jid, nome, descricao = null, criadoEm = agora() }) {
  const existente = db.prepare('SELECT id FROM grupos WHERE wa_jid = ?').get(jid);
  if (existente) {
    db.prepare('UPDATE grupos SET nome = ?, descricao = COALESCE(?, descricao) WHERE id = ?')
      .run(nome, descricao, existente.id);
    return existente.id;
  }
  const r = db.prepare('INSERT INTO grupos (wa_jid, nome, descricao, criado_em) VALUES (?, ?, ?, ?)')
    .run(jid, nome, descricao, criadoEm);
  return Number(r.lastInsertRowid);
}

export function vincularMembro({ pessoaId, grupoId, entrouEm = agora(), admin = false, nomeGrupo = null }) {
  const ja = db.prepare('SELECT 1 FROM membros WHERE pessoa_id = ? AND grupo_id = ?')
    .get(pessoaId, grupoId);
  if (ja) {
    db.prepare('UPDATE membros SET admin = ? WHERE pessoa_id = ? AND grupo_id = ?')
      .run(admin ? 1 : 0, pessoaId, grupoId);
    return false;
  }
  db.prepare('INSERT INTO membros (pessoa_id, grupo_id, entrou_em, admin) VALUES (?, ?, ?, ?)')
    .run(pessoaId, grupoId, entrouEm, admin ? 1 : 0);
  registrarEvento({
    pessoaId,
    tipo: 'entrou_grupo',
    descricao: nomeGrupo ? `Entrou no grupo ${nomeGrupo}` : 'Entrou em um grupo',
    ts: entrouEm
  });
  return true;
}

export function registrarEvento({ pessoaId, tipo, descricao, ts = agora() }) {
  db.prepare('INSERT INTO eventos (pessoa_id, tipo, descricao, ts) VALUES (?, ?, ?, ?)')
    .run(pessoaId, tipo, descricao, ts);
}

/**
 * Cria um aviso para a equipe. O campo `dados` guarda o retrato da pessoa no
 * momento do evento — é o que diferencia "saiu um observador" de
 * "saiu uma embaixadora que assinou dois abaixo-assinados".
 */
export function registrarAlerta({
  tipo, gravidade = 'aviso', pessoaId = null, grupoId = null,
  titulo, detalhe = null, dados = null, ts = agora()
}) {
  const r = db.prepare(`
    INSERT INTO alertas (tipo, gravidade, pessoa_id, grupo_id, titulo, detalhe, dados, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tipo, gravidade, pessoaId, grupoId, titulo, detalhe,
    dados ? JSON.stringify(dados) : null, ts);
  return Number(r.lastInsertRowid);
}

/** Retrato usado dentro do alerta. */
export function retratoDaPessoa(pessoaId) {
  const p = db.prepare(`
    SELECT p.nome, p.nome_wa, p.telefone, p.cidade, p.uf, p.atuacao, p.cadastro_em,
           f.engajamento, f.faixa, f.msgs_total, f.ultima_msg_texto, f.ultima_msg_ts,
           f.tema_principal, f.intencoes
      FROM pessoas p LEFT JOIN perfil f ON f.pessoa_id = p.id WHERE p.id = ?
  `).get(pessoaId);
  if (!p) return null;

  const assinou = db.prepare(`
    SELECT ab.titulo FROM assinaturas a JOIN abaixos ab ON ab.id = a.abaixo_id
     WHERE a.pessoa_id = ?
  `).all(pessoaId).map((a) => a.titulo);

  const outrosGrupos = db.prepare(`
    SELECT g.nome FROM membros m JOIN grupos g ON g.id = m.grupo_id
     WHERE m.pessoa_id = ? AND m.saiu_em IS NULL
  `).all(pessoaId).map((g) => g.nome);

  let intencoes = [];
  try { intencoes = JSON.parse(p.intencoes || '[]'); } catch { intencoes = []; }

  return {
    nome: p.nome || p.nome_wa || formatarTelefone(p.telefone),
    telefone: p.telefone,
    cidade: p.cidade, uf: p.uf, atuacao: p.atuacao,
    classificacao: p.faixa, engajamento: p.engajamento ?? 0,
    mensagens: p.msgs_total ?? 0,
    ultimaMensagem: p.ultima_msg_texto,
    ultimaMensagemEm: p.ultima_msg_ts,
    temaPrincipal: p.tema_principal,
    intencoes,
    assinou,
    cadastrado: Boolean(p.cadastro_em),
    aindaEstaEm: outrosGrupos
  };
}

export function registrarMensagem({
  waId, grupoId, pessoaId, tipo = 'texto', texto = null, respondeA = null,
  ts = agora(), deMim = false, privada = false, sentimento = null, lida = null
}) {
  const r = db.prepare(
    `INSERT INTO mensagens (wa_id, grupo_id, pessoa_id, tipo, texto, responde_a, ts,
                            de_mim, privada, sentimento, lida)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wa_id) DO NOTHING`
  ).run(waId, grupoId, pessoaId, tipo, texto, respondeA, ts,
    deMim ? 1 : 0, privada ? 1 : 0, sentimento,
    // O que chega de fora numa conversa privada nasce não lido.
    lida != null ? (lida ? 1 : 0) : (privada && !deMim ? 0 : 1));

  if (privada) {
    db.prepare('UPDATE pessoas SET ultimo_contato = MAX(COALESCE(ultimo_contato, 0), ?) WHERE id = ?')
      .run(ts, pessoaId);
  }
  return r.changes ? Number(r.lastInsertRowid) : null;
}

export function registrarReacao({ mensagemId, pessoaId, emoji, ts = agora() }) {
  db.prepare(
    `INSERT INTO reacoes (mensagem_id, pessoa_id, emoji, ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(mensagem_id, pessoa_id) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`
  ).run(mensagemId, pessoaId, emoji, ts);
}

/**
 * Abaixo-assinado / formulário de cadastro.
 * O telefone é a chave que costura o cadastro com quem já está nos grupos.
 */
export function salvarCadastro({ telefone, nome, cidade, bairro = null, atuacao, email = null, observacoes = null, ts = agora() }) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.length < 10) throw new Error('Telefone inválido');
  const completo = digitos.startsWith('55') ? digitos : `55${digitos}`;
  const jid = `${completo}@s.whatsapp.net`;

  let pessoa = db.prepare('SELECT id FROM pessoas WHERE wa_jid = ? OR telefone = ?').get(jid, completo);
  let novo = false;
  if (!pessoa) {
    novo = true;
    const r = db.prepare(
      `INSERT INTO pessoas (wa_jid, telefone, origem, primeiro_visto) VALUES (?, ?, 'abaixo-assinado', ?)`
    ).run(jid, completo, ts);
    pessoa = { id: Number(r.lastInsertRowid) };
  }

  // O formulário não pergunta o estado — dá para deduzir pelo DDD.
  const uf = DDD_UF[Number(completo.slice(2, 4))] ?? null;

  db.prepare(
    `UPDATE pessoas SET nome = ?, cidade = ?, uf = COALESCE(uf, ?),
       bairro = COALESCE(?, bairro), atuacao = ?,
       email = COALESCE(?, email), observacoes = COALESCE(?, observacoes), cadastro_em = ?
     WHERE id = ?`
  ).run(nome, cidade, uf, bairro, atuacao, email, observacoes, ts, pessoa.id);

  registrarEvento({
    pessoaId: pessoa.id,
    tipo: 'assinou',
    descricao: `Assinou o abaixo-assinado — ${cidade}${atuacao ? ` · ${atuacao}` : ''}`,
    ts
  });

  return { pessoaId: pessoa.id, novo };
}

/** Indexa uma mensagem em temas/intenções — usado pelo motor de scoring. */
export function analisar(texto) {
  return classificarTexto(texto);
}
