// Coletar dados — gestão dos embaixadores pela linha de comando.
//
//   npm run embaixadores                                  -> rendimento de cada um
//   npm run embaixadores -- --criar "Luciana" --papel "Rede Lara Maria"
//   npm run embaixadores -- --links                        -> link e QR de cada um
//   npm run embaixadores -- --captadas 1                   -> pessoas que ela trouxe
//   npm run embaixadores -- --desativar 3 / --reativar 3
//   CAMPANHA=claudia npm run embaixadores
//
// O embaixador divulga o link/QR dele; quem entra preenche o formulário com
// consentimento e cai na base já atribuído. O sistema nunca lê a agenda nem as
// conversas de ninguém — ver o cabeçalho de src/embaixadores.js.

import './ambiente.js';
import { db, usarCampanha, getConfig } from './db.js';
import * as emb from './embaixadores.js';

const CAMPANHA = usarCampanha();

const arg = (nome) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : null;
};

/** Origem pública do servidor, para montar os links divulgáveis. */
function base() {
  const explicito = arg('base');
  if (explicito) return explicito.replace(/\/$/, '');
  for (const candidato of [getConfig('url_cadastro', null), process.env.URL_CADASTRO]) {
    if (!candidato) continue;
    try { return new URL(candidato).origin; } catch { /* valor inválido, tenta o próximo */ }
  }
  return `http://localhost:${process.env.PORT || 3333}`;
}

const linkDe = (codigo) => `${base()}/formulario/${CAMPANHA}?e=${codigo}`;

/** Avisa quando o endereço só funciona na máquina da equipe. */
function avisarBaseLocal() {
  if (!/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(base())) return;
  console.log(
    `\n  ⚠️  O endereço destes links é ${base()} — só abre nesta máquina.` +
    '\n      Mandado para a Luciana, não funciona. Configure o endereço público:' +
    `\n      URL_CADASTRO no .env, ou a config url_cadastro desta campanha.\n`
  );
}

function tabela() {
  const itens = emb.rendimento();
  const r = emb.resumoDaColeta();

  console.log(`\nColetar dados · campanha: ${CAMPANHA}\n`);
  if (!itens.length) {
    console.log('  Nenhum embaixador cadastrado ainda.\n');
    console.log('  Comece por:  npm run embaixadores -- --criar "Luciana" --papel "Rede Lara Maria"\n');
    return itens;
  }

  console.log('  id  embaixador            captadas  7d  prováveis  possíveis  em grupo  propensão');
  console.log('  ' + '-'.repeat(88));
  for (const e of itens) {
    const nome = `${e.nome}${e.ativo ? '' : ' (inativo)'}`.slice(0, 20);
    console.log(
      `  ${String(e.id).padStart(3)}  ${nome.padEnd(20)} ${String(e.captadas).padStart(8)}` +
      ` ${String(e.captadas_7d).padStart(3)} ${String(e.provaveis).padStart(10)}` +
      ` ${String(e.possiveis).padStart(10)} ${String(e.em_grupo).padStart(9)}` +
      ` ${String(e.propensao_media ?? '—').padStart(10)}`
    );
  }
  console.log(
    `\n  ${r.captadas} pessoas captadas por indicação (${r.captadas_7d} nos últimos 7 dias).` +
    `\n  ${r.prontas_para_tratamento} com potencial de apoio e ainda fora de grupo da campanha` +
    ' — é esta a fila de tratamento.\n'
  );
  return itens;
}

// ------------------------------------------------------------------ criar
const NOME = arg('criar');
if (NOME) {
  const criado = emb.criar({ nome: NOME, papel: arg('papel'), telefone: arg('telefone') });
  console.log(`\n✅ Embaixador criado: ${criado.nome}${criado.papel ? ` · ${criado.papel}` : ''}`);
  console.log(`   código: ${criado.codigo}`);
  console.log(`   link:   ${linkDe(criado.codigo)}`);
  const wa = emb.linkWhatsapp(criado.codigo, getConfig('whatsapp_telefone', null));
  if (wa) console.log(`   whats: ${wa}`);
  console.log('\n   Mande o link (ou o QR) para ela divulgar na rede dela. Quem abrir');
  console.log('   preenche o formulário — ou chama no WhatsApp — e entra na base já');
  console.log('   atribuído a ela.');
  console.log('\n   O QR é de endereço: lê-se com a câmera do celular, NÃO em');
  console.log('   "WhatsApp → Dispositivos conectados".');
  avisarBaseLocal();
  tabela();
  process.exit(0);
}

// ---------------------------------------------------- ativar / desativar
const DESATIVAR = arg('desativar');
const REATIVAR = arg('reativar');
if (DESATIVAR || REATIVAR) {
  const id = Number(DESATIVAR || REATIVAR);
  if (!emb.porId(id)) {
    console.error(`\n❌ Não existe embaixador com id ${id} nesta campanha.\n`);
    process.exit(1);
  }
  const r = emb.definirAtivo(id, Boolean(REATIVAR));
  console.log(`\n✅ ${r.nome} agora está ${r.ativo ? 'ATIVO' : 'inativo'}.`);
  if (!r.ativo) {
    console.log('   O link dele para de atribuir novas pessoas. Quem já foi captado continua na base.');
  }
  tabela();
  process.exit(0);
}

// ------------------------------------------------------------- captadas
const CAPTADAS = arg('captadas');
if (CAPTADAS) {
  const e = emb.porId(Number(CAPTADAS));
  if (!e) {
    console.error(`\n❌ Não existe embaixador com id ${CAPTADAS}.\n`);
    process.exit(1);
  }
  const lista = emb.captadasDe(e.id);
  console.log(`\nPessoas captadas por ${e.nome} · ${lista.length}\n`);
  console.log('  propensão  faixa                 grupo  pessoa');
  console.log('  ' + '-'.repeat(76));
  for (const p of lista) {
    console.log(
      `  ${String(p.propensao ?? '—').padStart(9)}  ${String(p.faixa_apoio || '—').padEnd(20)}` +
      ` ${p.grupos_campanha ? '  sim' : '  não'}  ${p.nome || p.nome_wa || p.telefone}` +
      `${p.opt_out ? ' · OPT-OUT' : ''}`
    );
  }
  console.log('');
  process.exit(0);
}

// ----------------------------------------------------------------- links
if (process.argv.includes('--links')) {
  const itens = emb.listar();
  const telefone = getConfig('whatsapp_telefone', null);

  console.log(`\nLinks de captação · campanha: ${CAMPANHA}\n`);
  console.log('  ATENÇÃO: os QR abaixo são de ENDEREÇO, não de pareamento do WhatsApp.');
  console.log('  Lidos em "WhatsApp → Dispositivos conectados" dão "QR code inválido".');
  console.log('  Use a câmera do celular. O QR que conecta a campanha está na aba WhatsApp.\n');

  for (const e of itens) {
    console.log(`  ${e.nome}${e.ativo ? '' : ' (inativo)'}`);
    console.log(`    formulário: ${linkDe(e.codigo)}`);
    console.log(`    QR:         ${base()}/api/qr?texto=${encodeURIComponent(linkDe(e.codigo))}`);
    const wa = emb.linkWhatsapp(e.codigo, telefone);
    if (wa) {
      console.log(`    whatsapp:   ${wa}`);
      console.log(`    QR:         ${base()}/api/qr?texto=${encodeURIComponent(wa)}`);
    } else {
      console.log('    whatsapp:   (conecte o WhatsApp da campanha para gerar)');
    }
    console.log('');
  }
  if (!itens.length) console.log('  Nenhum embaixador cadastrado.\n');
  avisarBaseLocal();
  process.exit(0);
}

tabela();
console.log('  Criar:      npm run embaixadores -- --criar "Nome" --papel "Papel"');
console.log('  Links/QR:   npm run embaixadores -- --links');
console.log('  Detalhe:    npm run embaixadores -- --captadas <id>\n');
process.exit(0);
