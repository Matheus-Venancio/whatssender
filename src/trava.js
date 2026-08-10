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
//
// Cuidado de projeto: reinício NÃO é concorrência. O `node --watch` derruba o
// processo antigo e sobe o novo em sequência, e por um instante os dois
// coexistem. A trava precisa distinguir "outro processo trabalhando" de
// "o anterior terminando de morrer" — senão o modo de desenvolvimento quebra.

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PASTA_DADOS } from './db.js';

const ARQUIVO = join(PASTA_DADOS, '.instancia.lock');
const RENOVAR_A_CADA = 10_000;

// A trava é reescrita a cada 10s. Se parou de ser renovada por muito mais que
// isso, quem a criou morreu. Só vale para processos de outra máquina, onde não
// dá para checar o PID.
const SEM_RENOVAR_ESTA_MORTA = 35_000;

// Quanto esperar quando o dono ainda está vivo: pode ser um reinício em curso.
const ESPERA_TOTAL_MS = 8_000;
const INTERVALO_TENTATIVA_MS = 400;

let temporizador = null;

const esteHost = () =>
  process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'local';

const escrever = () => writeFileSync(ARQUIVO, JSON.stringify({
  pid: process.pid,
  desde: Date.now(),
  host: esteHost()
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

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma avaliação instantânea: dá para assumir a pasta agora?
 * Devolve `livre`, ou `ocupada` com o motivo.
 */
function avaliar() {
  const atual = ler();
  if (!atual) return { livre: true };

  const idade = Date.now() - (atual.desde ?? 0);

  // Mesma máquina: o PID é a verdade. Processo morto = trava órfã, pode assumir
  // na hora — independente de quão recente ela seja. É este caso que o
  // `node --watch` produz o tempo todo.
  if (atual.host === esteHost()) {
    return processoVivo(atual.pid)
      ? { livre: false, dono: atual, idade, motivo: 'vivo' }
      : { livre: true, orfa: atual };
  }

  // Outra máquina (container novo do Render): não há PID para consultar.
  // O critério passa a ser se a trava continua sendo renovada.
  return idade > SEM_RENOVAR_ESTA_MORTA
    ? { livre: true, orfa: atual }
    : { livre: false, dono: atual, idade, motivo: 'outra maquina' };
}

function assumir() {
  escrever();
  if (temporizador) clearInterval(temporizador);
  temporizador = setInterval(escrever, RENOVAR_A_CADA);
  temporizador.unref?.();
  return { ok: true };
}

/**
 * Assume a pasta de dados, esperando alguns segundos se o dono atual ainda
 * estiver de pé — dá tempo de um reinício terminar antes de desistir.
 *
 * Em desenvolvimento (`npm run dev`), o `node --watch` sobe o processo novo
 * sem garantir que o antigo já morreu — no Windows ele nem manda SIGTERM, o
 * que impede qualquer desligamento gracioso. Nesse modo, e SÓ nesse, a
 * instância nova encerra a anterior: reiniciar é a intenção declarada de quem
 * está editando código. Em produção isso nunca acontece.
 */
export async function tomarTrava({ substituir = process.env.SUBSTITUIR_INSTANCIA === 'true' } = {}) {
  const limite = Date.now() + ESPERA_TOTAL_MS;
  let ultima = avaliar();

  if (ultima.livre) return assumir();

  if (substituir && ultima.dono?.host === esteHost()) {
    console.log(`  › modo dev: encerrando a instância anterior (PID ${ultima.dono.pid})`);
    try { process.kill(ultima.dono.pid, 'SIGKILL'); } catch { /* já morreu */ }

    // Confirma a morte antes de assumir. Assumir com o antigo ainda vivo é
    // exatamente o cenário que derruba a sessão do WhatsApp.
    for (let i = 0; i < 25; i++) {
      await dormir(200);
      if (!processoVivo(ultima.dono.pid)) return assumir();
    }
    return { ok: false, ...ultima, motivo: 'a instância anterior não encerrou' };
  }

  // Dono vivo: pode ser o processo anterior encerrando. Espera e reavalia.
  process.stdout.write('  aguardando a instância anterior encerrar');
  while (Date.now() < limite) {
    await dormir(INTERVALO_TENTATIVA_MS);
    process.stdout.write('.');
    ultima = avaliar();
    if (ultima.livre) {
      process.stdout.write(' ok\n');
      return assumir();
    }
  }
  process.stdout.write('\n');
  return { ok: false, ...ultima };
}

export function soltarTrava() {
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
  const atual = ler();
  if (atual?.pid === process.pid) {
    try { unlinkSync(ARQUIVO); } catch { /* já sumiu */ }
  }
}

// Rede de segurança: qualquer saída do processo libera a pasta. Sem isto, um
// `Ctrl+C` seco ou um crash deixaria a trava órfã até o próximo boot.
process.on('exit', soltarTrava);

export function mensagemDeTravada({ dono, idade }) {
  return `
  ⚠  Já existe uma instância usando esta pasta de dados.

     processo ${dono.pid} em "${dono.host}", ativo há ${Math.round(idade / 1000)}s
     pasta: ${PASTA_DADOS}

  Esperei ${ESPERA_TOTAL_MS / 1000}s e ela continua de pé, então não é um
  reinício — é outra instância trabalhando.

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

export const CAMINHO_DA_TRAVA = ARQUIVO;
