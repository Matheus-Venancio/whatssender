// Testa os avisos no WhatsApp e o isolamento entre campanhas.
//
//   node --no-warnings=ExperimentalWarning src/teste-nuvem.js
//
// Não toca em rede: o envio é injetado. O que interessa aqui é a decisão —
// para quem vai, o que vira aviso, o que é engolido, e se uma campanha
// consegue enxergar ou usar o número da outra.

import * as contas from './contas.js';
import { avisar, textoDoEvento, destinoDaCampanha, limparControle, LIMITES } from './notificar.js';

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const SLUGS = ['t-claudia', 't-fernandao', 't-paulinho'];
const limpar = () => {
  for (const s of SLUGS) {
    try { contas.admin.prepare('DELETE FROM campanhas WHERE slug = ?').run(s); } catch { /* nada */ }
  }
  limparControle();
};

limpar();
contas.criarCampanha({ nome: 'Teste Cláudia', slug: 't-claudia' });
contas.criarCampanha({ nome: 'Teste Fernandão', slug: 't-fernandao' });
contas.criarCampanha({ nome: 'Teste Paulinho', slug: 't-paulinho' });

contas.atualizarCampanha('t-claudia', { alerta_whatsapp: '5519981466623' });
contas.atualizarCampanha('t-fernandao', { alerta_whatsapp: '5519911112222' });
// t-paulinho fica sem número de propósito.

console.log('\nTeste de avisos e isolamento\n');

// ------------------------------------------------------------ destinatário
console.log('1) Cada campanha avisa quem é dela');
ok(destinoDaCampanha('t-claudia') === '5519981466623', 'Cláudia → 5519981466623');
ok(destinoDaCampanha('t-fernandao') === '5519911112222', 'Fernandão → outro número');
ok(destinoDaCampanha('t-paulinho') === null, 'Paulinho sem número não recebe nada');

// ------------------------------------------------------------- o que vira aviso
console.log('\n2) O que merece interromper');
ok(textoDoEvento({ tipo: 'alerta', alerta: { titulo: 'Saiu do grupo', detalhe: 'Maria saiu', gravidade: 'aviso' } })
  ?.titulo.includes('Saiu do grupo'), 'alerta de saída vira aviso');
ok(textoDoEvento({ tipo: 'alerta', alerta: { titulo: 'Atrito', detalhe: 'x', gravidade: 'critico' } })
  ?.titulo.startsWith('🚨'), 'atrito crítico ganha marca de urgência');
ok(textoDoEvento({ tipo: 'privada', deMim: false, previa: 'oi', pessoaId: 7 }), 'mensagem recebida vira aviso');
ok(textoDoEvento({ tipo: 'privada', deMim: true, previa: 'ok', pessoaId: 7 }) === null,
  'resposta da própria equipe NÃO vira aviso');
ok(textoDoEvento({ tipo: 'mensagem' }) === null, 'mensagem de grupo não interrompe');
ok(textoDoEvento({ tipo: 'fila_progresso' }) === null, 'progresso da fila não interrompe');

// ------------------------------------------------------------------- entrega
console.log('\n3) Entrega');
const enviados = [];
const enviar = async (jid, texto) => { enviados.push({ jid, texto }); };

let r = await avisar('t-claudia', { chave: 'a1', titulo: 'Saiu do grupo', corpo: 'Maria saiu' }, enviar);
ok(r.enviado, 'aviso entregue');
ok(enviados[0].jid === '5519981466623@s.whatsapp.net', `foi para ${enviados[0].jid}`);
ok(enviados[0].texto.includes('Teste Cláudia'), 'assina com o nome da campanha');

r = await avisar('t-paulinho', { chave: 'a1', titulo: 'x', corpo: 'y' }, enviar);
ok(!r.enviado && /sem número/.test(r.motivo), 'campanha sem número não envia');

// --------------------------------------------------------------- repetição
console.log('\n4) Não vira metralhadora');
r = await avisar('t-claudia', { chave: 'a1', titulo: 'Saiu do grupo', corpo: 'João saiu' }, enviar);
ok(!r.enviado && /repetido/.test(r.motivo), 'mesmo assunto seguido é engolido');

r = await avisar('t-claudia', { chave: 'outro', titulo: 'Atrito', corpo: 'briga' }, enviar);
ok(r.enviado, 'assunto diferente passa na hora');

limparControle();
let entregues = 0;
for (let i = 0; i < LIMITES.porHora + 5; i++) {
  const x = await avisar('t-claudia', { chave: `c${i}`, titulo: 't', corpo: 'c' }, enviar);
  if (x.enviado) entregues++;
}
ok(entregues === LIMITES.porHora, `teto por hora respeitado (${entregues}/${LIMITES.porHora})`);

// -------------------------------------------------------------- isolamento
console.log('\n5) Isolamento entre candidatos');
limparControle();
enviados.length = 0;
await avisar('t-claudia', { chave: 'z', titulo: 'A', corpo: 'a' }, enviar);
await avisar('t-fernandao', { chave: 'z', titulo: 'B', corpo: 'b' }, enviar);

ok(enviados.length === 2, 'as duas campanhas enviaram');
ok(enviados[0].jid !== enviados[1].jid, 'cada uma para o seu número');
ok(enviados[0].texto.includes('Teste Cláudia') && !enviados[0].texto.includes('Fernandão'),
  'o aviso da Cláudia não cita o Fernandão');
ok(enviados[1].texto.includes('Teste Fernandão') && !enviados[1].texto.includes('Cláudia'),
  'o aviso do Fernandão não cita a Cláudia');

// A repetição é contada por campanha: silenciar uma não pode silenciar a outra.
limparControle();
enviados.length = 0;
await avisar('t-claudia', { chave: 'mesmo', titulo: 'A', corpo: 'a' }, enviar);
const doOutro = await avisar('t-fernandao', { chave: 'mesmo', titulo: 'A', corpo: 'a' }, enviar);
ok(doOutro.enviado, 'aviso repetido numa campanha não bloqueia a outra');

// -------------------------------------------------------- bancos separados
console.log('\n6) Bancos separados');
const { pastaDaCampanha } = await import('./db.js');
const pastas = SLUGS.map((s) => pastaDaCampanha(s));
ok(new Set(pastas).size === 3, 'três pastas distintas');
ok(contas.campanhasDoUsuario({ papel: 'equipe', campanha_slug: 't-claudia' }).length === 1,
  'usuário de equipe enxerga só a campanha dele');
ok(contas.podeAcessarCampanha({ papel: 'equipe', campanha_slug: 't-claudia' }, 't-fernandao') === false,
  'equipe da Cláudia não acessa a campanha do Fernandão');

limpar();
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Avisos e isolamento funcionando.'}\n`);
process.exit(falhas ? 1 : 0);
