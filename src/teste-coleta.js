// Testa "Coletar dados": captação por embaixador, atribuição de quem trouxe
// quem, e o potencial de apoio de quem chega só pelo formulário.
//
//   node --no-warnings=ExperimentalWarning src/teste-coleta.js

import './ambiente.js';
import { db, agora, usarCampanha } from './db.js';
import { salvarFormularioPautas, salvarCadastro, upsertPessoa } from './ingest.js';
import * as emb from './embaixadores.js';
import { calcularPropensao, PESOS_APOIO, recomputar } from './scoring.js';

const CAMPANHA = usarCampanha();

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const PREFIXO = '55199555';
const marca = 'ZZ-teste-coleta';

function limpar() {
  const ids = db.prepare(`SELECT id FROM pessoas WHERE telefone LIKE '${PREFIXO}%'`).all();
  for (const p of ids) {
    db.prepare('DELETE FROM interesses WHERE pessoa_id = ?').run(p.id);
    db.prepare('DELETE FROM pessoa_intencoes WHERE pessoa_id = ?').run(p.id);
    db.prepare('DELETE FROM perfil WHERE pessoa_id = ?').run(p.id);
    db.prepare('DELETE FROM eventos WHERE pessoa_id = ?').run(p.id);
  }
  db.prepare(`DELETE FROM mensagens WHERE pessoa_id IN (SELECT id FROM pessoas WHERE telefone LIKE '${PREFIXO}%')`).run();
  db.prepare(`DELETE FROM pessoas WHERE telefone LIKE '${PREFIXO}%'`).run();
  db.prepare(`DELETE FROM outbox WHERE doc_id LIKE '${PREFIXO}%'`).run();
  db.prepare(`DELETE FROM embaixadores WHERE papel = ?`).run(marca);
}

console.log('\nTeste de Coletar dados (captação por embaixador)\n');
limpar();

// ------------------------------------------------------ 1) embaixadores
console.log('1) Cadastro de embaixador e código próprio');

const luciana = emb.criar({ nome: 'Luciana Teste', papel: marca });
const cadima = emb.criar({ nome: 'Cadima Teste', papel: marca });

ok(Boolean(luciana.codigo), `código gerado: ${luciana.codigo}`);
ok(luciana.codigo !== cadima.codigo, 'cada embaixador tem código diferente');
ok(/-[0-9a-f]{4}$/.test(luciana.codigo),
  'o código tem sufixo aleatório — não é adivinhável a partir do nome');
ok(luciana.codigo.startsWith('luciana'), 'mas continua legível para conferência');
ok(emb.porCodigo(luciana.codigo)?.id === luciana.id, 'busca por código funciona');
ok(emb.porCodigo('nao-existe-0000') === null, 'código inexistente devolve null');

const doisIguais = emb.criar({ nome: 'Luciana Teste', papel: marca });
ok(doisIguais.codigo !== luciana.codigo, 'nome repetido não colide de código');

// -------------------------------------------------------- 2) atribuição
console.log('\n2) Atribuição de quem trouxe quem');

let seq = 0;
const entrar = (codigo, pautas, intencao = 'apoiador') => {
  seq++;
  return salvarFormularioPautas({
    nome: `Captada ${seq}`, telefone: `${PREFIXO}${String(100 + seq)}`,
    cidade: 'Campinas', atuacao: 'Mãe/Pai', pautas, intencao, embaixador: codigo
  });
};

const a = entrar(luciana.codigo, ['mulher', 'infancia_juventude'], 'voluntario');
ok(a.indicadaPor?.nome === 'Luciana Teste', 'quem entrou pelo link da Luciana fica com ela');

const b = entrar(cadima.codigo, ['pcd', 'educacao'], 'lideranca');
ok(b.indicadaPor?.nome === 'Cadima Teste', 'quem entrou pelo link do Cadima fica com ele');

const semCodigo = entrar(null, ['saude']);
ok(semCodigo.indicadaPor === null, 'sem código, ninguém leva o crédito');

const codigoFalso = entrar('inventado-9999', ['saude']);
ok(codigoFalso.indicadaPor === null, 'código inválido não atribui (e não quebra)');

// A regra que impede o relatório de captação de virar ficção.
const voltou = salvarFormularioPautas({
  nome: 'Captada 1', telefone: `${PREFIXO}101`, cidade: 'Campinas',
  atuacao: 'Mãe/Pai', pautas: ['saude'], embaixador: cadima.codigo
});
ok(voltou.indicadaPor?.nome === 'Luciana Teste',
  'quem voltou por outro link continua creditada a quem captou primeiro');

emb.definirAtivo(cadima.id, false);
const comInativo = entrar(cadima.codigo, ['educacao']);
ok(comInativo.indicadaPor === null, 'embaixador desativado para de atribuir');
emb.definirAtivo(cadima.id, true);

// O formulário simples (cadastro) também atribui.
const viaCadastro = salvarCadastro({
  telefone: `${PREFIXO}900`, nome: 'Captada Cadastro', cidade: 'Campinas',
  atuacao: 'Professora', embaixador: luciana.codigo
});
ok(viaCadastro.indicadaPor?.nome === 'Luciana Teste', 'o formulário de cadastro também atribui');
ok(db.prepare('SELECT origem FROM pessoas WHERE id = ?').get(viaCadastro.pessoaId).origem === 'indicacao',
  'a origem da pessoa nova fica registrada como indicação');

// -------------------------------------- 3) potencial de apoio na entrada
console.log('\n3) Potencial de apoio de quem só preencheu o formulário');

const base = {
  privadas_dela: 0, privadas_minhas: 0, priv_positivas: 0, priv_negativas: 0,
  msgs_total: 0, negativas: 0, atritos: 0, grupos_count: 0, grupos_que_saiu: 0,
  na_agenda: 0, assinaturas: 0, temTema: true, cadastro_em: agora(),
  temas_count: 1, intencao_peso: 0, intencao_top: null, indicado_por: null
};

const cru = calcularPropensao(base);
const comIntencao = calcularPropensao({ ...base, intencao_peso: 4, intencao_top: 'lideranca' });
const comTudo = calcularPropensao({
  ...base, intencao_peso: 4, intencao_top: 'lideranca', indicado_por: 1, temas_count: 3
});

ok(comIntencao.propensao > cru.propensao,
  `intenção declarada pesa: ${cru.propensao} → ${comIntencao.propensao}`);
ok(comTudo.propensao > comIntencao.propensao,
  `indicação e pautas somam: ${comIntencao.propensao} → ${comTudo.propensao}`);
ok(comTudo.faixa !== 'Sem sinal',
  `quem se declara liderança e vem por indicação sai de "Sem sinal" (agora: ${comTudo.faixa})`);
// Guarda de regressão: quem não declarou intenção nem veio por indicação tem de
// pontuar exatamente o que pontuava antes (interesse 10 + formulário 7 = 17).
// Se este número subir, os pesos novos vazaram para quem não deu sinal nenhum e a
// classificação inteira inflou.
ok(cru.propensao === 17 && cru.faixa === 'Contato frio',
  `sem intenção e sem indicação, a régua não mudou: ${cru.propensao} · ${cru.faixa}`);
ok(comTudo.propensao - cru.propensao === 40,
  `os sinais novos somam 40 pontos no máximo (${cru.propensao} → ${comTudo.propensao})`);

const lideranca = calcularPropensao({ ...base, intencao_peso: 4, intencao_top: 'lideranca' });
const demanda = calcularPropensao({ ...base, intencao_peso: 2, intencao_top: 'demanda' });
ok(lideranca.propensao > demanda.propensao,
  `liderança pontua mais que quem só trouxe demanda: ${lideranca.propensao} vs ${demanda.propensao}`);

const critico = calcularPropensao({ ...base, intencao_peso: 1, intencao_top: 'critico' });
ok(critico.propensao <= cru.propensao,
  'intenção "crítico / atrito" não vira ponto a favor');

const comAtrito = calcularPropensao({
  ...base, intencao_peso: 4, intencao_top: 'lideranca', indicado_por: 1, atritos: 1
});
ok(comAtrito.faixa === 'Não abordar',
  'atrito registrado continua tirando a pessoa da lista, por mais sinais que ela tenha');

ok(Number.isFinite(PESOS_APOIO.intencaoDeclarada) && Number.isFinite(PESOS_APOIO.indicacao),
  'os pesos novos existem e são numéricos');

// --------------------------------------------------- 4) relatório
console.log('\n4) Relatório de captação');

recomputar();
const rendimento = emb.rendimento().filter((e) => e.papel === marca);
const daLuciana = rendimento.find((e) => e.id === luciana.id);

ok(daLuciana.captadas === 2,
  `Luciana captou ${daLuciana.captadas} pessoas distintas (1 pelo formulário + 1 pelo cadastro)`);
ok(daLuciana.captadas_7d === 2, 'as duas contam na janela de 7 dias');
ok(daLuciana.propensao_media > 0, `propensão média calculada: ${daLuciana.propensao_media}`);
ok(daLuciana.em_grupo === 0, 'ninguém entrou em grupo da campanha ainda');

const captadas = emb.captadasDe(luciana.id);
ok(captadas.length === 2, 'a lista detalhada traz as 2 pessoas');
ok(new Set(captadas.map((p) => p.id)).size === captadas.length,
  'quem voltou por outro link não aparece duas vezes na lista');
ok(captadas.every((p) => p.faixa_apoio), 'todas com faixa de potencial de apoio preenchida');
ok(captadas[0].propensao >= captadas[captadas.length - 1].propensao,
  'a lista vem ordenada por propensão, para a equipe atacar de cima para baixo');

const resumo = emb.resumoDaColeta();
// Três, e não quatro: neste ponto só Captada 1, Captada 2 e Captada Cadastro
// têm indicado_por. As que entraram sem código, com código falso ou por
// embaixador inativo NÃO contam de propósito — contá-las faria o relatório
// creditar ao embaixador gente que ele não trouxe. A captação por wa.me, que
// acrescenta a quarta, só acontece na seção 5, abaixo.
ok(resumo.captadas === 3, `${resumo.captadas} pessoas captadas por indicação no total`);
ok(resumo.embaixadores >= 2, `${resumo.embaixadores} embaixadores ativos`);
ok(typeof resumo.prontas_para_tratamento === 'number',
  `fila de tratamento: ${resumo.prontas_para_tratamento} pessoas com potencial e fora de grupo`);

// ------------------------------------- 5) captação pelo WhatsApp (wa.me)
console.log('\n5) Captação pelo WhatsApp: link wa.me e atribuição pela 1ª mensagem');

const TEL_CAMPANHA = '5519981466623';
const wa = emb.linkWhatsapp(luciana.codigo, TEL_CAMPANHA, 'Dra. Cláudia Camargo');

ok(wa.startsWith(`https://wa.me/${TEL_CAMPANHA}?text=`), 'link wa.me aponta para o número da campanha');
ok(decodeURIComponent(wa).includes(`(indicação: ${luciana.codigo})`),
  'a mensagem sugerida carrega o código de quem indicou');
ok(decodeURIComponent(wa).includes('Dra. Cláudia Camargo'), 'e cita a candidata');
ok(emb.linkWhatsapp(luciana.codigo, null) === null,
  'sem número conectado não há link wa.me (em vez de gerar link quebrado)');
ok(emb.linkWhatsapp(luciana.codigo, '11999') === null, 'número curto também não gera link');

const extrair = emb.codigoNaMensagem;
ok(extrair(`Olá! Quero somar. (indicação: ${luciana.codigo})`) === luciana.codigo,
  'extrai o código da mensagem');
ok(extrair(`quero somar (indicacao: ${cadima.codigo})`) === cadima.codigo,
  'funciona sem acento e em minúsculas');
ok(extrair('Olá, quero apoiar a campanha!') === null,
  'mensagem comum não gera atribuição falsa');
ok(extrair('') === null && extrair(null) === null, 'texto vazio ou nulo não quebra');

// A pessoa chega pelo WhatsApp: ainda não existe na base.
const jidNovo = `${PREFIXO}777@s.whatsapp.net`;
const idWa = upsertPessoa({ jid: jidNovo, nomeWa: 'Vinda do WhatsApp' });
const atribuiu = emb.atribuirPorMensagem(idWa, emb.textoDeAbertura(luciana.codigo));
ok(atribuiu?.nome === 'Luciana Teste', 'quem chamou pelo link da Luciana fica com ela');

// Segunda mensagem com o código de OUTRO não pode mudar a atribuição.
const tentouRoubar = emb.atribuirPorMensagem(idWa, emb.textoDeAbertura(cadima.codigo));
ok(tentouRoubar?.nome === 'Luciana Teste',
  'código de outro embaixador numa mensagem posterior não rouba a atribuição');

const semCod = upsertPessoa({ jid: `${PREFIXO}778@s.whatsapp.net`, nomeWa: 'Sem código' });
ok(emb.atribuirPorMensagem(semCod, 'oi, tudo bem?') === null,
  'quem chama sem código não é atribuído a ninguém');

// -------------------------------------------------- 6) kit de divulgação
console.log('\n6) Kit de divulgação');

const LINK = `https://exemplo.org/formulario/claudia?e=${luciana.codigo}`;
const kit = emb.kitDeDivulgacao(luciana, {
  link: LINK, candidata: 'Dra. Cláudia Camargo', cargo: 'Deputada Estadual · SP'
});

ok(kit.pecas.length >= 5, `${kit.pecas.length} peças (story, grupo, direta, post, evento)`);
ok(kit.pecas.every((p) => p.titulo && p.dica && p.texto), 'toda peça tem título, dica e texto');
// A fala de evento é a única sem link no texto, e de propósito: é roteiro falado
// apontando para o QR impresso. Todas as outras precisam do link colável.
const semLink = kit.pecas.filter((p) => !p.texto.includes(LINK)).map((p) => p.canal);
ok(semLink.length === 1 && semLink[0] === 'evento',
  `só a fala de evento não traz o link (é roteiro falado). Sem link: ${semLink.join(', ')}`);
ok(kit.pecas.every((p) => !/20223|\b19\d{3}\b/.test(p.texto)),
  'nenhuma peça cita número de urna — número errado divulgado não se recolhe');
ok(kit.pecas.every((p) => !/vou conseguir|prometo|garanto/i.test(p.texto)),
  'nenhuma peça promete nada em nome da candidata');
ok(kit.pecas.some((p) => /ignora tranquilo|sem problema nenhum/i.test(p.texto)),
  'as peças oferecem saída a quem não quer participar');
ok(kit.regras.some((r) => /agenda/i.test(r)),
  'as regras entregues à embaixadora dizem explicitamente para não copiar agenda');
ok(kit.assinatura.includes('Luciana'), `assinatura montada: "${kit.assinatura}"`);

const semWa = emb.kitDeDivulgacao(luciana, { link: LINK, candidata: 'X' });
const comWa = emb.kitDeDivulgacao(luciana, {
  link: LINK, linkWhatsapp: 'https://wa.me/5519981466623?text=oi', candidata: 'X'
});
ok(comWa.pecas.length === semWa.pecas.length + 1,
  'a peça de WhatsApp só aparece quando existe número conectado');

let recusou = false;
try { emb.kitDeDivulgacao(luciana, { candidata: 'X' }); } catch { recusou = true; }
ok(recusou, 'sem link, o kit é recusado em vez de sair com texto sem link');

let recusouId = false;
try { emb.kitDeDivulgacao(999999, { link: LINK, candidata: 'X' }); } catch { recusouId = true; }
ok(recusouId, 'embaixador inexistente é recusado');

// ---------------------------------------------- 7) o que NÃO existe
console.log('\n7) O sistema não coleta agenda nem conversa de terceiro');

ok(typeof emb.importarContatos === 'undefined',
  'não existe função de importar a agenda do embaixador');
ok(typeof emb.lerConversasDoEmbaixador === 'undefined',
  'não existe função de ler as conversas do embaixador');
ok(!Object.keys(emb).some((k) => /contato|agenda|scrape|extrair/i.test(k)),
  'nenhuma função de extração de contato de terceiro no módulo');

limpar();
console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Coletar dados funcionando: captação atribuída e potencial de apoio na entrada.'}\n`);
process.exit(falhas ? 1 : 0);
