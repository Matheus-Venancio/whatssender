// Varre as mensagens já capturadas e gera os alertas de atrito que faltaram.
//
//   npm run riscos            -> analisa as mensagens dos últimos 30 dias
//   npm run riscos -- --tudo  -> analisa o histórico inteiro
//
// Útil depois de mexer no dicionário de risco: reavalia tudo com as regras novas.

import { db, usarCampanha } from './db.js';
import { analisarMensagem, RISCOS } from './risco.js';
import * as fb from './firestore.js';

// Estes scripts rodam sobre UMA campanha. Escolha com a variável CAMPANHA;
// sem ela, usa a primeira encontrada em data/campanhas/.
const CAMPANHA = usarCampanha();

const DIA = 86_400_000;
const tudo = process.argv.includes('--tudo');
const desde = tudo ? 0 : Date.now() - 30 * DIA;

const mensagens = db.prepare(`
  SELECT m.id, m.pessoa_id, m.grupo_id, m.texto, m.ts, g.nome AS grupo
    FROM mensagens m JOIN grupos g ON g.id = m.grupo_id
   WHERE m.texto IS NOT NULL AND m.texto <> '' AND m.ts >= ?
   ORDER BY m.ts
`).all(desde);

console.log(`\n› analisando ${mensagens.length} mensagens${tudo ? ' (histórico completo)' : ' dos últimos 30 dias'}…\n`);

const porCategoria = {};
const criados = [];

for (const msg of mensagens) {
  const r = analisarMensagem({
    pessoaId: msg.pessoa_id,
    grupoId: msg.grupo_id,
    nomeGrupo: msg.grupo,
    texto: msg.texto,
    ts: msg.ts
  });
  if (!r) continue;
  porCategoria[r.risco.categoria] = (porCategoria[r.risco.categoria] || 0) + 1;
  criados.push(r.alertaId);
  if (r.conflitoId) criados.push(r.conflitoId);
  console.log(`  ${r.risco.icone} ${RISCOS[r.risco.categoria].rotulo}`);
  console.log(`     ${r.quem} · ${msg.grupo} · ${new Date(msg.ts).toLocaleString('pt-BR')}`);
  console.log(`     "${msg.texto.slice(0, 90)}"`);
  console.log(`     → ${r.risco.acao}\n`);
}

if (!criados.length) {
  console.log('  Nenhum atrito encontrado.\n');
} else {
  console.log('─'.repeat(60));
  for (const [cat, n] of Object.entries(porCategoria).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${RISCOS[cat].rotulo.padEnd(34)} ${n}`);
  }
  console.log(`\n  ${criados.length} alerta(s) criado(s).\n`);

  await fb.iniciarFirebase();
  for (const id of criados) fb.publicarAlerta(id);
  const envio = await fb.processarFila();
  if (envio.enviados) console.log(`  Firestore: ${envio.enviados} documento(s) enviados.\n`);
}

process.exit(0);
