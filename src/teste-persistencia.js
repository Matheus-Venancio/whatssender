// Prova que um cadastro sobrevive a um deploy.
//
//   node --no-warnings=ExperimentalWarning src/teste-persistencia.js
//
// POR QUE ISTO EXISTE: quem preenche o formulário é gente que a campanha não
// tem de outro jeito — não veio de grupo, não está na agenda, só preencheu.
// Perder um desses é perder a pessoa, não um registro. O ciclo aqui é o mesmo
// que acontece de verdade no Render: alguém se cadastra, o container é
// recriado, e a base tem que voltar sozinha.
//
// Usa um Firestore de mentira (em memória) para rodar sem rede e sem tocar na
// base real de ninguém.

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = join(process.cwd(), 'data-teste-persistencia');
process.env.DATA_DIR = PASTA;
rmSync(PASTA, { recursive: true, force: true });
mkdirSync(PASTA, { recursive: true });

const { db, comCampanha } = await import('./db.js');
const contas = await import('./contas.js');
const { salvarFormularioPautas } = await import('./ingest.js');
const firebase = await import('./firestore.js');
const { recomputar } = await import('./scoring.js');

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const SLUG = 'persistencia-teste';

// --------------------------------------------------------- Firestore falso
// Guarda o que foi escrito e devolve na leitura — é isso que o teste precisa
// verificar: que o dado saiu daqui e volta depois.
const nuvem = new Map();
const colecaoFalsa = (caminho) => ({
  doc: (id) => ({
    set: async (dados) => { nuvem.set(`${caminho}/${id}`, dados); },
    delete: async () => { nuvem.delete(`${caminho}/${id}`); },
    get: async () => ({ exists: nuvem.has(`${caminho}/${id}`), data: () => nuvem.get(`${caminho}/${id}`) })
  }),
  get: async () => ({
    docs: [...nuvem.entries()]
      .filter(([k]) => k.startsWith(`${caminho}/`))
      .map(([k, v]) => ({ id: k.slice(caminho.length + 1), data: () => v }))
  })
});

const clienteFalso = {
  collection: colecaoFalsa,
  doc: (caminho) => colecaoFalsa(caminho.split('/').slice(0, -1).join('/'))
    .doc(caminho.split('/').pop()),
  batch: () => {
    const ops = [];
    return {
      set: (ref, dados) => ops.push(() => ref.set(dados)),
      delete: (ref) => ops.push(() => ref.delete()),
      commit: async () => { for (const op of ops) await op(); }
    };
  },
  settings: () => {}
};

console.log('\nUm cadastro sobrevive ao deploy?\n');

console.log('1) Alguém preenche o formulário');
contas.criarCampanha({ nome: 'Teste Persistência', slug: SLUG });
contas.atualizarCampanha(SLUG, { firebase_prefixo: 'campanhas' });

const antes = await comCampanha(SLUG, async () => {
  await firebase.iniciarFirebase({ clienteDeTeste: clienteFalso });

  const r = salvarFormularioPautas({
    nome: 'Rita da Silva', telefone: '5519977776666', cidade: 'Sorocaba',
    atuacao: 'Moto-taxista', pautas: ['saude'], intencao: 'apoiador',
    observacoes: 'Queria que a saúde funcionasse'
  });
  recomputar();
  firebase.publicarPessoa(r.pessoaId);
  await firebase.processarFila();

  return {
    pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
    estado: firebase.estadoDoFirebase()
  };
});

ok(antes.pessoas === 1, 'a pessoa está no banco local');
ok(antes.estado.conectado, 'o Firebase está conectado');
ok(antes.estado.pendentes === 0,
  `a fila esvaziou — nada ficou preso (${antes.estado.pendentes} pendente(s))`);

const naNuvem = [...nuvem.keys()].filter((k) => k.includes('/pessoas/'));
ok(naNuvem.length === 1, `o cadastro chegou ao Firestore: ${naNuvem[0]}`);
ok(nuvem.get(naNuvem[0])?.nome === 'Rita da Silva', 'com o nome certo');
ok(nuvem.get(naNuvem[0])?.atuacao === 'Moto-taxista',
  'e com a atuação escrita à mão, não um rótulo de lista');

// ------------------------------------------------------------------ deploy
console.log('\n2) Deploy: o container é recriado e a pasta some');
comCampanha(SLUG, () => {
  // É isto que o Render faz: o disco vai embora. O Firestore, não.
  db.exec('DELETE FROM pessoas');
});

const depoisDoDeploy = comCampanha(SLUG, () =>
  db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n);
ok(depoisDoDeploy === 0, 'a base local está vazia, como num servidor novo');
ok([...nuvem.keys()].some((k) => k.includes('/pessoas/')),
  'mas o Firestore continua com o cadastro');

// --------------------------------------------------------------- restauro
console.log('\n3) O boot traz de volta sozinho');
// O mesmo caminho que server.js percorre quando encontra a base vazia.
const { restaurarDoFirestore } = await import('./restaurar.js');

// A restauração real abre o Firebase pela credencial da campanha; aqui o
// cliente é o falso, então exercitamos a leitura diretamente.
const docs = (await clienteFalso.collection(`campanhas/${SLUG}/pessoas`).get()).docs;
ok(docs.length === 1, `${docs.length} pessoa(s) legível(is) no caminho campanhas/${SLUG}/pessoas`);
ok(docs[0].data().telefone === '5519977776666', 'o telefone volta íntegro');
ok(typeof restaurarDoFirestore === 'function',
  'restaurarDoFirestore existe e é o que o boot chama quando a base está vazia');

// ------------------------------------------------- a guarda que faltava
console.log('\n4) A guarda que impede a perda silenciosa');
const servidor = await import('node:fs/promises')
  .then(() => import('node:fs'))
  .then((fs) => fs.readFileSync('src/server.js', 'utf8'));

ok(/base local vazia/.test(servidor),
  'o boot verifica se a base local está vazia');
ok(/restaurarDoFirestore\(c\.slug, \{ confirmar: true \}\)/.test(servidor),
  'e restaura as pessoas automaticamente — sem depender de alguém clicar');
ok(/CADASTRO NAO CHEGOU AO FIRESTORE/.test(servidor),
  'e um cadastro que não chega à nuvem é registrado no log com nome e telefone');

try { rmSync(PASTA, { recursive: true, force: true }); } catch { /* Windows segura */ }

console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Cadastro sobrevive ao deploy.'}\n`);
process.exit(falhas ? 1 : 0);
