// Importa os abaixo-assinados exportados do Meta (Facebook/Instagram Lead Ads).
//
//   npm run importar            -> lê todos os CSV de data/leads/ e soma à base
//   npm run importar -- --limpar -> zera a base antes (usar ao entrar em produção)
//
// O casamento é sempre pelo telefone: quem assinou e já está num grupo de
// WhatsApp vira uma pessoa só, com as duas origens registradas.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, agora, usarCampanha, pastaDeLeads, campanhaAtual } from './db.js';
import { lerCsv, prepararLead } from './leads.js';
import { registrarEvento } from './ingest.js';
import { recomputar } from './scoring.js';

import {
  publicarPessoa, publicarAbaixo, publicarAssinatura, sincronizarTudo, estadoDoFirebase
} from './firestore.js';

// Resolvida na hora da chamada: o servidor importa este módulo e a campanha
// muda a cada requisição.
const pastaDeLeadsAtual = () => pastaDeLeads(campanhaAtual());

function upsertAbaixo(abaixo, campanha) {
  const existente = db.prepare('SELECT id FROM abaixos WHERE form_id = ?').get(abaixo.formId);
  if (existente) return existente.id;
  const r = db.prepare(
    'INSERT INTO abaixos (form_id, chave, titulo, bandeira, temas, campanha) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(abaixo.formId, abaixo.chave, abaixo.titulo, abaixo.bandeira,
    JSON.stringify(abaixo.temas || []), campanha || null);
  return Number(r.lastInsertRowid);
}

function upsertPessoaDoLead(lead) {
  const jid = `${lead.telefone}@s.whatsapp.net`;
  const existente = db.prepare('SELECT * FROM pessoas WHERE wa_jid = ? OR telefone = ?')
    .get(jid, lead.telefone);

  if (!existente) {
    const r = db.prepare(`
      INSERT INTO pessoas (wa_jid, telefone, nome, cidade, uf, cidade_bruta, atuacao, email,
                           origem, cadastro_em, primeiro_visto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'abaixo-assinado', ?, ?)
    `).run(jid, lead.telefone, lead.nome, lead.cidade, lead.uf, lead.cidadeBruta,
      lead.atuacao, lead.email, lead.criadoEm, lead.criadoEm);
    return { id: Number(r.lastInsertRowid), novo: true };
  }

  // Já existe (veio de um grupo, ou assinou outro abaixo-assinado antes).
  // Preenche só o que está vazio — nunca sobrescreve trabalho manual da equipe.
  db.prepare(`
    UPDATE pessoas SET
      nome         = COALESCE(NULLIF(nome, ''), ?),
      atuacao      = COALESCE(NULLIF(atuacao, ''), ?),
      email        = COALESCE(NULLIF(email, ''), ?),
      uf           = COALESCE(NULLIF(uf, ''), ?),
      cadastro_em  = MIN(COALESCE(cadastro_em, ?), ?),
      primeiro_visto = MIN(COALESCE(primeiro_visto, ?), ?)
    WHERE id = ?
  `).run(lead.nome, lead.atuacao, lead.email, lead.uf,
    lead.criadoEm, lead.criadoEm, lead.criadoEm, lead.criadoEm, existente.id);

  // Cidade e o texto que a originou andam juntos: se a assinatura anterior não
  // trouxe cidade utilizável, esta assume o par inteiro.
  if (lead.cidade && !existente.cidade) {
    db.prepare('UPDATE pessoas SET cidade = ?, cidade_bruta = ?, uf = COALESCE(?, uf) WHERE id = ?')
      .run(lead.cidade, lead.cidadeBruta, lead.uf, existente.id);
  }

  return { id: existente.id, novo: false, jaEraDoGrupo: existente.origem === 'grupo' };
}

export function importarArquivo(caminho) {
  // Buffer, não string: `lerCsv` precisa dos bytes para achar o BOM e decidir a
  // codificação. Ler como utf8 já teria destruído um arquivo UTF-16.
  return importarConteudo(readFileSync(caminho), caminho.split(/[\\/]/).pop());
}

/**
 * O importador de verdade. Recebe o conteúdo, não o caminho — é o que permite
 * importar tanto de `data/campanhas/<slug>/leads/` quanto de um upload do
 * painel, sem duplicar a regra.
 */
export function importarConteudo(conteudo, nomeArquivo = 'upload.csv') {
  const linhas = lerCsv(conteudo);
  const resumo = {
    arquivo: nomeArquivo,
    lidos: linhas.length,
    importados: 0, novos: 0, jaExistiam: 0, casadosComGrupo: 0,
    repetidos: 0, invalidos: 0, abaixos: new Set()
  };

  const jaTem = db.prepare('SELECT 1 FROM assinaturas WHERE lead_id = ?');
  const inserirAssinatura = db.prepare(`
    INSERT INTO assinaturas (lead_id, abaixo_id, pessoa_id, criado_em, plataforma, organico,
                             anuncio, conjunto, cidade_bruta, atuacao, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tocadas = new Set();
  const novasAssinaturas = [];
  const abaixosVistos = new Set();

  db.exec('BEGIN');
  try {
    for (const linha of linhas) {
      const lead = prepararLead(linha);
      if (!lead || !lead.telefoneValido) { resumo.invalidos++; continue; }
      if (jaTem.get(lead.leadId)) { resumo.repetidos++; continue; }

      const abaixoId = upsertAbaixo(lead.abaixo, lead.campanha);
      abaixosVistos.add(abaixoId);
      resumo.abaixos.add(lead.abaixo.titulo);

      const pessoa = upsertPessoaDoLead(lead);

      // Quem escreveu uma opinião no campo cidade está dando um recado —
      // vale mais como observação da ficha do que como lixo descartado.
      if (lead.desabafo) {
        db.prepare(`
          UPDATE pessoas SET observacoes = COALESCE(NULLIF(observacoes, '') || ' · ', '') || ?
           WHERE id = ? AND COALESCE(observacoes, '') NOT LIKE ?
        `).run(`"${lead.desabafo}" (escrito no campo cidade)`, pessoa.id, `%${lead.desabafo}%`);
        resumo.desabafos = (resumo.desabafos || 0) + 1;
      }

      if (pessoa.novo) resumo.novos++;
      else {
        resumo.jaExistiam++;
        if (pessoa.jaEraDoGrupo) resumo.casadosComGrupo++;
      }

      const r = inserirAssinatura.run(
        lead.leadId, abaixoId, pessoa.id, lead.criadoEm, lead.plataforma,
        lead.organico ? 1 : 0, lead.anuncio, lead.conjunto, lead.cidadeBruta,
        lead.atuacao, lead.status
      );
      novasAssinaturas.push(Number(r.lastInsertRowid));

      registrarEvento({
        pessoaId: pessoa.id,
        tipo: 'assinou',
        descricao: `Assinou "${lead.abaixo.titulo}" via ${lead.plataforma || 'anúncio'}`,
        ts: lead.criadoEm
      });

      tocadas.add(pessoa.id);
      resumo.importados++;
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  resumo.abaixos = [...resumo.abaixos];
  resumo.pessoasTocadas = [...tocadas];
  resumo.assinaturas = novasAssinaturas;
  resumo.abaixosIds = [...abaixosVistos];
  return resumo;
}

export function importarPasta(pasta = null) {
  pasta ??= pastaDeLeadsAtual();
  if (!existsSync(pasta)) {
    return { erro: `Pasta ${pasta} não existe. Coloque os CSV exportados do Meta lá dentro.` };
  }
  const arquivos = readdirSync(pasta).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (!arquivos.length) return { erro: 'Nenhum CSV encontrado em data/leads/.' };

  const resumos = arquivos.map((f) => importarArquivo(join(pasta, f)));
  return finalizarImportacao(resumos);
}

/**
 * Importa arquivos enviados pelo painel.
 *
 * `arquivos` = [{ nome, conteudo: Buffer }]. Guarda uma cópia em
 * data/campanhas/<slug>/leads/ antes de importar — se algo der errado na
 * interpretação, o arquivo original continua no servidor para conferência, e
 * não depende de alguém reencontrar o export no Gerenciador de Anúncios.
 */
export function importarEnviados(arquivos = []) {
  if (!arquivos.length) return { erro: 'Nenhum arquivo recebido.' };

  const pasta = pastaDeLeadsAtual();
  mkdirSync(pasta, { recursive: true });

  const resumos = [];
  for (const arquivo of arquivos) {
    const conteudo = Buffer.isBuffer(arquivo.conteudo)
      ? arquivo.conteudo
      : Buffer.from(arquivo.conteudo ?? '', 'base64');

    // Nome saneado: o que vem do navegador é texto de terceiro e não pode
    // virar caminho. Sem isto, "../../algo.csv" escreve fora da pasta.
    const seguro = String(arquivo.nome || 'upload.csv')
      .replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-120) || 'upload.csv';
    const destino = join(pasta, `${Date.now()}-${seguro}`);

    try {
      writeFileSync(destino, conteudo);
    } catch { /* sem disco de escrita: importa mesmo assim, o dado é o que importa */ }

    try {
      resumos.push(importarConteudo(conteudo, arquivo.nome || seguro));
    } catch (erro) {
      resumos.push({
        arquivo: arquivo.nome || seguro,
        erro: erro.message,
        lidos: 0, importados: 0, novos: 0, jaExistiam: 0,
        casadosComGrupo: 0, repetidos: 0, invalidos: 0,
        abaixos: [], pessoasTocadas: [], assinaturas: [], abaixosIds: []
      });
    }
  }

  return finalizarImportacao(resumos);
}

/**
 * O que acontece depois de importar, seja da pasta ou de um upload:
 * recalcular o perfil de quem foi tocado e publicar no Firestore.
 *
 * A publicação é o que faz o lead sobreviver a um deploy — sem ela o cadastro
 * fica só no banco local, que num servidor sem disco é apagado.
 */
function finalizarImportacao(resumos) {
  recomputar();

  const pessoas = new Set(resumos.flatMap((r) => r.pessoasTocadas ?? []));
  for (const id of pessoas) publicarPessoa(id);
  for (const id of new Set(resumos.flatMap((r) => r.abaixosIds ?? []))) publicarAbaixo(id);
  for (const id of resumos.flatMap((r) => r.assinaturas ?? [])) publicarAssinatura(id);

  const soma = (campo) => resumos.reduce((s, r) => s + (r[campo] ?? 0), 0);
  return {
    arquivos: resumos.map(({ pessoasTocadas, assinaturas, abaixosIds, ...r }) => r),
    total: {
      lidos: soma('lidos'),
      importados: soma('importados'),
      novos: soma('novos'),
      jaExistiam: soma('jaExistiam'),
      casadosComGrupo: soma('casadosComGrupo'),
      repetidos: soma('repetidos'),
      invalidos: soma('invalidos'),
      pessoasAfetadas: pessoas.size
    },
    // Sem isto o painel diz "importado com sucesso" e o dado some no deploy.
    espelhado: Boolean(estadoDoFirebase().conectado)
  };
}

function limparBase() {
  db.exec(`
    DELETE FROM reacoes; DELETE FROM mensagens; DELETE FROM eventos; DELETE FROM alertas;
    DELETE FROM pessoa_tags; DELETE FROM membros; DELETE FROM temas_pessoa;
    DELETE FROM perfil; DELETE FROM assinaturas; DELETE FROM abaixos;
    DELETE FROM pessoas; DELETE FROM grupos; DELETE FROM tags; DELETE FROM outbox;
  `);
}

const TAGS_PADRAO = [
  { nome: 'Liderança confirmada', cor: '#7c3aed' },
  { nome: 'Voluntário ativo', cor: '#16a34a' },
  { nome: 'Já foi visitado', cor: '#2563eb' },
  { nome: 'Doador', cor: '#f59e0b' },
  { nome: 'Atenção / atrito', cor: '#dc2626' },
  { nome: 'Multiplicador WhatsApp', cor: '#0891b2' }
];

// ---------------------------------------------------------------------- CLI
// Só executa como CLI quando este arquivo é o ponto de entrada — importá-lo
// pelo servidor não pode disparar nada.
if (process.argv[1]?.endsWith('importar-leads.js')) {
  usarCampanha();   // só quando roda como CLI — nunca ao ser importado pelo servidor
  const limpar = process.argv.includes('--limpar');

  if (limpar) {
    console.log('› limpando a base (modo produção)…');
    limparBase();
    for (const t of TAGS_PADRAO) {
      db.prepare('INSERT OR IGNORE INTO tags (nome, cor) VALUES (?, ?)').run(t.nome, t.cor);
    }
  }

  console.log(`› lendo CSVs de ${pastaDeLeadsAtual()}…`);
  const r = importarPasta();

  if (r.erro) {
    console.error(`\n❌ ${r.erro}\n`);
    process.exit(1);
  }

  for (const a of r.arquivos) {
    console.log(`   ${a.arquivo}: ${a.importados}/${a.lidos} importados` +
      `${a.repetidos ? ` · ${a.repetidos} já existiam` : ''}` +
      `${a.invalidos ? ` · ${a.invalidos} inválidos` : ''}`);
    for (const titulo of a.abaixos) console.log(`      ↳ ${titulo}`);
  }

  const pessoas = db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n;
  const assinaturas = db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get().n;

  console.log(`
✅ Importação concluída
   ${r.total.importados} assinaturas importadas (${r.total.novos} pessoas novas,
   ${r.total.jaExistiam} já estavam na base, ${r.total.casadosComGrupo} casadas com membro de grupo)
   Base agora: ${pessoas} pessoas · ${assinaturas} assinaturas
`);

  await import('./firestore.js').then(async (fb) => {
    await fb.iniciarFirebase();
    if (estadoDoFirebase().conectado) {
      sincronizarTudo();
      const envio = await fb.processarFila();
      console.log(`   Firestore: ${envio.enviados} documentos enviados.\n`);
    } else {
      const pendentes = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE enviado_em IS NULL').get().n;
      console.log(`   Firestore: ${pendentes} documentos na fila, aguardando credencial.`);
      console.log('   Configure o .env e rode "npm run firebase:sync".\n');
    }
    process.exit(0);
  });
}
