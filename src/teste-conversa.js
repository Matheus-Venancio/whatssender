// Testa a leitura de conversa privada: sentimento, intenção e sugestões.
// Cria uma conversa de mentira, verifica, e apaga tudo no fim.
//
//   node --no-warnings=ExperimentalWarning src/teste-conversa.js

import { db, agora, usarCampanha } from './db.js';
import { upsertPessoa, registrarMensagem } from './ingest.js';
import { recomputar } from './scoring.js';
import { analisarSentimento, lerConversa, sugerirRespostas, atualizarConversa } from './conversa.js';
import { listarConversas, marcarConversaLida } from './repo.js';

// Estes scripts rodam sobre UMA campanha. Escolha com a variável CAMPANHA;
// sem ela, usa a primeira encontrada em data/campanhas/.
const CAMPANHA = usarCampanha();

process.env.CANDIDATA ||= 'Dra. Cláudia Camargo';

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const TEL = '5519955550001';
const limpar = () => {
  const p = db.prepare('SELECT id FROM pessoas WHERE telefone = ?').get(TEL);
  if (p) db.prepare('DELETE FROM pessoas WHERE id = ?').run(p.id);
};

function montarConversa(mensagens, { cadastrada = true, cidade = 'Sorocaba' } = {}) {
  limpar();
  const id = upsertPessoa({ jid: `${TEL}@s.whatsapp.net`, nomeWa: 'Marlene Aparecida Lima' });
  db.prepare('UPDATE pessoas SET cidade = ?, uf = ?, cadastro_em = ? WHERE id = ?')
    .run(cidade, 'SP', cadastrada ? agora() : null, id);
  let t = agora() - mensagens.length * 60_000;
  for (const [deMim, texto] of mensagens) {
    registrarMensagem({
      waId: `teste-conv-${t}`, grupoId: null, pessoaId: id, texto, ts: (t += 60_000),
      deMim, privada: true, sentimento: deMim ? null : analisarSentimento(texto)
    });
  }
  recomputar();
  atualizarConversa(id);
  return id;
}

console.log('\nTeste de leitura de conversa privada\n');

// ------------------------------------------------------------- sentimento
console.log('1) Sentimento');
const casos = [
  ['Muito obrigada, Deus abençoe vocês!', 'positivo'],
  ['Bom dia, tudo bem?', 'neutro'],
  ['Meu filho sofre bullying e ninguém faz nada, preciso muito de ajuda', 'negativo'],
  ['a fila do SUS aqui é um descaso', 'negativo'],
  ['vou denunciar esse grupo', 'critico'],
  ['obrigada, mas continuo precisando de ajuda urgente', 'negativo']
];
for (const [texto, esperado] of casos) {
  const s = analisarSentimento(texto);
  ok(s === esperado, `"${texto.slice(0, 46)}…" → ${s}${s === esperado ? '' : ` (esperado ${esperado})`}`);
}

// ------------------------------------------------------ conversa com demanda
console.log('\n2) Conversa com pedido de ajuda');
let id = montarConversa([
  [false, 'Boa tarde! Vi o abaixo-assinado dos psicólogos nas escolas'],
  [true, 'Boa tarde! Que bom te ver por aqui 🙏'],
  [false, 'Meu filho tem 9 anos e sofre bullying na escola. Já procurei a direção e ninguém faz nada. Preciso muito de ajuda']
]);
let c = lerConversa(id);
ok(c.mensagens.length === 3, `${c.mensagens.length} mensagens na thread`);
ok(c.sentimento === 'negativo', `sentimento da conversa: ${c.sentimento}`);
ok(c.intencoes.includes('demanda'), `intenção detectada: ${c.intencoes.join(', ')}`);
ok(c.aguardando, 'marcada como aguardando resposta (última mensagem é dela)');

let sug = sugerirRespostas(id);
ok(sug.length > 0, `${sug.length} sugestão(ões) geradas`);
ok(sug[0].titulo.includes('Acolher'), `primeira sugestão: "${sug[0].titulo}"`);
ok(sug[0].texto.startsWith('Marlene, '), `usa o primeiro nome: "${sug[0].texto.slice(0, 32)}…"`);
ok(!/\bde a \b|\bpara a a\b/.test(sug.map((s) => s.texto).join(' ')), 'sem erro de concordância no texto');
ok(sug[0].texto.includes('Dra. Cláudia Camargo'), 'cita o nome da candidata configurado');
ok(sug.every((s) => s.porque && s.tom), 'toda sugestão explica o porquê e tem tom');

// --------------------------------------------------------- conversa hostil
console.log('\n3) Conversa hostil');
id = montarConversa([[false, 'Quem é você? Não pedi para entrar em grupo nenhum']]);
c = lerConversa(id);
ok(c.sentimento === 'critico', `sentimento: ${c.sentimento}`);
ok(c.risco?.categoria === 'nao_reconhece', `risco: ${c.risco?.categoria}`);
sug = sugerirRespostas(id);
ok(sug.length === 2, `${sug.length} sugestões (explicar ou só remover)`);
ok(sug.some((s) => /remov/i.test(s.texto)), 'uma delas oferece remover na hora');
ok(!sug.some((s) => /cadastro|abaixo-assinado.*Posso te adicionar/i.test(s.texto)),
  'não tenta captar cadastro de quem está irritado');

// ------------------------------------------------------ conversa positiva
console.log('\n4) Conversa positiva de quem quer ajudar');
id = montarConversa([[false, 'Adorei a proposta! Conta comigo, quero ajudar no que precisar']]);
c = lerConversa(id);
ok(c.sentimento === 'positivo', `sentimento: ${c.sentimento}`);
ok(c.intencoes.includes('voluntario'), `intenção: ${c.intencoes.join(', ')}`);
sug = sugerirRespostas(id);
ok(sug.some((s) => s.titulo.includes('passo concreto')), 'sugere tarefa concreta, não só agradecer');
ok(sug.some((s) => s.texto.includes('Sorocaba')), 'personaliza com a cidade dela');

// ------------------------------------------------- sem nome, sem cadastro
console.log('\n5) Pessoa sem nome e sem cadastro');
limpar();
id = upsertPessoa({ jid: `${TEL}@s.whatsapp.net` });
registrarMensagem({
  waId: 'teste-conv-x', grupoId: null, pessoaId: id, texto: 'oi', ts: agora(),
  deMim: false, privada: true, sentimento: 'neutro'
});
recomputar();
sug = sugerirRespostas(id);
ok(sug.every((s) => /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(s.texto)), 'sem nome, a frase começa com maiúscula');
ok(!sug.some((s) => s.texto.includes('undefined') || s.texto.includes('null')), 'nenhum buraco de template');
ok(sug.some((s) => s.titulo === 'Pedir o cadastro'), 'sugere completar o cadastro');

// --------------------------------------------------------- caixa de entrada
console.log('\n6) Caixa de entrada');
const inbox = listarConversas({});
const minha = inbox.itens.find((x) => x.tipo === 'privada' && x.pessoa_id === id);
ok(Boolean(minha), 'a conversa aparece na lista');
ok(minha?.nao_lidas === 1, `contador de não lidas: ${minha?.nao_lidas}`);
ok(minha?.aguardando === true, 'marcada como aguardando resposta');
ok(inbox.itens.some((x) => x.tipo === 'grupo'), 'grupos também aparecem no espelho');
marcarConversaLida(id);
ok(listarConversas({}).itens.find((x) => x.pessoa_id === id)?.nao_lidas === 0, 'abrir a conversa zera o contador');
ok(listarConversas({ filtro: 'privadas' }).itens.every((x) => x.tipo === 'privada'), 'filtro "privadas" funciona');
ok(listarConversas({ filtro: 'grupos' }).itens.every((x) => x.tipo === 'grupo'), 'filtro "grupos" funciona');

limpar();
recomputar();
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Leitura de conversa e sugestões funcionando.'}\n`);
process.exit(falhas ? 1 : 0);
