// Testa o isolamento entre campanhas e o controle de acesso.
//
// A pergunta que este teste responde: é possível, por algum caminho, um
// candidato ver o apoiador de outro? Se a resposta for sim, o sistema não pode
// ser usado — política é campo minado e vazar base é o pior tipo de problema.
//
//   node --no-warnings=ExperimentalWarning src/teste-contas.js

import { comCampanha, db, campanhaAtual, pastaDaCampanha, pastaDeAuth } from './db.js';
import * as contas from './contas.js';
import { upsertPessoa } from './ingest.js';

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const A = 'teste-campanha-a';
const B = 'teste-campanha-b';

function limpar() {
  for (const slug of [A, B]) {
    contas.admin.prepare('DELETE FROM campanhas WHERE slug = ?').run(slug);
    contas.admin.prepare('DELETE FROM usuarios WHERE campanha_slug = ?').run(slug);
  }
  contas.admin.prepare("DELETE FROM usuarios WHERE email LIKE '%@teste.local'").run();
}

console.log('\nTeste de isolamento entre campanhas e de permissões\n');
limpar();

// ------------------------------------------------------------- 1) criação
console.log('1) Criar duas campanhas');
const campA = contas.criarCampanha({ nome: 'Candidata A Teste', slug: A, cargo: 'Vereadora' });
const campB = contas.criarCampanha({ nome: 'Candidato B Teste', slug: B, cargo: 'Vereador' });
ok(campA.slug === A && campB.slug === B, 'as duas campanhas existem');
ok(pastaDaCampanha(A) !== pastaDaCampanha(B), 'cada uma na sua pasta');
ok(pastaDeAuth(A) !== pastaDeAuth(B), 'sessões de WhatsApp em pastas separadas');

// --------------------------------------------------------- 2) isolamento
console.log('\n2) Os dados de uma NÃO aparecem na outra');
comCampanha(A, () => {
  upsertPessoa({ jid: '5511900000001@s.whatsapp.net', nomeWa: 'Apoiadora da A' });
  upsertPessoa({ jid: '5511900000002@s.whatsapp.net', nomeWa: 'Outra da A' });
});
comCampanha(B, () => {
  upsertPessoa({ jid: '5511900000009@s.whatsapp.net', nomeWa: 'Apoiador do B' });
});

const naA = comCampanha(A, () => db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n);
const naB = comCampanha(B, () => db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n);
ok(naA === 2, `campanha A tem ${naA} pessoas`);
ok(naB === 1, `campanha B tem ${naB} pessoa`);

const vazouParaB = comCampanha(B, () =>
  db.prepare("SELECT COUNT(*) AS n FROM pessoas WHERE nome_wa LIKE '%da A%'").get().n);
ok(vazouParaB === 0, 'nenhum apoiador da A aparece na base da B');

const vazouParaA = comCampanha(A, () =>
  db.prepare("SELECT COUNT(*) AS n FROM pessoas WHERE nome_wa LIKE '%do B%'").get().n);
ok(vazouParaA === 0, 'nenhum apoiador da B aparece na base da A');

// ------------------------------------------------- 3) contexto obrigatório
console.log('\n3) Sem campanha no contexto, o banco recusa');
let recusou = false;
try { db.prepare('SELECT 1').get(); } catch (erro) {
  recusou = /Nenhuma campanha ativa/.test(erro.message);
}
ok(recusou, 'consulta fora de contexto lança erro em vez de cair num banco qualquer');

// ---------------------------------------------------- 4) contexto aninhado
console.log('\n4) O contexto volta ao normal depois de sair');
comCampanha(A, () => {
  ok(campanhaAtual() === A, 'dentro do bloco, a campanha é a A');
  comCampanha(B, () => {
    ok(campanhaAtual() === B, 'bloco aninhado troca para a B');
  });
  ok(campanhaAtual() === A, 'ao sair do aninhado, volta para a A');
});

// ------------------------------------------------------------ 5) usuários
console.log('\n5) Usuários e senhas');
const equipeA = contas.criarUsuario({
  email: 'equipe.a@teste.local', nome: 'Equipe A', papel: 'equipe', campanhaSlug: A
});
const candidatoB = contas.criarUsuario({
  email: 'candidato.b@teste.local', nome: 'Candidato B', papel: 'candidato', campanhaSlug: B
});
const adminTeste = contas.criarUsuario({
  email: 'admin@teste.local', nome: 'Admin Teste', papel: 'admin'
});

ok(equipeA.senhaGerada?.length >= 8, `senha gerada automaticamente (${equipeA.senhaGerada?.length} caracteres)`);
ok(!('senha_hash' in equipeA), 'o hash da senha nunca sai do módulo de contas');

const guardado = contas.admin.prepare('SELECT senha_hash FROM usuarios WHERE email = ?')
  .get('equipe.a@teste.local').senha_hash;
ok(!guardado.includes(equipeA.senhaGerada), 'a senha não fica em texto no banco');
ok(guardado.includes(':') && guardado.length > 100, 'guardada como scrypt com sal');

// -------------------------------------------------------------- 6) login
console.log('\n6) Login');
ok(contas.entrar({ email: 'equipe.a@teste.local', senha: 'errada' }).erro,
  'senha errada não entra');
ok(contas.entrar({ email: 'naoexiste@teste.local', senha: 'x' }).erro === 'E-mail ou senha incorretos',
  'e-mail inexistente devolve a MESMA mensagem (não revela quem existe)');

const sessao = contas.entrar({ email: 'equipe.a@teste.local', senha: equipeA.senhaGerada });
ok(Boolean(sessao.token), 'senha certa devolve token');
ok(contas.usuarioDoToken(sessao.token)?.email === 'equipe.a@teste.local', 'token identifica o usuário');
ok(contas.usuarioDoToken('token-inventado') === null, 'token inválido não identifica ninguém');

contas.sair(sessao.token);
ok(contas.usuarioDoToken(sessao.token) === null, 'depois de sair, o token morre');

// --------------------------------------------------------- 7) permissões
console.log('\n7) Quem pode o quê');
ok(contas.podeAcessarCampanha(equipeA, A), 'equipe A acessa a campanha A');
ok(!contas.podeAcessarCampanha(equipeA, B), 'equipe A NÃO acessa a campanha B');
ok(!contas.podeAcessarCampanha(candidatoB, A), 'candidato B NÃO acessa a campanha A');
ok(contas.podeAcessarCampanha(adminTeste, A) && contas.podeAcessarCampanha(adminTeste, B),
  'admin acessa as duas');

ok(contas.campanhasDoUsuario(equipeA).length === 1, 'equipe enxerga 1 campanha');
ok(contas.campanhasDoUsuario(candidatoB).length === 1, 'candidato enxerga 1 campanha');
ok(contas.campanhasDoUsuario(adminTeste).length >= 2, 'admin enxerga todas');

ok(contas.podeFazer(equipeA, 'responder'), 'equipe pode responder mensagem');
ok(contas.podeFazer(equipeA, 'adicionarEmMassa'), 'equipe pode disparar a fila de adição');
ok(!contas.podeFazer(equipeA, 'gerirUsuarios'), 'equipe NÃO cria acessos');

ok(contas.podeFazer(candidatoB, 'editarFicha'), 'candidato pode cadastrar e editar ficha');
ok(!contas.podeFazer(candidatoB, 'conectarWhatsapp'), 'candidato NÃO conecta WhatsApp');
ok(!contas.podeFazer(candidatoB, 'configurarFirebase'), 'candidato NÃO mexe no Firebase');
ok(!contas.podeFazer(candidatoB, 'adicionarEmMassa'), 'candidato NÃO dispara adição em massa');
ok(!contas.podeFazer(candidatoB, 'exportar'), 'candidato NÃO exporta a base');

ok(contas.podeFazer(adminTeste, 'gerirCampanhas') && contas.podeFazer(adminTeste, 'gerirUsuarios'),
  'admin administra campanhas e acessos');

// --------------------------------------------------- 8) desativar acesso
console.log('\n8) Desativar acesso');
const sessao2 = contas.entrar({ email: 'equipe.a@teste.local', senha: equipeA.senhaGerada });
contas.definirAtivo('equipe.a@teste.local', false);
ok(contas.usuarioDoToken(sessao2.token) === null, 'desativar derruba a sessão aberta na hora');
ok(contas.entrar({ email: 'equipe.a@teste.local', senha: equipeA.senhaGerada }).erro,
  'usuário desativado não consegue entrar');

const nova = contas.redefinirSenha('equipe.a@teste.local');
contas.definirAtivo('equipe.a@teste.local', true);
ok(Boolean(contas.entrar({ email: 'equipe.a@teste.local', senha: nova.senha }).token),
  'senha redefinida funciona');

// --------------------------------------------------- 9) Firebase separado
console.log('\n9) Firebase por campanha');
contas.atualizarCampanha(A, { firebase_key: 'data/campanhas/a/chave.json' });
const configA = contas.configDaCampanha(A);
const configB = contas.configDaCampanha(B);
ok(configA.urlCadastro !== configB.urlCadastro, 'cada campanha tem o seu formulário público');
ok(configA.urlCadastro === `/cadastro/${A}`, `formulário da A: ${configA.urlCadastro}`);
ok(configA.pasta !== configB.pasta, 'pastas de dados diferentes');

limpar();
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Isolamento e permissões funcionando.'}\n`);
process.exit(falhas ? 1 : 0);
