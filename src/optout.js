// Descadastramento — "não quero mais receber".
//
// POR QUE ISTO É UM MÓDULO PRÓPRIO: morava dentro de transmissao.js, e a
// transmissão foi removida do sistema. O opt-out não pode sair junto: ele é
// obrigação legal (Lei 9.504/97, art. 57-G, com 48 horas para atender), vale
// para qualquer contato que a campanha faça — resposta no painel, convite de
// grupo, mensagem de equipe — e não só para disparo em massa.
//
// Quem escreve "SAIR" no WhatsApp é atendido na hora pelo whatsapp.js, sem
// depender de alguém ver o painel dentro do prazo.

import { db, agora } from './db.js';
import { registrarEvento } from './ingest.js';

// Palavras que significam "me tire da lista". Ficam aqui, e não espalhadas,
// porque errar para MENOS aqui é descumprir a lei.
const PEDIDOS_DE_SAIDA = [
  'sair', 'sai', 'pare', 'parar', 'para de mandar', 'nao quero', 'não quero',
  'descadastr', 'remover', 'me tira', 'me tire', 'cancelar', 'stop', 'nao me mande',
  'não me mande', 'nao manda mais', 'não manda mais', 'sem interesse'
];

/** A pessoa está pedindo para sair da lista? */
export function pediuParaSair(texto) {
  if (!texto) return false;
  const limpo = String(texto).toLowerCase().trim().replace(/[.!]+$/, '');

  // Só mensagem curta e direta. Quem quer sair escreve "SAIR", não um
  // parágrafo — e procurar a palavra solta dentro de frase longa descadastra
  // por engano quem escreveu "não quero perder o evento" ou "vou sair de casa".
  // Errar para mais aqui custa um apoiador; errar para menos custa uma multa.
  // Por isso: curto E começando pelo pedido.
  if (limpo.length > 25) return false;
  return PEDIDOS_DE_SAIDA.some((p) => limpo === p || limpo.startsWith(p));
}

/** Marca a pessoa como descadastrada. Definitivo. */
export function descadastrar(pessoaId, origem = 'pediu no WhatsApp') {
  db.prepare('UPDATE pessoas SET opt_out = 1, opt_out_em = ? WHERE id = ?').run(agora(), pessoaId);
  registrarEvento({
    pessoaId, tipo: 'optout',
    descricao: `Pediu para não receber mais mensagens (${origem})`
  });
  return { ok: true };
}

/** Quem pediu para sair. A fila de adição a grupo também tem de respeitar. */
export const estaDescadastrada = (pessoaId) =>
  Boolean(db.prepare('SELECT opt_out FROM pessoas WHERE id = ?').get(pessoaId)?.opt_out);
