// "O cadastro feito hoje sobrevive ao próximo deploy?"
//
// POR QUE ISTO EXISTE: a resposta dependia de quatro coisas em arquivos
// diferentes — disco persistente, credencial de sistema, Firestore da campanha
// conectado e fila de saída vazia. Quando uma falhava, o painel continuava
// verde, o log soltava um aviso que ninguém lê, e a perda só aparecia depois do
// deploy seguinte — com a rua já tendo cadastrado gente o dia inteiro.
//
// A cadeia, na ordem em que quebra:
//
//   1. FIREBASE_SERVICE_ACCOUNT_JSON  — a credencial de SISTEMA, no ambiente.
//      É o elo que resolve o ovo-e-galinha: a chave de cada campanha vive em
//      data/campanhas/<slug>/firebase-key.json, que é justamente o que o disco
//      efêmero apaga. Sem esta variável, o boot não tem como buscar a chave de
//      volta, o Firestore da campanha nunca conecta, nada é espelhado e não há
//      o que restaurar. É a falha mais comum e a mais silenciosa.
//   2. chave da campanha — restaurada pelo item 1, ou presente em disco.
//   3. Firestore conectado — com a chave, conecta sozinho no boot.
//   4. fila de saída andando — escrita local vira documento remoto.
//
// Disco persistente resolve tudo sozinho, mas não é o cenário do Render sem
// disco, que é onde o dado some.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, PASTA_DADOS, SEM_DISCO, RAIZ, pastaDaCampanha } from './db.js';
import { estadoDoFirebase } from './firestore.js';

/** O disco onde os dados estão é apagado no próximo deploy? */
export function discoEfemero() {
  if (SEM_DISCO) return true;
  // Em produção, gravar dentro da pasta do próprio código é sinal de disco
  // efêmero: o disco montado fica fora da árvore da aplicação.
  return process.env.NODE_ENV === 'production' && PASTA_DADOS.startsWith(RAIZ);
}

export const temCredencialDeSistema = () =>
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim());

export const temChaveDaCampanha = (slug) =>
  existsSync(join(pastaDaCampanha(slug), 'firebase-key.json'));

/**
 * Diagnóstico completo para UMA campanha.
 *
 * `protegido` responde a única pergunta que importa na véspera de sair para a
 * rua: o que for cadastrado hoje continua existindo depois do próximo deploy?
 */
export function estadoDaProtecao(slug) {
  const efemero = discoEfemero();
  const credencial = temCredencialDeSistema();
  const chave = temChaveDaCampanha(slug);
  const firebase = estadoDoFirebase();
  const pendentes = db.prepare(
    'SELECT COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL'
  ).get().n;

  const problemas = [];

  // Com disco persistente o banco sobrevive sozinho; sem ele, tudo depende da
  // cadeia do Firebase. Por isso os problemas abaixo só são fatais quando o
  // disco é efêmero — mas continuam valendo como aviso, porque disco de
  // provedor também some.
  if (!credencial) {
    problemas.push({
      grave: efemero,
      o_que: 'FIREBASE_SERVICE_ACCOUNT_JSON não está definida',
      por_que: 'É a credencial que o servidor usa para buscar de volta a chave da campanha '
        + 'depois de um deploy. Sem ela, a chave some com o disco e o Firestore nunca reconecta.',
      como_resolver: 'No Render → Environment → Add: FIREBASE_SERVICE_ACCOUNT_JSON = '
        + 'o conteúdo inteiro do JSON da conta de serviço, numa linha só. Depois, Save e redeploy.'
    });
  }

  if (!chave && !firebase.conectado) {
    problemas.push({
      grave: true,
      o_que: `A campanha "${slug}" está sem a chave do Firebase`,
      por_que: 'Sem chave, nada do que entra é espelhado — nem cadastro de formulário.',
      como_resolver: credencial
        ? 'Reinicie o servidor: com a credencial de sistema definida, a chave volta sozinha no boot.'
        : 'Defina FIREBASE_SERVICE_ACCOUNT_JSON e reinicie; a chave volta sozinha.'
    });
  }

  if (!firebase.conectado) {
    problemas.push({
      grave: true,
      o_que: 'O Firestore desta campanha não está conectado',
      por_que: 'Cadastro entra só no banco local. Se o disco for recriado, some.',
      como_resolver: firebase.erro || 'Veja a aba Firebase para o motivo exato.'
    });
  } else if (pendentes > 200) {
    problemas.push({
      grave: false,
      o_que: `${pendentes} registros esperando para subir`,
      por_que: 'A fila reprocessa sozinha a cada 15s. Acúmulo grande indica rede ruim ou cota.',
      como_resolver: 'Acompanhe pela aba Firebase; se não baixar em alguns minutos, veja o log.'
    });
  }

  if (efemero && problemas.length === 0) {
    problemas.push({
      grave: false,
      o_que: 'Este servidor não tem disco persistente',
      por_que: 'O banco local é recriado a cada deploy — hoje o que salva é o Firebase, '
        + 'e ele está funcionando.',
      como_resolver: 'Para não depender só do Firebase: Render → serviço → Disk → Add Disk '
        + 'em /var/dados, com DATA_DIR=/var/dados.'
    });
  }

  const graves = problemas.filter((p) => p.grave);

  return {
    protegido: graves.length === 0,
    // 'ok' = sobrevive; 'risco' = sobrevive mas com ressalva; 'perda' = NÃO sobrevive.
    nivel: graves.length ? 'perda' : (problemas.length ? 'risco' : 'ok'),
    disco_efemero: efemero,
    credencial_de_sistema: credencial,
    chave_da_campanha: chave,
    firebase_conectado: Boolean(firebase.conectado),
    projeto: firebase.projeto ?? null,
    pendentes,
    problemas
  };
}

/** Bloco de log no boot. Silencioso quando está tudo certo. */
export function avisarNoBoot(slug) {
  const e = estadoDaProtecao(slug);
  if (e.protegido && e.nivel === 'ok') {
    console.log(`  [protecao:${slug}] cadastros protegidos · Firebase ${e.projeto ?? 'conectado'}`);
    return e;
  }

  const linhas = e.problemas.map((p) => `     ${p.grave ? '✗' : '·'} ${p.o_que}\n        ${p.como_resolver}`);
  console.warn(`
  ${'─'.repeat(66)}
  ${e.protegido ? '⚠  ATENÇÃO' : '✗  OS CADASTROS DE HOJE VÃO SUMIR NO PRÓXIMO DEPLOY'} — campanha ${slug}
${linhas.join('\n')}
  ${'─'.repeat(66)}
`);
  return e;
}
