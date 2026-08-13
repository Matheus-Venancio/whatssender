// Testa a classificação de propensão a apoiar.
//
//   node --no-warnings=ExperimentalWarning src/teste-apoio.js
//
// O caso que mais importa: campanha SEM abaixo-assinado (o Fernandão). A
// classificação não pode depender de cadastro, senão a base dele inteira
// ficaria em "Sem sinal" e a ferramenta seria inútil para ele.

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = join(process.cwd(), 'data-teste-apoio');
process.env.DATA_DIR = PASTA;
rmSync(PASTA, { recursive: true, force: true });
mkdirSync(PASTA, { recursive: true });

const { db, comCampanha, agora } = await import('./db.js');
const { upsertPessoa, upsertGrupo, vincularMembro, registrarMensagem, registrarAlerta } = await import('./ingest.js');
const { recomputar, CORES_APOIO, FAIXAS_APOIO } = await import('./scoring.js');
const { listarPessoas, panorama } = await import('./repo.js');
const { elegiveis } = await import('./adicionar-grupo.js');

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const SLUG = 'fernandao-teste';

const resultado = comCampanha(SLUG, () => {
  const grupoId = upsertGrupo({ jid: '111@g.us', nome: 'Apoiadores Morungaba', criadoEm: agora() });
  const outroGrupo = upsertGrupo({ jid: '222@g.us', nome: 'Bairro Centro', criadoEm: agora() });

  const criar = (tel, nome, opcoes = {}) => {
    const id = upsertPessoa({ jid: `${tel}@s.whatsapp.net`, nomeWa: nome, origem: opcoes.origem ?? 'contato' });
    if (opcoes.naAgenda) {
      db.prepare('UPDATE pessoas SET na_agenda = 1, nome_agenda = ? WHERE id = ?').run(nome, id);
    }
    return id;
  };

  // 1. Contato da agenda que conversa no privado e fala nos grupos.
  const forte = criar('5519990000001', 'Rosa Liderança', { naAgenda: true });
  vincularMembro({ pessoaId: forte, grupoId, nomeGrupo: 'Apoiadores Morungaba' });
  vincularMembro({ pessoaId: forte, grupoId: outroGrupo, nomeGrupo: 'Bairro Centro' });
  for (let i = 0; i < 10; i++) {
    registrarMensagem({
      waId: `f-priv-${i}`, grupoId: null, pessoaId: forte, privada: true, deMim: false,
      texto: 'quero ajudar na campanha, conta comigo!', sentimento: 'positivo', ts: agora() - i * 3600_000
    });
  }
  for (let i = 0; i < 30; i++) {
    registrarMensagem({
      waId: `f-grp-${i}`, grupoId, pessoaId: forte,
      texto: 'a rua do bairro precisa de asfalto', ts: agora() - i * 3600_000
    });
  }

  // 1b. Três formas de "conversar", para separar amizade de transmissão.
  const soRecebe = criar('5519955559001', 'Só Recebe', { naAgenda: true });
  for (let i = 0; i < 20; i++) {
    registrarMensagem({
      waId: `tx-${i}`, grupoId: null, pessoaId: soRecebe, privada: true, deMim: true,
      texto: 'oi, tudo bem?', ts: agora() - i * 3600_000
    });
  }

  const trocaBoa = criar('5519955559002', 'Conversa Junto', { naAgenda: true });
  for (let i = 0; i < 6; i++) {
    registrarMensagem({
      waId: `tb-eu-${i}`, grupoId: null, pessoaId: trocaBoa, privada: true, deMim: true,
      texto: 'oi!', ts: agora() - i * 7200_000
    });
    registrarMensagem({
      waId: `tb-ela-${i}`, grupoId: null, pessoaId: trocaBoa, privada: true, deMim: false,
      texto: 'adorei a proposta, obrigada!', sentimento: 'positivo', ts: agora() - i * 7200_000 + 60_000
    });
  }

  const trocaRuim = criar('5519955559003', 'Responde Mal', { naAgenda: true });
  for (let i = 0; i < 6; i++) {
    registrarMensagem({
      waId: `tr-eu-${i}`, grupoId: null, pessoaId: trocaRuim, privada: true, deMim: true,
      texto: 'oi!', ts: agora() - i * 7200_000
    });
    registrarMensagem({
      waId: `tr-ela-${i}`, grupoId: null, pessoaId: trocaRuim, privada: true, deMim: false,
      texto: 'não me manda mais isso', sentimento: 'negativo', ts: agora() - i * 7200_000 + 60_000
    });
  }

  // 2. Só contato da agenda, nunca falou.
  const morno = criar('5519990000002', 'Zé Silencioso', { naAgenda: true });

  // 3. Está num grupo e fala pouco.
  const grupo = criar('5519990000003', 'Ana do Grupo', { origem: 'grupo' });
  vincularMembro({ pessoaId: grupo, grupoId, nomeGrupo: 'Apoiadores Morungaba' });
  for (let i = 0; i < 6; i++) {
    registrarMensagem({
      waId: `a-grp-${i}`, grupoId, pessoaId: grupo,
      texto: 'bom dia pessoal', ts: agora() - i * 3600_000
    });
  }

  // 4. Contato que reclamou — não pode ser abordado.
  const atrito = criar('5519990000004', 'Pedro Irritado');
  vincularMembro({ pessoaId: atrito, grupoId, nomeGrupo: 'Apoiadores Morungaba' });
  for (let i = 0; i < 12; i++) {
    registrarMensagem({
      waId: `p-grp-${i}`, grupoId, pessoaId: atrito,
      texto: 'não quero saber desse grupo', sentimento: 'critico', ts: agora() - i * 3600_000
    });
  }
  registrarAlerta({
    tipo: 'atrito:saida_iminente', gravidade: 'critico', pessoaId: atrito, grupoId,
    titulo: 'Pedro quer sair', detalhe: 'teste'
  });

  // 5. Número solto, sem nada.
  const nada = criar('5519990000005', null);

  recomputar();

  const ler = (id) => db.prepare(
    'SELECT propensao, faixa_apoio, motivos_apoio FROM perfil WHERE pessoa_id = ?'
  ).get(id);

  return {
    forte: ler(forte), morno: ler(morno), grupo: ler(grupo),
    atrito: ler(atrito), nada: ler(nada),
    soRecebe: ler(soRecebe), trocaBoa: ler(trocaBoa), trocaRuim: ler(trocaRuim),
    grupoId, outroGrupo,
    semAssinaturas: db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get().n,
    panorama: panorama(),
    ranking: listarPessoas({ ordenar: 'propensao', porPagina: 10 }).itens,
    fila: elegiveis({ grupoId: outroGrupo, filtros: {} }),
    filaProvavel: elegiveis({ grupoId: outroGrupo, filtros: { apoio: 'Provável apoiador' } })
  };
});

console.log('\nClassificação de propensão a apoiar\n');
console.log(`Campanha de teste sem nenhum abaixo-assinado (${resultado.semAssinaturas} assinaturas)\n`);

console.log('1) Cada perfil recebe a faixa certa');
ok(resultado.forte.faixa_apoio === 'Provável apoiador',
  `agenda + privado + 30 msgs → ${resultado.forte.faixa_apoio} (${resultado.forte.propensao}/100)`);
ok(resultado.grupo.faixa_apoio === 'Possível apoiador' || resultado.grupo.faixa_apoio === 'Contato frio',
  `no grupo, fala pouco → ${resultado.grupo.faixa_apoio} (${resultado.grupo.propensao}/100)`);
ok(resultado.morno.propensao > 0 && resultado.morno.propensao < resultado.forte.propensao,
  `só na agenda → ${resultado.morno.faixa_apoio} (${resultado.morno.propensao}/100)`);
ok(resultado.nada.faixa_apoio === 'Sem sinal',
  `número solto → ${resultado.nada.faixa_apoio} (${resultado.nada.propensao}/100)`);

console.log('\n2) Quem gerou atrito sai da lista');
ok(resultado.atrito.faixa_apoio === 'Não abordar',
  `mesmo com 12 mensagens → ${resultado.atrito.faixa_apoio}`);
ok(JSON.parse(resultado.atrito.motivos_apoio)[0].includes('atrito'),
  'o motivo fica registrado na ficha');

console.log('\n3) Funciona sem abaixo-assinado nenhum');
ok(resultado.forte.propensao >= 62,
  `o melhor contato chega a ${resultado.forte.propensao}/100 sem cadastro nenhum`);
const motivos = JSON.parse(resultado.forte.motivos_apoio);
ok(motivos.some((m) => m.includes('privado')), `motivo citado: "${motivos[0]}"`);
ok(motivos.some((m) => m.includes('agenda')), 'reconhece que está salva na agenda');
ok(!motivos.some((m) => m.includes('assinou')), 'não inventa cadastro que não existe');

console.log('\n4) Ordenação e painel');
ok(resultado.ranking[0].propensao === resultado.forte.propensao,
  'a lista ordenada por propensão traz o mais provável primeiro');
ok(resultado.panorama.apoio.some((a) => a.faixa === 'Provável apoiador'),
  'o panorama mostra a distribuição por propensão');
ok(resultado.panorama.na_agenda === 5, `contagem de contatos da agenda: ${resultado.panorama.na_agenda}`);
ok(resultado.panorama.origens.some((o) => o.origem === 'contato'),
  'separa quem veio da agenda de quem veio do grupo');

console.log('\n5) A fila de adição usa a classificação');
ok(resultado.fila[0].propensao >= (resultado.fila[1]?.propensao ?? 0),
  'a fila ordena pelo mais provável');
ok(!resultado.fila.some((p) => p.faixa_apoio === 'Não abordar'),
  'quem tem atrito nunca entra na fila de adição');
ok(resultado.filaProvavel.every((p) => p.faixa_apoio === 'Provável apoiador'),
  `filtro por faixa funciona (${resultado.filaProvavel.length} provável(is))`);

console.log('\n6) Amizade x lista de transmissão');
console.log(`     só recebe ${resultado.soRecebe.propensao} · troca positiva `
  + `${resultado.trocaBoa.propensao} · responde mal ${resultado.trocaRuim.propensao}`);
ok(resultado.trocaBoa.propensao > resultado.soRecebe.propensao,
  'quem conversa nos dois sentidos supera quem só recebe da campanha');
ok(resultado.trocaBoa.propensao > resultado.trocaRuim.propensao,
  'com o mesmo volume, tom positivo supera tom negativo');
ok(resultado.soRecebe.faixa_apoio !== 'Provável apoiador',
  '20 mensagens sem nenhuma resposta não viram "provável apoiador"');
ok(/dois sentidos/.test(String(resultado.trocaBoa.motivos_apoio)),
  'a ficha explica que a conversa é recíproca');

// No Windows o SQLite ainda segura os arquivos quando o processo termina.
// A pasta é descartável e é recriada no início do próximo teste.
try { rmSync(PASTA, { recursive: true, force: true }); } catch { /* fica para depois */ }

console.log(`\n${falhas ? `❌ ${falhas} verificação(ões) falharam` : '✅ Classificação funcionando, inclusive sem abaixo-assinado.'}\n`);
process.exit(falhas ? 1 : 0);
