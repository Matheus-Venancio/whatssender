// Configuração inicial e gestão de campanhas/usuários pela linha de comando.
//
//   npm run configurar                       -> migra a base antiga e cria o admin
//   npm run configurar -- --campanha "Fernando Souza" --cargo "Vereador - Campinas"
//   n pm run configurar -- --usuario ana@x.com --nome "Ana" --papel equipe --campanha-slug fernando
//   npm run configurar -- --listar
//
// A migração acontece uma vez: data/rede.db + data/auth + data/leads viram
// data/campanhas/<slug>/…  Nada é apagado — os arquivos são movidos.

import { existsSync, renameSync, mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PASTA_DADOS, pastaDaCampanha, pastaDeAuth, pastaDeLeads, comCampanha, db } from './db.js';
import * as contas from './contas.js';

const arg = (nome, padrao = null) => {
  const i = process.argv.indexOf(` --${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
};
const tem = (nome) => process.argv.includes(`--${nome}`);

const linha = (t = '') => console.log(t);

// ---------------------------------------------------------------- migração
function migrarBaseAntiga(slug, nome) {
  const bancoAntigo = join(PASTA_DADOS, 'rede.db');
  if (!existsSync(bancoAntigo)) return false;

  const destino = pastaDaCampanha(slug);
  mkdirSync(destino, { recursive: true });

  linha(`› migrando a base existente para a campanha "${nome}"…`);

  for (const arquivo of ['rede.db', 'rede.db-wal', 'rede.db-shm']) {
    const de = join(PASTA_DADOS, arquivo);
    if (existsSync(de)) renameSync(de, join(destino, arquivo));
  }

  const authAntigo = join(PASTA_DADOS, 'auth');
  if (existsSync(authAntigo)) {
    renameSync(authAntigo, pastaDeAuth(slug));
    linha('  · sessão do WhatsApp movida (não precisa parear de novo)');
  }

  const leadsAntigo = join(PASTA_DADOS, 'leads');
  if (existsSync(leadsAntigo)) {
    mkdirSync(pastaDeLeads(slug), { recursive: true });
    for (const f of readdirSync(leadsAntigo)) {
      cpSync(join(leadsAntigo, f), join(pastaDeLeads(slug), f));
    }
    rmSync(leadsAntigo, { recursive: true, force: true });
    linha('  · CSVs dos abaixo-assinados movidos');
  }

  return true;
}

// ------------------------------------------------------------------ ações
function mostrarUsuario(u, senha) {
  linha(`  ${u.papel.padEnd(10)} ${u.email.padEnd(30)} ${u.nome}`);
  if (senha) linha(`  ${''.padEnd(10)} senha: ${senha}   ← anote, não aparece de novo`);
}

function listar() {
  const campanhas = contas.listarCampanhas();
  linha('\nCampanhas:');
  if (!campanhas.length) linha('  (nenhuma)');
  for (const c of campanhas) {
    const contagem = comCampanha(c.slug, () => ({
      pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
      grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos').get().n
    }));
    linha(`  ${c.slug.padEnd(14)} ${c.nome.padEnd(28)} ${contagem.pessoas} pessoas · ${contagem.grupos} grupos` +
      `${c.firebase_key ? ' · firebase próprio' : ''}${c.ativa ? '' : ' · INATIVA'}`);
    linha(`  ${''.padEnd(14)} formulário: /cadastro/${c.slug}`);
  }
  linha('\nUsuários:');
  const us = contas.listarUsuarios();
  if (!us.length) linha('  (nenhum)');
  for (const u of us) {
    linha(`  ${u.papel.padEnd(10)} ${u.email.padEnd(30)} ${u.nome}` +
      `${u.campanha_slug ? ` → ${u.campanha_slug}` : ' → todas'}${u.ativo ? '' : ' · DESATIVADO'}`);
  }
  linha('');
}

// ------------------------------------------------------------------- fluxo
if (tem('listar')) {
  listar();
  process.exit(0);
}

// Cadastrar um usuário avulso
if (arg('usuario')) {
  const email = arg('usuario');
  const nome = arg('nome') || email.split('@')[0];
  const papel = arg('papel', 'equipe');
  const campanhaSlug = arg('campanha-slug');
  try {
    const u = contas.criarUsuario({ email, nome, papel, campanhaSlug, senha: arg('senha') });
    linha('\n✅ Usuário criado:');
    mostrarUsuario(u, u.senhaGerada);
    linha('');
  } catch (erro) {
    console.error(`\n❌ ${erro.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// Cadastrar uma campanha nova
if (arg('campanha')) {
  const nome = arg('campanha');
  const slug = arg('slug') || contas.slugificar(nome);
  try {
    const c = contas.criarCampanha({
      nome,
      cargo: arg('cargo'),
      slug,
      cor: arg('cor', '#5b21b6'),
      firebaseKey: arg('firebase-key')
    });
    linha(`\n✅ Campanha "${c.nome}" criada (${c.slug})`);
    linha(`   banco:      data/campanhas/${c.slug}/rede.db`);
    linha(`   formulário: /cadastro/${c.slug}`);

    // Já cria os dois acessos que toda campanha precisa.
    const equipe = contas.criarUsuario({
      email: arg('email-equipe') || `equipe@${slug}.local`,
      nome: `Equipe ${nome}`, papel: 'equipe', campanhaSlug: slug
    });
    const candidato = contas.criarUsuario({
      email: arg('email-candidato') || `${slug}@candidato.local`,
      nome, papel: 'candidato', campanhaSlug: slug
    });
    linha('\n   Acessos criados:');
    mostrarUsuario(equipe, equipe.senhaGerada);
    mostrarUsuario(candidato, candidato.senhaGerada);
    linha('');
    linha(`   Falta apontar o Firebase dela: coloque a chave em data/campanhas/${slug}/firebase-key.json`);
    linha(`   e rode:  npm run configurar -- --firebase ${slug}`);
    linha('');
  } catch (erro) {
    console.error(`\n❌ ${erro.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// Apontar a chave do Firebase de uma campanha
if (arg('firebase')) {
  const slug = arg('firebase');
  const caminho = arg('caminho') || `data/campanhas/${slug}/firebase-key.json`;
  if (!existsSync(join(PASTA_DADOS, '..', caminho))) {
    console.error(`\n❌ Não encontrei ${caminho}\n`);
    process.exit(1);
  }
  contas.atualizarCampanha(slug, { firebase_key: caminho });
  linha(`\n✅ Firebase da campanha "${slug}" apontado para ${caminho}\n`);
  process.exit(0);
}

// ---------------------------------------------------- configuração inicial
if (contas.temAlgumUsuario()) {
  linha('\nO sistema já está configurado.\n');
  listar();
  linha('Para adicionar:');
  linha('  npm run configurar -- --campanha "Fernando Souza" --cargo "Vereador - Campinas"');
  linha('  npm run configurar -- --usuario ana@campanha.com --nome "Ana" --papel equipe --campanha-slug claudia');
  linha('');
  process.exit(0);
}

const slugInicial = arg('slug', 'claudia');
const nomeInicial = arg('nome-campanha', 'Dra. Cláudia Camargo');
const cargoInicial = arg('cargo', 'Deputada Estadual · SP');
const emailAdmin = arg('admin', 'matheusvecordeiro@gmail.com');

linha('\n══ Configuração inicial ══\n');

const migrou = migrarBaseAntiga(slugInicial, nomeInicial);

const campanha = contas.obterCampanha(slugInicial) ?? contas.criarCampanha({
  nome: nomeInicial,
  cargo: cargoInicial,
  slug: slugInicial,
  firebaseKey: existsSync(join(PASTA_DADOS, 'firebase-key.json')) ? 'data/firebase-key.json' : null
});

const totais = comCampanha(campanha.slug, () => ({
  pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
  grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos').get().n,
  assinaturas: db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get().n
}));

linha(`✅ Campanha "${campanha.nome}" (${campanha.slug})`);
linha(`   ${totais.pessoas} pessoas · ${totais.grupos} grupos · ${totais.assinaturas} assinaturas`);
if (migrou) linha('   base existente migrada sem perder nada');

const admin = contas.criarUsuario({
  email: emailAdmin, nome: 'Matheus (administrador)', papel: 'admin'
});
const equipe = contas.criarUsuario({
  email: arg('email-equipe', `equipe@${slugInicial}.local`),
  nome: `Equipe ${campanha.nome}`, papel: 'equipe', campanhaSlug: campanha.slug
});
const candidato = contas.criarUsuario({
  email: arg('email-candidato', `${slugInicial}@candidato.local`),
  nome: campanha.nome, papel: 'candidato', campanhaSlug: campanha.slug
});

linha('\n══ Acessos criados ══\n');
mostrarUsuario(admin, admin.senhaGerada);
mostrarUsuario(equipe, equipe.senhaGerada);
mostrarUsuario(candidato, candidato.senhaGerada);

linha(`
══ O que cada papel faz ══

  admin      vê e administra TODAS as campanhas, cria acessos
  equipe     trabalha só nesta campanha: responde, adiciona, edita ficha
  candidato  vê a base dele e usa o formulário de cadastro para preencher
             com as pessoas. Não mexe em conexão, Firebase nem adição em massa.

══ Próximos passos ══

  npm start
  → http://localhost:${process.env.PORT || 3333}/login

  Para os outros candidatos:
  npm run configurar -- --campanha "Fernando Souza" --cargo "Vereador - Campinas"
  npm run configurar -- --campanha "Gustavo Lima"  --cargo "Vereador - Valinhos"
`);

process.exit(0);
