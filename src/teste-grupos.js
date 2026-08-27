// Testa a marcação de grupo da campanha, a recomendação de grupo no formulário
// e a trava que impede despejar apoiador em grupo de terceiro.
//
//   node --no-warnings=ExperimentalWarning src/teste-grupos.js
//
// O caso que motivou tudo isto está no teste 4: o telefone âncora da campanha
// está em grupos que não são dela (curso, igreja, outra profissional), e eles
// apareciam na mesma lista de destino da fila de adição.

import './ambiente.js';
import { db, agora, usarCampanha } from './db.js';
import { upsertGrupo, classificarGrupoNaBase, definirGrupoManualmente } from './ingest.js';
import { classificarGrupo, recomendarGrupo } from './grupos-campanha.js';
import { definicaoDoAbaixo } from './leads.js';
import { classificarTexto } from './lexicon.js';
import * as fila from './adicionar-grupo.js';

const CAMPANHA = usarCampanha();

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const PREFIXO_JID = '000000000000000901';
const CANDIDATA = 'Dra. Cláudia Camargo';

function limpar() {
  const alvos = db.prepare(
    `SELECT id FROM grupos WHERE wa_jid LIKE '${PREFIXO_JID}%'`
  ).all();
  for (const g of alvos) {
    db.prepare('DELETE FROM fila_adicao WHERE grupo_id = ?').run(g.id);
    db.prepare('DELETE FROM membros WHERE grupo_id = ?').run(g.id);
    db.prepare('DELETE FROM grupos WHERE id = ?').run(g.id);
  }
}

console.log('\nTeste de grupos da campanha\n');
limpar();

// -------------------------------------------------- 1) quem é da campanha
console.log('1) Reconhecer o grupo da campanha pelo nome');

const DA_CAMPANHA = [
  'Protegendo quem protege | Educação',
  'Protegendo quem protege | Saúde',
  'Protegendo quem protege | Mulheres',
  'Protegendo quem protege | Criaças e Adolescentes',   // com o erro de digitação real
  'Protegendo quem protege | Inclusão',
  'Salve a Escola',
  'Proteja Digital · pais e professores',
  'Amigos, Amigas da Claudia Camargo 🧡'
];

const DE_TERCEIRO = [
  'Oficina Das Emoções',
  'CRIS GROBERIO - INFO',
  'Inscrições abertas! 💫 11',
  'Mulheres Que Oram e Agem.',
  'Justiceiras - Campinas'
];

for (const nome of DA_CAMPANHA) {
  const r = classificarGrupo(nome, null, { candidata: CANDIDATA });
  ok(r.daCampanha === true, `"${nome}" é da campanha`);
}
for (const nome of DE_TERCEIRO) {
  const r = classificarGrupo(nome, null, { candidata: CANDIDATA });
  ok(r.daCampanha === false, `"${nome}" NÃO é da campanha`);
}

// --------------------------------------------------------------- 2) temas
console.log('\n2) Tema de cada grupo da campanha');
const tema = (nome, descricao = null) =>
  classificarGrupo(nome, descricao, { candidata: CANDIDATA }).tema;

ok(tema('Protegendo quem protege | Educação') === 'educacao', 'Educação → educacao');
ok(tema('Protegendo quem protege | Saúde') === 'saude', 'Saúde → saude');
ok(tema('Protegendo quem protege | Mulheres') === 'mulher', 'Mulheres → mulher');
ok(tema('Protegendo quem protege | Criaças e Adolescentes') === 'infancia_juventude',
  'Criaças e Adolescentes (com typo) → infancia_juventude');
ok(tema('Protegendo quem protege | Inclusão') === 'pcd', 'Inclusão → pcd');
ok(tema('Salve a Escola') === 'educacao', 'Salve a Escola → educacao');
ok(tema('Proteja Digital · pais e professores') === 'protecao_digital',
  'Proteja Digital ganha do "professores" que vem depois (ordem das regras)');

// O grupo geral tem de continuar geral: é o destino de quem não casa com pilar.
ok(tema('Amigos, Amigas da Claudia Camargo 🧡') === null,
  'grupo geral fica sem tema');
ok(tema('Amigos, Amigas da Claudia Camargo 🧡',
  'Grupo para união para proteção de crianças e adolescentes. Eleições 2026') === null,
  'descrição falando de crianças NÃO dá tema ao grupo geral');

// ------------------------------------------------------- 3) recomendação
console.log('\n3) Recomendação de grupo no formulário');

const GRUPOS = [
  { id: 12, nome: 'Amigos, Amigas da Claudia Camargo 🧡', tema: null, da_campanha: 1 },
  { id: 5, nome: 'PQP | Criaças e Adolescentes', tema: 'infancia_juventude', da_campanha: 1 },
  { id: 2, nome: 'PQP | Educação', tema: 'educacao', da_campanha: 1 },
  { id: 3, nome: 'PQP | Saúde', tema: 'saude', da_campanha: 1 },
  { id: 99, nome: 'Inscrições abertas! 💫 11', tema: null, da_campanha: 0 }
];

ok(recomendarGrupo(GRUPOS, ['educacao'])?.id === 2, 'quem marcou educação vai para o grupo de Educação');
ok(recomendarGrupo(GRUPOS, ['saude', 'educacao'])?.id === 3, 'a primeira pauta marcada é que decide');
ok(recomendarGrupo(GRUPOS, ['protecao_digital', 'educacao'])?.id === 2,
  'sem grupo do tema, cai na pauta seguinte');
ok(recomendarGrupo(GRUPOS, ['animais'])?.id === 12, 'sem casamento nenhum, vai para o grupo geral');
ok(recomendarGrupo(GRUPOS, [])?.id === 12, 'sem pauta marcada, grupo geral');
ok(recomendarGrupo(GRUPOS, ['animais'])?.id !== 99, 'nunca recomenda grupo de terceiro');
ok(recomendarGrupo([{ id: 99, tema: null, da_campanha: 0 }], ['educacao']) === null,
  'só há grupo de terceiro: não recomenda nada (antes recomendava o primeiro da lista)');
ok(recomendarGrupo([], ['educacao']) === null, 'base sem grupo: null, não estouro');

// ------------------------------------------------- 4) a trava da fila
console.log('\n4) Trava: não enfileirar em grupo de terceiro');

const idExterno = upsertGrupo({
  jid: `${PREFIXO_JID}01@g.us`, nome: 'Oficina Das Emoções', criadoEm: agora()
});
const idDaCampanha = upsertGrupo({
  jid: `${PREFIXO_JID}02@g.us`, nome: 'Protegendo quem protege | Teste Grupos', criadoEm: agora()
});

const externo = db.prepare('SELECT da_campanha, tema FROM grupos WHERE id = ?').get(idExterno);
const daCampanha = db.prepare('SELECT da_campanha, tema FROM grupos WHERE id = ?').get(idDaCampanha);
ok(Number(externo.da_campanha) === 0, 'grupo de terceiro entra marcado como externo');
ok(Number(daCampanha.da_campanha) === 1, 'grupo da campanha entra marcado como da campanha');

let recusou = false;
let mensagem = '';
try {
  fila.enfileirar({ grupoId: idExterno, pessoaIds: [] });
} catch (erro) {
  recusou = true;
  mensagem = erro.message;
}
ok(recusou, 'enfileirar em grupo de terceiro é recusado');
ok(/não está marcado como grupo da campanha/.test(mensagem),
  `o erro explica o motivo: "${mensagem.slice(0, 60)}…"`);
ok(db.prepare('SELECT COUNT(*) AS n FROM fila_adicao WHERE grupo_id = ?').get(idExterno).n === 0,
  'ninguém foi enfileirado no grupo de terceiro');

let aceitou = true;
try {
  fila.enfileirar({ grupoId: idDaCampanha, pessoaIds: [] });
} catch {
  aceitou = false;
}
ok(aceitou, 'grupo da campanha continua aceitando fila');

// ------------------------------------- 5) renomear e decisão manual
console.log('\n5) Renomear grupo e decisão manual da equipe');

upsertGrupo({ jid: `${PREFIXO_JID}02@g.us`, nome: 'Salve a Escola' });
ok(db.prepare('SELECT tema FROM grupos WHERE id = ?').get(idDaCampanha).tema === 'educacao',
  'renomear para "Salve a Escola" reclassifica o tema sozinho');

definirGrupoManualmente(idExterno, { daCampanha: true, tema: 'mulher' });
const manual = db.prepare(
  'SELECT da_campanha, tema, classificacao_manual FROM grupos WHERE id = ?'
).get(idExterno);
ok(Number(manual.da_campanha) === 1 && manual.tema === 'mulher',
  'a equipe pode marcar à mão um grupo que o nome não denuncia');
ok(Number(manual.classificacao_manual) === 1, 'fica registrado que foi decisão manual');

classificarGrupoNaBase(idDaCampanha);
const aindaManual = db.prepare('SELECT da_campanha FROM grupos WHERE id = ?').get(idExterno);
ok(Number(aindaManual.da_campanha) === 1,
  'reclassificar outro grupo não desfaz a decisão manual');

let aceitouManual = true;
try { fila.enfileirar({ grupoId: idExterno, pessoaIds: [] }); } catch { aceitouManual = false; }
ok(aceitouManual, 'depois de marcado à mão, o grupo aceita fila');

// --------------------------------- 6) tema novo e dedução de abaixo
console.log('\n6) Proteção digital: tema e dedução de abaixo-assinado');

const temas = (t) => classificarTexto(t).temas.map((x) => x.tema);
ok(temas('meu filho sofre cyberbullying no jogo online').includes('protecao_digital'),
  'cyberbullying em jogo online → protecao_digital');
ok(temas('precisamos de controle parental e tempo de tela').includes('protecao_digital'),
  'controle parental / tempo de tela → protecao_digital');
ok(!temas('fui ao posto de saude ontem').includes('protecao_digital'),
  'assunto de saúde não vira proteção digital');
ok(!temas('denunciei maus tratos de animais').includes('protecao_digital'),
  'denúncia de maus tratos de animais não vira proteção digital');

const projetoDigital = definicaoDoAbaixo('f:ainda-nao-mapeado',
  'ABAIXO-ASSINADO #4 - Proteja Digital: crianças seguras na internet');
ok(projetoDigital.temas.includes('protecao_digital'),
  'formulário novo do Proteja Digital já entra com tema (antes vinha com temas: [])');
ok(projetoDigital.bandeira === 'Proteção digital da infância', 'e com a bandeira certa');

const inclusao = definicaoDoAbaixo('f:outro', 'Inclusão para crianças atípicas nas escolas');
ok(inclusao.temas.includes('pcd'), 'formulário de inclusão deduz o tema pcd');

const conhecido = definicaoDoAbaixo('f:1024024180552028', 'qualquer nome aqui');
ok(conhecido.chave === 'violencia-escolas',
  'formulário já mapeado continua vindo do mapa, não da dedução');

limpar();
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Grupos da campanha, recomendação e trava funcionando.'}\n`);
process.exit(falhas ? 1 : 0);
