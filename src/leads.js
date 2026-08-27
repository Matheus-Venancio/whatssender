// Normalização dos leads que vêm do Meta (Facebook/Instagram Lead Ads).
// O CSV que o Gerenciador de Anúncios exporta é sujo: cidade em caixa baixa,
// UF grudada no nome, atuação em slug. Aqui vira dado utilizável.

const UFS = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão',
  MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará',
  PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro',
  RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins'
};

const NOME_PARA_UF = Object.fromEntries(
  Object.entries(UFS).map(([sigla, nome]) => [semAcento(nome), sigla])
);

// DDD -> UF, para deduzir o estado quando a pessoa não escreveu.
const DDD_UF = {
  11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP',
  21: 'RJ', 22: 'RJ', 24: 'RJ', 27: 'ES', 28: 'ES',
  31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG', 35: 'MG', 37: 'MG', 38: 'MG',
  41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR',
  47: 'SC', 48: 'SC', 49: 'SC',
  51: 'RS', 53: 'RS', 54: 'RS', 55: 'RS',
  61: 'DF', 62: 'GO', 63: 'TO', 64: 'GO', 65: 'MT', 66: 'MT', 67: 'MS',
  68: 'AC', 69: 'RO',
  71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA', 79: 'SE',
  81: 'PE', 82: 'AL', 83: 'PB', 84: 'RN', 85: 'CE', 86: 'PI', 87: 'PE', 88: 'CE', 89: 'PI',
  91: 'PA', 92: 'AM', 93: 'PA', 94: 'PA', 95: 'RR', 96: 'AP', 97: 'AM', 98: 'MA', 99: 'MA'
};

const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'du', 'del', 'em']);

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Versão que preserva o comprimento: usada quando precisamos casar posição de
// caractere entre o texto sem acento e o texto original.
const ACENTUADOS = 'áàâãäéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ';
const SIMPLES____ = 'aaaaaeeeeiiiiooooouuuucnyAAAAAEEEEIIIIOOOOOUUUUCNY';
const MAPA_ACENTO = new Map([...ACENTUADOS].map((c, i) => [c, SIMPLES____[i]]));

function dobrar(s) {
  let saida = '';
  for (const c of String(s || '')) saida += (MAPA_ACENTO.get(c) ?? c).toLowerCase();
  return saida;
}

// Estados cuja capital tem o mesmo nome do estado: aí "São Paulo" sozinho
// quase sempre quer dizer a capital, não o estado inteiro.
const CAPITAL_HOMONIMA = new Set(['SP', 'RJ']);

function capitalizar(texto) {
  return texto
    .split(/\s+/)
    .map((palavra, i) => {
      const limpa = palavra.toLowerCase();
      if (i > 0 && MINUSCULAS.has(semAcento(limpa))) return limpa;
      return limpa.charAt(0).toUpperCase() + limpa.slice(1);
    })
    .join(' ');
}

/**
 * "iracemapolis são Paulo" -> { cidade: 'Iracemapolis', uf: 'SP' }
 * "Brasília DF"            -> { cidade: 'Brasília', uf: 'DF' }
 * "sp"                     -> { cidade: null, uf: 'SP' }
 */
export function normalizarCidade(bruto, dddFallback = null) {
  let texto = String(bruto || '').replace(/[\/;|]/g, ' - ').replace(/\s+/g, ' ').trim();
  if (!texto) return { cidade: null, uf: dddFallback ? DDD_UF[dddFallback] ?? null : null, bruto: bruto || null };

  let uf = null;
  let eraNomeDeEstado = false;

  // 1) estado escrito por extenso, em qualquer posição
  for (const [nomeSemAcento, sigla] of Object.entries(NOME_PARA_UF)) {
    const regex = new RegExp(`(?:^|[\\s,-])(${nomeSemAcento})(?=[\\s,-]|$)`);
    const casa = regex.exec(dobrar(texto));   // dobrar preserva posições
    if (!casa) continue;
    uf = sigla;
    eraNomeDeEstado = true;
    const inicio = casa.index + casa[0].length - casa[1].length;
    texto = (texto.slice(0, inicio) + ' ' + texto.slice(inicio + nomeSemAcento.length))
      .replace(/\s+/g, ' ').trim();
    break;
  }

  // 2) sigla de UF sobrando no fim — inclusive depois do passo 1
  //    ("São Paulo sp" vira "" e não "Sp").
  for (let i = 0; i < 2; i++) {
    const casa = texto.match(/(?:^|[\s,-]+)([A-Za-z]{2})\s*$/);
    if (!casa || !UFS[casa[1].toUpperCase()]) break;
    uf ??= casa[1].toUpperCase();
    texto = texto.slice(0, casa.index).trim();
  }

  texto = texto.replace(/^[\s,-]+|[\s,-]+$/g, '');

  // Campo aberto = campo sujo. Duas coisas acontecem muito:
  //   "51", "72"  -> a pessoa digitou a idade
  //   "só mudar a atitude dos professores..." -> escreveu uma opinião
  // Nos dois casos não é cidade. O texto original fica em `bruto` e o
  // importador aproveita o desabafo como observação da ficha.
  const letras = (texto.match(/\p{L}/gu) || []).length;
  const palavras = texto.split(/\s+/).filter(Boolean).length;
  const pareceCidade = letras >= 3 && palavras <= 5 && texto.length <= 42;
  let cidade = pareceCidade ? capitalizar(texto) : null;
  const desabafo = !pareceCidade && palavras > 3 ? String(bruto).trim() : null;

  // "São Paulo" / "Rio de Janeiro" sozinhos: quase sempre é a capital.
  if (!cidade && eraNomeDeEstado && CAPITAL_HOMONIMA.has(uf)) cidade = UFS[uf];

  if (!uf && dddFallback) uf = DDD_UF[dddFallback] ?? null;

  return { cidade, uf, desabafo, bruto: String(bruto || '').trim() || null };
}

/** "professor(a)_ou_educador(a)" -> "Professor(a) ou educador(a)" */
export function normalizarAtuacao(bruto) {
  const texto = String(bruto || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!texto) return null;
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** "+55 11 94900-7524" -> "5511949007524" (sempre com DDI 55) */
export function normalizarTelefone(bruto) {
  let d = String(bruto || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (!d.startsWith('55') && d.length <= 11) d = `55${d}`;
  if (d.length < 12 || d.length > 13) return { telefone: d, valido: false };
  return { telefone: d, valido: true };
}

export const dddDe = (telefone) => Number(String(telefone || '').slice(2, 4)) || null;

export function nomeProprio(bruto) {
  const texto = String(bruto || '').replace(/\s+/g, ' ').trim();
  if (!texto) return null;
  // Se veio TODO EM CAIXA ALTA ou todo minúsculo, arruma; senão respeita o que a pessoa digitou.
  const precisaArrumar = texto === texto.toUpperCase() || texto === texto.toLowerCase();
  return precisaArrumar ? capitalizar(texto) : texto;
}

// ---------------------------------------------------------------------------
// Os abaixo-assinados da campanha. A chave é o form_id do Meta, que é estável.
// `temas` alimenta o motor de interesse: assinar já diz muito sobre a pessoa,
// mesmo antes dela escrever qualquer coisa no grupo.
// ---------------------------------------------------------------------------
export const ABAIXOS = {
  'f:1024024180552028': {
    chave: 'violencia-escolas',
    titulo: 'Pelo fim da violência nas escolas',
    bandeira: 'Educação preventiva',
    temas: ['seguranca', 'educacao', 'infancia_juventude']
  },
  'f:1463298645565400': {
    chave: 'psicologos-escolas',
    titulo: 'Psicólogos em tempo integral nas escolas',
    bandeira: 'Saúde mental',
    temas: ['saude', 'educacao', 'infancia_juventude']
  },
  'f:1708003377460963': {
    chave: 'pena-mais-dura',
    titulo: 'Pena mais dura e sem prescrição para quem abusa de crianças e adolescentes',
    bandeira: 'Proteção da infância',
    temas: ['infancia_juventude', 'seguranca']
  }
};

// Pistas para deduzir bandeira e temas de um formulário que ainda não está no
// mapa acima.
//
// POR QUE: `form_id` do Meta só existe depois do formulário publicado. Sem isto,
// o primeiro lote do Proteja Digital entraria com `temas: []` — ou seja, gente
// captada na bandeira mais forte da campanha chegava sem interesse nenhum
// registrado, e sem interesse não há recomendação de grupo nem segmentação.
// A ordem importa: o recorte mais específico vem primeiro.
const PISTAS_DE_ABAIXO = [
  {
    termos: ['proteja digital', 'protecao digital', 'digital', 'internet', 'online', 'tela', 'cyberbullying', 'rede social'],
    bandeira: 'Proteção digital da infância',
    temas: ['protecao_digital', 'infancia_juventude', 'seguranca']
  },
  {
    termos: ['inclusao', 'deficiencia', 'autis', 'atipic', 'neurodiver', 'pcd'],
    bandeira: 'Inclusão',
    temas: ['pcd', 'educacao', 'infancia_juventude']
  },
  {
    termos: ['quem cuida', 'profissional', 'profissionais', 'conselho tutelar', 'enfermag', 'agente de saude'],
    bandeira: 'Cuidar de quem cuida',
    temas: ['saude', 'educacao']
  },
  {
    termos: ['saude mental', 'psicolog', 'ansiedade', 'depressao', 'suicidio'],
    bandeira: 'Saúde mental',
    temas: ['saude', 'educacao', 'infancia_juventude']
  },
  {
    termos: ['familia', 'familias'],
    bandeira: 'Fortalecimento das famílias',
    temas: ['mulher', 'infancia_juventude', 'assistencia_social']
  },
  {
    termos: ['escola', 'educacao', 'professor', 'educador'],
    bandeira: 'Educação preventiva',
    temas: ['educacao', 'seguranca', 'infancia_juventude']
  },
  {
    termos: ['crianca', 'criancas', 'adolescente', 'infancia', 'abuso', 'pena', 'prescricao'],
    bandeira: 'Proteção da infância',
    temas: ['infancia_juventude', 'seguranca']
  },
  {
    termos: ['mulher', 'mulheres', 'violencia domestica', 'feminicidio', 'maria da penha'],
    bandeira: 'Mulher',
    temas: ['mulher', 'seguranca']
  }
];

/**
 * Fallback para formulários novos que ainda não estão no mapa acima.
 *
 * Quando o formulário do Meta entrar em produção, o certo é registrá-lo em
 * `ABAIXOS` com o `form_id` real (aparece na coluna `form_id` do CSV, no
 * formato `f:123...`) — a chave fica estável mesmo se o nome do anúncio mudar.
 * Até lá, a dedução por nome mantém o lead segmentado.
 */
export function definicaoDoAbaixo(formId, formName) {
  if (ABAIXOS[formId]) return { formId, ...ABAIXOS[formId] };

  const alvo = semAcento(formName || '');
  const pista = PISTAS_DE_ABAIXO.find((p) => p.termos.some((t) => alvo.includes(t)));

  return {
    formId,
    chave: semAcento(formName).replace(/[^a-z0-9]+/g, '-').slice(0, 48) || formId,
    titulo: formName || 'Abaixo-assinado sem nome',
    bandeira: pista?.bandeira ?? null,
    temas: pista?.temas ?? []
  };
}

// ---------------------------------------------------------------------------
// Leitor de CSV sem dependência. O Meta exporta com vírgula e aspas duplas.
// ---------------------------------------------------------------------------
export function lerCsv(texto) {
  const limpo = texto.replace(/^﻿/, '');
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroDeAspas = false;

  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (limpo[i + 1] === '"') { campo += '"'; i++; } else dentroDeAspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { dentroDeAspas = true; continue; }
    if (c === ',') { linha.push(campo); campo = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
    campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  if (!linhas.length) return [];

  const cabecalho = linhas[0].map((c) => c.trim());
  return linhas.slice(1)
    .filter((l) => l.some((c) => c.trim()))
    .map((l) => Object.fromEntries(cabecalho.map((c, i) => [c, (l[i] ?? '').trim()])));
}

/**
 * Aceita os nomes de coluna do Meta em português ou inglês — o export muda
 * conforme o idioma da conta.
 */
const APELIDOS = {
  id: ['id', 'lead_id'],
  criadoEm: ['created_time', 'created_at', 'data_de_criacao'],
  nome: ['full_name', 'nome_completo', 'name', 'nome'],
  telefone: ['whatsapp_number', 'phone_number', 'telefone', 'numero_de_telefone'],
  cidade: ['qual_sua_cidade?', 'qual_sua_cidade', 'city', 'cidade'],
  atuacao: ['você_atua_como:', 'voce_atua_como:', 'você_atua_como', 'voce_atua_como', 'atuacao'],
  email: ['email', 'e-mail'],
  formId: ['form_id'],
  formName: ['form_name'],
  campanha: ['campaign_name'],
  campanhaId: ['campaign_id'],
  anuncio: ['ad_name'],
  conjunto: ['adset_name'],
  plataforma: ['platform'],
  organico: ['is_organic'],
  status: ['lead_status']
};

export function extrairCampos(linha) {
  const chaves = Object.fromEntries(
    Object.keys(linha).map((k) => [semAcento(k).replace(/\s+/g, '_'), linha[k]])
  );
  const pegar = (nomes) => {
    for (const nome of nomes) {
      const valor = chaves[semAcento(nome).replace(/\s+/g, '_')];
      if (valor != null && valor !== '') return valor;
    }
    return null;
  };
  return Object.fromEntries(
    Object.entries(APELIDOS).map(([campo, nomes]) => [campo, pegar(nomes)])
  );
}

/** Transforma uma linha crua do Meta no registro que o sistema usa. */
export function prepararLead(linha) {
  const bruto = extrairCampos(linha);
  if (!bruto.telefone) return null;

  const tel = normalizarTelefone(bruto.telefone);
  if (!tel) return null;

  const ddd = dddDe(tel.telefone);
  const local = normalizarCidade(bruto.cidade, ddd);
  const criadoEm = bruto.criadoEm ? new Date(bruto.criadoEm).getTime() : Date.now();

  return {
    leadId: bruto.id || `${tel.telefone}-${criadoEm}`,
    telefone: tel.telefone,
    telefoneValido: tel.valido,
    nome: nomeProprio(bruto.nome),
    cidade: local.cidade,
    uf: local.uf,
    // Só guarda o texto original quando ele de fato virou uma cidade — assim a
    // ficha não mostra "cidade informada: 51" ao lado de uma cidade real vinda
    // de outra assinatura da mesma pessoa.
    cidadeBruta: local.cidade ? local.bruto : null,
    desabafo: local.desabafo,
    atuacao: normalizarAtuacao(bruto.atuacao),
    email: bruto.email || null,
    criadoEm: Number.isFinite(criadoEm) ? criadoEm : Date.now(),
    abaixo: definicaoDoAbaixo(bruto.formId, bruto.formName),
    campanha: bruto.campanha || null,
    anuncio: bruto.anuncio || null,
    conjunto: bruto.conjunto || null,
    plataforma: bruto.plataforma === 'ig' ? 'Instagram' : bruto.plataforma === 'fb' ? 'Facebook' : bruto.plataforma,
    organico: String(bruto.organico).toLowerCase() === 'true',
    status: bruto.status || null
  };
}

export { UFS, DDD_UF };
