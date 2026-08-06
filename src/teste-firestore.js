// Teste da camada Firestore sem rede: um cliente falso com a mesma superfície
// do firebase-admin (collection/doc/batch/set/delete/commit).
// Verifica a fila, o lote, o retry e o formato dos documentos.
//
//   node --no-warnings=ExperimentalWarning src/teste-firestore.js

import { db } from './db.js';
import * as fb from './firestore.js';

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

// --------------------------------------------------------- cliente de mentira
function criarClienteFalso() {
  const armazem = new Map();      // "colecao/doc" -> dados
  const chamadas = { commits: 0, docs: 0 };
  let falharProxima = false;

  const cliente = {
    _armazem: armazem,
    _chamadas: chamadas,
    quebrarProximoCommit() { falharProxima = true; },
    settings() {},
    collection: (colecao) => ({
      doc: (id) => ({ _caminho: `${colecao}/${id}` })
    }),
    batch() {
      const operacoes = [];
      return {
        set(ref, dados) { operacoes.push(['set', ref._caminho, dados]); },
        delete(ref) { operacoes.push(['delete', ref._caminho]); },
        async commit() {
          if (falharProxima) { falharProxima = false; throw new Error('sem permissão (simulado)'); }
          if (operacoes.length > 500) throw new Error('lote acima de 500 operações');
          chamadas.commits++;
          for (const [op, caminho, dados] of operacoes) {
            chamadas.docs++;
            if (op === 'delete') armazem.delete(caminho);
            else armazem.set(caminho, dados);
          }
        }
      };
    }
  };
  return cliente;
}

/** Firestore rejeita undefined e arrays dentro de arrays. */
function validarValor(valor, caminho, problemas) {
  if (valor === undefined) { problemas.push(`${caminho} = undefined`); return; }
  if (valor === null || valor instanceof Date) return;
  if (Array.isArray(valor)) {
    for (const [i, item] of valor.entries()) {
      if (Array.isArray(item)) problemas.push(`${caminho}[${i}] é array dentro de array`);
      else validarValor(item, `${caminho}[${i}]`, problemas);
    }
    return;
  }
  if (typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) validarValor(v, `${caminho}.${k}`, problemas);
    return;
  }
  if (!['string', 'number', 'boolean'].includes(typeof valor)) {
    problemas.push(`${caminho} é ${typeof valor}`);
  }
}

// ------------------------------------------------------------------- execução
console.log('\nTeste da camada Firestore (cliente falso, sem rede)\n');

const totalPessoas = db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n;
if (!totalPessoas) {
  console.error('Base vazia. Rode "npm run producao" antes.\n');
  process.exit(1);
}

const cliente = criarClienteFalso();
await fb.iniciarFirebase({ clienteDeTeste: cliente });

console.log('1) Formato dos documentos');
const amostra = db.prepare(`
  SELECT p.id FROM pessoas p
   ORDER BY (SELECT COUNT(*) FROM assinaturas s WHERE s.pessoa_id = p.id) DESC LIMIT 25
`).all();
const problemas = [];
for (const { id } of amostra) validarValor(fb.montarPessoa(id), `pessoas/${id}`, problemas);
ok(problemas.length === 0, `25 documentos de pessoa com tipos válidos${problemas.length ? ` — ${problemas.slice(0, 3).join(', ')}` : ''}`);

const doc = fb.montarPessoa(amostra[0].id);
ok(typeof doc.telefone === 'string' && /^\d{12,13}$/.test(doc.telefone), `id do documento é o telefone (${doc.telefone})`);
ok(doc.perfil && typeof doc.perfil.engajamento === 'number', 'perfil embutido no documento');
ok(Array.isArray(doc.interesse.temas), 'interesse.temas é array (dá para filtrar com array-contains)');
ok(Array.isArray(doc.assinaturas) && doc.assinaturas.length > 0, `assinaturas embutidas (${doc.assinaturas.length})`);
ok(doc.atualizadoEm instanceof Date, 'atualizadoEm é Date (vira Timestamp no Firestore)');

console.log('\n2) Fila e envio em lote');
db.prepare('DELETE FROM outbox').run();
const resumo = fb.sincronizarTudo();
ok(resumo.pendentes > 0, `${resumo.pendentes} documentos enfileirados`);

let enviadosTotal = 0;
let lote;
do {
  lote = await fb.processarFila();
  enviadosTotal += lote.enviados;
} while (lote.enviados > 0);

ok(enviadosTotal === resumo.pendentes, `todos enviados (${enviadosTotal}/${resumo.pendentes})`);
ok(cliente._armazem.size === enviadosTotal, `${cliente._armazem.size} documentos gravados no destino`);
ok(cliente._chamadas.commits >= Math.ceil(enviadosTotal / 400), `enviados em ${cliente._chamadas.commits} lote(s), nenhum acima de 500`);
ok(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL').get().n === 0, 'fila zerada');

// A fila serializa em JSON no meio do caminho. Se as datas não forem
// reconstruídas, elas chegam ao Firestore como string em vez de Timestamp.
const gravado = cliente._armazem.get(`pessoas/${doc.telefone}`);
ok(gravado?.atualizadoEm instanceof Date,
  `atualizadoEm chega como Date depois da fila (${gravado?.atualizadoEm?.constructor?.name})`);
ok(gravado?.cadastroEm instanceof Date, 'cadastroEm sobrevive à serialização');
ok(gravado?.assinaturas?.every((a) => a.em instanceof Date), 'datas dentro de arrays também');
// `atualizadoEm` é gerado a cada montagem, então compara-se uma data estável.
ok(gravado?.cadastroEm?.getTime() === doc.cadastroEm.getTime(),
  `valor da data preservado (${gravado?.cadastroEm?.toISOString()})`);

const colecoes = [...cliente._armazem.keys()].reduce((acc, c) => {
  const nome = c.split('/')[0];
  acc[nome] = (acc[nome] || 0) + 1;
  return acc;
}, {});
console.log('     coleções gravadas:', Object.entries(colecoes).map(([k, v]) => `${k}=${v}`).join(' · '));
ok(colecoes.pessoas === totalPessoas, `uma linha por pessoa (${colecoes.pessoas} = ${totalPessoas})`);
ok(!colecoes.mensagens, 'mensagens NÃO espelhadas por padrão (economiza cota)');

console.log('\n3) Deduplicação da fila');
const alvo = amostra[0].id;
fb.publicarPessoa(alvo);
fb.publicarPessoa(alvo);
fb.publicarPessoa(alvo);
ok(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL').get().n === 1,
  '3 publicações do mesmo documento viram 1 na fila');
await fb.processarFila();

console.log('\n4) Falha de rede não perde dado');
fb.publicarPessoa(alvo);
cliente.quebrarProximoCommit();
const comErro = await fb.processarFila();
ok(comErro.enviados === 0 && Boolean(comErro.erro), `commit falhou de propósito: "${comErro.erro}"`);
ok(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL').get().n === 1,
  'documento continua na fila depois do erro');
const retry = await fb.processarFila();
ok(retry.enviados === 1, 'reenvio automático funcionou');

console.log('\n5) Documentos de alerta (saída de grupo)');
const grupoTeste = db.prepare('SELECT id FROM grupos LIMIT 1').get();
const idAlerta = db.prepare(`
  INSERT INTO alertas (tipo, gravidade, pessoa_id, grupo_id, titulo, detalhe, dados, ts)
  VALUES ('saiu_grupo','critico',?,?,'Teste saiu do grupo','detalhe','{"assinou":["x"]}',?)
`).run(alvo, grupoTeste?.id ?? null, Date.now()).lastInsertRowid;
fb.publicarAlerta(Number(idAlerta));
await fb.processarFila();
const alertaGravado = cliente._armazem.get(`alertas/${idAlerta}`);
ok(Boolean(alertaGravado), 'alerta chegou na coleção alertas');
ok(alertaGravado?.tipo === 'saiu_grupo' && alertaGravado?.pessoa?.telefone, 'alerta traz tipo e a pessoa junto');
db.prepare('DELETE FROM alertas WHERE id = ?').run(idAlerta);

console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Tudo certo — a camada Firestore está pronta para receber a credencial.'}\n`);
process.exit(falhas ? 1 : 0);
