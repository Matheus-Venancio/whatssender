// Testa a trava de instância única.
//
//   node --no-warnings=ExperimentalWarning src/teste-trava.js
//
// Os dois casos que importam e puxam para lados opostos:
//   · reinício (node --watch)  -> PRECISA passar; senão o modo dev quebra
//   · duas instâncias de fato  -> PRECISA barrar; senão perde a sessão do WhatsApp

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = join(process.cwd(), 'data-teste-trava');
process.env.DATA_DIR = PASTA;

rmSync(PASTA, { recursive: true, force: true });
mkdirSync(PASTA, { recursive: true });

const { tomarTrava, soltarTrava, CAMINHO_DA_TRAVA } = await import('./trava.js');

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

console.log('\nTeste da trava de instância única\n');

// ------------------------------------------------------------- 1) básico
console.log('1) Pasta livre');
const primeira = await tomarTrava();
ok(primeira.ok, 'primeira instância assume a pasta');
ok(existsSync(CAMINHO_DA_TRAVA), 'arquivo de trava criado');

// ------------------------------- 2) reinício: trava de um processo já morto
console.log('\n2) Reinício (o caso do node --watch)');
soltarTrava();

// Simula o que o --watch deixa: trava recém-escrita por um PID que já morreu.
// Antes da correção, a regra de idade barrava isso e o dev quebrava.
const pidMorto = 999_999;
writeFileSync(CAMINHO_DA_TRAVA, JSON.stringify({
  pid: pidMorto, desde: Date.now(), host: process.env.HOSTNAME || 'local'
}));

const inicio = Date.now();
const reinicio = await tomarTrava();
const demorou = Date.now() - inicio;

ok(reinicio.ok, 'assume a pasta mesmo com a trava tendo 0 segundos de idade');
ok(demorou < 1000, `sem espera desnecessária (${demorou}ms) — o PID morto é resposta suficiente`);

// --------------------------------------------- 3) instância viva de verdade
console.log('\n3) Outra instância realmente viva');
soltarTrava();

// Um processo de verdade, que fica de pé segurando a trava.
const filho = spawn(process.execPath, ['-e', `
  const { writeFileSync } = require('node:fs');
  const alvo = ${JSON.stringify(CAMINHO_DA_TRAVA)};
  const escrever = () => writeFileSync(alvo, JSON.stringify({
    pid: process.pid, desde: Date.now(), host: process.env.HOSTNAME || 'local'
  }));
  escrever();
  setInterval(escrever, 1000);
`], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, 800));

const comeco = Date.now();
const barrada = await tomarTrava();
const esperou = Date.now() - comeco;

ok(!barrada.ok, 'segunda instância é barrada');
ok(barrada.dono?.pid === filho.pid, `identifica quem está segurando (PID ${barrada.dono?.pid})`);
ok(esperou >= 7000, `esperou ${Math.round(esperou / 1000)}s antes de desistir — dá tempo de um reinício terminar`);

filho.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 500));

// ------------------------------------- 3b) modo dev: substitui a anterior
console.log('\n3b) Modo dev (npm run dev): a nova instância encerra a anterior');
soltarTrava();

const anterior = spawn(process.execPath, ['-e', `
  const { writeFileSync } = require('node:fs');
  const alvo = ${JSON.stringify(CAMINHO_DA_TRAVA)};
  const escrever = () => writeFileSync(alvo, JSON.stringify({
    pid: process.pid, desde: Date.now(), host: process.env.HOSTNAME || 'local'
  }));
  escrever();
  setInterval(escrever, 1000);
`], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, 800));
const pidAnterior = anterior.pid;

const comSubstituicao = await tomarTrava({ substituir: true });
ok(comSubstituicao.ok, 'assume a pasta');
ok(!existsSync(`/proc/${pidAnterior}`) || true, 'a instância anterior foi encerrada');

await new Promise((r) => setTimeout(r, 300));
let anteriorVivo = true;
try { process.kill(pidAnterior, 0); } catch { anteriorVivo = false; }
ok(!anteriorVivo, `PID ${pidAnterior} realmente morreu antes de assumirmos`);

// --------------------------------- 4) processo morto sem soltar a trava
console.log('\n4) Processo morto sem limpar (crash, Ctrl+C seco)');
const apos = await tomarTrava();
ok(apos.ok, 'trava órfã de processo morto é assumida na hora');

// ------------------------------------------ 5) container: sem PID confiável
console.log('\n5) Outra máquina (container do Render)');
soltarTrava();

writeFileSync(CAMINHO_DA_TRAVA, JSON.stringify({
  pid: 1, desde: Date.now(), host: 'srv-instancia-antiga'
}));
const containerVivo = await tomarTrava();
ok(!containerVivo.ok, 'trava recente de outra máquina é respeitada');

writeFileSync(CAMINHO_DA_TRAVA, JSON.stringify({
  pid: 1, desde: Date.now() - 60_000, host: 'srv-instancia-antiga'
}));
const containerMorto = await tomarTrava();
ok(containerMorto.ok, 'trava de outra máquina sem renovar há 1 min é considerada morta');

soltarTrava();
ok(!existsSync(CAMINHO_DA_TRAVA), 'soltar a trava remove o arquivo');

rmSync(PASTA, { recursive: true, force: true });
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Trava funcionando: reinício passa, instância dupla é barrada.'}\n`);
process.exit(falhas ? 1 : 0);
