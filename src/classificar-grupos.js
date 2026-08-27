// Marca quais grupos de WhatsApp são da campanha e que pilar cada um atende.
//
//   npm run grupos                          -> mostra a situação de todos
//   npm run grupos -- --aplicar             -> (re)classifica pelo nome
//   npm run grupos -- --marcar 12           -> "este é da campanha" (decisão da equipe)
//   npm run grupos -- --marcar 12 --tema educacao
//   npm run grupos -- --desmarcar 1         -> "este NÃO é da campanha"
//   CAMPANHA=claudia npm run grupos
//
// POR QUE ISTO É NECESSÁRIO: o Baileys lista todos os grupos do telefone âncora,
// inclusive os que não têm nada a ver com a campanha. Enquanto eles não estiverem
// marcados, a fila de adição os oferece como destino — e é assim que assinante de
// abaixo-assinado acaba dentro do grupo de terceiro.

import './ambiente.js';
import { db, usarCampanha } from './db.js';
import { classificarGrupoNaBase, definirGrupoManualmente } from './ingest.js';
import { TEMAS } from './lexicon.js';

const CAMPANHA = usarCampanha();

const arg = (nome) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : null;
};

const APLICAR = process.argv.includes('--aplicar');
const MARCAR = arg('marcar');
const DESMARCAR = arg('desmarcar');
const TEMA = arg('tema');

if (TEMA && !TEMAS[TEMA]) {
  console.error(`\n❌ Tema "${TEMA}" não existe. Temas válidos:\n   ${Object.keys(TEMAS).join(', ')}\n`);
  process.exit(1);
}

function mostrar(titulo) {
  const grupos = db.prepare(`
    SELECT g.id, g.nome, g.tema, g.da_campanha, g.classificacao_manual,
           (SELECT COUNT(*) FROM membros m WHERE m.grupo_id = g.id AND m.saiu_em IS NULL) AS membros
      FROM grupos g WHERE g.ativo = 1
     ORDER BY g.da_campanha DESC, g.nome
  `).all();

  console.log(`\n${titulo}  ·  campanha: ${CAMPANHA}\n`);
  console.log('  id  destino   tema                       membros  grupo');
  console.log('  ' + '-'.repeat(86));

  for (const g of grupos) {
    const marca = g.da_campanha ? '✅ SIM  ' : '⛔ não  ';
    const tema = g.tema ? (TEMAS[g.tema]?.rotulo ?? g.tema) : (g.da_campanha ? '(geral)' : '—');
    const mao = g.classificacao_manual ? ' ✋' : '';
    console.log(
      `  ${String(g.id).padStart(3)}  ${marca}  ${tema.padEnd(26)} ${String(g.membros).padStart(6)}   ${g.nome}${mao}`
    );
  }

  const daCampanha = grupos.filter((g) => g.da_campanha);
  const semTema = daCampanha.filter((g) => !g.tema);
  console.log(`\n  ${daCampanha.length} de ${grupos.length} grupos são da campanha.`);
  if (semTema.length > 1) {
    console.log(
      `  ⚠️  ${semTema.length} grupos da campanha sem tema. Só um deve ficar sem tema (o grupo\n` +
      '      geral, usado como destino de quem não casa com nenhum pilar). Defina o tema\n' +
      '      dos outros com --marcar <id> --tema <tema>, senão a recomendação do formulário\n' +
      '      manda todo mundo para o primeiro deles.'
    );
  }
  if (!daCampanha.length) {
    console.log(
      '  ⚠️  Nenhum grupo marcado como da campanha: a fila de adição vai recusar todos\n' +
      '      (de propósito) e o formulário não recomenda grupo. Rode com --aplicar.'
    );
  }
  console.log('');
  return grupos;
}

if (MARCAR || DESMARCAR) {
  const id = Number(MARCAR || DESMARCAR);
  const existe = db.prepare('SELECT id, nome FROM grupos WHERE id = ?').get(id);
  if (!existe) {
    console.error(`\n❌ Não existe grupo com id ${id} nesta campanha.\n`);
    process.exit(1);
  }
  const r = definirGrupoManualmente(id, { daCampanha: Boolean(MARCAR), tema: MARCAR ? TEMA : null });
  console.log(
    `\n✅ "${r.nome}" agora é ${r.da_campanha ? 'GRUPO DA CAMPANHA' : 'grupo externo'}` +
    `${r.tema ? ` · tema ${TEMAS[r.tema]?.rotulo ?? r.tema}` : ''}` +
    '\n   Marcado à mão (✋): a reclassificação automática não mexe mais nele.'
  );
  mostrar('Situação atual');
  process.exit(0);
}

if (!APLICAR) {
  mostrar('Situação atual (nada foi alterado)');
  console.log('  Para (re)classificar pelo nome:  npm run grupos -- --aplicar\n');
  process.exit(0);
}

const alvos = db.prepare(
  'SELECT id, nome FROM grupos WHERE classificacao_manual = 0 ORDER BY id'
).all();

let daCampanha = 0;
for (const g of alvos) {
  const r = classificarGrupoNaBase(g.id);
  if (r?.daCampanha) daCampanha++;
}

const manuais = db.prepare(
  'SELECT COUNT(*) AS n FROM grupos WHERE classificacao_manual = 1'
).get().n;

console.log(
  `\n✅ ${alvos.length} grupos reclassificados (${daCampanha} da campanha).` +
  `${manuais ? ` ${manuais} preservados por decisão manual.` : ''}`
);
mostrar('Depois da classificação');
process.exit(0);
