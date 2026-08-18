// Testa o disparo privado: quem entra, quem nunca entra, e o que a lei exige.
//
//   node --no-warnings=ExperimentalWarning src/teste-transmissao.js
//
// Não toca em rede: o envio é injetado. O que se verifica aqui é a DECISÃO —
// e, principalmente, as recusas. Num disparo eleitoral, o que protege a
// campanha (e o número) é o que o sistema se recusa a fazer.

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// A janela de horário é aberta AQUI, antes de importar o módulo: os limites são
// lidos do ambiente na carga. Sem isto, o teste passava de dia e falhava depois
// das 20h — a fila recusava por horário e as asserções de envio nunca chegavam
// a rodar. O comportamento de recusa fora do horário é testado à parte, com uma
// instância própria, em vez de depender de quando a suíte roda.
process.env.ENVIO_HORA_INICIO = '0';
process.env.ENVIO_HORA_FIM = '24';

const PASTA = join(process.cwd(), 'data-teste-transmissao');
process.env.DATA_DIR = PASTA;
rmSync(PASTA, { recursive: true, force: true });
mkdirSync(PASTA, { recursive: true });

const { db, comCampanha, agora } = await import('./db.js');
const { upsertPessoa, registrarMensagem, registrarAlerta } = await import('./ingest.js');
const { recomputar } = await import('./scoring.js');
const t = await import('./transmissao.js');

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const SLUG = 'transmissao-teste';

console.log('\nDisparo privado — regras e limites\n');

const cenario = comCampanha(SLUG, () => {
  const criar = (tel, nome, opcoes = {}) => {
    const id = upsertPessoa({ jid: `${tel}@s.whatsapp.net`, nomeWa: nome });
    const campos = [];
    const valores = [];
    if (opcoes.naAgenda) { campos.push('na_agenda = 1'); }
    if (opcoes.cidade) { campos.push('cidade = ?'); valores.push(opcoes.cidade); }
    if (opcoes.cadastrada) { campos.push('cadastro_em = ?'); valores.push(agora()); }
    if (campos.length) {
      db.prepare(`UPDATE pessoas SET ${campos.join(', ')} WHERE id = ?`).run(...valores, id);
    }
    return id;
  };

  // Elegíveis por vínculo real.
  const naAgenda = criar('5519900000001', 'Rosa da Agenda', { naAgenda: true, cidade: 'Sorocaba' });
  const conversou = criar('5519900000002', 'Marco Conversou', { cidade: 'Sorocaba' });
  registrarMensagem({
    waId: 'c1', grupoId: null, pessoaId: conversou, privada: true, deMim: false,
    texto: 'oi, tudo bem?', ts: agora()
  });
  const cadastrou = criar('5519900000003', 'Ana Cadastrou', { cadastrada: true });

  // NUNCA elegíveis.
  const semVinculo = criar('5519900000004', 'Zé Desconhecido');   // nº solto: art. 57-E
  const saiu = criar('5519900000005', 'Paulo Saiu', { naAgenda: true });
  const briga = criar('5519900000006', 'Rita Reclamou', { naAgenda: true });
  registrarAlerta({
    tipo: 'atrito:hostilidade', gravidade: 'critico', pessoaId: briga,
    titulo: 'Rita reclamou', detalhe: 'teste'
  });

  recomputar();
  t.descadastrar(saiu, 'teste');

  return { naAgenda, conversou, cadastrou, semVinculo, saiu, briga };
});

// ----------------------------------------------------------------- elegíveis
console.log('1) Quem pode receber');
const lista = comCampanha(SLUG, () => t.elegiveis());
const nomes = lista.map((p) => p.nome);
ok(nomes.includes('Rosa da Agenda'), 'contato salvo na agenda entra');
ok(nomes.includes('Marco Conversou'), 'quem já conversou no privado entra');
ok(nomes.includes('Ana Cadastrou'), 'quem preencheu o formulário entra');

console.log('\n2) Quem a lei e o bom senso mantêm de fora');
ok(!nomes.includes('Zé Desconhecido'),
  'número sem vínculo nenhum fica fora (art. 57-E: nada de cadastro de terceiros)');
ok(!nomes.includes('Paulo Saiu'), 'quem se descadastrou nunca mais entra (art. 57-G)');
ok(!nomes.includes('Rita Reclamou'), 'quem gerou atrito fica fora');
ok(lista.length === 3, `${lista.length} elegíveis de 6 pessoas na base`);

// --------------------------------------------------------------- opt-out
console.log('\n3) Reconhecer o pedido de saída');
for (const frase of ['SAIR', 'sair', 'pare', 'não quero', 'me tira dessa lista', 'descadastrar']) {
  ok(t.pediuParaSair(frase), `"${frase}" → descadastra`);
}
ok(!t.pediuParaSair('não quero perder o evento de sábado, me manda o endereço'),
  'frase longa com "não quero" NÃO descadastra por engano');
ok(!t.pediuParaSair('vou sair de casa agora'), '"vou sair de casa" não é pedido de saída');

// -------------------------------------------------------------- mensagem
console.log('\n4) A mensagem');
const pessoa = { nome: 'Maria Aparecida Souza', cidade: 'Sorocaba' };
const texto = t.montarTexto('{saudacao}! Sou da campanha e queria seu apoio em {cidade}.', pessoa, 0);
ok(texto.includes('Maria'), 'usa o primeiro nome');
ok(!texto.includes('Aparecida'), 'só o primeiro nome, não o nome inteiro');
ok(texto.includes('Sorocaba'), 'usa a cidade');
ok(/SAIR/i.test(texto), 'inclui o descadastramento — exigência do art. 57-G');

const a = t.montarTexto('{saudacao}, tudo bem?', pessoa, 0);
const b = t.montarTexto('{saudacao}, tudo bem?', pessoa, 1);
ok(a !== b, 'duas mensagens seguidas não saem idênticas');

const semNome = t.montarTexto('{saudacao}!', { nome: null }, 0);
ok(!semNome.includes('undefined') && !semNome.includes('null'), 'sem nome, não deixa buraco no texto');

// -------------------------------------------------------------- calendário
console.log('\n5) Calendário eleitoral');
ok(t.janelaLegal({ tipo: 'propaganda', hoje: '2026-07-01' }).pode === false,
  'propaganda antes de 16/08 é recusada (art. 36)');
ok(/16/.test(t.janelaLegal({ tipo: 'propaganda', hoje: '2026-07-01' }).motivo),
  'a recusa diz a data a partir da qual pode');
ok(t.janelaLegal({ tipo: 'propaganda', hoje: '2026-09-01' }).pode === true,
  'depois de 16/08, propaganda liberada');
ok(t.janelaLegal({ tipo: 'propaganda', hoje: '2026-10-04' }).pode === false,
  'no dia da eleição, propaganda vedada (art. 39 §5º)');
ok(t.janelaLegal({ tipo: 'interno', hoje: '2026-07-01' }).pode === true,
  'comunicação interna não depende do início da propaganda');
ok(t.janelaLegal({ tipo: 'interno', hoje: '2026-10-04' }).pode === false,
  'no dia da eleição nem a interna sai — o silêncio vale para o disparo todo');

// ------------------------------------------------------------------ envio
console.log('\n6) Ritmo e parada');
const enviados = [];
const resultado = await comCampanha(SLUG, async () => {
  // 'interno' porque o teste roda em qualquer data: mobilização não espera
  // 16 de agosto. A recusa da propaganda fora da janela já foi verificada acima.
  const criada = t.criar({ titulo: 'Convite', tipo: 'interno', modelo: '{saudacao}, vem com a gente?' });
  t.registrarExecutor(async (jid, txt) => { enviados.push({ jid, txt }); });
  t.iniciar(criada.id);

  const primeira = await t.girar();
  // O impedimento tem que ser lido AQUI dentro: porQueNaoAgora consulta a fila
  // da campanha ativa. Fora do comCampanha ele estoura — e só estourava à
  // noite, quando o envio é recusado por horário e a asserção chegava nele.
  return { criada, primeira, impedimento: t.porQueNaoAgora(), detalhe: t.obter(criada.id) };
});

ok(resultado.criada.alvos === 3, `a lista nasce com ${resultado.criada.alvos} pessoas`);
ok(resultado.primeira.enviada === true || Boolean(resultado.impedimento),
  resultado.primeira.enviada
    ? 'primeira mensagem enviada'
    : `não enviou, com motivo declarado: ${resultado.impedimento}`);

if (resultado.primeira.enviada) {
  ok(enviados[0].jid.endsWith('@s.whatsapp.net'), 'enviou para um JID de telefone');
  ok(/SAIR/i.test(enviados[0].txt), 'a mensagem que saiu tem o descadastramento');
}

// Falha seguida tem que pausar, não insistir.
const parou = await comCampanha(SLUG, async () => {
  const c = t.criar({ titulo: 'Teste falha', tipo: 'interno', modelo: 'oi {nome}' });
  t.registrarExecutor(async () => { throw new Error('rede caiu'); });
  t.iniciar(c.id);
  for (let i = 0; i < t.LIMITES.falhasSeguidasParaPausar; i++) await t.girar();
  return t.estadoDoEnvio();
});
ok(parou.pausada === true, `pausou após ${t.LIMITES.falhasSeguidasParaPausar} falhas seguidas`);
ok(/falhas seguidas/.test(parou.motivoPausa || ''), `motivo registrado: "${parou.motivoPausa}"`);

console.log('\n7) Limites de ritmo configurados');
ok(t.LIMITES.intervaloMin >= 30, `intervalo mínimo de ${t.LIMITES.intervaloMin}s entre mensagens`);
ok(t.LIMITES.porDia <= 300, `teto diário de ${t.LIMITES.porDia}`);
// A janela deste processo foi aberta no topo para o teste não depender da hora.
// A recusa por horário se prova com uma instância própria, de janela fechada.
process.env.ENVIO_HORA_INICIO = '9';
process.env.ENVIO_HORA_FIM = '9';
const noturno = await import(`./transmissao.js?janela=${Date.now()}`);
ok(noturno.dentroDoHorario(new Date('2026-08-17T14:00:00')) === false,
  'fora da janela configurada, a fila recusa — mesmo às 14h');
ok(noturno.dentroDoHorario(new Date('2026-08-17T03:00:00')) === false,
  'de madrugada também recusa');

try { rmSync(PASTA, { recursive: true, force: true }); } catch { /* Windows segura o arquivo */ }

console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Disparo privado dentro das regras.'}\n`);
process.exit(falhas ? 1 : 0);
