// Detecção de atrito nos grupos.
//
// O lexicon.js entende INTERESSE (do que a pessoa gosta). Este arquivo entende
// RISCO: quando a conversa azeda, quando alguém não sabe por que está ali, e
// principalmente quando o número da campanha está em perigo.
//
// A ordem de prioridade não é acadêmica. Uma denúncia em massa derruba o
// WhatsApp da campanha em horas — isso vem antes de qualquer outra coisa.

import { db, agora } from './db.js';
import { normalizar } from './lexicon.js';
import { registrarAlerta, retratoDaPessoa, formatarTelefone } from './ingest.js';

const MINUTO = 60_000;

export const RISCOS = {
  ameaca_denuncia: {
    rotulo: 'Ameaça de denúncia',
    gravidade: 'critico',
    prioridade: 6,
    cor: '#dc2626',
    icone: '🚨',
    acao: 'URGENTE: remova a pessoa do grupo e NÃO envie mais nada para ela. ' +
          'Denúncia em massa derruba o número da campanha.',
    termos: [
      'vou denunciar', 'vou reportar', 'denunciar esse grupo', 'denunciar o grupo',
      'vou reportar esse grupo', 'isso e golpe', 'isso e um golpe', 'e golpe',
      'vou processar', 'meu advogado', 'procon', 'lgpd', 'ministerio publico',
      'vou na policia', 'boletim de ocorrencia', 'crime eleitoral',
      'vou bloquear e denunciar', 'reportar como spam', 'denuncio'
    ]
  },

  nao_reconhece: {
    rotulo: 'Não sabe por que está no grupo',
    gravidade: 'critico',
    prioridade: 5,
    cor: '#ea580c',
    icone: '❓',
    acao: 'Responda no privado, não no grupo: diga quem é a candidata, quem adicionou ' +
          'e ofereça a saída. É daqui que nasce a denúncia.',
    termos: [
      'quem e voce', 'quem sao voces', 'quem e vc', 'quem fala',
      'que grupo e esse', 'que grupo e este', 'do que se trata',
      'nao conheco ninguem', 'nao conheco esse grupo', 'nao sei que grupo e esse',
      'quem me adicionou', 'quem me colocou', 'quem me inseriu', 'quem me botou',
      'nao pedi para entrar', 'nao pedi pra entrar', 'nao autorizei',
      'como eu entrei', 'como entrei aqui', 'fui adicionado sem',
      'onde conseguiu meu numero', 'onde pegou meu numero', 'quem deu meu numero',
      'como conseguiram meu numero', 'nao autorizei ninguem'
    ]
  },

  saida_iminente: {
    rotulo: 'Vai sair do grupo',
    gravidade: 'critico',
    prioridade: 4,
    cor: '#d97706',
    icone: '🚪',
    acao: 'Chame no privado antes que saia. Não discuta no grupo — ' +
          'saída anunciada costuma levar outras pessoas junto.',
    termos: [
      'nao quero saber do grupo', 'nao quero saber desse grupo', 'nao quero mais esse grupo',
      'quero sair do grupo', 'quero sair desse grupo', 'vou sair do grupo', 'vou sair desse grupo',
      'to saindo do grupo', 'tou saindo', 'estou saindo do grupo', 'saindo do grupo',
      'me tira do grupo', 'me tire do grupo', 'me tirem do grupo', 'me tira daqui',
      'me remove do grupo', 'me removam', 'me exclui do grupo', 'me exclua',
      'pode me tirar', 'podem me tirar', 'favor me remover', 'favor me tirar',
      'nao quero mais fazer parte', 'nao quero participar', 'sai desse grupo',
      'me tira dessa lista', 'me descadastra', 'nao quero mais receber'
    ]
  },

  hostilidade: {
    rotulo: 'Hostilidade / ofensa',
    gravidade: 'aviso',
    prioridade: 3,
    cor: '#b91c1c',
    icone: '⚡',
    acao: 'Modere agora. Se persistir, remova — briga no grupo esvazia o grupo.',
    termos: [
      'cala a boca', 'cale a boca', 'vai se', 'vai tomar', 'foda se', 'fodase',
      'que palhacada', 'palhacada', 'que absurdo', 'ridiculo', 'ridicula',
      'que vergonha', 'sem vergonha', 'mentiroso', 'mentirosa', 'safado', 'safada',
      'otario', 'otaria', 'idiota', 'imbecil', 'burro', 'burra', 'estupido',
      'seu lixo', 'que lixo', 'pqp', 'puta que', 'merda', 'porra', 'caralho',
      'nao enche', 'me deixa em paz', 'para de me encher', 'chato pra caramba'
    ]
  },

  rejeicao_politica: {
    rotulo: 'Rejeição política',
    gravidade: 'aviso',
    prioridade: 2,
    cor: '#7c2d12',
    icone: '🗳️',
    acao: 'Não confronte no grupo. Se for pontual, ignore; se contaminar, chame no privado.',
    termos: [
      'nao acredito em politico', 'todo politico', 'todos os politicos', 'politico e tudo igual',
      'so promessa', 'so promessas', 'promessa de campanha', 'enganacao', 'enganando o povo',
      'nao vou votar', 'nao voto', 'chega de politica', 'sem politica aqui',
      'aqui nao e lugar de politica', 'usando a causa', 'se aproveitando'
    ]
  },

  insatisfacao: {
    rotulo: 'Incomodado com o volume',
    gravidade: 'info',
    prioridade: 1,
    cor: '#0891b2',
    icone: '🔕',
    acao: 'Sinal de desgaste. Reduza a frequência de mensagens nesse grupo.',
    termos: [
      'muita mensagem', 'mensagem demais', 'para de mandar', 'parem de mandar',
      'ja silenciei', 'vou silenciar', 'silenciei o grupo', 'isso e spam', 'virou spam',
      'nao me interessa', 'que chato', 'toda hora', 'so notificacao'
    ]
  }
};

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REGEX = new Map(
  Object.entries(RISCOS).map(([chave, def]) => [
    chave,
    new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${def.termos.map((t) => escapar(normalizar(t))).join('|')})(?![\\p{L}\\p{N}])`,
      'u'
    )
  ])
);

/**
 * Devolve o risco de maior prioridade encontrado no texto, ou null.
 * Só um por mensagem: o objetivo é dar UMA instrução clara ao administrador,
 * não uma lista de classificações.
 */
export function detectarRisco(texto) {
  const t = normalizar(texto);
  if (!t) return null;

  let achado = null;
  for (const [chave, regex] of REGEX) {
    if (!regex.test(t)) continue;
    const def = RISCOS[chave];
    if (!achado || def.prioridade > achado.prioridade) achado = { categoria: chave, ...def };
  }
  return achado;
}

// ---------------------------------------------------------------------------

/** Já existe alerta desta pessoa, nesta categoria, neste grupo, há pouco tempo? */
function alertaRecente(pessoaId, grupoId, categoria, janelaMin = 30) {
  return db.prepare(`
    SELECT id FROM alertas
     WHERE pessoa_id = ? AND grupo_id IS ? AND tipo = ? AND ts >= ?
     ORDER BY ts DESC LIMIT 1
  `).get(pessoaId, grupoId, `atrito:${categoria}`, agora() - janelaMin * MINUTO);
}

/**
 * Quando duas ou mais pessoas diferentes geram atrito no mesmo grupo em pouco
 * tempo, não é caso isolado: é briga. Isso merece um alerta próprio.
 */
function verificarConflitoColetivo(grupoId, nomeGrupo, janelaMin = 60) {
  const desde = agora() - janelaMin * MINUTO;
  const pessoas = db.prepare(`
    SELECT COUNT(DISTINCT pessoa_id) AS n FROM alertas
     WHERE grupo_id = ? AND tipo LIKE 'atrito:%' AND ts >= ?
  `).get(grupoId, desde).n;

  if (pessoas < 2) return null;

  const jaAvisado = db.prepare(`
    SELECT id FROM alertas WHERE grupo_id = ? AND tipo = 'conflito_grupo' AND ts >= ?
  `).get(grupoId, desde);
  if (jaAvisado) return null;

  return registrarAlerta({
    tipo: 'conflito_grupo',
    gravidade: 'critico',
    grupoId,
    titulo: `Discussão no grupo ${nomeGrupo}`,
    detalhe: `${pessoas} pessoas diferentes geraram atrito na última hora. ` +
             'Entre no grupo agora e acalme a conversa.',
    dados: { pessoas, janelaMin, grupo: nomeGrupo }
  });
}

/**
 * Analisa uma mensagem e, se houver risco, cria o alerta.
 * Devolve { alertaId, risco } ou null.
 */
export function analisarMensagem({ pessoaId, grupoId, nomeGrupo, texto, ts = agora() }) {
  const risco = detectarRisco(texto);
  if (!risco) return null;

  // A mesma pessoa repetindo o mesmo tipo de reclamação não vira 5 alertas.
  if (alertaRecente(pessoaId, grupoId, risco.categoria)) return null;

  const retrato = retratoDaPessoa(pessoaId) || {};
  const quem = retrato.nome || formatarTelefone(retrato.telefone) || 'Alguém';

  const contexto = [
    retrato.classificacao && retrato.mensagens
      ? `${retrato.classificacao} · ${retrato.mensagens} mensagens`
      : 'primeira interação dela no grupo',
    retrato.cidade ? `${retrato.cidade}${retrato.uf ? `/${retrato.uf}` : ''}` : null,
    retrato.assinou?.length ? `assinou ${retrato.assinou.length} abaixo-assinado(s)` : null,
    retrato.aindaEstaEm?.length > 1 ? `está em ${retrato.aindaEstaEm.length} grupos` : null
  ].filter(Boolean).join(' · ');

  const alertaId = registrarAlerta({
    tipo: `atrito:${risco.categoria}`,
    gravidade: risco.gravidade,
    pessoaId,
    grupoId,
    titulo: `${quem} — ${risco.rotulo.toLowerCase()} em ${nomeGrupo}`,
    detalhe: `“${String(texto).trim().slice(0, 180)}”`,
    dados: { ...retrato, risco: risco.categoria, acao: risco.acao, contexto, mensagem: texto, grupo: nomeGrupo },
    ts
  });

  // Risco alto marca a ficha da pessoa, para ela aparecer sinalizada na lista
  // e ficar de fora de qualquer disparo futuro.
  if (risco.gravidade === 'critico') marcarAtrito(pessoaId);

  const conflitoId = verificarConflitoColetivo(grupoId, nomeGrupo);

  return { alertaId, conflitoId, risco, quem, contexto };
}

function marcarAtrito(pessoaId) {
  db.prepare(`INSERT OR IGNORE INTO tags (nome, cor) VALUES ('Atenção / atrito', '#dc2626')`).run();
  const tag = db.prepare(`SELECT id FROM tags WHERE nome = 'Atenção / atrito'`).get();
  if (tag) {
    db.prepare('INSERT OR IGNORE INTO pessoa_tags (pessoa_id, tag_id) VALUES (?, ?)')
      .run(pessoaId, tag.id);
  }
}

/** Rótulo legível para um tipo salvo no banco ("atrito:saida_iminente"). */
export function definicaoDoTipo(tipo) {
  if (tipo === 'conflito_grupo') {
    return {
      rotulo: 'Discussão no grupo', cor: '#dc2626', icone: '🔥',
      acao: 'Entre no grupo e acalme a conversa antes que vire debandada.'
    };
  }
  if (!tipo?.startsWith('atrito:')) return null;
  const def = RISCOS[tipo.slice(7)];
  return def ? { rotulo: def.rotulo, cor: def.cor, icone: def.icone, acao: def.acao } : null;
}
