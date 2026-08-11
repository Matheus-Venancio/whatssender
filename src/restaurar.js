// Traz a base de uma campanha de volta do Firestore para o banco local.
//
// POR QUE ISSO EXISTE: o banco fica em data/, que nunca vai para o git (dado
// pessoal e chave do Firebase). Servidor novo — Render, VPS, outra máquina —
// nasce vazio, e "conectar o Firebase" não muda isso: a sincronização só
// ESCREVE. Sem este caminho de volta, o Firestore vira um backup que ninguém
// consegue usar.
//
// O que NÃO volta:
//   · a sessão do WhatsApp — de propósito. A mesma sessão em duas máquinas faz
//     o WhatsApp invalidar o pareamento. Cada servidor lê o seu QR.
//   · o histórico de mensagens, que não é espelhado por padrão (volume alto).
//     A classificação por participação se refaz com as conversas novas.

import { readFileSync } from 'node:fs';
import { db, comCampanha } from './db.js';
import * as contas from './contas.js';

const emMs = (valor) => {
  if (!valor) return null;
  if (typeof valor?.toDate === 'function') return valor.toDate().getTime();
  const t = new Date(valor).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Abre um cliente Firestore só para leitura, com a credencial da campanha. */
async function clienteDaCampanha(config, slug) {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');

  const conta = JSON.parse(readFileSync(config.firebaseKey, 'utf8'));
  const nome = `restaura-${slug}`;
  const app = getApps().find((a) => a.name === nome)
    ?? initializeApp({ credential: cert(conta), projectId: conta.project_id }, nome);

  return { fs: getFirestore(app), projeto: conta.project_id };
}

/**
 * @param {string} slug        campanha a restaurar
 * @param {boolean} confirmar  false = só conta o que viria (padrão, não escreve)
 */
export async function restaurarDoFirestore(slug, { confirmar = false } = {}) {
  const config = contas.configDaCampanha(slug);
  if (!config) return { erro: `Campanha "${slug}" não existe.` };
  if (!config.firebaseKey) {
    return { erro: 'Esta campanha ainda não tem a chave do Firebase configurada.' };
  }

  const { fs, projeto } = await clienteDaCampanha(config, slug);

  // Mesmo caminho que a sincronização usa para escrever — ver a nota em
  // contas.js sobre a pasta poder divergir do slug.
  const pasta = config.firebasePasta || slug;
  const raiz = config.firebasePrefixo ? `${config.firebasePrefixo}/${pasta}/` : '';
  const ler = async (colecao) => (await fs.collection(raiz + colecao).get()).docs;

  const [pessoas, grupos, abaixos, assinaturas] = await Promise.all([
    ler('pessoas'), ler('grupos'), ler('abaixos'), ler('assinaturas')
  ]);

  const antes = comCampanha(slug, () => ({
    pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
    grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos').get().n
  }));

  const noFirestore = {
    pessoas: pessoas.length, grupos: grupos.length,
    abaixos: abaixos.length, assinaturas: assinaturas.length
  };

  if (!confirmar) {
    return { simulacao: true, projeto, caminho: raiz || '(raiz)', antes, noFirestore };
  }

  const resumo = comCampanha(slug, () => {
    const idPorChaveAbaixo = new Map();
    db.exec('BEGIN');
    try {
      // --- grupos ---------------------------------------------------------
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

      // --- abaixo-assinados -----------------------------------------------
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

      // --- pessoas --------------------------------------------------------
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
      const buscarId = db.prepare('SELECT id FROM pessoas WHERE wa_jid = ?');

      for (const doc of pessoas) {
        const p = doc.data();
        const telefone = p.telefone ?? doc.id;
        const jid = p.waJid ?? `${telefone}@s.whatsapp.net`;
        gravarPessoa.run(jid, telefone, p.nomeWhatsapp ?? null, p.nome ?? null,
          p.cidade ?? null, p.uf ?? null, p.cidadeInformada ?? null, p.bairro ?? null,
          p.atuacao ?? null, p.email ?? null, p.origem ?? 'grupo',
          emMs(p.cadastroEm), emMs(p.primeiroVisto), p.observacoes ?? null,
          p.naAgenda ? 1 : 0, p.nomeAgenda ?? null);

        const id = buscarId.get(jid).id;
        for (const g of p.grupos ?? []) {
          const grupoId = gruposPorJid.get(g.jid);
          if (grupoId) vincular.run(id, grupoId, emMs(g.entrouEm), g.admin ? 1 : 0, emMs(g.saiuEm));
        }
      }

      // --- assinaturas ----------------------------------------------------
      const gravarAssinatura = db.prepare(`
        INSERT INTO assinaturas (lead_id, abaixo_id, pessoa_id, criado_em, plataforma,
                                 organico, anuncio, conjunto, cidade_bruta, atuacao, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(lead_id) DO NOTHING
      `);
      const porTelefone = db.prepare('SELECT id FROM pessoas WHERE telefone = ?');
      let assinaturasOk = 0;
      for (const doc of assinaturas) {
        const a = doc.data();
        const abaixoId = idPorChaveAbaixo.get(a.abaixoChave);
        const pessoa = porTelefone.get(a.telefone);
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
  comCampanha(slug, () => recomputar());

  const depois = comCampanha(slug, () => ({
    pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
    grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos').get().n,
    assinaturas: db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get().n,
    membros: db.prepare('SELECT COUNT(*) AS n FROM membros').get().n
  }));

  return { ok: true, projeto, caminho: raiz || '(raiz)', noFirestore, antes, depois, ...resumo };
}
