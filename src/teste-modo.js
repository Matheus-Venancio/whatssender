// Testa a separação entre "só contatos" e "completo".
//
//   node --no-warnings=ExperimentalWarning src/teste-modo.js
//
// POR QUE ISTO MERECE TESTE PRÓPRIO: é uma promessa de privacidade feita na
// tela — "esta conexão não lê suas conversas". Se um caminho de ingestão
// escapar da guarda, o sistema passa a gravar mensagem de um celular pessoal
// enquanto a interface garante que não. Testar a promessa é o mínimo.

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = join(process.cwd(), 'data-teste-modo');
process.env.DATA_DIR = PASTA;
rmSync(PASTA, { recursive: true, force: true });
mkdirSync(PASTA, { recursive: true });

const { comCampanha, setConfig, getConfig } = await import('./db.js');
const wa = await import('./whatsapp.js');

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const SLUG = 'modo-teste';

console.log('\nModos de conexão: contatos x completo\n');

console.log('1) Padrão e troca');
comCampanha(SLUG, () => {
  ok(wa.modoAtual() === 'completo', 'sem nada configurado, o padrão é completo');
  ok(wa.soContatos() === false, 'e soContatos é falso');

  setConfig('whatsapp_modo', 'contatos');
  ok(wa.modoAtual() === 'contatos', 'gravado o modo contatos, ele é lido de volta');
  ok(wa.soContatos() === true, 'soContatos passa a ser verdadeiro');

  setConfig('whatsapp_modo', 'completo');
  ok(wa.modoAtual() === 'completo', 'volta para completo');
});

console.log('\n2) O modo sobrevive à reconexão');
comCampanha(SLUG, () => {
  setConfig('whatsapp_modo', 'contatos');
  // A reconexão automática chama conectar() sem argumentos. Se o modo vivesse
  // em memória, uma queda de internet promoveria a conexão para leitura
  // completa sem ninguém pedir — exatamente o que não pode acontecer.
  ok(wa.modoAtual() === 'contatos',
    'lido do banco, não de argumento — reconectar não promove para completo');
  ok(getConfig('whatsapp_modo') === 'contatos', 'e está mesmo persistido');
});

console.log('\n3) Cada campanha tem o seu modo');
comCampanha('modo-outra', () => {
  ok(wa.modoAtual() === 'completo',
    'outra campanha não herda o modo contatos da primeira');
});
comCampanha(SLUG, () => {
  ok(wa.modoAtual() === 'contatos', 'e a primeira continua em contatos');
});

console.log('\n4) Valor inválido não vira modo');
comCampanha(SLUG, () => {
  setConfig('whatsapp_modo', 'qualquer-coisa');
  ok(wa.modoAtual() === 'completo',
    'valor desconhecido cai em completo — falhar para o modo mais restrito '
    + 'esconderia conversas que a equipe espera ver');
  ok(wa.MODOS.length === 2 && wa.MODOS.includes('contatos') && wa.MODOS.includes('completo'),
    'só existem dois modos declarados');
});

try { rmSync(PASTA, { recursive: true, force: true }); } catch { /* Windows segura */ }

console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Modos de conexão separados corretamente.'}\n`);
process.exit(falhas ? 1 : 0);
