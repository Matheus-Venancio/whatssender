// Leitura de conversa: sentimento, resumo e sugestões de resposta.
//
// Não há IA aqui — é um motor de regras sobre o que o sistema já sabe da
// pessoa (cadastro, grupos, temas, assinaturas) somado ao que ela acabou de
// escrever. A vantagem: roda offline, é auditável e a equipe consegue editar
// os textos sem depender de ninguém.

import { db, agora, getConfig } from './db.js';
import { normalizar, TEMAS } from './lexicon.js';
import { detectarRisco } from './risco.js';
import { formatarTelefone } from './ingest.js';

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const construir = (termos) => new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${termos.map((t) => escapar(normalizar(t))).join('|')})(?![\\p{L}\\p{N}])`, 'u'
);

// ---------------------------------------------------------------- sentimento
const POSITIVO = construir([
  'obrigada', 'obrigado', 'obrigadaa', 'valeu', 'gratidao', 'grata', 'grato',
  'adorei', 'amei', 'maravilhoso', 'maravilhosa', 'otimo', 'otima', 'excelente',
  'parabens', 'deus abencoe', 'abencoada', 'abencoado', 'que bom', 'perfeito',
  'show', 'top', 'sucesso', 'orgulho', 'lindo', 'linda', 'emocionante',
  'ajudou muito', 'esperanca', 'apoio', 'apoiando', 'estou com voces', 'conta comigo',
  'que noticia boa', 'fico feliz', 'muito bom', 'amo', 'bacana', 'legal'
]);

const NEGATIVO = construir([
  'triste', 'decepcionado', 'decepcionada', 'decepcao', 'revoltado', 'revoltada',
  'indignado', 'indignada', 'cansado', 'cansada', 'pessimo', 'pessima', 'horrivel',
  'nada muda', 'nao adianta', 'desanimado', 'desanimada', 'sem esperanca',
  'abandonado', 'abandonada', 'descaso', 'humilhante', 'injusto', 'injustica',
  'sofrendo', 'sofre', 'sofri', 'angustia', 'desesperada', 'desesperado', 'nao aguento',
  'ninguem faz nada', 'ninguem resolve', 'ninguem ajuda', 'ja procurei', 'ja pedi',
  'bullying', 'violencia', 'agressao', 'ameaca', 'ameacado', 'ameacada',
  'medo', 'chorando', 'chorei', 'doente', 'internado', 'internada', 'faleceu',
  'sem dinheiro', 'passando fome', 'despejo', 'demitido', 'demitida'
]);

/**
 * positivo | neutro | negativo | critico
 *
 * Pedido de ajuda conta como negativo mesmo sem palavra "triste": quem chama
 * a campanha para resolver um problema não está num momento neutro.
 */
export function analisarSentimento(texto) {
  const t = normalizar(texto);
  if (!t) return 'neutro';
  if (detectarRisco(texto)?.gravidade === 'critico') return 'critico';

  const bom = POSITIVO.test(t);
  const ruim = NEGATIVO.test(t) || Boolean(detectarRisco(texto)) || PADROES.demanda.test(t);

  if (bom && !ruim) return 'positivo';
  if (ruim && !bom) return 'negativo';
  if (ruim && bom) return 'negativo';   // "obrigada, mas preciso muito de ajuda"
  return 'neutro';
}

export const CORES_SENTIMENTO = {
  positivo: '#16a34a', neutro: '#94a3b8', negativo: '#f59e0b', critico: '#dc2626'
};

export const ROTULOS_SENTIMENTO = {
  positivo: 'Positivo', neutro: 'Neutro', negativo: 'Negativo', critico: 'Crítico'
};

// ------------------------------------------------------------------ intenção
const PADROES = {
  saudacao: construir(['bom dia', 'boa tarde', 'boa noite', 'ola', 'oi', 'oie', 'opa', 'e ai']),
  agradecimento: construir(['obrigada', 'obrigado', 'valeu', 'gratidao', 'agradeco', 'grata', 'grato']),
  voluntario: construir([
    'quero ajudar', 'posso ajudar', 'conta comigo', 'to dentro', 'tou dentro',
    'quero participar', 'quero fazer parte', 'me coloco a disposicao', 'como faco para ajudar',
    'quero ser voluntario', 'quero ser voluntaria', 'to junto', 'me chama'
  ]),
  demanda: construir([
    'preciso de ajuda', 'preciso muito', 'to precisando', 'me ajuda', 'me ajude',
    'como faco', 'como consigo', 'onde consigo', 'nao consigo', 'nao sei o que fazer',
    'socorro', 'urgente', 'estou desesperada', 'estou desesperado', 'pode me ajudar'
  ]),
  evento: construir([
    'que horas', 'onde vai ser', 'qual endereco', 'tem evento', 'vai ter reuniao',
    'quando vai ser', 'confirmo presenca', 'posso ir', 'quero ir'
  ]),
  doacao: construir(['quero doar', 'como doar', 'posso doar', 'contribuir', 'ajudar financeiramente']),
  candidatura: construir([
    'vai se candidatar', 'e candidata', 'qual partido', 'qual numero', 'vai concorrer',
    'deputada', 'vereadora', 'campanha'
  ])
};

function detectarIntencoes(texto) {
  const t = normalizar(texto);
  const achadas = [];
  for (const [chave, regex] of Object.entries(PADROES)) if (regex.test(t)) achadas.push(chave);
  if (/\?\s*$/.test(String(texto).trim()) || /^(quem|qual|quando|onde|como|por que|porque|quanto)\b/.test(t)) {
    achadas.push('pergunta');
  }
  return achadas;
}

// ----------------------------------------------------------------- contexto
function contextoDaPessoa(pessoaId) {
  const p = db.prepare(`
    SELECT p.id, p.nome, p.nome_wa, p.telefone, p.cidade, p.uf, p.atuacao, p.cadastro_em,
           f.faixa, f.engajamento, f.tema_principal, f.msgs_total
      FROM pessoas p LEFT JOIN perfil f ON f.pessoa_id = p.id WHERE p.id = ?
  `).get(pessoaId);
  if (!p) return null;

  const grupos = db.prepare(`
    SELECT g.nome FROM membros m JOIN grupos g ON g.id = m.grupo_id
     WHERE m.pessoa_id = ? AND m.saiu_em IS NULL
  `).all(pessoaId).map((g) => g.nome);

  const assinaturas = db.prepare(`
    SELECT ab.titulo, ab.bandeira FROM assinaturas a JOIN abaixos ab ON ab.id = a.abaixo_id
     WHERE a.pessoa_id = ?
  `).all(pessoaId);

  const nomeCompleto = p.nome || p.nome_wa || '';
  return {
    ...p,
    nomeExibicao: nomeCompleto || formatarTelefone(p.telefone),
    primeiroNome: (nomeCompleto.trim().split(/\s+/)[0] || '').replace(/[^\p{L}]/gu, '') || null,
    grupos,
    assinaturas,
    cadastrada: Boolean(p.cadastro_em),
    temaRotulo: p.tema_principal ? TEMAS[p.tema_principal]?.rotulo?.toLowerCase() : null
  };
}

export function candidata() {
  return process.env.CANDIDATA?.trim() || getConfig('candidata', null);
}

// ------------------------------------------------------------------- resumo
/**
 * Lê a conversa privada e devolve o retrato dela: sentimento, o que a pessoa
 * quer, se está esperando resposta e há quanto tempo.
 */
export function lerConversa(pessoaId, limite = 40) {
  const ctx = contextoDaPessoa(pessoaId);
  if (!ctx) return null;

  const mensagens = db.prepare(`
    SELECT id, texto, tipo, ts, de_mim, sentimento, lida
      FROM mensagens WHERE pessoa_id = ? AND privada = 1
     ORDER BY ts DESC LIMIT ?
  `).all(pessoaId, limite).reverse();

  const dela = mensagens.filter((m) => !m.de_mim && m.texto);
  const ultima = mensagens.at(-1) ?? null;
  const ultimaDela = dela.at(-1) ?? null;

  // Sentimento da conversa: as mensagens recentes pesam mais.
  const recentes = dela.slice(-6);
  const contagem = { positivo: 0, neutro: 0, negativo: 0, critico: 0 };
  for (const m of recentes) contagem[m.sentimento || analisarSentimento(m.texto)]++;
  const sentimento = contagem.critico ? 'critico'
    : contagem.negativo > contagem.positivo ? 'negativo'
      : contagem.positivo > 0 ? 'positivo' : 'neutro';

  const intencoes = ultimaDela ? detectarIntencoes(ultimaDela.texto) : [];
  const risco = ultimaDela ? detectarRisco(ultimaDela.texto) : null;

  const aguardando = Boolean(ultima && !ultima.de_mim);
  const naoLidas = mensagens.filter((m) => !m.de_mim && !m.lida).length;

  return {
    pessoa: ctx,
    mensagens,
    total: db.prepare('SELECT COUNT(*) AS n FROM mensagens WHERE pessoa_id = ? AND privada = 1').get(pessoaId).n,
    sentimento,
    intencoes,
    risco: risco ? { categoria: risco.categoria, rotulo: risco.rotulo, acao: risco.acao, gravidade: risco.gravidade } : null,
    aguardando,
    naoLidas,
    esperandoHa: aguardando && ultima ? agora() - ultima.ts : null,
    ultimaMensagem: ultima,
    ultimaDela
  };
}

// -------------------------------------------------------------- sugestões
// Todos os modelos são escritos em minúscula. Com nome vira "Marlene, sinto muito…";
// sem nome, a primeira letra sobe: "Sinto muito…". Evita "Marlene! sinto muito".
const abrir = (ctx, frase) => {
  const f = String(frase).trim();
  return ctx.primeiroNome ? `${ctx.primeiroNome}, ${f}` : f.charAt(0).toUpperCase() + f.slice(1);
};

/**
 * Monta de 1 a 3 respostas prontas para a última mensagem da pessoa.
 * Cada sugestão diz também POR QUE foi sugerida — a equipe precisa entender,
 * não só copiar.
 */
export function sugerirRespostas(pessoaId) {
  const conversa = lerConversa(pessoaId);
  if (!conversa) return [];

  const { pessoa: ctx, intencoes, risco, sentimento } = conversa;
  const quem = candidata();
  const aEquipe = quem ? `a equipe de ${quem}` : 'a nossa equipe';
  const sugestoes = [];
  const add = (s) => { if (sugestoes.length < 3) sugestoes.push(s); };

  // --- 1. Risco vem antes de tudo -----------------------------------------
  if (risco?.categoria === 'ameaca_denuncia') {
    add({
      titulo: 'Pedir desculpas e encerrar o contato',
      tom: 'formal',
      porque: 'A pessoa ameaçou denunciar. Insistir agora derruba o número da campanha.',
      texto: abrir(ctx, 'peço sinceras desculpas pelo incômodo. Vou remover seu número da nossa lista e dos grupos agora mesmo, e você não receberá mais nenhuma mensagem nossa. Obrigado pelo retorno.')
    });
    return sugestoes;
  }

  if (risco?.categoria === 'nao_reconhece') {
    add({
      titulo: 'Explicar quem somos e oferecer saída',
      tom: 'acolhedor',
      porque: 'Ela não sabe por que está no grupo — é daqui que nasce a denúncia.',
      texto: abrir(ctx, `me desculpe pela confusão! Aqui é ${aEquipe}. ` +
        `${ctx.assinaturas.length
          ? `Você assinou o abaixo-assinado "${ctx.assinaturas[0].titulo}" e foi incluída no grupo de quem apoia a causa.`
          : 'Você foi incluída num grupo de apoio à causa por alguém que participa.'} ` +
        'Se preferir não participar, é só me avisar que eu removo na hora, sem problema nenhum.')
    });
    add({
      titulo: 'Só remover, sem argumentar',
      tom: 'direto',
      porque: 'Quando a pessoa está irritada, insistir piora. Remover rápido evita denúncia.',
      texto: 'Desculpe o incômodo! Já estou removendo você do grupo agora. Tenha um ótimo dia.'
    });
    return sugestoes;
  }

  if (risco?.categoria === 'saida_iminente') {
    add({
      titulo: 'Tentar segurar, sem pressionar',
      tom: 'acolhedor',
      porque: 'Anunciou que vai sair. Uma resposta pessoal costuma reverter.',
      texto: abrir(ctx, 'entendo perfeitamente. Antes de você sair, queria só te dizer: o grupo existe para ' +
        `${ctx.temaRotulo ? `discutir ${ctx.temaRotulo} de perto` : 'organizar quem quer melhorar a nossa região'}. ` +
        'Se o incômodo for o volume de mensagens, posso te tirar do grupo e te avisar só do essencial aqui no privado. Prefere assim?')
    });
    add({
      titulo: 'Remover com porta aberta',
      tom: 'direto',
      porque: 'Respeitar o pedido preserva a relação para depois.',
      texto: abrir(ctx, 'claro, sem problema nenhum! Já removi você do grupo. Se um dia quiser voltar, é só me chamar aqui. Obrigado pelo tempo que ficou com a gente 🙏')
    });
    return sugestoes;
  }

  if (risco) {
    add({
      titulo: 'Acolher a reclamação',
      tom: 'acolhedor',
      porque: `Sinal de ${risco.rotulo.toLowerCase()} na última mensagem.`,
      texto: abrir(ctx, 'obrigado por falar abertamente — a gente prefere ouvir isso do que não saber. Me conta o que mais te incomodou que eu ajusto por aqui.')
    });
  }

  // --- 2. Oportunidade -----------------------------------------------------
  if (intencoes.includes('voluntario')) {
    add({
      titulo: 'Aceitar a ajuda com passo concreto',
      tom: 'direto',
      porque: 'Se ofereceu para ajudar. Oferta sem tarefa concreta esfria em 48h.',
      texto: abrir(ctx, 'que alegria ler isso! 🙌 A ajuda que mais faz diferença agora é simples: ' +
        `compartilhar o abaixo-assinado com pessoas ${ctx.cidade ? `de ${ctx.cidade}` : 'da sua região'} ` +
        'e trazer para o grupo quem se importa com a causa. Posso te mandar o material pronto?')
    });
    add({
      titulo: 'Marcar uma conversa',
      tom: 'acolhedor',
      porque: 'Quem se oferece merece contato humano — é assim que nasce liderança local.',
      texto: abrir(ctx, 'muito obrigado! Queria te conhecer melhor. Você teria 10 minutos essa semana para uma ligação rápida? Me diz um horário bom para você.')
    });
  }

  if (intencoes.includes('demanda') || sentimento === 'negativo') {
    add({
      titulo: 'Acolher e pedir os detalhes',
      tom: 'acolhedor',
      porque: intencoes.includes('demanda')
        ? 'A pessoa pediu ajuda com um caso concreto.'
        : 'O tom da conversa está negativo — acolher antes de qualquer outra coisa.',
      texto: abrir(ctx, 'sinto muito por isso, e obrigado por confiar essa situação a nós. ' +
        `Para eu conseguir encaminhar, me manda por favor: o que aconteceu, ${ctx.cidade ? 'o bairro' : 'a cidade e o bairro'} e um telefone de contato. ` +
        `Vou levar isso pessoalmente para ${aEquipe}.`)
    });
  }

  if (intencoes.includes('doacao')) {
    add({
      titulo: 'Direcionar a contribuição',
      tom: 'formal',
      porque: 'Falou em doar. Doação de campanha tem regra — responda pelo canal oficial.',
      texto: abrir(ctx, 'muito obrigado pela intenção! Doação de campanha precisa seguir o canal oficial do TSE, e eu te mando o link assim que estiver liberado. Enquanto isso, a maior contribuição é divulgar a causa 🙏')
    });
  }

  if (intencoes.includes('evento')) {
    add({
      titulo: 'Responder sobre o encontro',
      tom: 'direto',
      porque: 'Perguntou sobre evento ou encontro.',
      texto: abrir(ctx, 'que bom que quer participar! Vou te confirmar data, horário e endereço ainda hoje aqui no privado. Posso contar com você?')
    });
  }

  // --- 3. Completar a ficha ------------------------------------------------
  if (!ctx.cadastrada) {
    add({
      titulo: 'Pedir o cadastro',
      tom: 'direto',
      porque: 'A ficha dela está incompleta — falta nome, cidade ou atuação.',
      texto: abrir(ctx, `para eu te manter informada das novidades da sua região, você pode preencher rapidinho aqui? Leva 30 segundos: ${urlCadastro()}`)
    });
  } else if (!ctx.grupos.length) {
    add({
      titulo: 'Convidar para o grupo',
      tom: 'acolhedor',
      porque: 'Assinou o abaixo-assinado mas não está em nenhum grupo.',
      texto: abrir(ctx, `vi que você assinou o abaixo-assinado${ctx.assinaturas[0]?.bandeira ? ` sobre ${ctx.assinaturas[0].bandeira.toLowerCase()}` : ''} — muito obrigado! ` +
        `Temos um grupo de WhatsApp onde a gente organiza as ações${ctx.cidade ? ` na região de ${ctx.cidade}` : ''}. Posso te adicionar?`)
    });
  }

  if (intencoes.includes('agradecimento') || sentimento === 'positivo') {
    add({
      titulo: 'Retribuir e engajar',
      tom: 'acolhedor',
      porque: 'A conversa está positiva — é o melhor momento para pedir algo.',
      texto: abrir(ctx, `nós é que agradecemos 🙏 Se puder, compartilha nosso trabalho com quem também se importa com ${ctx.temaRotulo || 'a causa'}. Cada pessoa nova faz diferença de verdade.`)
    });
  }

  // --- 4. Quando não há sinal claro ---------------------------------------
  if (!sugestoes.length) {
    add({
      titulo: 'Responder e abrir espaço',
      tom: 'acolhedor',
      porque: 'Sem sinal claro na mensagem — melhor devolver a palavra para ela.',
      texto: abrir(ctx, `obrigado por escrever! Como posso te ajudar${ctx.cidade ? ` aí em ${ctx.cidade}` : ''}?`)
    });
    add({
      titulo: 'Apresentar a causa',
      tom: 'direto',
      porque: 'Serve quando a pessoa ainda não sabe do que se trata.',
      texto: abrir(ctx, `aqui é ${aEquipe}. Estamos organizando quem quer melhorar ${ctx.temaRotulo || 'a nossa região'} — e a sua voz conta muito. Quer que eu te explique melhor?`)
    });
  }

  return sugestoes;
}

function urlCadastro() {
  return process.env.URL_CADASTRO || `http://localhost:${process.env.PORT || 3333}/cadastro`;
}

/** Guarda o resumo na tabela de conversas (usado pela lista da caixa de entrada). */
export function atualizarConversa(pessoaId) {
  const c = lerConversa(pessoaId, 12);
  if (!c) return null;
  db.prepare(`
    INSERT INTO conversas (pessoa_id, sentimento, resumo, atualizado_em)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(pessoa_id) DO UPDATE SET
      sentimento = excluded.sentimento,
      resumo = excluded.resumo,
      atualizado_em = excluded.atualizado_em
  `).run(pessoaId, c.sentimento, c.intencoes.join(','), agora());
  return c;
}
