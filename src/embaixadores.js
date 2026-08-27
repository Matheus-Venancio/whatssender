// Coletar dados — captação por embaixador.
//
// O PROBLEMA REAL: a base tem 1007 pessoas, mas só ~148 estão em grupo da
// campanha. A Luciana (Rede Lara Maria), a Lucilene e o Cadima têm alcance de
// verdade e querem ajudar a mapear apoiador. Como transformar esse alcance em
// base própria da campanha?
//
// O QUE ESTE MÓDULO FAZ: dá a cada embaixador um código, um link e um QR Code
// próprios. Ele divulga para a rede dele; quem quiser entrar abre o link,
// preenche o formulário (que já pede consentimento explícito) e cai na base da
// Cláudia já atribuído a quem trouxe. O motor de potencial de apoio que já
// existe (`scoring.js` → propensao / faixa_apoio) roda em cima disso sozinho.
//
// O QUE ESTE MÓDULO NÃO FAZ, DE PROPÓSITO: ler a agenda de contatos ou as
// conversas do embaixador. Pareado por QR, o WhatsApp entrega a lista de
// contatos e o histórico — e é tentador, porque resolveria a base num dia. Não
// dá para fazer:
//
//   · as pessoas da agenda da Luciana nunca deram dado nenhum à campanha. Entrar
//     numa base política com finalidade de abordagem exige base legal, e não há
//     nenhuma aqui (LGPD art. 7 e 11 — preferência política é dado sensível);
//   · a Luciana pode consentir pela conta DELA, nunca pelas centenas de pessoas
//     que escreveram para ela. Conversa privada é dado de terceiro;
//   · a Rede Lara Maria é rede de mães de vítimas. Estar naquela lista já revela
//     dado sensível. Se vazar que a lista virou base de campanha, o estrago cai
//     na Luciana e na Lucilene — que são o ativo de credibilidade da candidatura;
//   · operacionalmente é o caminho mais curto para "quem é você, onde conseguiu
//     meu número" — o sinal crítico que o `risco.js` já monitora — e para a
//     denúncia por disparo em massa a lista de terceiro.
//
// A captação por link/QR chega no mesmo lugar (base própria, atribuída, com
// potencial de apoio calculado) sem nenhum desses riscos.

import { randomBytes } from 'node:crypto';
import { db, agora } from './db.js';

const semAcento = (t) => String(t || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Código curto e legível: pedaço do nome + sufixo aleatório.
 * O sufixo existe para o código não ser adivinhável — sem ele, qualquer pessoa
 * escreveria `?e=lucilene` e sujaria a atribuição de quem captou o quê.
 */
function gerarCodigo(nome) {
  const base = semAcento(nome).split('-').filter(Boolean).slice(0, 2).join('-').slice(0, 18) || 'emb';
  for (let tentativa = 0; tentativa < 20; tentativa++) {
    const codigo = `${base}-${randomBytes(2).toString('hex')}`;
    if (!db.prepare('SELECT 1 FROM embaixadores WHERE codigo = ?').get(codigo)) return codigo;
  }
  return `emb-${randomBytes(6).toString('hex')}`;
}

export function criar({ nome, papel = null, telefone = null }) {
  const limpo = String(nome || '').trim();
  if (limpo.length < 2) throw new Error('Informe o nome do embaixador');

  const tel = telefone ? String(telefone).replace(/\D/g, '') : null;
  const codigo = gerarCodigo(limpo);
  const r = db.prepare(
    `INSERT INTO embaixadores (codigo, nome, papel, telefone, criado_em)
     VALUES (?, ?, ?, ?, ?)`
  ).run(codigo, limpo, papel?.trim() || null, tel && tel.length >= 10 ? tel : null, agora());
  return db.prepare('SELECT * FROM embaixadores WHERE id = ?').get(Number(r.lastInsertRowid));
}

export const porCodigo = (codigo) =>
  db.prepare('SELECT * FROM embaixadores WHERE codigo = ?').get(String(codigo || '').trim()) ?? null;

export const porId = (id) =>
  db.prepare('SELECT * FROM embaixadores WHERE id = ?').get(Number(id)) ?? null;

export const listar = ({ apenasAtivos = false } = {}) =>
  db.prepare(
    `SELECT * FROM embaixadores ${apenasAtivos ? 'WHERE ativo = 1' : ''} ORDER BY ativo DESC, nome`
  ).all();

export function definirAtivo(id, ativo) {
  db.prepare('UPDATE embaixadores SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, Number(id));
  return porId(id);
}

export function renomear(id, { nome = null, papel = null, telefone = null }) {
  const atual = porId(id);
  if (!atual) throw new Error('Embaixador não encontrado');
  const tel = telefone ? String(telefone).replace(/\D/g, '') : atual.telefone;
  db.prepare('UPDATE embaixadores SET nome = ?, papel = ?, telefone = ? WHERE id = ?')
    .run(nome?.trim() || atual.nome, papel?.trim() ?? atual.papel, tel, Number(id));
  return porId(id);
}

/**
 * Atribui a pessoa ao embaixador que a trouxe.
 *
 * A primeira atribuição vale: se a pessoa voltar por outro link depois, ela
 * continua contando para quem a captou primeiro. Sem essa regra, o último link
 * clicado roubaria o crédito e o relatório de captação viraria ficção.
 */
export function registrarIndicacao(pessoaId, codigo, ts = agora()) {
  if (!codigo) return null;
  const emb = porCodigo(codigo);
  if (!emb || !emb.ativo) return null;

  const pessoa = db.prepare('SELECT indicado_por FROM pessoas WHERE id = ?').get(pessoaId);
  if (!pessoa) return null;
  if (pessoa.indicado_por) return porId(pessoa.indicado_por);

  db.prepare('UPDATE pessoas SET indicado_por = ?, indicado_em = ? WHERE id = ?')
    .run(emb.id, ts, pessoaId);
  return emb;
}

// ---------------------------------------------------------------------------
// Captação pelo WhatsApp
//
// O QR do formulário é um QR de ENDEREÇO (abre uma página). Não é, e não pode
// ser, o QR de pareamento do WhatsApp — ler ele em "Dispositivos conectados"
// devolve "QR code inválido", porque aquele leitor só aceita o payload de
// pareamento do próprio WhatsApp.
//
// Mas existe um jeito legítimo de a captação acontecer dentro do WhatsApp: um
// link wa.me que abre a conversa com o número da campanha já com a mensagem
// escrita. A pessoa envia, e a conversa nasce com ELA iniciando o contato —
// que é o único formato em que abordar por WhatsApp não é disparo a lista de
// terceiro. A mensagem carrega o código de quem indicou, e a atribuição sai daí.
// ---------------------------------------------------------------------------

const MARCA_INDICACAO = /indica[cç][aã]o:\s*([a-z0-9][a-z0-9-]{2,46})/i;

/** Texto sugerido da primeira mensagem, com o código de quem indicou. */
export function textoDeAbertura(codigo, candidata = null) {
  const nome = String(candidata || process.env.CANDIDATA || 'a nossa candidata').trim();
  return `Olá! Quero somar com ${nome} e receber as informações da campanha. (indicação: ${codigo})`;
}

/** Link wa.me que abre a conversa com o número da campanha já com o texto. */
export function linkWhatsapp(codigo, telefoneDaCampanha, candidata = null) {
  const numero = String(telefoneDaCampanha || '').replace(/\D/g, '');
  if (numero.length < 12) return null;   // sem número conectado não há para onde mandar
  return `https://wa.me/${numero}?text=${encodeURIComponent(textoDeAbertura(codigo, candidata))}`;
}

/** Extrai o código de indicação de um texto de mensagem, se houver. */
export const codigoNaMensagem = (texto) => MARCA_INDICACAO.exec(String(texto || ''))?.[1] ?? null;

/**
 * Atribui a pessoa a partir da primeira mensagem que ela mandou no WhatsApp.
 * Chamado pelo whatsapp.js quando a conversa privada começa.
 */
export function atribuirPorMensagem(pessoaId, texto, ts = agora()) {
  const codigo = codigoNaMensagem(texto);
  if (!codigo) return null;
  return registrarIndicacao(pessoaId, codigo, ts);
}

/** Links públicos do embaixador. `base` sem barra no fim. */
export function linksDe(codigo, base = '') {
  const raiz = String(base || '').replace(/\/$/, '');
  return {
    formulario: `${raiz}/formulario/{slug}?e=${codigo}`,
    cadastro: `${raiz}/cadastro/{slug}?e=${codigo}`
  };
}

// ---------------------------------------------------------------------------
// Kit de divulgação
//
// O gargalo da captação por embaixador não é o link — é a pergunta "o que eu
// escrevo?". A Luciana tem alcance, boa vontade e nenhum texto pronto; cada dia
// que ela passa sem postar é alcance que não virou base. O kit resolve isso: a
// mensagem sai pronta, na voz DELA (não na voz da campanha, que soa a panfleto),
// com o link já dentro.
//
// A regra de tom é a mesma fixada para a campanha: técnico antes de emocional,
// sem polarização, sem prometer nada em nome da candidata, sem citar caso real de
// ninguém. Embaixador falando demais cria passivo que a campanha não controla.
// ---------------------------------------------------------------------------

/**
 * Textos prontos para o embaixador divulgar, com o link dele já embutido.
 *
 * `canal` diz onde cada peça se usa; o painel monta um botão de copiar por canal.
 * Nada aqui cita número de urna de propósito — número errado em peça divulgada não
 * tem como ser recolhido, e quem confirma isso é o jurídico, não este código.
 */
export function kitDeDivulgacao(embaixador, { link, linkWhatsapp = null, candidata, cargo = null } = {}) {
  const e = typeof embaixador === 'object' ? embaixador : porId(embaixador);
  if (!e) throw new Error('Embaixador não encontrado');
  if (!link) throw new Error('Informe o link de captação');

  const quem = String(candidata || 'a nossa candidata').trim();
  const oCargo = cargo ? ` (${cargo})` : '';
  const papel = e.papel ? ` do ${e.papel}` : '';
  const primeiro = e.nome.trim().split(/\s+/)[0];

  const pecas = [
    {
      canal: 'story',
      titulo: 'Story / Status do WhatsApp',
      dica: 'Curto, com o link colável. Poste com uma foto sua ou do trabalho da rede.',
      texto:
        'Você que é mãe, pai, professora ou trabalha com criança: estou reunindo ' +
        'quem quer proteção de verdade para criança e adolescente em São Paulo.\n\n' +
        `Deixa seu nome aqui que eu te incluo:\n${link}`
    },
    {
      canal: 'grupo',
      titulo: 'Grupo de WhatsApp',
      dica: 'O que mais converte. Explique por que VOCÊ está pedindo — é o seu nome que dá peso.',
      texto:
        'Pessoal, um pedido pessoal.\n\n' +
        `Estou apoiando ${quem}${oCargo} porque ela trabalha com proteção de criança e ` +
        'adolescente há anos, e não só em ano de eleição. Estamos montando uma rede de ' +
        'quem quer acompanhar esse trabalho de perto.\n\n' +
        `Se você quer participar, é só deixar seu nome aqui — leva um minuto:\n${link}\n\n` +
        'Quem entrar recebe as informações direto, sem intermediário. Quem não quiser, ' +
        'sem problema nenhum. Obrigada!'
    },
    {
      canal: 'direta',
      titulo: 'Mensagem individual (para quem você escolher)',
      dica: 'Use com quem você conhece e acha que tem a ver. Você escolhe a pessoa e manda ' +
        'do seu celular — é assim que tem de ser.',
      texto:
        'Oi! Tudo bem?\n\n' +
        'Lembrei de você. Estou reunindo pessoas que se importam com proteção de criança ' +
        `e adolescente, para acompanhar o trabalho da ${quem}.\n\n` +
        `Se fizer sentido para você, deixa seu nome aqui: ${link}\n\n` +
        'Se não for o seu momento, ignora tranquilo — não fico chateada 🙏'
    },
    {
      canal: 'post',
      titulo: 'Legenda de post (Instagram / Facebook)',
      dica: 'Coloque o link nos stories e na bio: o Instagram não deixa link clicável na legenda.',
      texto:
        'Muita gente me pergunta o que dá para fazer, além de se indignar.\n\n' +
        'Dá para se organizar. Estou reunindo quem quer proteção real para criança e ' +
        'adolescente em São Paulo — mães, pais, professores, profissionais de saúde, ' +
        'conselho tutelar. Gente que vive isso na prática.\n\n' +
        'O link está nos stories e na bio. Um minuto para preencher.\n\n' +
        `(link para colar na bio: ${link})`
    },
    {
      canal: 'evento',
      titulo: 'Fala de 20 segundos em evento (com o QR na mão)',
      dica: 'Imprima o QR em A5. Fale isso e mostre — funciona melhor que qualquer panfleto.',
      texto:
        'Antes de eu sair: quem quiser acompanhar esse trabalho de perto, aponta a câmera ' +
        'do celular nesse código aqui. Você põe seu nome, sua cidade e o que te preocupa ' +
        'mais, e passa a receber as informações direto. Não é lista de propaganda: é para ' +
        'a gente saber quem está junto e no que cada um pode ajudar.'
    }
  ];

  if (linkWhatsapp) {
    pecas.push({
      canal: 'whatsapp',
      titulo: 'Para quem prefere só chamar no WhatsApp',
      dica: 'Abre a conversa com a campanha já com a mensagem escrita. A pessoa só envia.',
      texto: `Se preferir falar direto com a equipe da ${quem}, é por aqui:\n${linkWhatsapp}`
    });
  }

  return {
    embaixador: { id: e.id, nome: e.nome, papel: e.papel, codigo: e.codigo },
    assinatura: `${primeiro}${papel}`,
    regras: [
      'Fale na sua voz, não na voz da campanha — é o seu nome que dá credibilidade.',
      'Não prometa nada em nome da candidata (vaga, emprego, benefício, atendimento).',
      'Não cite caso real de criança, nem nome de vítima, nem processo em andamento.',
      'Se citar número, diga de onde veio.',
      'Quem disser que não quer: agradeça e encerre. Insistir é o que gera denúncia.',
      'Não copie a agenda de ninguém — quem entra é quem abriu o link e quis entrar.'
    ],
    pecas
  };
}

/**
 * Quanto cada embaixador trouxe, e com que qualidade.
 *
 * Volume sozinho engana: 200 contatos frios não valem 20 prováveis apoiadores.
 * Por isso o relatório traz a quebra por faixa de potencial de apoio (a mesma do
 * `scoring.js`) e quantos já entraram em grupo da campanha — que é o passo em
 * que a captação vira audiência de verdade.
 */
export function rendimento() {
  return db.prepare(`
    SELECT e.id, e.codigo, e.nome, e.papel, e.ativo, e.criado_em,
           (SELECT COUNT(*) FROM pessoas p WHERE p.indicado_por = e.id) AS captadas,
           (SELECT COUNT(*) FROM pessoas p WHERE p.indicado_por = e.id AND p.cadastro_em IS NOT NULL) AS com_ficha,
           (SELECT COUNT(*) FROM pessoas p WHERE p.indicado_por = e.id
              AND p.indicado_em >= ?) AS captadas_7d,
           (SELECT COUNT(*) FROM pessoas p JOIN perfil f ON f.pessoa_id = p.id
             WHERE p.indicado_por = e.id AND f.faixa_apoio = 'Provável apoiador') AS provaveis,
           (SELECT COUNT(*) FROM pessoas p JOIN perfil f ON f.pessoa_id = p.id
             WHERE p.indicado_por = e.id AND f.faixa_apoio = 'Possível apoiador') AS possiveis,
           (SELECT COUNT(*) FROM pessoas p JOIN perfil f ON f.pessoa_id = p.id
             WHERE p.indicado_por = e.id AND f.faixa_apoio = 'Contato frio') AS frios,
           (SELECT ROUND(AVG(f.propensao), 1) FROM pessoas p JOIN perfil f ON f.pessoa_id = p.id
             WHERE p.indicado_por = e.id) AS propensao_media,
           (SELECT COUNT(DISTINCT p.id) FROM pessoas p
              JOIN membros m ON m.pessoa_id = p.id AND m.saiu_em IS NULL
              JOIN grupos g ON g.id = m.grupo_id AND g.da_campanha = 1
             WHERE p.indicado_por = e.id) AS em_grupo
      FROM embaixadores e
     ORDER BY captadas DESC, e.nome
  `).all(agora() - 7 * 24 * 60 * 60 * 1000);
}

/** Total da captação por indicação, para o painel. */
export function resumoDaColeta() {
  const n = (sql, ...p) => db.prepare(sql).get(...p)?.n ?? 0;
  return {
    embaixadores: n('SELECT COUNT(*) AS n FROM embaixadores WHERE ativo = 1'),
    captadas: n('SELECT COUNT(*) AS n FROM pessoas WHERE indicado_por IS NOT NULL'),
    captadas_7d: n('SELECT COUNT(*) AS n FROM pessoas WHERE indicado_por IS NOT NULL AND indicado_em >= ?',
      agora() - 7 * 24 * 60 * 60 * 1000),
    prontas_para_tratamento: n(`
      SELECT COUNT(*) AS n FROM pessoas p JOIN perfil f ON f.pessoa_id = p.id
       WHERE p.indicado_por IS NOT NULL
         AND f.faixa_apoio IN ('Provável apoiador', 'Possível apoiador')
         AND p.opt_out = 0
         AND NOT EXISTS (SELECT 1 FROM membros m JOIN grupos g ON g.id = m.grupo_id
                          WHERE m.pessoa_id = p.id AND m.saiu_em IS NULL AND g.da_campanha = 1)`)
  };
}

/** Pessoas de um embaixador, para conferência e para a fila de ação. */
export function captadasDe(embaixadorId, { limite = 200 } = {}) {
  return db.prepare(`
    SELECT p.id, p.nome, p.nome_wa, p.telefone, p.cidade, p.uf, p.atuacao,
           p.indicado_em, p.cadastro_em, p.opt_out,
           f.propensao, f.faixa_apoio,
           (SELECT COUNT(*) FROM membros m JOIN grupos g ON g.id = m.grupo_id
             WHERE m.pessoa_id = p.id AND m.saiu_em IS NULL AND g.da_campanha = 1) AS grupos_campanha
      FROM pessoas p LEFT JOIN perfil f ON f.pessoa_id = p.id
     WHERE p.indicado_por = ?
     ORDER BY COALESCE(f.propensao, 0) DESC, p.indicado_em DESC
     LIMIT ?
  `).all(Number(embaixadorId), Number(limite));
}
