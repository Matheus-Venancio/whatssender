import { db, agora } from './db.js';
import { TEMAS, INTENCOES, classificarTexto } from './lexicon.js';
import { DDD_UF } from './leads.js';

/** "5519999998888@s.whatsapp.net" -> "5519999998888" */
export function telefoneDoJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Formata para leitura humana: +55 (19) 99999-8888 */
/**
 * Máscara brasileira só para número brasileiro. Aplicá-la em tudo produzia
 * aberrações como "+17 (01) 92491-532388" para um número dos EUA, e dava a
 * impressão de que a base estava corrompida quando o dado estava certo.
 */
export function formatarTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (!d) return tel || '';

  const brasileiro = d.startsWith('55') && (d.length === 12 || d.length === 13);
  if (brasileiro) {
    const ddd = d.slice(2, 4);
    const resto = d.slice(4);
    const corte = resto.length > 8 ? 5 : 4;
    return `+55 (${ddd}) ${resto.slice(0, corte)}-${resto.slice(corte)}`;
  }

  // Identificador interno do WhatsApp (LID), não um telefone.
  if (d.length > 14) return `id ${d}`;

  // Estrangeiro: agrupa em blocos legíveis sem inventar DDD.
  return `+${d.replace(/(\d{1,3})(\d{3})(\d+)/, '$1 $2 $3')}`;
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
  const ja = db.prepare('SELECT saiu_em FROM membros WHERE pessoa_id = ? AND grupo_id = ?').get(pessoaId, grupoId);
  if (ja) {
    if (ja.saiu_em != null) {
      db.prepare('UPDATE membros SET saiu_em = NULL, entrou_em = ? WHERE pessoa_id = ? AND grupo_id = ?')
        .run(entrouEm, pessoaId, grupoId);
      return true;
    }
    return false;
  }
  db.prepare('INSERT INTO membros (pessoa_id, grupo_id, entrou_em, admin) VALUES (?, ?, ?, ?)')
    .run(pessoaId, grupoId, entrouEm, admin ? 1 : 0);
  return true;
}

export function registrarMensagem({
  waId, grupoId, pessoaId, tipo = 'texto', texto, respondeA = null, ts = agora(),
  deMim = false, privada = false, sentimento = null, lida = !privada || deMim
}) {
  const r = db.prepare(
    `INSERT OR IGNORE INTO mensagens
       (wa_id, grupo_id, pessoa_id, tipo, texto, responde_a, ts, de_mim, privada, sentimento, lida)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(waId, grupoId, pessoaId, tipo, texto, respondeA, ts, deMim ? 1 : 0, privada ? 1 : 0, sentimento, lida ? 1 : 0);
  return r.changes > 0 ? Number(r.lastInsertRowid) : null;
}

export function registrarReacao({ mensagemId, pessoaId, emoji, ts = agora() }) {
  db.prepare(
    `INSERT INTO reacoes (mensagem_id, pessoa_id, emoji, ts) VALUES (?, ?, ?, ?)
     ON CONFLICT(mensagem_id, pessoa_id) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`
  ).run(mensagemId, pessoaId, emoji, ts);
}

export function registrarEvento({ pessoaId, tipo, descricao = null, dados = null, ts = agora() }) {
  db.prepare(
    `INSERT INTO eventos (pessoa_id, tipo, descricao, dados, ts) VALUES (?, ?, ?, ?, ?)`
  ).run(pessoaId, tipo, descricao, dados ? JSON.stringify(dados) : null, ts);
}

export function registrarAlerta({ tipo, gravidade = 'info', pessoaId = null, grupoId = null, titulo, detalhe = null, dados = null, ts = agora() }) {
  const r = db.prepare(
    `INSERT INTO alertas (tipo, gravidade, pessoa_id, grupo_id, titulo, detalhe, dados, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tipo, gravidade, pessoaId, grupoId, titulo, detalhe, dados ? JSON.stringify(dados) : null, ts);
  return Number(r.lastInsertRowid);
}

export function retratoDaPessoa(pessoaId) {
  // A tabela de perfil se chama `faixa`, não `classificacao`, e liga por
  // `pessoa_id`. O alerta depende deste retrato para saber se a saída dói.
  const p = db.prepare(`
    SELECT p.id, p.nome, p.nome_wa, p.telefone, p.cidade, p.uf, p.atuacao, p.cadastro_em,
           f.faixa, f.engajamento, f.msgs_total,
           f.ultima_msg_texto, f.ultima_msg_ts, f.tema_principal, f.intencoes
      FROM pessoas p LEFT JOIN perfil f ON f.pessoa_id = p.id
     WHERE p.id = ?
  `).get(pessoaId);
  if (!p) return {};

  const assinou = db.prepare(`
    SELECT ab.titulo FROM assinaturas s JOIN abaixos ab ON ab.id = s.abaixo_id
     WHERE s.pessoa_id = ?
  `).all(pessoaId).map((a) => a.titulo);

  const aindaEstaEm = db.prepare(`
    SELECT g.nome FROM membros m JOIN grupos g ON g.id = m.grupo_id
     WHERE m.pessoa_id = ? AND m.saiu_em IS NULL
  `).all(pessoaId).map((g) => g.nome);

  let intencoes = [];
  try { intencoes = JSON.parse(p.intencoes || '[]'); } catch { intencoes = []; }

  return {
    id: p.id,
    nome: p.nome || p.nome_wa || formatarTelefone(p.telefone),
    telefone: p.telefone,
    cidade: p.cidade,
    uf: p.uf,
    atuacao: p.atuacao,
    classificacao: p.faixa,
    engajamento: p.engajamento ?? 0,
    mensagens: p.msgs_total ?? 0,
    ultimaMensagem: p.ultima_msg_texto,
    ultimaMensagemEm: p.ultima_msg_ts,
    temaPrincipal: p.tema_principal,
    intencoes,
    cadastrado: Boolean(p.cadastro_em),
    assinou,
    aindaEstaEm
  };
}

/**
 * Abaixo-assinado / formulário de cadastro.
 * O telefone é a chave que costura o cadastro com quem já está nos grupos.
 */
// `nome`, `cidade` e `atuacao` têm padrão porque `undefined` faz o UPDATE
// falhar no node:sqlite — a pessoa entrava pelo INSERT e ficava sem nome e sem
// cadastro_em, isto é, invisível para o disparo. O formulário sempre manda os
// três; quem chama pela API, nem sempre.
export function salvarCadastro({ telefone, nome = null, cidade = null, bairro = null, atuacao = null, email = null, observacoes = null, ts = agora() }) {
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

/**
 * Formulário completo de perfilamento de pautas do apoiador.
 */
export function salvarFormularioPautas({
  nome, telefone, cidade, bairro = null, atuacao, email = null,
  pautas = [], intencao = 'apoiador', observacoes = null, ts = agora()
}) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.length < 10) throw new Error('Telefone inválido (mínimo 10 dígitos com DDD)');
  const completo = digitos.startsWith('55') ? digitos : `55${digitos}`;
  const jid = `${completo}@s.whatsapp.net`;

  let pessoa = db.prepare('SELECT id FROM pessoas WHERE wa_jid = ? OR telefone = ?').get(jid, completo);
  let novo = false;
  if (!pessoa) {
    novo = true;
    const r = db.prepare(
      `INSERT INTO pessoas (wa_jid, telefone, origem, primeiro_visto) VALUES (?, ?, 'formulario_pautas', ?)`
    ).run(jid, completo, ts);
    pessoa = { id: Number(r.lastInsertRowid) };
  }

  const uf = DDD_UF[Number(completo.slice(2, 4))] ?? null;

  db.prepare(
    `UPDATE pessoas SET nome = ?, cidade = ?, uf = COALESCE(uf, ?),
       bairro = COALESCE(?, bairro), atuacao = ?,
       email = COALESCE(?, email), observacoes = COALESCE(?, observacoes), cadastro_em = COALESCE(cadastro_em, ?)
     WHERE id = ?`
  ).run(nome, cidade, uf, bairro, atuacao, email, observacoes, ts, pessoa.id);

  const listaPautas = Array.isArray(pautas) ? pautas : (typeof pautas === 'string' ? [pautas] : []);
  for (const tema of listaPautas) {
    if (TEMAS[tema]) {
      db.prepare(`
        INSERT INTO interesses (pessoa_id, tema, acertos, ultimo_em)
        VALUES (?, ?, 5, ?)
        ON CONFLICT(pessoa_id, tema) DO UPDATE SET acertos = acertos + 5, ultimo_em = excluded.ultimo_em
      `).run(pessoa.id, tema, ts);
    }
  }

  if (intencao && INTENCOES[intencao]) {
    db.prepare(`
      INSERT INTO pessoa_intencoes (pessoa_id, intencao, peso, ultimo_em)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pessoa_id, intencao) DO UPDATE SET peso = max(peso, excluded.peso), ultimo_em = excluded.ultimo_em
    `).run(pessoa.id, intencao, INTENCOES[intencao].peso, ts);
  }

  const nomesPautas = listaPautas.map(t => TEMAS[t]?.rotulo || t).join(', ');
  const descEv = `Preencheu Formulário de Pautas ${nomesPautas ? `— Luta por: ${nomesPautas}` : ''}`;
  registrarEvento({
    pessoaId: pessoa.id,
    tipo: 'pesquisa_pautas',
    descricao: descEv,
    dados: { pautas: listaPautas, intencao },
    ts
  });

  const gruposAtivos = db.prepare('SELECT id, nome, descricao FROM grupos WHERE ativo = 1').all();
  let grupoRecomendado = null;
  if (gruposAtivos.length > 0) {
    const pautaPrincipal = listaPautas[0];
    const rotuloPrincipal = pautaPrincipal ? (TEMAS[pautaPrincipal]?.rotulo || '') : '';
    let match = gruposAtivos.find(g =>
      rotuloPrincipal && g.nome.toLowerCase().includes(rotuloPrincipal.toLowerCase())
    );
    if (!match) match = gruposAtivos[0];
    grupoRecomendado = match;
  }

  return {
    pessoaId: pessoa.id,
    nome,
    novo,
    pautaPrincipal: listaPautas[0] ? (TEMAS[listaPautas[0]]?.rotulo || listaPautas[0]) : 'Comunidade',
    pautasFormatadas: nomesPautas,
    grupoRecomendado
  };
}

/** Indexa uma mensagem em temas/intenções — usado pelo motor de scoring. */
export function analisar(texto) {
  return classificarTexto(texto);
}
