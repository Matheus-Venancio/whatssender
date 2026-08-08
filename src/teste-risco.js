// Testa o detector de atrito: o que ele precisa pegar, o que NÃO pode pegar,
// e o fluxo completo até o alerta com a ação recomendada.
//
//   node --no-warnings=ExperimentalWarning src/teste-risco.js

import { db, agora, usarCampanha } from './db.js';
import { upsertGrupo, upsertPessoa, vincularMembro } from './ingest.js';
import { detectarRisco, analisarMensagem, RISCOS } from './risco.js';
import { listarAlertas } from './repo.js';

// Estes scripts rodam sobre UMA campanha. Escolha com a variável CAMPANHA;
// sem ela, usa a primeira encontrada em data/campanhas/.
const CAMPANHA = usarCampanha();

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

console.log('\nTeste do detector de atrito\n');

// ------------------------------------------------------- 1) deve detectar
console.log('1) Frases que precisam gerar alerta');
const deveDetectar = [
  ['Não quero saber do grupo', 'saida_iminente'],
  ['Quem é você?', 'nao_reconhece'],
  ['me tira do grupo por favor', 'saida_iminente'],
  ['vou sair desse grupo agora', 'saida_iminente'],
  ['quem me adicionou aqui?', 'nao_reconhece'],
  ['que grupo é esse? não pedi para entrar', 'nao_reconhece'],
  ['onde conseguiu meu número?', 'nao_reconhece'],
  ['vou denunciar esse grupo', 'ameaca_denuncia'],
  ['isso é golpe, vou reportar', 'ameaca_denuncia'],
  ['que palhaçada, um absurdo', 'hostilidade'],
  ['chega de política nesse grupo', 'rejeicao_politica'],
  ['só promessa, não acredito em político', 'rejeicao_politica'],
  ['muita mensagem, já silenciei', 'insatisfacao'],
  ['PARA DE MANDAR ISSO', 'insatisfacao']
];
for (const [frase, esperado] of deveDetectar) {
  const r = detectarRisco(frase);
  ok(r?.categoria === esperado,
    `"${frase}" → ${r?.categoria ?? 'NADA'}${r?.categoria === esperado ? '' : ` (esperado ${esperado})`}`);
}

// -------------------------------------------------- 2) NÃO pode detectar
console.log('\n2) Frases normais que NÃO podem virar alerta (falso positivo)');
const naoDetectar = [
  'Olá pessoal, bom dia!',
  'Alegria grande ver o grupo crescendo',
  'Testando o grupo',
  'quero saber mais sobre o projeto',
  'vou sair para o trabalho agora, depois volto',
  'a merenda da escola melhorou muito',
  'quem é a responsável pela creche do bairro?',
  'preciso de ajuda com o cadastro',
  'meu filho sai da escola às 17h',
  'conta comigo, quero ajudar',
  'a política pública de saúde precisa melhorar',
  'denunciei maus tratos de animais na prefeitura'
];
for (const frase of naoDetectar) {
  const r = detectarRisco(frase);
  ok(!r, `"${frase}"${r ? ` → detectou ${r.categoria} (NÃO devia)` : ''}`);
}

// --------------------------------------------- 3) prioridade entre riscos
console.log('\n3) Quando há mais de um sinal, vence o mais grave');
const misto = detectarRisco('que palhaçada, quero sair do grupo e vou denunciar');
ok(misto?.categoria === 'ameaca_denuncia',
  `hostilidade + saída + denúncia → ${misto?.categoria} (denúncia é o pior cenário)`);

// ---------------------------------------------------- 4) fluxo do alerta
console.log('\n4) Fluxo completo até o alerta');
const JID = '000000000000000001@g.us';
const TEL = '5519900000101';
const limpar = () => {
  const g = db.prepare('SELECT id FROM grupos WHERE wa_jid = ?').get(JID);
  if (g) { db.prepare('DELETE FROM alertas WHERE grupo_id = ?').run(g.id); db.prepare('DELETE FROM grupos WHERE id = ?').run(g.id); }
  for (const t of [TEL, '5519900000102']) {
    const p = db.prepare('SELECT id FROM pessoas WHERE telefone = ?').get(t);
    if (p) db.prepare('DELETE FROM pessoas WHERE id = ?').run(p.id);
  }
};
limpar();

const grupoId = upsertGrupo({ jid: JID, nome: 'Grupo Teste Atrito', criadoEm: agora() });
const pessoaId = upsertPessoa({ jid: `${TEL}@s.whatsapp.net`, nomeWa: 'Princesa Teste' });
vincularMembro({ pessoaId, grupoId, nomeGrupo: 'Grupo Teste Atrito' });

const r1 = analisarMensagem({
  pessoaId, grupoId, nomeGrupo: 'Grupo Teste Atrito',
  texto: 'Não quero saber do grupo', ts: agora()
});
ok(Boolean(r1?.alertaId), 'alerta criado');
const alerta = db.prepare('SELECT * FROM alertas WHERE id = ?').get(r1.alertaId);
ok(alerta.tipo === 'atrito:saida_iminente', `tipo gravado: ${alerta.tipo}`);
ok(alerta.gravidade === 'critico', 'gravidade crítica');
ok(alerta.titulo.includes('Princesa Teste') && alerta.titulo.includes('Grupo Teste Atrito'),
  `título identifica quem e onde — "${alerta.titulo}"`);
ok(alerta.detalhe.includes('Não quero saber do grupo'), 'detalhe cita a mensagem literal');
ok(JSON.parse(alerta.dados).acao?.includes('privado'), 'alerta carrega a ação recomendada');

const tagAtrito = db.prepare(`
  SELECT 1 FROM pessoa_tags pt JOIN tags t ON t.id = pt.tag_id
   WHERE pt.pessoa_id = ? AND t.nome = 'Atenção / atrito'
`).get(pessoaId);
ok(Boolean(tagAtrito), 'pessoa marcada com "Atenção / atrito" na ficha');

// -------------------------------------------------------- 5) sem repetir
console.log('\n5) Repetição não vira enxurrada de alerta');
analisarMensagem({ pessoaId, grupoId, nomeGrupo: 'Grupo Teste Atrito', texto: 'me tira do grupo', ts: agora() });
analisarMensagem({ pessoaId, grupoId, nomeGrupo: 'Grupo Teste Atrito', texto: 'quero sair do grupo', ts: agora() });
const doTipo = db.prepare(
  "SELECT COUNT(*) AS n FROM alertas WHERE pessoa_id = ? AND tipo = 'atrito:saida_iminente'"
).get(pessoaId).n;
ok(doTipo === 1, `3 mensagens do mesmo tipo → ${doTipo} alerta`);

const r2 = analisarMensagem({
  pessoaId, grupoId, nomeGrupo: 'Grupo Teste Atrito', texto: 'quem é você afinal?', ts: agora()
});
ok(Boolean(r2?.alertaId), 'mas categoria diferente gera alerta novo');

// ------------------------------------------------ 6) conflito coletivo
console.log('\n6) Duas pessoas brigando = alerta de discussão no grupo');
const outraId = upsertPessoa({ jid: '5519900000102@s.whatsapp.net', nomeWa: 'Outra Pessoa' });
vincularMembro({ pessoaId: outraId, grupoId, nomeGrupo: 'Grupo Teste Atrito' });
const r3 = analisarMensagem({
  pessoaId: outraId, grupoId, nomeGrupo: 'Grupo Teste Atrito',
  texto: 'que absurdo, palhaçada isso aqui', ts: agora()
});
ok(Boolean(r3?.conflitoId), 'alerta de conflito coletivo disparado');
const conflito = db.prepare('SELECT * FROM alertas WHERE id = ?').get(r3.conflitoId);
ok(conflito?.gravidade === 'critico', 'conflito coletivo é prioridade');
ok(conflito?.detalhe.includes('2 pessoas'), `detalhe: "${conflito?.detalhe?.slice(0, 60)}…"`);

analisarMensagem({ pessoaId: outraId, grupoId, nomeGrupo: 'Grupo Teste Atrito', texto: 'ridículo, que vergonha', ts: agora() });
ok(db.prepare("SELECT COUNT(*) AS n FROM alertas WHERE grupo_id = ? AND tipo = 'conflito_grupo'").get(grupoId).n === 1,
  'conflito coletivo não se repete na mesma janela');

// -------------------------------------------------------- 7) no painel
console.log('\n7) Como chega no painel');
const lista = listarAlertas({ limite: 10 }).filter((a) => a.grupo === 'Grupo Teste Atrito');
ok(lista.every((a) => a.def?.icone && a.def?.cor), 'todo alerta chega com ícone e cor');
ok(lista.some((a) => a.acao), 'painel recebe a ação recomendada pronta');
const saida = lista.find((a) => a.tipo === 'atrito:saida_iminente');
ok(saida?.def?.rotulo === RISCOS.saida_iminente.rotulo, `rótulo legível: "${saida?.def?.rotulo}"`);

limpar();
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Detector de atrito funcionando.'}\n`);
process.exit(falhas ? 1 : 0);
