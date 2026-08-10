// Testa o aviso de saída de grupo sem precisar do WhatsApp conectado:
// injeta os mesmos eventos que o Baileys entrega em `group-participants.update`.
//
//   node --no-warnings=ExperimentalWarning src/teste-alertas.js
//
// Cria um grupo temporário, mexe nele e apaga tudo no fim — a base real
// não é afetada.

import { db, agora, usarCampanha } from './db.js';
import { upsertGrupo, upsertPessoa, vincularMembro, registrarMensagem } from './ingest.js';
import { recomputar } from './scoring.js';
import * as whatsapp from './whatsapp.js';
import * as fb from './firestore.js';

// Estes scripts rodam sobre UMA campanha. Escolha com a variável CAMPANHA;
// sem ela, usa a primeira encontrada em data/campanhas/.
const CAMPANHA = usarCampanha();

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const JID_GRUPO = '000000000000000000@g.us';
const ENGAJADA = '5519900000001';
const SILENCIOSA = '5519900000002';
const ADMIN = '5519900000009';
const NOVA = '5519900000003';

function limparTeste() {
  const g = db.prepare('SELECT id FROM grupos WHERE wa_jid = ?').get(JID_GRUPO);
  if (g) {
    db.prepare('DELETE FROM alertas WHERE grupo_id = ?').run(g.id);
    db.prepare('DELETE FROM grupos WHERE id = ?').run(g.id);
  }
  for (const tel of [ENGAJADA, SILENCIOSA, ADMIN, NOVA]) {
    const p = db.prepare('SELECT id FROM pessoas WHERE telefone = ?').get(tel);
    if (p) db.prepare('DELETE FROM pessoas WHERE id = ?').run(p.id);
  }
  // Sem isto, o que o teste publicou fica pendente na outbox e um
  // 'firebase:sync' posterior empurra dado de teste para produção.
  db.prepare("DELETE FROM outbox WHERE doc_id LIKE '5519900000%' OR doc_id LIKE '00000000%' OR doc_id LIKE 'teste-%'").run();
}

console.log('\nTeste do aviso de saída de grupo (eventos simulados do Baileys)\n');
limparTeste();

// Cliente falso do Firestore só para conferir que o alerta também é publicado.
// A campanha usa prefixo (campanhas/<slug>/...): o teste procura no mesmo
// caminho em que o código grava.
const { configDaCampanha } = await import('./contas.js');
const prefixoFb = configDaCampanha(CAMPANHA)?.firebasePrefixo;
const raiz = prefixoFb ? `${prefixoFb}/${CAMPANHA}/` : '';

const gravados = new Map();
await fb.iniciarFirebase({
  clienteDeTeste: {
    settings() {},
    collection: (c) => ({ doc: (id) => ({ _caminho: `${c}/${id}` }) }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, d) => ops.push([ref._caminho, d]),
        delete: () => {},
        commit: async () => { for (const [k, v] of ops) gravados.set(k, v); }
      };
    }
  }
});

// ---------------------------------------------------------------- cenário
const grupoId = upsertGrupo({ jid: JID_GRUPO, nome: 'Grupo de Teste', criadoEm: agora() });

const idEngajada = upsertPessoa({ jid: `${ENGAJADA}@s.whatsapp.net`, nomeWa: 'Marta Testadora' });
const idSilenciosa = upsertPessoa({ jid: `${SILENCIOSA}@s.whatsapp.net`, nomeWa: 'Zé Silencioso' });
upsertPessoa({ jid: `${ADMIN}@s.whatsapp.net`, nomeWa: 'Admin da Campanha' });

vincularMembro({ pessoaId: idEngajada, grupoId, nomeGrupo: 'Grupo de Teste' });
vincularMembro({ pessoaId: idSilenciosa, grupoId, nomeGrupo: 'Grupo de Teste' });

// A engajada fala bastante e fala de segurança; a outra nunca escreveu.
for (let i = 0; i < 40; i++) {
  registrarMensagem({
    waId: `teste-${i}`, grupoId, pessoaId: idEngajada, tipo: 'texto',
    texto: i % 3 === 0
      ? 'a rua tá completamente escura, poste queimado faz semanas'
      : 'conta comigo, quero ajudar no que precisar',
    ts: agora() - i * 3600_000
  });
}
db.prepare('UPDATE pessoas SET cadastro_em = ?, cidade = ?, uf = ? WHERE id = ?')
  .run(agora(), 'Campinas', 'SP', idEngajada);
recomputar();

const perfilAntes = db.prepare('SELECT faixa, engajamento FROM perfil WHERE pessoa_id = ?').get(idEngajada);
console.log(`Cenário: ${perfilAntes.faixa} (${perfilAntes.engajamento}/100) + uma pessoa que nunca escreveu\n`);

// ---------------------------------------------------------------- 1) entrada
console.log('1) Alguém entra no grupo');
whatsapp.simularEventoDeGrupo({
  id: JID_GRUPO,
  action: 'add',
  author: `${ADMIN}@s.whatsapp.net`,
  participants: [{ id: `${NOVA}@lid`, phoneNumber: `${NOVA}@s.whatsapp.net`, notify: 'Recém Chegada' }]
});
const entrada = db.prepare(
  "SELECT * FROM alertas WHERE tipo = 'entrou_grupo' AND grupo_id = ? ORDER BY id DESC LIMIT 1"
).get(grupoId);
ok(Boolean(entrada), 'alerta de entrada criado');
ok(entrada?.gravidade === 'info', 'entrada tem gravidade "info" (não polui o painel)');
const novaPessoa = db.prepare('SELECT nome_wa FROM pessoas WHERE telefone = ?').get(NOVA);
ok(novaPessoa?.nome_wa === 'Recém Chegada',
  'nome do WhatsApp lido do objeto participante (formato Baileys 7)');
ok(db.prepare('SELECT 1 FROM membros m JOIN pessoas p ON p.id = m.pessoa_id WHERE p.telefone = ? AND m.grupo_id = ?')
  .get(NOVA, grupoId) != null, 'vínculo com o grupo criado a partir do LID + phoneNumber');

// -------------------------------------------------- 2) saiu por conta própria
console.log('\n2) A pessoa engajada sai sozinha');
whatsapp.simularEventoDeGrupo({
  id: JID_GRUPO,
  action: 'remove',
  author: `${ENGAJADA}@s.whatsapp.net`,          // autor == ela mesma
  participants: [{ id: `${ENGAJADA}@s.whatsapp.net`, phoneNumber: `${ENGAJADA}@s.whatsapp.net` }]
});
const saida = db.prepare(
  'SELECT * FROM alertas WHERE pessoa_id = ? ORDER BY id DESC LIMIT 1'
).get(idEngajada);
ok(saida?.tipo === 'saiu_grupo', 'classificado como saída voluntária (não remoção)');
ok(saida?.gravidade === 'critico', 'gravidade crítica: era engajada e tinha cadastro');
ok(/saiu por conta própria/.test(saida?.titulo || ''), `título explica o que houve — "${saida?.titulo}"`);
ok(/Ativo|Embaixador/.test(saida?.detalhe || ''), 'detalhe traz a classificação que ela tinha');
ok(/saiu de TODOS os grupos/.test(saida?.detalhe || ''), 'detalhe avisa que ela não está em mais nenhum grupo');

const dados = JSON.parse(saida.dados);
ok(dados.ultimaMensagem?.length > 0, 'alerta guarda a última coisa que ela escreveu');
ok(dados.temaPrincipal === 'seguranca', `alerta guarda o interesse dela (${dados.temaPrincipal})`);
ok(dados.intencoes?.includes('voluntario'), 'alerta guarda que ela tinha se oferecido para ajudar');

const membro = db.prepare(
  'SELECT saiu_em FROM membros WHERE pessoa_id = ? AND grupo_id = ?'
).get(idEngajada, grupoId);
ok(Boolean(membro?.saiu_em), 'vínculo marcado com a data de saída (histórico preservado)');

// ---------------------------------------------------- 3) removida pelo admin
console.log('\n3) A pessoa silenciosa é removida por um administrador');
whatsapp.simularEventoDeGrupo({
  id: JID_GRUPO,
  action: 'remove',
  author: `${ADMIN}@s.whatsapp.net`,             // autor != ela
  participants: [{ id: `${SILENCIOSA}@s.whatsapp.net`, phoneNumber: `${SILENCIOSA}@s.whatsapp.net` }]
});
const remocao = db.prepare(
  'SELECT * FROM alertas WHERE pessoa_id = ? ORDER BY id DESC LIMIT 1'
).get(idSilenciosa);
ok(remocao?.tipo === 'removido_grupo', 'classificado como remoção por administrador');
ok(remocao?.gravidade === 'aviso', 'gravidade menor: nunca participou nem se cadastrou');
const quemRemoveu = JSON.parse(remocao.dados).porQuem;
ok(quemRemoveu === '+55 (19) 90000-0009', `registra quem removeu (${quemRemoveu})`);

// ------------------------------------------------------------ 4) idempotência
console.log('\n4) O mesmo evento chegando duas vezes');
const antes = db.prepare('SELECT COUNT(*) AS n FROM alertas WHERE grupo_id = ?').get(grupoId).n;
whatsapp.simularEventoDeGrupo({
  id: JID_GRUPO, action: 'remove', author: `${ADMIN}@s.whatsapp.net`,
  participants: [{ phoneNumber: `${SILENCIOSA}@s.whatsapp.net` }]
});
ok(db.prepare('SELECT COUNT(*) AS n FROM alertas WHERE grupo_id = ?').get(grupoId).n === antes,
  'não duplica o alerta de quem já estava marcado como fora');

// ------------------------------------------------------------- 5) Firestore
console.log('\n5) Publicação no Firestore');
await fb.processarFila();
ok([...gravados.keys()].some((k) => k === `${raiz}alertas/${saida.id}`), 'alerta da saída foi para a coleção alertas');
const docPessoa = gravados.get(`${raiz}pessoas/${ENGAJADA}`);
ok(Boolean(docPessoa), 'ficha da pessoa republicada depois da saída');
ok(docPessoa?.grupos?.some((g) => g.ativo === false), 'documento mostra o grupo com ativo=false');

// ---------------------------------------------------------------- 6) painel
console.log('\n6) O que o painel mostra');
const { listarAlertas, contarAlertas, filaDeAcao } = await import('./repo.js');
const naoLidos = contarAlertas();
ok(naoLidos.total >= 3, `${naoLidos.total} alertas não lidos no sino`);
ok(naoLidos.criticos >= 1, `${naoLidos.criticos} deles marcado como prioridade`);
ok(listarAlertas({ limite: 5 })[0].dados !== null, 'painel recebe o retrato junto com o alerta');
ok(filaDeAcao().saidas.some((p) => p.telefone === ENGAJADA),
  'a pessoa aparece na coluna "Saíram dos grupos" da fila de ação');

limparTeste();
recomputar();

console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ O aviso de saída de grupo está funcionando.'}\n`);
process.exit(falhas ? 1 : 0);
