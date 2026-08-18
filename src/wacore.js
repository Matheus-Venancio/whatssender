// Adaptador do WA-Core2 — WhatsApp como serviço, em vez de socket próprio.
//
// POR QUE EXISTE: com o Baileys, a sessão vive neste processo. Deploy, queda ou
// hibernação derrubam a conexão, e foi preciso construir persistência da
// credencial no Firestore para sobreviver a isso. Aqui a conexão fica com o
// fornecedor: o servidor pode reiniciar à vontade que a linha continua pareada.
//
// HIERARQUIA (o ponto que mais confunde):
//     team  →  externalId       — o cliente/campanha
//     linha →  userExternalId   — o número de WhatsApp
// A conexão é POR LINHA. Um team pode ter várias. Quase toda rota quer os dois.
//
// O QUE O RATE LIMIT DELES NÃO É: a documentação é explícita — 60/min em send é
// "proteção de borda contra token vazado ou loop, não uma fila anti-banimento
// para lotes". Quem protege o número do bloqueio continua sendo a fila em
// transmissao.js: intervalo aleatório, teto diário, horário, parada em falha.
// Trocar de provedor não muda nada disso.
//
// AMBIENTE COMPARTILHADO: a doc proíbe chamar connect-by-external no ambiente
// de parceria — um pareamento de teste queima a reputação do IP que todos os
// clientes dividem. Por isso o pareamento aqui exige
// WACORE_PERMITIR_PAREAMENTO=true: trava consciente, não descuido.

// LIDO A CADA USO, não na importação.
//
// Com `const TOKEN = process.env...` no topo, o módulo congelava o ambiente do
// instante em que foi importado. Se o .env fosse carregado depois — e era, só
// dentro de iniciarFirebase — o token ficava vazio para sempre, e o painel
// dizia "WACORE_TOKEN não está configurado" com o token ali no arquivo.
const base = () => (process.env.WACORE_BASE || 'https://wacore2.dartenmind.com.br').replace(/\/+$/, '');
const token = () => (process.env.WACORE_TOKEN || '').trim();

export const configurado = () => Boolean(token());
export const baseUrl = () => base();
export const pareamentoLiberado = () => process.env.WACORE_PERMITIR_PAREAMENTO === 'true';

/** Erro com o status HTTP preservado — quem chama precisa distinguir 404 de 429. */
export class ErroWaCore extends Error {
  constructor(mensagem, status, corpo) {
    super(mensagem);
    this.status = status;
    this.corpo = corpo;
  }
}

async function chamar(metodo, caminho, corpo = null, { tentativa = 1 } = {}) {
  if (!configurado()) throw new ErroWaCore('WACORE_TOKEN não configurado', 0, null);

  const resposta = await fetch(`${base()}${caminho}`, {
    method: metodo,
    headers: {
      'X-App-Token': token(),
      ...(corpo ? { 'Content-Type': 'application/json' } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(30_000)
  });

  // 429 traz Retry-After. Respeitar é o mínimo; ignorar é como se perde acesso.
  if (resposta.status === 429 && tentativa <= 2) {
    const espera = Number(resposta.headers.get('retry-after') || 5) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(espera, 60_000)));
    return chamar(metodo, caminho, corpo, { tentativa: tentativa + 1 });
  }

  const texto = await resposta.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { bruto: texto.slice(0, 200) }; }

  if (!resposta.ok || dados?.success === false) {
    const detalhe = dados?.details?.[0]?.message || dados?.error || `HTTP ${resposta.status}`;
    throw new ErroWaCore(detalhe, resposta.status, dados);
  }
  return dados;
}

// --------------------------------------------------------------- service
/** Confirma que o token vale. É a chamada mais barata da API. */
export const listarTeams = () => chamar('GET', '/api/service/teams');

/** Registra o cliente. `externalId` precisa ser UUID — a API recusa texto livre. */
export const registrarTeam = ({ externalId, name }) =>
  chamar('POST', '/api/service/register', { externalId, name });

/**
 * Cria a linha de WhatsApp dentro do team. Idempotente: repetir com o mesmo
 * userExternalId devolve a existente em vez de duplicar.
 */
export const criarLinha = ({ externalId, userExternalId, whatsappNumber = null }) =>
  chamar('POST', '/api/service/user', {
    externalId, userExternalId, ...(whatsappNumber ? { whatsappNumber } : {})
  });

export const detalhesDoTeam = (externalId) =>
  chamar('GET', `/api/service/team/${encodeURIComponent(externalId)}`);

export const removerTeam = (externalId) =>
  chamar('DELETE', `/api/service/unregister/${encodeURIComponent(externalId)}`);

// -------------------------------------------------------------- whatsapp
/**
 * Estado da linha. Antes de parear vem "disconnected" — é o esperado, não erro.
 *
 * A doc avisa que `qr` e `pairing` significam a mesma coisa para a interface:
 * tratar só um dos dois faz a tela esconder o QR antes de a pessoa usar.
 */
export const status = (externalId, userExternalId = null) =>
  chamar('GET', `/api/whatsapp/status-by-external/${encodeURIComponent(externalId)}`
    + (userExternalId ? `?userExternalId=${encodeURIComponent(userExternalId)}` : ''));

export const desconectar = (externalId, userExternalId = null) =>
  chamar('POST', `/api/whatsapp/disconnect-by-external/${encodeURIComponent(externalId)}`,
    userExternalId ? { userExternalId } : {});

/** Estados que significam "ainda esperando alguém parear". */
export const esperandoPareamento = (s) => ['qr', 'pairing'].includes(String(s || '').toLowerCase());

/**
 * Inicia o pareamento. Com `pairingPhone`, vem código de 8 letras em vez de QR.
 *
 * A trava não é preciosismo: no ambiente compartilhado um pareamento de teste
 * afeta a reputação do IP de todos os clientes do fornecedor.
 */
export function parear({ externalId, userExternalId = null, pairingPhone = null }) {
  if (!pareamentoLiberado()) {
    throw new ErroWaCore(
      'Pareamento bloqueado neste ambiente. A documentação do WA-Core2 proíbe '
      + 'connect-by-external no ambiente compartilhado: ele pareia um WhatsApp real e '
      + 'afeta a reputação do IP dividido com os clientes em produção. Para liberar, '
      + 'defina WACORE_PERMITIR_PAREAMENTO=true — só no ambiente próprio.',
      403, null
    );
  }
  return chamar('POST', `/api/whatsapp/connect-by-external/${encodeURIComponent(externalId)}`, {
    ...(userExternalId ? { userExternalId } : {}),
    ...(pairingPhone ? { pairingPhone: String(pairingPhone).replace(/\D/g, '') } : {})
  });
}

/**
 * Envia mensagem. `clientMessageId` dá idempotência: repetir o mesmo id não
 * duplica a mensagem, o que torna o retry seguro depois de um timeout.
 */
export function enviar({ externalId, userExternalId = null, to, texto = null, midia = null, clientMessageId = null }) {
  const corpo = {
    to: String(to).replace(/\D/g, ''),
    ...(userExternalId ? { userExternalId } : {}),
    ...(clientMessageId ? { clientMessageId } : {})
  };

  const familia = (t) => (t === 'video' ? 'video' : t === 'audio' ? 'audio' : 'image');

  if (midia?.url || midia?.base64) {
    corpo.type = familia(midia.tipo);
    if (midia.url) corpo.mediaUrl = midia.url;
    else corpo.mediaBase64 = String(midia.base64).split(',').pop();
    if (midia.mimetype) corpo.mimetype = midia.mimetype;
    if (midia.fileName) corpo.fileName = midia.fileName;
    // Áudio vira PTT (nota de voz) e ignora legenda — o texto vai à parte.
    if (texto && corpo.type !== 'audio') corpo.caption = texto;
  } else {
    corpo.type = 'text';
    corpo.text = texto;
  }

  return chamar('POST', `/api/whatsapp/send-by-external/${encodeURIComponent(externalId)}`, corpo);
}

/** Diagnóstico: token, alcance e o que o app enxerga. */
export async function diagnostico() {
  const saude = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json()).catch(() => null);
  const teams = await listarTeams().catch((e) => ({ erro: e.message, status: e.status }));
  return {
    base: base(),
    tokenConfigurado: configurado(),
    pareamentoLiberado: pareamentoLiberado(),
    servico: saude?.service ?? null,
    saude: saude?.status ?? null,
    teams
  };
}
