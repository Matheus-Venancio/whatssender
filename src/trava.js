// Trava de instância única.
//
// A causa número um de perder a sessão do WhatsApp é banal: dois processos
// apontando para a mesma pasta de dados. Acontece ao abrir dois terminais, ao
// deixar um `npm run dev` esquecido, ou ao subir 2 instâncias no Render.
// O WhatsApp derruba uma das conexões e, dependendo do caso, invalida o
// pareamento — aí só lendo o QR de novo.
//
// A guarda de porta não resolve: dois processos em portas diferentes usam a
// MESMA pasta. Por isso a trava é do diretório de dados, não da porta.

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PASTA_DADOS } from './db.js';

const ARQUIVO = join(PASTA_DADOS, '.instancia.lock');
const RENOVAR_A_CADA = 10_000;
const CONSIDERAR_MORTA_APOS = 45_000;

let temporizador = null;

const escrever = () => writeFileSync(ARQUIVO, JSON.stringify({
  pid: process.pid,
  desde: Date.now(),
  host: process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'local'
}));

function ler() {
  try { return JSON.parse(readFileSync(ARQUIVO, 'utf8')); } catch { return null; }
}

/** O processo daquele PID ainda está vivo nesta máquina? */
function processoVivo(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);   // sinal 0 não mata: só testa a existência
    return true;
  } catch (erro) {
    return erro.code === 'EPERM';   // existe, mas é de outro usuário
  }
}

/**
 * Devolve `{ ok: true }` se esta instância pode assumir a pasta de dados,
 * ou `{ ok: false, dono }` quando outra está viva.
 */
export function tomarTrava() {
  const atual = ler();

  if (atual) {
    const idade = Date.now() - (atual.desde ?? 0);
    const mesmoHost = atual.host === (process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'local');

    // Viva: outro processo está com a pasta.
    if ((mesmoHost && processoVivo(atual.pid)) || idade < CONSIDERAR_MORTA_APOS) {
      return { ok: false, dono: atual, idade };
    }
    // Trava velha de um processo que morreu sem limpar.
  }

  escrever();
  temporizador = setInterval(escrever, RENOVAR_A_CADA);
  temporizador.unref?.();
  return { ok: true };
}

export function soltarTrava() {
  if (temporizador) clearInterval(temporizador);
  const atual = ler();
  if (atual?.pid === process.pid) {
    try { unlinkSync(ARQUIVO); } catch { /* já sumiu */ }
  }
}

export function mensagemDeTravada({ dono, idade }) {
  return `
  ⚠  Já existe uma instância usando esta pasta de dados.

     processo ${dono.pid} em "${dono.host}", ativo há ${Math.round(idade / 1000)}s
     pasta: ${PASTA_DADOS}

  Subir uma segunda instância sobre a MESMA pasta faz duas conexões com a
  mesma sessão do WhatsApp — o WhatsApp derruba uma e pode invalidar o
  pareamento, obrigando a ler o QR de novo.

  O que fazer:
    · Se é o sistema já rodando, use aquela janela.
    · Se aquele processo travou, encerre-o:
        Windows   taskkill /PID ${dono.pid} /F
    · Para rodar uma cópia de teste em paralelo, aponte outra pasta:
        $env:DATA_DIR="data-teste"; $env:PORT="3399"; npm start
`;
}
