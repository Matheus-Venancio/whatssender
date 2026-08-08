// Estado por campanha.
//
// Antes, cada módulo tinha um estado global (um socket do WhatsApp, um cliente
// do Firestore, uma fila de adição). Com vários candidatos, cada um precisa do
// seu. Este utilitário guarda um registro por campanha e devolve o da campanha
// ativa no contexto — sem obrigar cada função a receber o slug como parâmetro.

import { campanhaAtual } from './db.js';

export function porCampanha(criar) {
  const mapa = new Map();

  const de = (slug) => {
    if (!slug) throw new Error('Nenhuma campanha ativa no contexto');
    if (!mapa.has(slug)) mapa.set(slug, criar(slug));
    return mapa.get(slug);
  };

  return {
    de,
    atual: () => de(campanhaAtual()),
    existe: (slug) => mapa.has(slug),
    esquecer: (slug) => mapa.delete(slug),
    slugs: () => [...mapa.keys()],
    todas: () => [...mapa.entries()]
  };
}
