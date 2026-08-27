// Que grupo é da campanha, e que tema ele atende.
//
// POR QUE ISTO EXISTE: o número âncora está em grupos que não são da campanha
// (grupos pessoais, de curso, de igreja, de outra profissional). Eles entram na
// base porque o Baileys lista TODOS os grupos do telefone — e daí nasciam dois
// problemas sérios:
//
//   1. a fila de adição oferecia esses grupos: um clique errado despejaria
//      assinantes do abaixo-assinado dentro do grupo de terceiro. Além do
//      constrangimento, é exatamente o caminho da denúncia por uso indevido
//      de dado pessoal;
//   2. a recomendação de grupo no formulário caía em `gruposAtivos[0]` quando
//      não achava match — o primeiro grupo por id, que aqui é um grupo externo.
//
// A regra é o inverso da anterior: um grupo só é tratado como da campanha se
// for reconhecidamente dela. Na dúvida, fica de fora.
//
// O `tema` usa as MESMAS chaves de `lexicon.js`, porque é com elas que o
// formulário de pautas responde — é o que faz o casamento pauta → grupo
// funcionar sem depender do nome do grupo conter o rótulo do tema.

import { normalizar } from './lexicon.js';

// Assinaturas fixas de grupo da campanha. Ficam aqui, e não no nome do tema,
// porque o nome do grupo no WhatsApp muda ao longo da campanha e não se pode
// perder o vínculo por causa de uma renomeação.
const ASSINATURAS_PADRAO = [
  'protegendo quem protege',
  'proteja digital',
  'salve a escola'
];

function limparTitulo(nome) {
  return normalizar(nome)
    .replace(/\b(dra|dr|vereador|vereadora|deputado|deputada|prof|professora|professor)\b\.?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * As assinaturas que marcam um grupo como sendo da campanha:
 * as fixas, o nome da candidata (`CANDIDATA`) e o que a equipe acrescentar
 * em `GRUPOS_CAMPANHA` (separado por vírgula).
 */
export function assinaturasDaCampanha({ candidata = null } = {}) {
  const lista = [...ASSINATURAS_PADRAO];

  const nome = limparTitulo(candidata ?? process.env.CANDIDATA ?? '');
  if (nome.split(' ').filter(Boolean).length >= 2) lista.push(nome);

  for (const extra of String(process.env.GRUPOS_CAMPANHA || '').split(',')) {
    const limpo = normalizar(extra);
    if (limpo.length >= 4) lista.push(limpo);
  }

  return [...new Set(lista)];
}

// Primeira regra que casar ganha — por isso a ordem importa: o recorte mais
// específico vem antes do mais genérico ("proteja digital" antes de "infância",
// "saúde mental" antes de "saúde").
const REGRAS_DE_TEMA = [
  { tema: 'protecao_digital', termos: ['proteja digital', 'protecao digital', 'seguranca digital', 'internet segura', 'mundo digital'] },
  { tema: 'pcd', termos: ['inclusao', 'inclusiva', 'pcd', 'deficiencia', 'atipic', 'autis', 'tea', 'neurodiver'] },
  { tema: 'infancia_juventude', termos: ['criancas e adolescentes', 'criacas e adolescentes', 'crianca', 'criacas', 'adolescente', 'infancia', 'primeira infancia'] },
  { tema: 'educacao', termos: ['educacao', 'salve a escola', 'escola', 'professor', 'professora', 'docente'] },
  { tema: 'saude', termos: ['saude', 'saude mental', 'psicolog', 'enfermag'] },
  { tema: 'mulher', termos: ['mulher', 'mulheres', 'maes', 'justiceiras'] },
  { tema: 'seguranca', termos: ['seguranca', 'violencia'] }
];

/**
 * Classifica um grupo pelo nome (e descrição, como reforço).
 *
 * Devolve `{ daCampanha, tema }`. `tema: null` num grupo da campanha é o caso
 * legítimo do grupo geral (ex.: "Amigos, Amigas da Cláudia Camargo") — serve
 * como destino de quem não casa com nenhum pilar.
 */
export function classificarGrupo(nome, descricao = null, opcoes = {}) {
  const alvo = normalizar(nome);
  if (!alvo) return { daCampanha: false, tema: null };

  const assinaturas = assinaturasDaCampanha(opcoes);

  // Pertencer à campanha pode vir da descrição também ("Eleições 2026" num
  // grupo cujo nome não cita a candidata).
  const alvoEDescricao = `${alvo} ${normalizar(descricao || '')}`;
  const daCampanha = assinaturas.some((a) => alvoEDescricao.includes(a));

  // Só classifica tema de grupo da campanha. Marcar tema em grupo de terceiro
  // não serve para nada e ainda faria o grupo parecer elegível numa leitura
  // distraída do painel.
  if (!daCampanha) return { daCampanha: false, tema: null };

  // O TEMA sai do NOME, nunca da descrição — e isso é deliberado. O grupo geral
  // "Amigos, Amigas da Cláudia Camargo" tem descrição falando de proteção de
  // crianças, e por ela ganhava o tema `infancia_juventude`: passava a competir
  // com o grupo do pilar e a campanha ficava sem grupo geral, ou seja, sem
  // destino para quem não casa com nenhum pilar. O nome é o que a equipe
  // controla e mantém padronizado ("Protegendo quem protege | Educação").
  for (const regra of REGRAS_DE_TEMA) {
    if (regra.termos.some((t) => alvo.includes(t))) {
      return { daCampanha: true, tema: regra.tema };
    }
  }
  return { daCampanha: true, tema: null };
}

/**
 * Escolhe o grupo da campanha para quem acabou de preencher o formulário.
 *
 * `pautas` vem na ordem em que a pessoa marcou; a primeira pesa mais. Sem
 * casamento nenhum, cai no grupo geral da campanha (tema nulo). Se não houver
 * grupo da campanha, devolve null — e o formulário mostra a mensagem neutra,
 * em vez de convidar para o grupo de outra pessoa.
 */
export function recomendarGrupo(grupos, pautas = []) {
  const daCampanha = (grupos || []).filter((g) => g.da_campanha === 1 || g.daCampanha === true);
  if (!daCampanha.length) return null;

  for (const pauta of pautas) {
    const casou = daCampanha.find((g) => g.tema && g.tema === pauta);
    if (casou) return casou;
  }

  return daCampanha.find((g) => !g.tema) ?? null;
}
