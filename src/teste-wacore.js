// Testa o adaptador do WA-Core2 CONTRA A API DE VERDADE.
//
//   WACORE_TOKEN=... node --no-warnings=ExperimentalWarning src/teste-wacore.js
//
// Segue exatamente os "Primeiros passos" da documentação, que são as únicas
// operações seguras no ambiente compartilhado:
//
//   1. registrar o team      2. criar a linha      3. consultar o status
//
// O QUE ESTE TESTE NÃO FAZ, DE PROPÓSITO: chamar connect-by-external. A doc
// proíbe no ambiente de parceria — parearia um WhatsApp real e afetaria a
// reputação do IP compartilhado com os clientes em produção. O teste verifica
// que a trava está no lugar, o que é o oposto de exercitá-la.
//
// Sem WACORE_TOKEN o teste passa sem tocar a rede: a suíte não pode depender
// de credencial de terceiro para rodar.

import { randomUUID } from 'node:crypto';
import * as wa from './wacore.js';

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

console.log('\nAdaptador WA-Core2\n');

// ------------------------------------------------- montagem do corpo (offline)
console.log('1) Montagem da mensagem');
{
  // Espia o corpo sem rede, trocando o fetch por um espião.
  const originalFetch = globalThis.fetch;
  let visto = null;
  globalThis.fetch = async (url, opcoes) => {
    visto = { url: String(url), corpo: JSON.parse(opcoes.body || '{}') };
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
  };
  process.env.WACORE_TOKEN ||= 'token-de-teste';
  const { enviar } = await import(`./wacore.js?espiao=${Date.now()}`);

  await enviar({ externalId: 'time-1', to: '+55 (19) 99146-9316', texto: 'oi' });
  ok(visto.corpo.to === '5519991469316', `telefone limpo: ${visto.corpo.to}`);
  ok(visto.corpo.type === 'text', 'sem anexo, vai como texto');
  ok(visto.url.includes('/api/whatsapp/send-by-external/time-1'), 'rota e id na URL');

  await enviar({
    externalId: 't', to: '5519999999999', texto: 'Legenda',
    midia: { tipo: 'imagem', url: 'https://x/foto.jpg', mimetype: 'image/jpeg' }
  });
  ok(visto.corpo.type === 'image', 'imagem vira type=image');
  ok(visto.corpo.caption === 'Legenda', 'o texto vira legenda da imagem');
  ok(!visto.corpo.text, 'não manda texto e legenda ao mesmo tempo');

  await enviar({
    externalId: 't', to: '5519999999999', texto: 'Ouça',
    midia: { tipo: 'audio', url: 'https://x/a.ogg' }
  });
  ok(visto.corpo.type === 'audio', 'áudio vira type=audio');
  ok(!visto.corpo.caption, 'áudio NÃO leva legenda — o WhatsApp descarta');

  await enviar({ externalId: 't', to: '5519999999999', texto: 'oi', clientMessageId: 'abc' });
  ok(visto.corpo.clientMessageId === 'abc', 'clientMessageId vai no corpo (idempotência)');

  ok(wa.esperandoPareamento('qr') && wa.esperandoPareamento('pairing'),
    'qr e pairing contam como "esperando pareamento"');
  ok(!wa.esperandoPareamento('connected'), 'connected não é espera');

  globalThis.fetch = originalFetch;
}

// ------------------------------------------------------ trava de pareamento
console.log('\n2) Trava do ambiente compartilhado');
{
  let barrou = false;
  let mensagem = '';
  try {
    await wa.parear({ externalId: randomUUID() });
  } catch (erro) {
    barrou = erro.status === 403;
    mensagem = erro.message;
  }
  ok(barrou, 'parear é recusado sem WACORE_PERMITIR_PAREAMENTO');
  ok(/reputa/i.test(mensagem), 'a recusa explica o motivo (reputação do IP compartilhado)');
}

// -------------------------------------------------------- contra a API real
const TOKEN_REAL = process.env.WACORE_TOKEN && process.env.WACORE_TOKEN !== 'token-de-teste';

if (!TOKEN_REAL) {
  console.log('\n3) API real — pulado (sem WACORE_TOKEN)');
} else {
  console.log('\n3) Primeiros passos contra a API real');

  const d = await wa.diagnostico();
  ok(d.saude === 'ok', `serviço no ar: ${d.servico} (${d.saude})`);
  ok(!d.teams?.erro, `token válido — ${d.teams?.total ?? '?'} team(s) visíveis`);

  const teamId = randomUUID();
  const linhaId = randomUUID();

  const team = await wa.registrarTeam({ externalId: teamId, name: 'Rede de Apoio — teste' });
  ok(team?.success !== false, `team registrado: ${teamId.slice(0, 8)}…`);

  const linha = await wa.criarLinha({ externalId: teamId, userExternalId: linhaId });
  ok(Boolean(linha?.data?.userId), `linha criada: userId ${linha?.data?.userId}`);

  // Idempotência: repetir não pode duplicar.
  const repetida = await wa.criarLinha({ externalId: teamId, userExternalId: linhaId });
  ok(repetida?.data?.userId === linha?.data?.userId,
    'repetir a criação devolve a mesma linha (idempotente)');

  const st = await wa.status(teamId, linhaId);
  const situacao = st?.data?.status ?? st?.status ?? JSON.stringify(st).slice(0, 60);
  ok(Boolean(st), `status da linha: ${situacao} — "disconnected" é o esperado antes de parear`);

  const teams = await wa.listarTeams();
  ok((teams.data || []).some((t) => t.externalId === teamId || t.external_id === teamId),
    'o team aparece na listagem do app');

  // Limpa o que criou: ambiente compartilhado não é lugar de deixar lixo.
  try {
    await wa.removerTeam(teamId);
    const depois = await wa.listarTeams();
    ok(!(depois.data || []).some((t) => t.externalId === teamId || t.external_id === teamId),
      'team de teste removido no fim');
  } catch (erro) {
    console.log(`  ⚠ não consegui remover o team de teste (${erro.message}) — remova ${teamId}`);
  }
}

console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Adaptador WA-Core2 funcionando.'}\n`);
process.exit(falhas ? 1 : 0);
