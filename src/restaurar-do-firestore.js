// Linha de comando para restaurar a base de uma campanha a partir do Firestore.
// A lógica mora em restaurar.js, compartilhada com o botão do painel — no
// Render o Shell é recurso pago, então a interface precisa dar conta sozinha.
//
//   npm run restaurar -- --campanha claudia
//   npm run restaurar -- --campanha claudia --confirmar

import * as contas from './contas.js';
import { restaurarDoFirestore } from './restaurar.js';

const arg = (nome) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : null;
};

const SLUG = arg('campanha');
const CONFIRMAR = process.argv.includes('--confirmar');

if (!SLUG) {
  console.error(`
Informe a campanha:
  npm run restaurar -- --campanha claudia

Campanhas cadastradas: ${contas.listarCampanhas().map((c) => c.slug).join(', ') || '(nenhuma)'}
`);
  process.exit(1);
}

const r = await restaurarDoFirestore(SLUG, { confirmar: CONFIRMAR });

if (r.erro) {
  console.error(`\n❌ ${r.erro}\n`);
  process.exit(1);
}

console.log(`\nProjeto ${r.projeto} · caminho ${r.caminho}\n`);
console.log('No Firestore:');
for (const [k, v] of Object.entries(r.noFirestore)) console.log(`  ${k.padEnd(12)} ${v}`);
console.log(`\nNo banco local: ${r.antes.pessoas} pessoas · ${r.antes.grupos} grupos`);

if (r.simulacao) {
  console.log('\n── simulação ── nada foi escrito.');
  console.log(`Para restaurar de verdade:  npm run restaurar -- --campanha ${SLUG} --confirmar\n`);
  process.exit(0);
}

console.log(`
✅ Base restaurada
   ${r.depois.pessoas} pessoas · ${r.depois.grupos} grupos · ${r.depois.membros} vínculos
   ${r.depois.assinaturas} assinaturas (${r.assinaturasOk} vieram do Firestore)

   O histórico de mensagens NÃO volta — não é espelhado por padrão.
   Falta ler o QR do WhatsApp neste servidor.
`);
process.exit(0);
