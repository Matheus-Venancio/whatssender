// Testa a importação de CSV de lead do Meta, em qualquer formato que ele exporte.
//
//   node --no-warnings=ExperimentalWarning src/teste-importacao.js
//
// POR QUE ISTO MERECE TESTE PRÓPRIO: o Gerenciador de Anúncios não exporta um
// formato só. O MESMO abaixo-assinado sai ora em UTF-8 com vírgula, ora em
// UTF-16LE com TAB. Um arquivo UTF-16 lido como UTF-8 não estoura erro nenhum:
// vira uma linha só com bytes nulos, o parser aceita, e a importação "funciona"
// gravando lixo. É a pior classe de bug para base de campanha: silenciosa, e só
// descoberta quando alguém tenta falar com a pessoa.

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = join(process.cwd(), 'data-teste-importacao');
process.env.DATA_DIR = PASTA;
rmSync(PASTA, { recursive: true, force: true });
mkdirSync(join(PASTA, 'campanhas'), { recursive: true });

const { db, comCampanha } = await import('./db.js');
const contas = await import('./contas.js');
const { lerCsv, decodificarCsv, detectarDelimitador } = await import('./leads.js');
const { importarConteudo, importarEnviados } = await import('./importar-leads.js');

let falhas = 0;
const ok = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas++;
};

const SLUG = 'importacao-teste';
contas.criarCampanha({ nome: 'Teste Importacao', slug: SLUG });

const COLUNAS = ['id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name',
  'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform',
  'você_atua_como:', 'qual_sua_cidade?', 'full_name', 'whatsapp_number'];

const linhaDe = (i, cidade, nome, telefone) => [
  `l:90000000000000${i}`, '2026-08-07T10:28:48-03:00', 'ag:1', 'Escolas',
  'as:1', 'SP - ESTADO', 'c:1', 'ABAIXO #1', 'f:1024024180552028',
  '"Pelo fim da violencia nas escolas"', 'false', 'fb',
  'apoiador_da_causa', `"${cidade}"`, `"${nome}"`, telefone
];

const montar = (linhas, delim) =>
  [COLUNAS.join(delim), ...linhas.map((l) => l.join(delim))].join('\r\n');

const LINHAS = [
  linhaDe(1, 'São Paulo', 'watfa Daychoum', '+5511976143221'),
  linhaDe(2, 'Taboao da Serra', 'Barbara Santos', '+5511949463504'),
  linhaDe(3, 'Campinas', 'MARIA DA SILVA', '+55 19 99999-1234')
];

// UTF-16LE com BOM e TAB: o que o Meta mandou desta vez.
const utf16Tab = Buffer.concat([
  Buffer.from([0xFF, 0xFE]),
  Buffer.from(montar(LINHAS, '\t'), 'utf16le')
]);
// UTF-8 com virgula: o formato dos arquivos que ja estavam na base.
const utf8Virgula = Buffer.from(montar(LINHAS, ','), 'utf8');

console.log('\nImportacao de CSV do Meta\n');
console.log('1) Descobrir a codificacao pelo proprio arquivo');

ok(decodificarCsv(utf16Tab).startsWith('id\t'), 'UTF-16LE com BOM e decodificado');
ok(decodificarCsv(utf8Virgula).startsWith('id,'), 'UTF-8 continua funcionando');
ok([...decodificarCsv(utf16Tab)].every((c) => c.charCodeAt(0) !== 0),
  'nenhum byte nulo sobrevive a decodificacao');

const utf8ComBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8Virgula]);
ok(decodificarCsv(utf8ComBom).startsWith('id,'), 'BOM de UTF-8 e removido');

const utf16SemBom = Buffer.from(montar(LINHAS, '\t'), 'utf16le');
ok(decodificarCsv(utf16SemBom).startsWith('id\t'),
  'UTF-16 sem BOM e reconhecido pelos bytes nulos');

console.log('\n2) Descobrir o delimitador');
ok(detectarDelimitador('a\tb\tc') === '\t', 'TAB');
ok(detectarDelimitador('a,b,c') === ',', 'virgula');
ok(detectarDelimitador('a;b;c') === ';', 'ponto e virgula');
// O caso que quebra quem conta o arquivo inteiro em vez do cabecalho.
ok(detectarDelimitador('id\tnome\tcidade\n1\t"Silva, Maria"\t"Sao Paulo, SP"') === '\t',
  'virgula dentro do dado nao engana a deteccao');

console.log('\n3) Ler as linhas');
const doTab = lerCsv(utf16Tab);
const daVirgula = lerCsv(utf8Virgula);
ok(doTab.length === 3, `UTF-16/TAB: ${doTab.length} linhas`);
ok(daVirgula.length === 3, `UTF-8/virgula: ${daVirgula.length} linhas`);
ok(doTab[0].full_name === 'watfa Daychoum', 'nome sai sem as aspas');
ok(doTab[0]['qual_sua_cidade?'] === 'São Paulo', 'acento preservado na cidade');
ok(doTab[0].whatsapp_number === '+5511976143221', 'telefone integro');
ok(JSON.stringify(doTab) === JSON.stringify(daVirgula),
  'os dois formatos produzem exatamente o mesmo resultado');

console.log('\n4) Importar para a base');
const r1 = comCampanha(SLUG, () => importarConteudo(utf16Tab, 'meta-utf16.csv'));
ok(r1.importados === 3, `${r1.importados} assinaturas importadas`);
ok(r1.novos === 3, `${r1.novos} pessoas novas`);
ok(r1.invalidos === 0, 'nenhuma linha invalida');

const gravadas = comCampanha(SLUG, () => db.prepare(
  'SELECT telefone, nome, cidade, uf FROM pessoas ORDER BY telefone'
).all());
ok(gravadas.length === 3, 'tres pessoas na base');
ok(gravadas.every((p) => /^55\d{10,11}$/.test(p.telefone)),
  `telefones normalizados: ${gravadas.map((p) => p.telefone).join(', ')}`);
ok(gravadas.some((p) => p.nome === 'Maria da Silva'),
  'CAIXA ALTA vira nome proprio, com a particula em minuscula');
ok(gravadas.every((p) => p.uf === 'SP'), 'UF deduzida pelo DDD');
ok(gravadas.some((p) => p.cidade === 'São Paulo'), 'cidade com acento preservada');

console.log('\n5) Subir o mesmo arquivo de novo');
const r2 = comCampanha(SLUG, () => importarConteudo(utf16Tab, 'meta-utf16.csv'));
ok(r2.importados === 0, 'nada e importado de novo');
ok(r2.repetidos === 3, `${r2.repetidos} assinaturas reconhecidas como repetidas`);

const contar = () => comCampanha(SLUG, () =>
  db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n);
ok(contar() === 3, 'a base continua com tres pessoas');

// O mesmo lead exportado no OUTRO formato tambem nao pode duplicar.
const r3 = comCampanha(SLUG, () => importarConteudo(utf8Virgula, 'meta-utf8.csv'));
ok(r3.repetidos === 3, 'o mesmo lead em UTF-8 tambem e reconhecido');
ok(contar() === 3, 'ainda tres pessoas');

console.log('\n6) Upload pela tela');
const novo = Buffer.concat([
  Buffer.from([0xFF, 0xFE]),
  Buffer.from(montar([linhaDe(4, 'Sorocaba', 'Joana Prado', '+5515988887777')], '\t'), 'utf16le')
]);
const up = comCampanha(SLUG, () => importarEnviados([
  { nome: 'novo lote.csv', conteudo: novo.toString('base64') }
]));
ok(up.total.novos === 1, 'o upload em base64 importa a pessoa nova');
ok(up.arquivos[0].arquivo === 'novo lote.csv', 'o resumo diz de qual arquivo veio');
ok(typeof up.espelhado === 'boolean',
  'o resultado diz se foi espelhado no Firebase');

const vazio = comCampanha(SLUG, () => importarEnviados([]));
ok(Boolean(vazio.erro), 'upload sem arquivo devolve erro, nao estouro');

// Nome de arquivo e texto de terceiro: nao pode virar caminho.
const travessia = comCampanha(SLUG, () => importarEnviados([
  { nome: '../../../fora.csv', conteudo: novo.toString('base64') }
]));
ok(!travessia.erro, 'nome hostil nao derruba a importacao');
ok(contar() === 4, 'e a base segue coerente: quatro pessoas');

console.log('\n7) Arquivo que nao e lead');
const lixo = comCampanha(SLUG, () => importarConteudo(
  Buffer.from('coluna_a,coluna_b\n1,2\n', 'utf8'), 'planilha-errada.csv'));
ok(lixo.importados === 0, 'nada e importado de uma planilha sem telefone');
ok(lixo.invalidos === 1, 'a linha e contada como invalida, e o painel mostra isso');

rmSync(PASTA, { recursive: true, force: true });
console.log(`\n${falhas ? `❌ ${falhas} verificacao(oes) falharam` : '✅ Importacao de CSV funcionando em UTF-8 e UTF-16, virgula e TAB.'}\n`);
process.exit(falhas ? 1 : 0);
