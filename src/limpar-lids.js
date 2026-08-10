// Remove da base os "telefones" que na verdade são LIDs do WhatsApp.
//
//   npm run limpar-lids                -> mostra o que sairia
//   npm run limpar-lids -- --confirmar
//
// O LID é o identificador interno que o WhatsApp usa quando a pessoa esconde
// o número. Uma versão anterior do conector aceitava esse valor como telefone,
// criando pessoas-fantasma: aparecem na contagem, sujam a classificação e é
// impossível mandar mensagem para elas.
//
// Um número E.164 tem no máximo 15 dígitos, mas telefone brasileiro tem 12 ou
// 13 e nenhum país usa 15 com o formato que o WhatsApp gera para LID. O corte
// abaixo é conservador: só remove quem passa de 14 dígitos E nunca trocou
// mensagem (se falou, o registro é útil mesmo sem número utilizável).

import { db, usarCampanha } from './db.js';
import * as fb from './firestore.js';

const CAMPANHA = usarCampanha();
const CONFIRMAR = process.argv.includes('--confirmar');

const alvos = db.prepare(`
  SELECT p.id, p.telefone, p.origem,
         (SELECT COUNT(*) FROM mensagens m WHERE m.pessoa_id = p.id) AS mensagens,
         (SELECT COUNT(*) FROM membros mb WHERE mb.pessoa_id = p.id AND mb.saiu_em IS NULL) AS grupos
    FROM pessoas p
   WHERE LENGTH(p.telefone) > 14
     AND NOT EXISTS (SELECT 1 FROM assinaturas s WHERE s.pessoa_id = p.id)
`).all();

const semRastro = alvos.filter((p) => p.mensagens === 0);
const comMensagem = alvos.filter((p) => p.mensagens > 0);

console.log(`\nCampanha: ${CAMPANHA}\n`);
console.log(`Identificadores internos (LID) encontrados: ${alvos.length}`);
console.log(`  ${semRastro.length} nunca escreveram  → serão removidos`);
console.log(`  ${comMensagem.length} têm mensagens     → preservados (o histórico vale)`);

if (!semRastro.length) {
  console.log('\nNada a remover.\n');
  process.exit(0);
}

console.log('\namostra:');
for (const p of semRastro.slice(0, 5)) {
  console.log(`  ${p.telefone}  (${p.origem}, ${p.grupos} grupo(s))`);
}

if (!CONFIRMAR) {
  console.log('\n── simulação ── nada foi apagado.');
  console.log('Para aplicar:  npm run limpar-lids -- --confirmar\n');
  process.exit(0);
}

await fb.iniciarFirebase();
for (const p of semRastro) fb.enfileirar(fb.COLECOES.pessoas, p.telefone, null, 'delete');

const ids = semRastro.map((p) => p.id).join(',');
db.exec('BEGIN');
try {
  db.prepare(`DELETE FROM pessoas WHERE id IN (${ids})`).run();
  db.exec('COMMIT');
} catch (erro) {
  db.exec('ROLLBACK');
  console.error('\n❌ falha:', erro.message, '\n');
  process.exit(1);
}

const { recomputar } = await import('./scoring.js');
recomputar();

let enviados = 0;
if (fb.estadoDoFirebase().conectado) {
  let lote;
  do { lote = await fb.processarFila(); enviados += lote.enviados; } while (lote.enviados > 0);
}

console.log(`
✅ ${semRastro.length} registros-fantasma removidos
   Base agora: ${db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n} pessoas
   Firestore: ${enviados} exclusões aplicadas
`);
process.exit(0);
