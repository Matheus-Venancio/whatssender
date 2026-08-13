// Avisos no WhatsApp de quem coordena a campanha.
//
// O painel só ajuda quem está com ele aberto. Alerta de saída de grupo, atrito
// e mensagem no privado precisam chegar onde a equipe já olha o dia inteiro —
// o próprio WhatsApp.
//
// O NÚMERO NÃO FICA NO CÓDIGO: este repositório é público. Ele é um campo da
// campanha (`alerta_whatsapp`), digitado no painel, e agora sobrevive a deploy
// junto com o resto do controle. `ALERTA_WHATSAPP` no ambiente serve de padrão
// para todas as campanhas.
//
// QUEM AVISA QUEM: o aviso sai pelo WhatsApp DA PRÓPRIA CAMPANHA. A campanha da
// Cláudia nunca usa o socket do Fernandão — nem para mandar recado.

import { comCampanha } from './db.js';
import * as contas from './contas.js';

const MINUTO = 60_000;

// Estado por campanha: evita repetir o mesmo aviso e evita virar spam quando
// um grupo esvazia de uma vez.
const controle = new Map();

const estadoDe = (slug) => {
  if (!controle.has(slug)) {
    controle.set(slug, { enviadosNaHora: 0, janela: Date.now(), ultimos: new Map() });
  }
  return controle.get(slug);
};

export const LIMITES = {
  porHora: Number(process.env.ALERTA_POR_HORA || 20),
  repetirApos: Number(process.env.ALERTA_REPETIR_MIN || 30) * MINUTO
};

/** Número que recebe os avisos desta campanha, ou null. */
export function destinoDaCampanha(slug) {
  const c = contas.obterCampanha(slug);
  const bruto = c?.alerta_whatsapp || process.env.ALERTA_WHATSAPP || '';
  const digitos = String(bruto).replace(/\D/g, '');
  return digitos.length >= 12 && digitos.length <= 15 ? digitos : null;
}

/**
 * @param enviar  função que fala com o WhatsApp — injetada para o teste não
 *                precisar de socket nem de rede.
 */
export async function avisar(slug, { chave, titulo, corpo }, enviar) {
  const destino = destinoDaCampanha(slug);
  if (!destino) return { enviado: false, motivo: 'sem número configurado' };

  const e = estadoDe(slug);
  const agora = Date.now();

  if (agora - e.janela > 60 * MINUTO) { e.janela = agora; e.enviadosNaHora = 0; }
  if (e.enviadosNaHora >= LIMITES.porHora) {
    return { enviado: false, motivo: 'teto por hora atingido' };
  }

  // O mesmo assunto não volta antes do intervalo: cinco pessoas saindo do
  // mesmo grupo em sequência é UM problema, não cinco mensagens.
  const visto = e.ultimos.get(chave);
  if (visto && agora - visto < LIMITES.repetirApos) {
    return { enviado: false, motivo: 'repetido há pouco' };
  }

  const campanha = contas.obterCampanha(slug);
  const texto = `*${titulo}*\n${corpo}\n\n_${campanha?.nome ?? slug} · Rede de Apoio_`;

  try {
    await enviar(`${destino}@s.whatsapp.net`, texto);
    e.ultimos.set(chave, agora);
    e.enviadosNaHora++;
    return { enviado: true, destino };
  } catch (erro) {
    return { enviado: false, motivo: erro.message };
  }
}

/** Traduz um evento do sistema em aviso. Devolve null para o que não vale interromper. */
export function textoDoEvento(evento) {
  if (evento.tipo === 'alerta') {
    const a = evento.alerta;
    return {
      chave: `alerta:${a.tipo ?? a.titulo}`,
      titulo: a.gravidade === 'critico' ? `🚨 ${a.titulo}` : `🔔 ${a.titulo}`,
      corpo: a.detalhe || 'Abra o painel para ver os detalhes.'
    };
  }

  // Mensagem no privado: só o que CHEGA. O eco das respostas da equipe
  // transformaria a conversa normal num despertador.
  if (evento.tipo === 'privada' && !evento.deMim) {
    return {
      chave: `privada:${evento.pessoaId ?? evento.previa?.slice(0, 20)}`,
      titulo: '💬 Mensagem no privado',
      corpo: `${evento.nome ? `${evento.nome}: ` : ''}${(evento.previa || '').slice(0, 180)}`
    };
  }

  return null;
}

/**
 * Liga o fluxo de eventos aos avisos. `enviarPorCampanha(slug, jid, texto)`
 * fica a cargo de quem chama — é o whatsapp.js, dentro da campanha certa.
 */
export function ligarAvisos(assinar, enviarPorCampanha) {
  assinar((evento) => {
    const slug = evento.campanha;
    if (!slug) return;

    const aviso = textoDoEvento(evento);
    if (!aviso) return;

    comCampanha(slug, () =>
      avisar(slug, aviso, (jid, texto) => enviarPorCampanha(slug, jid, texto))
        .catch(() => { /* aviso é acessório: nunca derruba o fluxo principal */ })
    );
  });
}

/** Só para os testes: zera o histórico de repetição. */
export const limparControle = () => controle.clear();
