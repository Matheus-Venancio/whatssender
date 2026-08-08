// Remove da base os leads que não são do estado escolhido.
//
//   npm run filtrar-uf                 -> só mostra o que sairia (não apaga nada)
//   npm run filtrar-uf -- --confirmar  -> apaga de verdade, aqui e no Firestore
//   npm run filtrar-uf -- --uf RJ --confirmar
//
// Regras de segurança embutidas:
//   · só mexe em quem assinou abaixo-assinado (lead). Membro de grupo que nunca
//     assinou não é tocado — ele entrou pelo WhatsApp, não pela campanha de anúncio.
//   · quem já está em algum grupo é preservado por padrão: tirar da base alguém
//     que está no grupo deixa o sistema cego para aquela pessoa.

import { db, usarCampanha } from './db.js';
import * as fb from './firestore.js';

// Estes scripts rodam sobre UMA campanha. Escolha com a variável CAMPANHA;
// sem ela, usa a primeira encontrada em data/campanhas/.
const CAMPANHA = usarCampanha();

const argumento = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};

const UF_MANTIDA = argumento('uf', 'SP').toUpperCase();
const CONFIRMAR = process.argv.includes('--confirmar');
const INCLUIR_EM_GRUPO = process.argv.includes('--incluir-membros-de-grupo');

const CONDICAO = `
  EXISTS (SELECT 1 FROM assinaturas s WHERE s.pessoa_id = p.id)
  AND (p.uf IS NULL OR p.uf <> ?)
  ${INCLUIR_EM_GRUPO ? '' : 'AND NOT EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.saiu_em IS NULL)'}
`;

const alvos = db.prepare(`
  SELECT p.id, p.telefone, p.nome, p.uf, p.cidade,
         (SELECT COUNT(*) FROM assinaturas s WHERE s.pessoa_id = p.id) AS assinaturas
    FROM pessoas p WHERE ${CONDICAO} ORDER BY p.uf, p.nome
`).all(UF_MANTIDA);

const porUf = alvos.reduce((acc, p) => {
  const k = p.uf || '(sem uf)';
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

console.log(`\nMantendo apenas leads de ${UF_MANTIDA}\n`);
console.log('Sairiam da base:');
for (const [uf, n] of Object.entries(porUf).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${uf.padEnd(10)} ${n}`);
}
console.log(`   ${'TOTAL'.padEnd(10)} ${alvos.length} pessoas`);

const preservados = db.prepare(`
  SELECT COUNT(*) AS n FROM pessoas p
   WHERE EXISTS (SELECT 1 FROM assinaturas s WHERE s.pessoa_id = p.id)
     AND (p.uf IS NULL OR p.uf <> ?)
     AND EXISTS (SELECT 1 FROM membros m WHERE m.pessoa_id = p.id AND m.saiu_em IS NULL)
`).get(UF_MANTIDA).n;

if (preservados && !INCLUIR_EM_GRUPO) {
  console.log(`\n   ⚠ ${preservados} pessoa(s) fora de ${UF_MANTIDA} foram PRESERVADAS por já estarem`);
  console.log('     em algum grupo do WhatsApp. Use --incluir-membros-de-grupo para apagar também.');
}

const naoLeads = db.prepare(
  'SELECT COUNT(*) AS n FROM pessoas p WHERE NOT EXISTS (SELECT 1 FROM assinaturas s WHERE s.pessoa_id = p.id)'
).get().n;
console.log(`\nNão serão tocadas: ${naoLeads} pessoas que vieram dos grupos e nunca assinaram.`);

if (!alvos.length) {
  console.log('\nNada a remover.\n');
  process.exit(0);
}

if (!CONFIRMAR) {
  console.log('\n── simulação ──  nada foi apagado.');
  console.log('Para apagar de verdade:  npm run filtrar-uf -- --confirmar\n');
  process.exit(0);
}

// --------------------------------------------------------------- executando
console.log('\n› removendo…');

// Antes de apagar localmente, junta as chaves para remover no Firestore.
const idsLista = alvos.map((p) => p.id).join(',');
const leads = db.prepare(
  `SELECT lead_id FROM assinaturas WHERE pessoa_id IN (${idsLista})`
).all().map((a) => a.lead_id);
const eventos = db.prepare(
  `SELECT pessoa_id, tipo, ts FROM eventos WHERE pessoa_id IN (${idsLista})`
).all();

await fb.iniciarFirebase();

for (const p of alvos) fb.enfileirar(fb.COLECOES.pessoas, p.telefone, null, 'delete');
for (const lead of leads) fb.enfileirar(fb.COLECOES.assinaturas, lead, null, 'delete');
for (const e of eventos) {
  fb.enfileirar(fb.COLECOES.eventos, `${e.pessoa_id}-${e.ts}-${e.tipo}`, null, 'delete');
}

// ON DELETE CASCADE cuida de assinaturas, eventos, perfil, temas e tags.
db.exec('BEGIN');
try {
  db.prepare(`DELETE FROM pessoas WHERE id IN (${idsLista})`).run();
  db.exec('COMMIT');
} catch (erro) {
  db.exec('ROLLBACK');
  console.error('\n❌ falha ao apagar:', erro.message, '\n');
  process.exit(1);
}

const { recomputar } = await import('./scoring.js');
recomputar();

let enviados = 0;
if (fb.estadoDoFirebase().conectado) {
  let lote;
  do { lote = await fb.processarFila(); enviados += lote.enviados; } while (lote.enviados > 0);
}

const restam = db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n;
const restamLeads = db.prepare(
  'SELECT COUNT(*) AS n FROM pessoas p WHERE EXISTS (SELECT 1 FROM assinaturas s WHERE s.pessoa_id = p.id)'
).get().n;

console.log(`
✅ ${alvos.length} pessoas removidas (${leads.length} assinaturas)
   Base agora: ${restam} pessoas · ${restamLeads} leads
   Firestore: ${enviados} exclusões aplicadas
`);
process.exit(0);
