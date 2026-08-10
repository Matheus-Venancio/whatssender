// Testa a fila de adição a grupo sem tocar no WhatsApp real: injeta um
// executor falso que devolve os mesmos status que o WhatsApp devolve
// (200 adicionou, 403 privacidade, 408 saiu recente, 401 bloqueou).
//
//   node --no-warnings=ExperimentalWarning src/teste-adicao.js

import { db, agora, usarCampanha } from './db.js';
import { upsertGrupo, upsertPessoa, vincularMembro } from './ingest.js';
import * as fila from './adicionar-grupo.js';

// Estes scripts rodam sobre UMA campanha. Escolha com a variável CAMPANHA;
// sem ela, usa a primeira encontrada em data/campanhas/.
const CAMPANHA = usarCampanha();

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const JID_GRUPO = '000000000000000777@g.us';
const PREFIXO = '55199777';

function limpar() {
  // Restrito ao prefixo DESTE teste. Um padrão amplo como '5519%' apagaria
  // da outbox gente real esperando para subir ao Firestore.
  db.prepare(`DELETE FROM outbox WHERE doc_id LIKE '${PREFIXO}%' OR doc_id = ?`).run(JID_GRUPO);
  const g = db.prepare('SELECT id FROM grupos WHERE wa_jid = ?').get(JID_GRUPO);
  if (g) db.prepare('DELETE FROM grupos WHERE id = ?').run(g.id);
  db.prepare(`DELETE FROM pessoas WHERE telefone LIKE '${PREFIXO}%'`).run();
}

console.log('\nTeste da fila de adição a grupo\n');
limpar();

const grupoId = upsertGrupo({ jid: JID_GRUPO, nome: 'Grupo Teste Adição', criadoEm: agora() });

// 6 pessoas: 4 assinantes de SP, 1 já no grupo, 1 sem assinatura.
const pessoas = [];
for (let i = 1; i <= 6; i++) {
  const tel = `${PREFIXO}${String(i).padStart(4, '0')}`;
  const id = upsertPessoa({ jid: `${tel}@s.whatsapp.net`, nomeWa: `Pessoa ${i}` });
  db.prepare('UPDATE pessoas SET nome = ?, cidade = ?, uf = ?, cadastro_em = ? WHERE id = ?')
    .run(`Pessoa ${i} Teste`, 'Campinas', i === 5 ? 'RJ' : 'SP', agora(), id);
  pessoas.push({ id, tel });
}
vincularMembro({ pessoaId: pessoas[5].id, grupoId, nomeGrupo: 'Grupo Teste Adição' });

// ------------------------------------------------------------- elegibilidade
console.log('1) Quem pode entrar na fila');
// A base real tem centenas de pessoas; aqui olhamos só as do teste.
const doTeste = (lista) => lista.filter((p) => p.telefone?.startsWith(PREFIXO));

const todos = doTeste(fila.elegiveis({ grupoId, filtros: {} }));
ok(todos.length === 5, `${todos.length} elegíveis de 6 (quem já está no grupo fica de fora)`);
ok(!todos.some((p) => p.id === pessoas[5].id), 'membro atual não é reenfileirado');

const soSp = doTeste(fila.elegiveis({ grupoId, filtros: { uf: 'SP' } }));
ok(soSp.length === 4, `filtro por UF: ${soSp.length} de SP`);

const semGrupo = doTeste(fila.elegiveis({ grupoId, filtros: { somenteSemGrupo: 'sim' } }));
ok(semGrupo.length === 5, `filtro "só quem não está em nenhum grupo": ${semGrupo.length}`);

// ---------------------------------------------------------------- enfileirar
console.log('\n2) Enfileirar com um clique');
const alvos = soSp.map((p) => p.id);
const r = fila.enfileirar({ grupoId, pessoaIds: alvos });
ok(r.enfileirados === 4, `${r.enfileirados} pessoas na fila`);
ok(r.pendentes === 4, `${r.pendentes} pendentes`);
ok(typeof r.estimativa === 'string', `estimativa de tempo calculada: ${r.estimativa}`);

const repetido = fila.enfileirar({ grupoId, pessoaIds: alvos });
ok(repetido.enfileirados === 0, 'clicar de novo não duplica ninguém');

// ------------------------------------------------------------- ritmo seguro
console.log('\n3) Ritmo — o que impede a rajada');
ok(fila.LIMITES.intervaloMin >= 60, `intervalo mínimo de ${fila.LIMITES.intervaloMin}s entre adições`);
ok(fila.LIMITES.intervaloMax > fila.LIMITES.intervaloMin, 'intervalo é aleatório, não fixo');
ok(fila.LIMITES.porDia <= 60, `teto diário de ${fila.LIMITES.porDia}`);
ok(fila.LIMITES.porHora <= 20, `teto por hora de ${fila.LIMITES.porHora}`);
ok(fila.resumo(grupoId).estado.impedimento === 'WhatsApp desconectado',
  'sem WhatsApp conectado, a fila não anda');

// -------------------------------------------------------- executor de mentira
// A janela de horário é uma trava real e é testada logo acima. Aqui ela sai do
// caminho: sem isso, este teste passaria de dia e falharia depois das 20h.
const horarioOriginal = { inicio: fila.LIMITES.horaInicio, fim: fila.LIMITES.horaFim };
fila.LIMITES.horaInicio = 0;
fila.LIMITES.horaFim = 24;

console.log('\n4) Processando com o WhatsApp respondendo');
const chamadas = [];
let convitesEnviados = 0;
const respostas = ['200', '403', '408', '200'];   // uma de cada situação real

fila.registrarExecutor({
  adicionar: async (grupoJid, pessoaJid) => {
    chamadas.push({ grupoJid, pessoaJid, em: Date.now() });
    return { status: respostas[chamadas.length - 1] ?? '200', jid: pessoaJid };
  },
  obterConvite: async () => 'ABC123CONVITE',
  enviarMensagem: async (jid, texto) => {
    convitesEnviados++;
    ok(texto.includes('chat.whatsapp.com/ABC123CONVITE'), 'convite traz o link do grupo');
    ok(texto.includes('Grupo Teste Adição'), 'convite cita o nome do grupo');
    ok(texto.includes('assinou nosso abaixo-assinado'), 'convite explica por que a pessoa está sendo chamada');
    ok(texto.includes('ignorar esta mensagem'), 'convite dá saída educada (evita denúncia)');
    return true;
  }
});

for (let i = 0; i < 4; i++) await fila.processarAgoraParaTeste();

ok(chamadas.length === 4, `${chamadas.length} tentativas feitas`);
ok(chamadas.every((c) => c.grupoJid === JID_GRUPO), 'todas no grupo certo');
ok(new Set(chamadas.map((c) => c.pessoaJid)).size === 4, 'uma pessoa por vez, sem repetir');

const r2 = fila.resumo(grupoId);
ok(r2.adicionados === 2, `${r2.adicionados} adicionadas direto (status 200)`);
ok(r2.convidados === 1, `${r2.convidados} convidada por link (status 403 = privacidade)`);
ok(convitesEnviados === 1, 'convite enviado no privado para quem não pode ser adicionada');
ok(r2.falharam === 1, `${r2.falharam} falhou (status 408 = saiu do grupo recentemente)`);
ok(r2.pendentes === 0, 'fila esvaziada');

const item408 = fila.listarFila({ grupoId, situacao: 'falhou' })[0];
ok(/readicionar/.test(item408.erro || ''), `erro explicado em português: "${item408.erro}"`);

// --------------------------------------------------- parada de segurança
console.log('\n5) Parada automática quando o WhatsApp reclama');
fila.enfileirar({ grupoId, pessoaIds: [pessoas[4].id] });
db.prepare("UPDATE fila_adicao SET situacao='pendente' WHERE grupo_id = ?").run(grupoId);
fila.retomar();
fila.registrarExecutor({
  adicionar: async () => { throw new Error('rate-overlimit'); },
  obterConvite: async () => null,
  enviarMensagem: async () => true
});
for (let i = 0; i < fila.LIMITES.falhasSeguidasParaPausar; i++) await fila.processarAgoraParaTeste();
ok(fila.estadoDaFila().pausada, 'fila pausou sozinha depois das falhas seguidas');
ok(/proteger o número/.test(fila.estadoDaFila().motivoPausa || ''),
  `motivo registrado: "${fila.estadoDaFila().motivoPausa}"`);

const pausada = fila.resumo(grupoId);
ok(pausada.estado.impedimento !== null, 'pausada não processa mais nada');
fila.retomar();
ok(!fila.estadoDaFila().pausada, 'retomar volta a funcionar');

// ------------------------------------------------------------- cancelar
console.log('\n6) Cancelar o que sobrou');
const cancelou = fila.cancelarPendentes(grupoId);
ok(cancelou.cancelados >= 0, `${cancelou.cancelados} pendente(s) cancelado(s)`);
ok(fila.resumo(grupoId).pendentes === 0, 'nada mais pendente');

// ------------------------------------------------------- janela de horário
console.log('\n7) Janela de horário');
fila.enfileirar({ grupoId, pessoaIds: [pessoas[0].id] });
db.prepare("UPDATE fila_adicao SET situacao='pendente' WHERE grupo_id = ?").run(grupoId);

fila.LIMITES.horaInicio = 3;
fila.LIMITES.horaFim = 4;      // janela que certamente não é agora
ok(/fora do horário/.test(fila.resumo(grupoId).estado.impedimento || ''),
  `fora da janela, a fila não anda: "${fila.resumo(grupoId).estado.impedimento}"`);

const antesDaJanela = fila.resumo(grupoId).adicionados;
await fila.processarAgoraParaTeste();
ok(fila.resumo(grupoId).adicionados === antesDaJanela,
  'ninguém é adicionado de madrugada, mesmo com fila cheia');

fila.LIMITES.horaInicio = 0;
fila.LIMITES.horaFim = 24;
ok(fila.resumo(grupoId).estado.impedimento === null, 'dentro da janela, volta a andar');

// Devolve os limites reais, para o teste não deixar rastro.
fila.LIMITES.horaInicio = horarioOriginal.inicio;
fila.LIMITES.horaFim = horarioOriginal.fim;
fila.cancelarPendentes(grupoId);

fila.registrarExecutor(null);
limpar();
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Fila de adição funcionando com ritmo seguro.'}\n`);
process.exit(falhas ? 1 : 0);
