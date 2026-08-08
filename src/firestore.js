// Ponte com o Firebase (Firestore).
//
// Arquitetura: o SQLite local continua sendo o motor analítico (é ele que faz
// os cruzamentos e o score em milissegundos). O Firestore é a **base de
// produção**: onde os dados ficam de verdade, compartilhados entre a equipe,
// acessíveis por app/painel externo e com backup do Google.
//
// Toda escrita passa por uma outbox no SQLite. Se o Firebase estiver fora do ar
// (ou nem configurado ainda), nada se perde: a fila reprocessa sozinha.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { db, agora, setConfig, getConfig, RAIZ, campanhaAtual, comCampanha } from './db.js';
import { porCampanha } from './porcampanha.js';
import { configDaCampanha } from './contas.js';

export const COLECOES = {
  pessoas: 'pessoas',
  grupos: 'grupos',
  abaixos: 'abaixos',
  assinaturas: 'assinaturas',
  eventos: 'eventos',
  alertas: 'alertas',
  mensagens: 'mensagens'
};

// Um cliente, um estado e um loop por campanha: a Cláudia escreve no Firebase
// dela, o Fernando no dele. Nunca compartilham conexão.
const conexoes = porCampanha(() => ({
  cliente: null,
  temporizador: null,
  emAndamento: null,
  estado: {
    configurado: false,
    conectado: false,
    projeto: null,
    prefixo: null,
    erro: null,
    pendentes: 0,
    enviados: 0,
    ultimoEnvio: null,
    espelharMensagens: false
  }
}));

/** Estado do Firebase da campanha ativa. */
export const estadoDoFirebase = () => conexoes.atual().estado;

// --------------------------------------------------------------------- setup
function carregarEnv() {
  try { process.loadEnvFile(join(RAIZ, '.env')); } catch { /* sem .env, usa o ambiente */ }
}

function resolverCaminho(caminho) {
  if (!caminho) return null;
  return isAbsolute(caminho) ? caminho : join(RAIZ, caminho);
}

/**
 * A chave só vem do .env quando a campanha declara `firebase_prefixo` — ou seja,
 * quando ela ASSUMIU compartilhar o projeto e ficar numa subcoleção própria.
 * Sem isso, campanha sem chave própria não conecta: escrever a base do Fernando
 * dentro do projeto da Cláudia seria pior do que não sincronizar.
 */
function credenciais(slug, estado) {
  const config = configDaCampanha(slug);
  const compartilhado = Boolean(config?.firebasePrefixo);
  const caminho = config?.firebaseKey
    ?? (compartilhado
      ? resolverCaminho(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS)
      : null);

  if (!caminho && !compartilhado) {
    estado.erro = 'Esta campanha ainda não tem projeto do Firebase. '
      + 'Coloque a chave em data/campanhas/' + slug + '/firebase-key.json e rode '
      + '"npm run configurar -- --firebase ' + slug + '".';
    return null;
  }

  if (caminho && existsSync(caminho)) return JSON.parse(readFileSync(caminho, 'utf8'));
  if (compartilhado && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  if (caminho) estado.erro = `Chave não encontrada em ${caminho}`;
  return null;
}

/**
 * Duas formas de isolar os dados de cada candidato no Firebase:
 *   1. projeto próprio  — cada campanha com a sua chave (recomendado);
 *   2. projeto único    — mesma chave, coleções sob campanhas/<slug>/…
 * O caminho abaixo resolve as duas.
 */
function caminhoDaColecao(slug, colecao) {
  const config = configDaCampanha(slug);
  const prefixo = config?.firebasePrefixo;
  return prefixo ? `${prefixo}/${slug}/${colecao}` : colecao;
}

/**
 * `clienteDeTeste` existe para os testes automatizados exercitarem a fila
 * inteira sem depender de rede nem do emulador (que precisa de Java).
 */
export async function iniciarFirebase({ clienteDeTeste = null } = {}) {
  carregarEnv();
  const slug = campanhaAtual();
  const conexao = conexoes.atual();
  const { estado } = conexao;

  estado.espelharMensagens = process.env.FIRESTORE_ESPELHAR_MENSAGENS === 'true';
  atualizarPendentes();

  if (clienteDeTeste) {
    conexao.cliente = clienteDeTeste;
    Object.assign(estado, {
      configurado: true, conectado: true, projeto: 'projeto-de-teste', erro: null
    });
    return true;
  }

  const conta = credenciais(slug, estado);
  const projeto = conta?.project_id || process.env.FIREBASE_PROJECT_ID || null;

  if (!conta && !process.env.FIRESTORE_EMULATOR_HOST) {
    estado.configurado = false;
    estado.conectado = false;
    estado.erro = estado.erro || 'Chave do Firebase não configurada para esta campanha.';
    return false;
  }

  try {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');

    // Um app nomeado por campanha — o SDK permite vários lado a lado.
    const nomeApp = `campanha-${slug}`;
    const app = getApps().find((a) => a.name === nomeApp)
      ?? initializeApp(conta ? { credential: cert(conta), projectId: projeto } : { projectId: projeto }, nomeApp);

    conexao.cliente = getFirestore(app);
    conexao.cliente.settings({ ignoreUndefinedProperties: true });

    estado.configurado = true;
    estado.projeto = projeto;
    estado.prefixo = configDaCampanha(slug)?.firebasePrefixo ?? null;
    estado.erro = null;

    // Ping real: confirma credencial e permissão antes de dizer "conectado".
    await conexao.cliente.collection('_saude').doc('ping')
      .set({ em: new Date(), origem: 'rede-apoio', campanha: slug });
    estado.conectado = true;
    console.log(`[firebase:${slug}] conectado ao projeto ${projeto}`);

    iniciarLoop(slug);
    return true;
  } catch (erro) {
    estado.configurado = Boolean(conta);
    estado.conectado = false;
    estado.erro = erro.message;
    console.error(`[firebase:${slug}] falha ao conectar:`, erro.message);
    return false;
  }
}

function iniciarLoop(slug) {
  const conexao = conexoes.de(slug);
  if (conexao.temporizador) return;
  const intervalo = Number(process.env.FIRESTORE_INTERVALO_MS || 15_000);
  conexao.temporizador = setInterval(() => {
    comCampanha(slug, () => processarFila().catch(() => {}));
  }, intervalo);
  conexao.temporizador.unref?.();
  processarFila().catch(() => {});
}

export function desligarFirebase(slug) {
  const conexao = conexoes.de(slug);
  if (conexao.temporizador) clearInterval(conexao.temporizador);
  conexao.temporizador = null;
  conexao.cliente = null;
  conexao.estado.conectado = false;
}

// -------------------------------------------------------------------- outbox
//
// A fila guarda o documento como JSON, e JSON não tem tipo data: um `Date`
// viraria string e chegaria ao Firestore como texto, não como Timestamp.
// Por isso as datas são marcadas na ida e reconstruídas na volta.
function serializar(dados) {
  return JSON.stringify(dados, function (chave, valor) {
    const original = this[chave];          // antes do toJSON() do Date
    return original instanceof Date ? { __data: original.toISOString() } : valor;
  });
}

function desserializar(texto) {
  return JSON.parse(texto, (_chave, valor) =>
    (valor && typeof valor === 'object' && typeof valor.__data === 'string')
      ? new Date(valor.__data)
      : valor);
}

const inserirFila = () => db.prepare(
  `INSERT INTO outbox (colecao, doc_id, operacao, carga, criado_em) VALUES (?, ?, ?, ?, ?)`
);

function atualizarPendentes() {
  conexoes.atual().estado.pendentes = db.prepare(
    'SELECT COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL'
  ).get().n;
}

export function enfileirar(colecao, docId, dados, operacao = 'set') {
  if (colecao === COLECOES.mensagens && !conexoes.atual().estado.espelharMensagens) return;
  // Substitui um envio pendente do mesmo documento em vez de empilhar versões.
  db.prepare('DELETE FROM outbox WHERE colecao = ? AND doc_id = ? AND enviado_em IS NULL')
    .run(colecao, docId);
  inserirFila().run(colecao, docId, operacao, dados ? serializar(dados) : null, agora());
  atualizarPendentes();
}

export async function processarFila({ limite = 400 } = {}) {
  const conexao = conexoes.atual();
  if (!conexao.cliente) return { enviados: 0 };
  // Se já existe um envio em curso (o loop de fundo, por exemplo), espera por
  // ele em vez de devolver 0 — senão quem chamou acha que a fila esvaziou.
  if (conexao.emAndamento) return conexao.emAndamento;
  conexao.emAndamento = enviarLote(limite, campanhaAtual());
  try {
    return await conexao.emAndamento;
  } finally {
    conexao.emAndamento = null;
  }
}

async function enviarLote(limite, slug) {
  const conexao = conexoes.de(slug);
  const { cliente: firestore, estado: estadoFirebase } = conexao;
  try {
    const pendentes = db.prepare(
      'SELECT id, colecao, doc_id, operacao, carga FROM outbox WHERE enviado_em IS NULL ORDER BY id LIMIT ?'
    ).all(limite);
    if (!pendentes.length) return { enviados: 0 };

    const lote = firestore.batch();
    for (const item of pendentes) {
      const ref = firestore.collection(caminhoDaColecao(slug, item.colecao)).doc(item.doc_id);
      if (item.operacao === 'delete') lote.delete(ref);
      else lote.set(ref, desserializar(item.carga), { merge: true });
    }
    await lote.commit();

    const marcar = db.prepare('UPDATE outbox SET enviado_em = ?, erro = NULL WHERE id = ?');
    const em = agora();
    db.exec('BEGIN');
    for (const item of pendentes) marcar.run(em, item.id);
    db.exec('COMMIT');

    estadoFirebase.enviados += pendentes.length;
    estadoFirebase.ultimoEnvio = em;
    estadoFirebase.conectado = true;
    estadoFirebase.erro = null;
    setConfig('firestore_ultimo_envio', em);
    atualizarPendentes();

    // Limpa o histórico já enviado para a fila não crescer sem fim.
    db.prepare('DELETE FROM outbox WHERE enviado_em IS NOT NULL AND enviado_em < ?')
      .run(em - 7 * 86_400_000);

    return { enviados: pendentes.length };
  } catch (erro) {
    estadoFirebase.conectado = false;
    estadoFirebase.erro = erro.message;
    db.prepare(
      'UPDATE outbox SET tentativas = tentativas + 1, erro = ? WHERE enviado_em IS NULL'
    ).run(erro.message);
    console.error('[firebase] erro ao enviar lote:', erro.message);
    return { enviados: 0, erro: erro.message };
  }
}

// ------------------------------------------------------- montagem dos documentos
const jsonSeguro = (texto, padrao) => {
  try { return texto ? JSON.parse(texto) : padrao; } catch { return padrao; }
};

/**
 * O documento da pessoa é desnormalizado de propósito: quem abrir o Firestore
 * (ou um app da equipe) vê a ficha inteira sem precisar de join.
 */
export function montarPessoa(pessoaId) {
  const p = db.prepare(`
    SELECT p.*, f.engajamento, f.faixa, f.msgs_total, f.msgs_30d, f.msgs_7d,
           f.reacoes_dadas, f.reacoes_recebidas, f.respostas_dadas, f.respostas_recebidas,
           f.grupos_count, f.ultima_msg_ts, f.ultima_msg_texto, f.ultima_msg_grupo,
           f.dias_sem_falar, f.tema_principal, f.intencoes, f.completude, f.proxima_acao
      FROM pessoas p LEFT JOIN perfil f ON f.pessoa_id = p.id
     WHERE p.id = ?
  `).get(pessoaId);
  if (!p) return null;

  const temas = db.prepare(
    'SELECT tema, score, mencoes FROM temas_pessoa WHERE pessoa_id = ? ORDER BY score DESC'
  ).all(pessoaId);

  const tags = db.prepare(
    `SELECT t.nome FROM tags t JOIN pessoa_tags pt ON pt.tag_id = t.id WHERE pt.pessoa_id = ?`
  ).all(pessoaId).map((t) => t.nome);

  const grupos = db.prepare(
    `SELECT g.nome, g.wa_jid, m.admin, m.entrou_em, m.saiu_em FROM grupos g
       JOIN membros m ON m.grupo_id = g.id WHERE m.pessoa_id = ?`
  ).all(pessoaId);

  const assinaturas = db.prepare(
    `SELECT a.lead_id, a.criado_em, a.plataforma, a.anuncio, ab.titulo, ab.chave, ab.bandeira
       FROM assinaturas a JOIN abaixos ab ON ab.id = a.abaixo_id
      WHERE a.pessoa_id = ? ORDER BY a.criado_em`
  ).all(pessoaId);

  return {
    telefone: p.telefone,
    waJid: p.wa_jid,
    nome: p.nome,
    nomeWhatsapp: p.nome_wa,
    cidade: p.cidade,
    uf: p.uf,
    bairro: p.bairro,
    cidadeInformada: p.cidade_bruta,
    atuacao: p.atuacao,
    email: p.email,
    origem: p.origem,
    observacoes: p.observacoes,
    cadastroEm: p.cadastro_em ? new Date(p.cadastro_em) : null,
    primeiroVisto: p.primeiro_visto ? new Date(p.primeiro_visto) : null,
    perfil: {
      engajamento: p.engajamento ?? 0,
      classificacao: p.faixa ?? 'Observador',
      completude: p.completude ?? 0,
      proximaAcao: p.proxima_acao ?? null,
      mensagensTotal: p.msgs_total ?? 0,
      mensagens30d: p.msgs_30d ?? 0,
      mensagens7d: p.msgs_7d ?? 0,
      reacoesRecebidas: p.reacoes_recebidas ?? 0,
      respostasRecebidas: p.respostas_recebidas ?? 0,
      gruposCount: p.grupos_count ?? 0,
      diasSemFalar: p.dias_sem_falar ?? null,
      ultimaResposta: p.ultima_msg_ts
        ? { em: new Date(p.ultima_msg_ts), texto: p.ultima_msg_texto, grupo: p.ultima_msg_grupo }
        : null
    },
    interesse: {
      temaPrincipal: p.tema_principal,
      temas: temas.map((t) => t.tema),
      temasDetalhe: temas,
      intencoes: jsonSeguro(p.intencoes, [])
    },
    tags,
    grupos: grupos.map((g) => ({
      nome: g.nome, jid: g.wa_jid, admin: Boolean(g.admin),
      entrouEm: g.entrou_em ? new Date(g.entrou_em) : null,
      saiuEm: g.saiu_em ? new Date(g.saiu_em) : null,
      ativo: !g.saiu_em
    })),
    assinaturas: assinaturas.map((a) => ({
      leadId: a.lead_id, abaixoAssinado: a.titulo, chave: a.chave,
      bandeira: a.bandeira, plataforma: a.plataforma, anuncio: a.anuncio,
      em: new Date(a.criado_em)
    })),
    // Campos derivados que facilitam consulta direto no Firestore.
    busca: [p.nome, p.nome_wa, p.cidade, p.atuacao, p.telefone]
      .filter(Boolean).join(' ').toLowerCase(),
    atualizadoEm: new Date()
  };
}

export function montarGrupo(grupoId) {
  const g = db.prepare('SELECT * FROM grupos WHERE id = ?').get(grupoId);
  if (!g) return null;
  const membros = db.prepare(
    'SELECT COUNT(*) AS n FROM membros WHERE grupo_id = ? AND saiu_em IS NULL'
  ).get(grupoId).n;
  return {
    jid: g.wa_jid,
    nome: g.nome,
    descricao: g.descricao,
    membros,
    criadoEm: g.criado_em ? new Date(g.criado_em) : null,
    ativo: Boolean(g.ativo),
    atualizadoEm: new Date()
  };
}

export function montarAlerta(alertaId) {
  const a = db.prepare(`
    SELECT a.*, p.telefone, p.nome, p.nome_wa, g.nome AS grupo
      FROM alertas a
      LEFT JOIN pessoas p ON p.id = a.pessoa_id
      LEFT JOIN grupos g ON g.id = a.grupo_id
     WHERE a.id = ?
  `).get(alertaId);
  if (!a) return null;
  return {
    tipo: a.tipo,
    gravidade: a.gravidade,
    titulo: a.titulo,
    detalhe: a.detalhe,
    pessoa: a.telefone ? { telefone: a.telefone, nome: a.nome || a.nome_wa } : null,
    grupo: a.grupo || null,
    dados: jsonSeguro(a.dados, null),
    lido: Boolean(a.lido),
    em: new Date(a.ts)
  };
}

// ------------------------------------------------------------- API de escrita
export function publicarPessoa(pessoaId) {
  const doc = montarPessoa(pessoaId);
  if (!doc?.telefone) return;
  enfileirar(COLECOES.pessoas, doc.telefone, doc);
  db.prepare('UPDATE pessoas SET firestore_em = ? WHERE id = ?').run(agora(), pessoaId);
}

export function publicarGrupo(grupoId) {
  const doc = montarGrupo(grupoId);
  if (doc?.jid) enfileirar(COLECOES.grupos, doc.jid, doc);
}

export function publicarAlerta(alertaId) {
  const doc = montarAlerta(alertaId);
  if (doc) enfileirar(COLECOES.alertas, String(alertaId), doc);
}

export function publicarAbaixo(abaixoId) {
  const a = db.prepare('SELECT * FROM abaixos WHERE id = ?').get(abaixoId);
  if (!a) return;
  const assinaturas = db.prepare(
    'SELECT COUNT(*) AS n FROM assinaturas WHERE abaixo_id = ?'
  ).get(abaixoId).n;
  enfileirar(COLECOES.abaixos, a.chave, {
    formId: a.form_id,
    chave: a.chave,
    titulo: a.titulo,
    bandeira: a.bandeira,
    campanha: a.campanha,
    temas: jsonSeguro(a.temas, []),
    assinaturas,
    atualizadoEm: new Date()
  });
}

export function publicarAssinatura(assinaturaId) {
  const a = db.prepare(`
    SELECT a.*, ab.chave, ab.titulo, p.telefone, p.nome
      FROM assinaturas a
      JOIN abaixos ab ON ab.id = a.abaixo_id
      JOIN pessoas p ON p.id = a.pessoa_id
     WHERE a.id = ?
  `).get(assinaturaId);
  if (!a) return;
  enfileirar(COLECOES.assinaturas, a.lead_id, {
    leadId: a.lead_id,
    abaixoAssinado: a.titulo,
    abaixoChave: a.chave,
    telefone: a.telefone,
    nome: a.nome,
    cidadeInformada: a.cidade_bruta,
    atuacao: a.atuacao,
    plataforma: a.plataforma,
    organico: Boolean(a.organico),
    anuncio: a.anuncio,
    conjunto: a.conjunto,
    status: a.status,
    em: new Date(a.criado_em)
  });
}

export function publicarEvento(pessoaId, evento) {
  enfileirar(COLECOES.eventos, `${pessoaId}-${evento.ts}-${evento.tipo}`, {
    pessoaId: String(pessoaId),
    telefone: db.prepare('SELECT telefone FROM pessoas WHERE id = ?').get(pessoaId)?.telefone ?? null,
    tipo: evento.tipo,
    descricao: evento.descricao,
    em: new Date(evento.ts)
  });
}

/** Empurra a base inteira. Usado no primeiro carregamento e no botão "sincronizar tudo". */
export function sincronizarTudo() {
  const pessoas = db.prepare('SELECT id FROM pessoas').all();
  for (const p of pessoas) publicarPessoa(p.id);
  for (const g of db.prepare('SELECT id FROM grupos').all()) publicarGrupo(g.id);
  for (const a of db.prepare('SELECT id FROM abaixos').all()) publicarAbaixo(a.id);
  for (const a of db.prepare('SELECT id FROM assinaturas').all()) publicarAssinatura(a.id);
  for (const a of db.prepare('SELECT id FROM alertas ORDER BY id DESC LIMIT 200').all()) publicarAlerta(a.id);
  atualizarPendentes();
  return { pessoas: pessoas.length, pendentes: conexoes.atual().estado.pendentes };
}

export function statusFirebase() {
  atualizarPendentes();
  const estado = conexoes.atual().estado;
  return {
    ...estado,
    campanha: campanhaAtual(),
    ultimoEnvio: estado.ultimoEnvio || Number(getConfig('firestore_ultimo_envio', 0)) || null,
    erros: db.prepare(
      'SELECT erro, COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL AND erro IS NOT NULL GROUP BY erro LIMIT 3'
    ).all()
  };
}
