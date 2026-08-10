// Reconstrói o banco local de uma campanha a partir do Firestore dela.
//
//   npm run restaurar -- --campanha claudia
//   npm run restaurar -- --campanha claudia --confirmar
//
// Para que serve: o banco fica em data/, que nunca vai para o git (tem dado
// pessoal e a chave do Firebase). Quando você sobe o sistema num servidor
// novo — Render, VPS, outra máquina — ele nasce vazio. Este comando traz a
// base de volta do Firestore, que já é o sistema de registro.
//
// O que NÃO volta: a sessão do WhatsApp. É de propósito. A mesma sessão em
// duas máquinas faz o WhatsApp invalidar o pareamento. Cada servidor lê o
// seu QR.

import { readFileSync } from 'node:fs';
import { db, comCampanha } from './db.js';
import * as contas from './contas.js';

const arg = (nome, padrao = null) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
};

const SLUG = arg('campanha');
const CONFIRMAR = process.argv.includes('--confirmar');

if (!SLUG) {
  console.error(`
Informe a campanha:
  npm run restaurar -- --campanha claudia

Campanhas cadastradas: ${contas.listarCampanhas().map((c) => c.slug).join(', ') || '(nenhuma)'}
`);
  process.exit(1);
}

const config = contas.configDaCampanha(SLUG);
if (!config) {
  console.error(`\n❌ Campanha "${SLUG}" não existe. Crie antes com: npm run configurar -- --campanha "Nome"\n`);
  process.exit(1);
}
if (!config.firebaseKey) {
  console.error(`\n❌ A campanha "${SLUG}" não tem chave do Firebase configurada.\n`);
  process.exit(1);
}

const { initializeApp, cert } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');

const conta = JSON.parse(readFileSync(config.firebaseKey, 'utf8'));
const fs = getFirestore(initializeApp({ credential: cert(conta), projectId: conta.project_id }, `restaura-${SLUG}`));

const raiz = config.firebasePrefixo ? `${config.firebasePrefixo}/${SLUG}/` : '';
const ler = async (colecao) => (await fs.collection(raiz + colecao).get()).docs;

console.log(`\nRestaurando "${config.nome}" do projeto ${conta.project_id}`);
console.log(`caminho no Firestore: ${raiz || '(raiz)'}\n`);

const [pessoas, grupos, abaixos, assinaturas] = await Promise.all([
  ler('pessoas'), ler('grupos'), ler('abaixos'), ler('assinaturas')
]);

const local = comCampanha(SLUG, () => ({
  pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
  grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos').get().n
}));

console.log('No Firestore:');
console.log(`  pessoas      ${pessoas.length}`);
console.log(`  grupos       ${grupos.length}`);
console.log(`  abaixos      ${abaixos.length}`);
console.log(`  assinaturas  ${assinaturas.length}`);
console.log(`\nNo banco local: ${local.pessoas} pessoas · ${local.grupos} grupos`);

if (!CONFIRMAR) {
  console.log('\n── simulação ── nada foi escrito.');
  console.log(`Para restaurar de verdade:  npm run restaurar -- --campanha ${SLUG} --confirmar\n`);
  process.exit(0);
}

const emMs = (valor) => {
  if (!valor) return null;
  if (typeof valor?.toDate === 'function') return valor.toDate().getTime();
  const t = new Date(valor).getTime();
  return Number.isFinite(t) ? t : null;
};

console.log('\n› gravando…');

const resumo = comCampanha(SLUG, () => {
  const idPorJid = new Map();
  const idPorChaveAbaixo = new Map();

  db.exec('BEGIN');
  try {
    // --- grupos ------------------------------------------------------------
    const gravarGrupo = db.prepare(`
      INSERT INTO grupos (wa_jid, nome, descricao, criado_em, ativo) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wa_jid) DO UPDATE SET nome = excluded.nome, descricao = excluded.descricao
    `);
    for (const doc of grupos) {
      const g = doc.data();
      gravarGrupo.run(g.jid ?? doc.id, g.nome ?? doc.id, g.descricao ?? null,
        emMs(g.criadoEm), g.ativo === false ? 0 : 1);
    }
    const gruposPorJid = new Map(
      db.prepare('SELECT id, wa_jid FROM grupos').all().map((g) => [g.wa_jid, g.id])
    );

    // --- abaixo-assinados --------------------------------------------------
    const gravarAbaixo = db.prepare(`
      INSERT INTO abaixos (form_id, chave, titulo, bandeira, temas, campanha)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(form_id) DO UPDATE SET titulo = excluded.titulo
    `);
    for (const doc of abaixos) {
      const a = doc.data();
      gravarAbaixo.run(a.formId ?? doc.id, a.chave ?? doc.id, a.titulo ?? doc.id,
        a.bandeira ?? null, JSON.stringify(a.temas ?? []), a.campanha ?? null);
    }
    for (const a of db.prepare('SELECT id, chave FROM abaixos').all()) {
      idPorChaveAbaixo.set(a.chave, a.id);
    }

    // --- pessoas -----------------------------------------------------------
    const gravarPessoa = db.prepare(`
      INSERT INTO pessoas (wa_jid, telefone, nome_wa, nome, cidade, uf, cidade_bruta, bairro,
                           atuacao, email, origem, cadastro_em, primeiro_visto, observacoes,
                           na_agenda, nome_agenda)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(wa_jid) DO UPDATE SET
        nome = COALESCE(excluded.nome, pessoas.nome),
        cidade = COALESCE(excluded.cidade, pessoas.cidade),
        uf = COALESCE(excluded.uf, pessoas.uf),
        atuacao = COALESCE(excluded.atuacao, pessoas.atuacao),
        email = COALESCE(excluded.email, pessoas.email),
        na_agenda = MAX(pessoas.na_agenda, excluded.na_agenda)
    `);
    const vincular = db.prepare(`
      INSERT INTO membros (pessoa_id, grupo_id, entrou_em, admin, saiu_em) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pessoa_id, grupo_id) DO UPDATE SET saiu_em = excluded.saiu_em
    `);

    for (const doc of pessoas) {
      const p = doc.data();
      const telefone = p.telefone ?? doc.id;
      const jid = p.waJid ?? `${telefone}@s.whatsapp.net`;
      gravarPessoa.run(jid, telefone, p.nomeWhatsapp ?? null, p.nome ?? null,
        p.cidade ?? null, p.uf ?? null, p.cidadeInformada ?? null, p.bairro ?? null,
        p.atuacao ?? null, p.email ?? null, p.origem ?? 'grupo',
        emMs(p.cadastroEm), emMs(p.primeiroVisto), p.observacoes ?? null,
        p.naAgenda ? 1 : 0, p.nomeAgenda ?? null);

      const id = db.prepare('SELECT id FROM pessoas WHERE wa_jid = ?').get(jid).id;
      idPorJid.set(jid, id);

      for (const g of p.grupos ?? []) {
        const grupoId = gruposPorJid.get(g.jid);
        if (grupoId) {
          vincular.run(id, grupoId, emMs(g.entrouEm), g.admin ? 1 : 0, emMs(g.saiuEm));
        }
      }
    }

    // --- assinaturas -------------------------------------------------------
    const gravarAssinatura = db.prepare(`
      INSERT INTO assinaturas (lead_id, abaixo_id, pessoa_id, criado_em, plataforma,
                               organico, anuncio, conjunto, cidade_bruta, atuacao, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(lead_id) DO NOTHING
    `);
    let assinaturasOk = 0;
    for (const doc of assinaturas) {
      const a = doc.data();
      const abaixoId = idPorChaveAbaixo.get(a.abaixoChave);
      const pessoa = db.prepare('SELECT id FROM pessoas WHERE telefone = ?').get(a.telefone);
      if (!abaixoId || !pessoa) continue;
      gravarAssinatura.run(a.leadId ?? doc.id, abaixoId, pessoa.id, emMs(a.em) ?? Date.now(),
        a.plataforma ?? null, a.organico ? 1 : 0, a.anuncio ?? null, a.conjunto ?? null,
        a.cidadeInformada ?? null, a.atuacao ?? null, a.status ?? null);
      assinaturasOk++;
    }

    db.exec('COMMIT');
    return { assinaturasOk };
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
});

const { recomputar } = await import('./scoring.js');
comCampanha(SLUG, () => recomputar());

const final = comCampanha(SLUG, () => ({
  pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
  grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos').get().n,
  assinaturas: db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get().n,
  membros: db.prepare('SELECT COUNT(*) AS n FROM membros').get().n
}));

console.log(`
✅ Base de "${config.nome}" restaurada
   ${final.pessoas} pessoas · ${final.grupos} grupos · ${final.membros} vínculos
   ${final.assinaturas} assinaturas (${resumo.assinaturasOk} vieram do Firestore)

   O histórico de mensagens NÃO volta — ele não é espelhado no Firestore por
   padrão. A classificação por participação se refaz conforme as conversas
   novas chegarem.

   Falta ler o QR do WhatsApp neste servidor.
`);
process.exit(0);
