// Testa o diagnóstico "o cadastro de hoje sobrevive ao próximo deploy?".
//
//   node --no-warnings=ExperimentalWarning src/teste-protecao.js
//
// POR QUE ISTO MERECE TESTE: é o aviso que a equipe vai olhar na véspera de sair
// para a rua. Um diagnóstico que diz "protegido" quando não está é pior do que
// não existir — a perda só apareceria depois, com um dia de cadastro dentro.

import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = join(process.cwd(), 'data-teste-protecao');
process.env.DATA_DIR = PASTA;
rmSync(PASTA, { recursive: true, force: true });
mkdirSync(join(PASTA, 'campanhas'), { recursive: true });

const { comCampanha, pastaDaCampanha } = await import('./db.js');
const contas = await import('./contas.js');
const firebase = await import('./firestore.js');
const protecao = await import('./protecao.js');

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const SLUG = 'protecao-teste';
const CREDENCIAL = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const AMBIENTE = process.env.NODE_ENV;

const clienteFalso = {
  collection: () => ({ doc: () => ({ set: async () => {}, get: async () => ({ exists: false }) }) }),
  doc: () => ({ set: async () => {}, get: async () => ({ exists: false }) }),
  batch: () => ({ set: () => {}, delete: () => {}, commit: async () => {} }),
  settings: () => {}
};

console.log('\nDiagnóstico de proteção dos cadastros\n');
contas.criarCampanha({ nome: 'Teste Proteção', slug: SLUG });

// ------------------------------------------- 1) o caso que perde o cadastro
console.log('1) Sem credencial de sistema e sem Firebase');
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

let e = comCampanha(SLUG, () => protecao.estadoDaProtecao(SLUG));
ok(e.protegido === false, 'não está protegido');
ok(e.nivel === 'perda', `nível "perda" (era "${e.nivel}")`);
ok(e.credencial_de_sistema === false, 'aponta a credencial de sistema ausente');
ok(e.firebase_conectado === false, 'aponta o Firestore desconectado');
ok(e.problemas.some((p) => p.o_que.includes('FIREBASE_SERVICE_ACCOUNT_JSON')),
  'nomeia a variável que falta');
ok(e.problemas.every((p) => p.como_resolver && p.como_resolver.length > 20),
  'todo problema vem com o que fazer, não só com o diagnóstico');
ok(e.problemas.some((p) => /Render/.test(p.como_resolver)),
  'a instrução cita onde definir (Render → Environment)');

// ------------------------------------------------- 2) credencial presente
console.log('\n2) Com a credencial de sistema definida');
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"type":"service_account","project_id":"x"}';
e = comCampanha(SLUG, () => protecao.estadoDaProtecao(SLUG));
ok(e.credencial_de_sistema === true, 'reconhece a credencial');
ok(e.protegido === false, 'ainda assim não protege enquanto o Firestore não conecta');
ok(!e.problemas.some((p) => p.o_que.includes('FIREBASE_SERVICE_ACCOUNT_JSON')),
  'para de cobrar a variável que já existe');

// --------------------------------------------------- 3) Firestore de pé
console.log('\n3) Com o Firestore conectado');
await comCampanha(SLUG, () => firebase.iniciarFirebase({ clienteDeTeste: clienteFalso }));
e = comCampanha(SLUG, () => protecao.estadoDaProtecao(SLUG));
ok(e.firebase_conectado === true, 'reconhece a conexão');
ok(e.protegido === true, 'agora o cadastro sobrevive');
ok(e.problemas.every((p) => !p.grave), 'nenhum problema grave restante');

// -------------------------------------------- 4) chave em disco conta
console.log('\n4) Chave da campanha em disco');
ok(protecao.temChaveDaCampanha(SLUG) === false, 'sem chave em disco, reporta falso');
writeFileSync(join(pastaDaCampanha(SLUG), 'firebase-key.json'), '{}');
ok(protecao.temChaveDaCampanha(SLUG) === true, 'com chave em disco, reporta verdadeiro');

// -------------------------------------------------- 5) disco efêmero
console.log('\n5) Detecção de disco efêmero');
ok(typeof protecao.discoEfemero() === 'boolean', 'discoEfemero() responde booleano');
ok(protecao.discoEfemero() === false,
  'com DATA_DIR gravável, o disco não é considerado efêmero');

// ----------------------------------------------------- 6) o aviso no boot
console.log('\n6) Aviso no boot');
const avisos = [];
const warnOriginal = console.warn;
const logOriginal = console.log;
console.warn = (...a) => avisos.push(a.join(' '));
console.log = () => {};
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
process.env.NODE_ENV = 'production';
comCampanha(SLUG, () => protecao.avisarNoBoot(SLUG));
console.warn = warnOriginal;
console.log = logOriginal;

ok(avisos.length === 1, 'quando há problema, o boot grita uma vez');
ok(/FIREBASE_SERVICE_ACCOUNT_JSON/.test(avisos[0] || ''),
  'o aviso do boot nomeia a variável que falta');

const silencio = [];
console.warn = (...a) => silencio.push(a.join(' '));
console.log = () => {};
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
process.env.NODE_ENV = AMBIENTE ?? 'test';
comCampanha(SLUG, () => protecao.avisarNoBoot(SLUG));
console.warn = warnOriginal;
console.log = logOriginal;
ok(silencio.length === 0, 'quando está tudo certo, o boot não polui o log');

if (CREDENCIAL === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = CREDENCIAL;

rmSync(PASTA, { recursive: true, force: true });
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Diagnóstico de proteção confiável.'}\n`);
process.exit(falhas ? 1 : 0);
