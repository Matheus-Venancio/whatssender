// Reorganiza o Firestore para separar os clientes.
//
//   npm run firebase:migrar            -> mostra o plano, não escreve nada
//   npm run firebase:migrar -- --confirmar
//
// ANTES (tudo misturado na raiz do projeto):
//     pessoas/5519...        ← de quem? impossível saber olhando
//     grupos/1203...
//
// DEPOIS (uma árvore por candidato):
//     campanhas/claudia/pessoas/5519...
//     campanhas/claudia/grupos/1203...
//     campanhas/fernandao/pessoas/...
//
// Assim o mesmo projeto Firebase atende vários candidatos sem risco de um
// enxergar o outro, e o console fica legível. Quem preferir isolamento total
// pode dar a cada campanha o seu próprio projeto (basta uma firebase_key
// diferente) — o código trata os dois casos.

import { readFileSync } from 'node:fs';
import { comCampanha, db } from './db.js';
import * as contas from './contas.js';

const CONFIRMAR = process.argv.includes('--confirmar');
const PREFIXO = 'campanhas';
const COLECOES = ['pessoas', 'grupos', 'assinaturas', 'abaixos', 'alertas', 'eventos', 'mensagens'];

// Documentos criados pelas suítes de teste que escaparam para produção.
const EH_LIXO_DE_TESTE = (colecao, id, dados) => {
  if (colecao === 'grupos') {
    return /^0{6,}/.test(id) || /Grupo (de )?Teste/i.test(dados?.nome ?? '');
  }
  if (colecao === 'pessoas') {
    return /^55199(00000|55550|77700|11112)/.test(id)
      || /Teste|Testadora|Silencioso|Recém Chegada/i.test(dados?.nome ?? dados?.nomeWhatsapp ?? '');
  }
  if (colecao === 'alertas') return /Grupo (de )?Teste/i.test(dados?.titulo ?? '');
  return false;
};

const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');

async function clienteDe(slug) {
  const cfg = contas.configDaCampanha(slug);
  if (!cfg?.firebaseKey) return null;
  const conta = JSON.parse(readFileSync(cfg.firebaseKey, 'utf8'));
  const nome = `migra-${slug}`;
  const app = getApps().find((a) => a.name === nome)
    ?? initializeApp({ credential: cert(conta), projectId: conta.project_id }, nome);
  const fs = getFirestore(app);
  fs.settings({ ignoreUndefinedProperties: true });
  return { fs, projeto: conta.project_id };
}

/** Copia em lotes de 400 — o limite do batch do Firestore é 500. */
async function moverColecao(fs, slug, colecao, { confirmar }) {
  const origem = await fs.collection(colecao).get();
  if (origem.empty) return { movidos: 0, lixo: 0 };

  let movidos = 0;
  let lixo = 0;
  let lote = fs.batch();
  let naFila = 0;

  const despejar = async () => {
    if (!naFila) return;
    if (confirmar) await lote.commit();
    lote = fs.batch();
    naFila = 0;
  };

  for (const doc of origem.docs) {
    const dados = doc.data();

    if (EH_LIXO_DE_TESTE(colecao, doc.id, dados)) {
      lixo++;
      lote.delete(doc.ref);                    // some sem ser copiado
    } else {
      movidos++;
      lote.set(fs.collection(`${PREFIXO}/${slug}/${colecao}`).doc(doc.id), dados);
      lote.delete(doc.ref);                    // remove a versão antiga da raiz
    }

    naFila += 2;
    if (naFila >= 400) await despejar();
  }
  await despejar();

  return { movidos, lixo };
}

// ---------------------------------------------------------------------------
console.log(`\n${CONFIRMAR ? 'Migrando' : 'Simulando a migração'} — uma árvore por candidato\n`);

const campanhas = contas.listarCampanhas();
let algoAFazer = false;

for (const campanha of campanhas) {
  const cliente = await clienteDe(campanha.slug);
  if (!cliente) {
    console.log(`  ${campanha.slug.padEnd(16)} sem chave do Firebase — nada a migrar`);
    continue;
  }

  console.log(`  ${campanha.nome}  (projeto ${cliente.projeto})`);

  let totalMovidos = 0;
  let totalLixo = 0;

  for (const colecao of COLECOES) {
    const { movidos, lixo } = await moverColecao(cliente.fs, campanha.slug, colecao, { confirmar: CONFIRMAR });
    if (movidos || lixo) {
      console.log(`     ${colecao.padEnd(13)} ${String(movidos).padStart(5)} → ${PREFIXO}/${campanha.slug}/${colecao}` +
        `${lixo ? `   (${lixo} de teste, descartados)` : ''}`);
    }
    totalMovidos += movidos;
    totalLixo += lixo;
  }

  if (!totalMovidos && !totalLixo) {
    console.log('     (raiz já está limpa — provavelmente já migrada)');
    continue;
  }
  algoAFazer = true;

  if (CONFIRMAR) {
    // Documento-pai: sem ele, o console mostra a coleção em itálico e alguns
    // SDKs não listam a subcoleção.
    await cliente.fs.collection(PREFIXO).doc(campanha.slug).set({
      slug: campanha.slug,
      nome: campanha.nome,
      cargo: campanha.cargo,
      cor: campanha.cor,
      ativa: Boolean(campanha.ativa),
      migradoEm: new Date()
    }, { merge: true });

    contas.atualizarCampanha(campanha.slug, { firebase_prefixo: PREFIXO });

    // A outbox local aponta para os caminhos antigos; refazer garante que a
    // próxima sincronização escreva na árvore nova.
    comCampanha(campanha.slug, () => db.prepare('DELETE FROM outbox').run());
  }

  console.log(`     total: ${totalMovidos} documentos${totalLixo ? ` · ${totalLixo} de teste descartados` : ''}\n`);
}

if (!CONFIRMAR) {
  console.log(`\n── simulação ── nada foi alterado.`);
  console.log('Para aplicar:  npm run firebase:migrar -- --confirmar\n');
} else if (algoAFazer) {
  console.log('✅ Migração concluída. Cada candidato agora tem a própria árvore.');
  console.log('   Rode "npm run firebase:sync" para repovoar a fila na estrutura nova.\n');
} else {
  console.log('Nada a fazer.\n');
}

process.exit(0);
