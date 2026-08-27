// Gerência de instância de WhatsApp por campanha.
//
// Duas origens possíveis, escolhidas por campanha:
//
//   baileys — socket neste processo. A sessão é nossa; sobrevive a deploy
//             porque nuvem.js guarda a credencial no Firestore.
//   wacore  — WA-Core2. Quem mantém a conexão pareada é o fornecedor; aqui
//             ficam só os identificadores para endereçar a linha.
//
// Este módulo é a camada única por onde o painel fala com qualquer uma das
// duas. Sem ele, cada tela precisaria saber de qual provedor é a campanha —
// e é assim que um "se for wacore" esquecido manda comando para o socket errado.
//
// PROVISIONAMENTO: no WA-Core2, antes de qualquer QR existir, é preciso ter
// team e linha registrados. A doc é explícita: connect-by-external NÃO
// auto-cria a linha; com userExternalId inexistente ele devolve 404. Por isso
// `garantirLinha` roda antes de conectar, e é idempotente — repetir não
// duplica nem cobra nada.

import { randomUUID } from 'node:crypto';
import * as contas from './contas.js';
import * as wacore from './wacore.js';
import * as baileys from './whatsapp.js';

export const provedorDa = (slug) => contas.obterCampanha(slug)?.provedor || 'baileys';

/**
 * Garante que a campanha tem team e linha no WA-Core2, criando o que faltar.
 * Os UUIDs ficam guardados: o mesmo número precisa cair sempre na mesma linha,
 * senão cada conexão vira uma instância nova no fornecedor.
 */
export async function garantirLinha(slug, { whatsappNumber = null } = {}) {
  const campanha = contas.obterCampanha(slug);
  if (!campanha) throw new Error(`Campanha "${slug}" não existe`);
  if (!wacore.configurado()) {
    throw new Error('WACORE_TOKEN não configurado — sem ele não dá para falar com a API.');
  }

  let externalId = campanha.wacore_external_id;
  let userId = campanha.wacore_user_id;

  if (!externalId) {
    externalId = randomUUID();
    await wacore.registrarTeam({ externalId, name: campanha.nome });
    contas.atualizarCampanha(slug, { wacore_external_id: externalId });
  }

  if (!userId) {
    userId = randomUUID();
    // Idempotente do lado deles: repetir com o mesmo userExternalId devolve a
    // linha existente. Guardamos ANTES de conectar para não perder o vínculo
    // se a conexão falhar no meio.
    await wacore.criarLinha({ externalId, userExternalId: userId, whatsappNumber });
    contas.atualizarCampanha(slug, { wacore_user_id: userId });
  }

  return { externalId, userExternalId: userId };
}

/** Estado da conexão, no formato que o painel já entende. */
export async function estado(slug) {
  if (provedorDa(slug) !== 'wacore') return baileys.estadoDoWhatsapp();

  const campanha = contas.obterCampanha(slug);
  if (!campanha?.wacore_external_id) {
    return {
      provedor: 'wacore', status: 'desconectado', qr: null, telefone: null,
      erro: null, aindaNaoProvisionada: true
    };
  }

  try {
    const r = await wacore.status(campanha.wacore_external_id, campanha.wacore_user_id);
    const bruto = String(r?.data?.status ?? r?.status ?? '').toLowerCase();
    return {
      provedor: 'wacore',
      // `qr` e `pairing` são a mesma coisa para a interface. A doc avisa que
      // tratar só um faz a tela esconder o QR antes de a pessoa conseguir usar.
      status: bruto === 'connected' ? 'conectado'
        : wacore.esperandoPareamento(bruto) ? 'qr'
          : bruto === 'connecting' ? 'conectando' : 'desconectado',
      statusBruto: bruto || null,
      telefone: r?.data?.whatsappNumber ?? r?.whatsappNumber ?? null,
      qr: null,
      erro: null
    };
  } catch (erro) {
    return { provedor: 'wacore', status: 'erro', qr: null, telefone: null, erro: erro.message };
  }
}

/**
 * Começa a conexão e devolve o que a tela precisa mostrar.
 * No WA-Core2 o QR já vem pronto como data URI — não geramos imagem nenhuma.
 */
export async function conectar(slug, { pairingPhone = null, whatsappNumber = null, modo = null } = {}) {
  if (provedorDa(slug) !== 'wacore') {
    return baileys.conectar({ parearCom: pairingPhone, modo });
  }

  const { externalId, userExternalId } = await garantirLinha(slug, { whatsappNumber });
  const r = await wacore.parear({ externalId, userExternalId, pairingPhone });
  const d = r?.data ?? r;

  return {
    provedor: 'wacore',
    status: 'qr',
    qr: d?.qrImage ?? null,        // data:image/png;base64,… pronto para <img>
    qrTexto: d?.qr ?? null,
    codigo: d?.pairingCode ?? null,
    codigoPara: pairingPhone ? String(pairingPhone).replace(/\D/g, '') : null,
    telefone: null,
    erro: null
  };
}

export async function desconectar(slug, opcoes = {}) {
  if (provedorDa(slug) !== 'wacore') return baileys.desconectar(opcoes);

  const campanha = contas.obterCampanha(slug);
  if (!campanha?.wacore_external_id) return { status: 'desconectado' };
  await wacore.desconectar(campanha.wacore_external_id, campanha.wacore_user_id);
  return { provedor: 'wacore', status: 'desconectado' };
}

/**
 * Envia uma mensagem pela origem da campanha.
 *
 * `anexo` chega como {caminho, tipo, nome} — o formato que transmissao.js já
 * usa. Para o WA-Core2 ele vira base64: a alternativa seria hospedar o arquivo
 * numa URL pública, e material de campanha não deve ficar baixável por quem
 * descobrir o endereço.
 */
export async function enviar(slug, jid, texto, anexo = null, { clientMessageId = null } = {}) {
  if (provedorDa(slug) !== 'wacore') return baileys.enviarMensagem(jid, texto);

  const campanha = contas.obterCampanha(slug);
  if (!campanha?.wacore_external_id) throw new Error('Campanha sem linha no WA-Core2');

  let midia = null;
  if (anexo?.caminho) {
    const { readFile } = await import('node:fs/promises');
    midia = {
      tipo: anexo.tipo,
      base64: (await readFile(anexo.caminho)).toString('base64'),
      fileName: anexo.nome ?? undefined
    };
  }

  return wacore.enviar({
    externalId: campanha.wacore_external_id,
    userExternalId: campanha.wacore_user_id,
    to: String(jid).split('@')[0],
    texto, midia, clientMessageId
  });
}
