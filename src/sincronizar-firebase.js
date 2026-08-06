// Empurra a base inteira para o Firestore.
//
//   npm run firebase:sync    -> conecta e envia tudo
//   npm run firebase:teste   -> não envia nada; só mostra os documentos que
//                               seriam gravados (serve para conferir o formato
//                               antes de ter a chave do projeto)

import { db } from './db.js';
import * as fb from './firestore.js';

const teste = process.argv.includes('--teste');

if (teste) {
  console.log('› modo teste: nada será enviado ao Firebase.\n');

  const pessoa = db.prepare(`
    SELECT p.id FROM pessoas p LEFT JOIN perfil f ON f.pessoa_id = p.id
     ORDER BY (SELECT COUNT(*) FROM assinaturas s WHERE s.pessoa_id = p.id) DESC,
              f.engajamento DESC LIMIT 1
  `).get();

  if (!pessoa) {
    console.log('Base vazia. Rode "npm run importar" primeiro.');
    process.exit(0);
  }

  console.log(`— documento de exemplo: pessoas/${fb.montarPessoa(pessoa.id).telefone}`);
  console.log(JSON.stringify(fb.montarPessoa(pessoa.id), null, 2));

  const grupo = db.prepare('SELECT id FROM grupos LIMIT 1').get();
  if (grupo) {
    console.log(`\n— documento de exemplo: grupos/…`);
    console.log(JSON.stringify(fb.montarGrupo(grupo.id), null, 2));
  }

  const resumo = fb.sincronizarTudo();
  const porColecao = db.prepare(
    'SELECT colecao, COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL GROUP BY colecao'
  ).all();
  console.log('\n— documentos que seriam gravados:');
  for (const c of porColecao) console.log(`   ${c.colecao.padEnd(14)} ${c.n}`);
  console.log(`   ${'TOTAL'.padEnd(14)} ${resumo.pendentes}`);
  console.log('\nOs documentos ficam na fila (tabela outbox) e sobem sozinhos');
  console.log('assim que a credencial do Firebase for configurada.\n');
  process.exit(0);
}

const ok = await fb.iniciarFirebase();
if (!ok) {
  console.error(`\n❌ ${fb.estadoFirebase.erro}\n`);
  console.error('Passo a passo:');
  console.error('  1. console.firebase.google.com → criar projeto → Firestore Database');
  console.error('  2. Configurações do projeto → Contas de serviço → Gerar nova chave privada');
  console.error('  3. Salve o JSON em data/firebase-key.json');
  console.error('  4. Copie .env.example para .env e ajuste o caminho\n');
  process.exit(1);
}

const resumo = fb.sincronizarTudo();
console.log(`› ${resumo.pendentes} documentos na fila…`);

const pendentes = () =>
  db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL').get().n;

let total = 0;
while (pendentes() > 0) {
  const lote = await fb.processarFila();
  if (lote.erro) {
    console.error(`\n❌ ${lote.erro}\n`);
    process.exit(1);
  }
  if (!lote.enviados) {          // nada saiu e nada falhou: evita laço infinito
    console.error(`\n❌ ${pendentes()} documentos travados na fila.\n`);
    process.exit(1);
  }
  total += lote.enviados;
  console.log(`   enviados ${total}…`);
}

console.log(`\n✅ ${total} documentos no Firestore (projeto ${fb.estadoFirebase.projeto}).\n`);
process.exit(0);
