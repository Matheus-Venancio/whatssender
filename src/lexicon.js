// Dicionário que traduz o que a pessoa escreve em temas e intenções.
// É o coração do "Interesse": tudo aqui é editável pela equipe da campanha,
// sem mexer no resto do sistema.

export const TEMAS = {
  saude: {
    rotulo: 'Saúde',
    cor: '#ef4444',
    termos: ['sus', 'posto de saude', 'ubs', 'upa', 'hospital', 'medico', 'medica', 'consulta',
      'exame', 'remedio', 'farmacia', 'fila do sus', 'especialista', 'dentista', 'vacina',
      'ambulancia', 'samu', 'saude mental', 'psicologo', 'psiquiatra', 'ansiedade', 'depressao',
      'agente de saude', 'enfermeira', 'enfermeiro', 'cirurgia']
  },
  educacao: {
    rotulo: 'Educação',
    cor: '#3b82f6',
    termos: ['escola', 'creche', 'professor', 'professora', 'aluno', 'alunos', 'merenda',
      'material escolar', 'vaga na creche', 'ensino', 'sala de aula', 'diretora', 'diretor',
      'apae', 'alfabetizacao', 'reforco escolar', 'faculdade', 'curso tecnico', 'bolsa de estudo',
      'transporte escolar', 'educacao infantil']
  },
  seguranca: {
    rotulo: 'Segurança',
    cor: '#0f172a',
    termos: ['assalto', 'roubo', 'furto', 'ladrao', 'policia', 'pm', 'guarda municipal', 'gcm',
      'camera', 'cameras', 'iluminacao', 'poste queimado', 'rua escura', 'trafico', 'droga',
      'boca de fumo', 'violencia', 'medo de sair', 'seguranca publica', 'viatura', 'ronda']
  },
  emprego_renda: {
    rotulo: 'Emprego e renda',
    cor: '#f59e0b',
    termos: ['emprego', 'desempregado', 'desempregada', 'vaga de emprego', 'curriculo', 'trabalho',
      'renda', 'mei', 'autonomo', 'autonoma', 'empreendedor', 'empreendedora', 'feira',
      'ambulante', 'comerciante', 'pequeno negocio', 'capacitacao', 'curso profissionalizante',
      'sine', 'carteira assinada', 'bico']
  },
  mulher: {
    rotulo: 'Mulher',
    cor: '#ec4899',
    termos: ['mulher', 'mulheres', 'mae solo', 'maes solo', 'violencia domestica', 'agressao',
      'medida protetiva', 'maria da penha', 'feminicidio', 'assedio', 'delegacia da mulher',
      'casa da mulher', 'empoderamento', 'coletivo de mulheres']
  },
  infancia_juventude: {
    rotulo: 'Infância e juventude',
    cor: '#8b5cf6',
    termos: ['crianca', 'criancas', 'adolescente', 'jovem', 'juventude', 'conselho tutelar',
      'bullying', 'abuso', 'protecao da infancia', 'primeira infancia', 'brinquedoteca',
      'praca para as criancas', 'atividade para jovens', 'estagio', 'jovem aprendiz', 'autismo',
      'tea', 'crianca atipica']
  },
  idoso: {
    rotulo: 'Pessoa idosa',
    cor: '#14b8a6',
    termos: ['idoso', 'idosa', 'terceira idade', 'aposentado', 'aposentada', 'inss', 'asilo',
      'casa de repouso', 'cuidador', 'cuidadora', 'melhor idade', 'passe do idoso', 'bengala',
      'fisioterapia']
  },
  mobilidade_infra: {
    rotulo: 'Mobilidade e infraestrutura',
    cor: '#64748b',
    termos: ['buraco', 'buraco na rua', 'asfalto', 'recape', 'calcada', 'onibus', 'ponto de onibus',
      'linha de onibus', 'passagem', 'tarifa', 'transporte publico', 'transito', 'semaforo',
      'lombada', 'faixa de pedestre', 'saneamento', 'esgoto', 'agua', 'enchente', 'alagamento',
      'lixo', 'coleta de lixo', 'entulho', 'praca abandonada', 'mato alto']
  },
  animais: {
    rotulo: 'Causa animal',
    cor: '#84cc16',
    termos: ['cachorro', 'cachorros', 'gato', 'gatos', 'animal abandonado', 'castracao',
      'castrar', 'protetora', 'protetor de animais', 'maus tratos', 'adocao de animais',
      'ong animal', 'veterinario', 'canil', 'resgate de animais']
  },
  cultura_esporte: {
    rotulo: 'Cultura e esporte',
    cor: '#f97316',
    termos: ['esporte', 'quadra', 'campo de futebol', 'time', 'treino', 'academia', 'ginasio',
      'projeto social', 'cultura', 'musica', 'banda', 'teatro', 'danca', 'artesanato', 'festival',
      'biblioteca', 'lei de incentivo', 'atleta']
  },
  fe_religiao: {
    rotulo: 'Fé e comunidade',
    cor: '#a855f7',
    termos: ['igreja', 'pastor', 'pastora', 'padre', 'missa', 'culto', 'celula', 'ministerio',
      'irmao', 'irma', 'deus', 'oracao', 'orar', 'abencoado', 'abencoada', 'terco', 'pastoral',
      'comunidade de fe', 'templo']
  },
  meio_ambiente: {
    rotulo: 'Meio ambiente',
    cor: '#22c55e',
    termos: ['arvore', 'arvores', 'poda', 'reciclagem', 'reciclavel', 'coleta seletiva',
      'nascente', 'rio', 'corrego', 'poluicao', 'area verde', 'parque', 'horta comunitaria',
      'sustentavel', 'catador', 'cooperativa de reciclagem']
  },
  assistencia_social: {
    rotulo: 'Assistência social',
    cor: '#06b6d4',
    termos: ['cesta basica', 'cras', 'creas', 'bolsa familia', 'cadunico', 'auxilio', 'doacao',
      'roupa', 'agasalho', 'pessoa em situacao de rua', 'fome', 'vulnerabilidade', 'bpc',
      'sopao', 'campanha do agasalho']
  },
  habitacao: {
    rotulo: 'Moradia',
    cor: '#d97706',
    termos: ['moradia', 'aluguel', 'casa propria', 'minha casa minha vida', 'regularizacao',
      'escritura', 'terreno', 'despejo', 'ocupacao', 'financiamento da casa', 'reforma da casa']
  },
  pcd: {
    rotulo: 'Pessoa com deficiência',
    cor: '#0ea5e9',
    termos: ['deficiencia', 'pcd', 'cadeirante', 'cadeira de rodas', 'acessibilidade', 'rampa',
      'libras', 'surdo', 'cego', 'baixa visao', 'laudo', 'terapia', 'fonoaudiologa',
      'terapia ocupacional', 'inclusao', 'aee']
  }
};

// Intenções: mais importantes que o tema para decidir o que fazer com a pessoa.
export const INTENCOES = {
  voluntario: {
    rotulo: 'Quer ajudar',
    cor: '#16a34a',
    peso: 3,
    termos: ['quero ajudar', 'posso ajudar', 'conta comigo', 'to dentro', 'tô dentro',
      'me coloco a disposicao', 'me coloca', 'como faco para ajudar', 'quero participar',
      'quero fazer parte', 'me chama', 'to junto', 'tô junto', 'disponivel', 'voluntario',
      'voluntaria', 'topo', 'me inscreve', 'quero ser voluntario']
  },
  multiplicador: {
    rotulo: 'Multiplicador',
    cor: '#2563eb',
    peso: 3,
    termos: ['ja compartilhei', 'compartilhei', 'mandei pro meu grupo', 'coloquei no status',
      'divulguei', 'passei pra galera', 'espalhei', 'chamei mais gente', 'trouxe uns amigos',
      'adicionei', 'convidei', 'postei', 'repassei']
  },
  lideranca: {
    rotulo: 'Liderança',
    cor: '#7c3aed',
    peso: 4,
    termos: ['sou presidente', 'presidente da associacao', 'sou lider', 'lidero', 'coordeno',
      'organizo', 'sou do conselho', 'diretora da', 'diretor da', 'representante do bairro',
      'sou sindica', 'sou sindico', 'associacao de moradores', 'sou pastor', 'sou pastora',
      'a frente do', 'minha equipe', 'meu grupo tem', 'tenho um grupo', 'administro']
  },
  demanda: {
    rotulo: 'Trouxe uma demanda',
    cor: '#f59e0b',
    peso: 2,
    termos: ['preciso de ajuda', 'to precisando', 'tô precisando', 'alguem sabe', 'alguém sabe',
      'como faco', 'como faço', 'onde consigo', 'nao consigo', 'não consigo', 'ta dificil',
      'tá difícil', 'reclamacao', 'ja pedi e nada', 'ninguem resolve', 'ninguém resolve',
      'abandonado', 'sem resposta', 'me ajuda', 'socorro', 'urgente']
  },
  evento: {
    rotulo: 'Vai a eventos',
    cor: '#0891b2',
    peso: 2,
    termos: ['vou estar', 'estarei', 'confirmo presenca', 'confirmado', 'que horas', 'onde vai ser',
      'me passa o endereco', 'to indo', 'tô indo', 'estive la', 'estive lá', 'foi otimo',
      'adorei o encontro', 'confirmo presença', 'vou sim']
  },
  critico: {
    rotulo: 'Crítico / atrito',
    cor: '#dc2626',
    peso: 1,
    termos: ['nao acredito em politico', 'todo politico', 'so promessa', 'só promessa',
      'mentira', 'enganacao', 'nao vou votar', 'sai desse grupo', 'me tira do grupo',
      'para de mandar', 'spam', 'chega de politica']
  }
};

const ACENTOS = /[̀-ͯ]/g;

export function normalizar(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(ACENTOS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Um regex por dicionário, com fronteira de palavra, compilado uma vez.
function compilar(dicionario) {
  const mapa = new Map();
  for (const [chave, def] of Object.entries(dicionario)) {
    const alternativas = def.termos.map((t) => escapar(normalizar(t))).join('|');
    mapa.set(chave, new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternativas})(?![\\p{L}\\p{N}])`, 'gu'));
  }
  return mapa;
}

const REGEX_TEMAS = compilar(TEMAS);
const REGEX_INTENCOES = compilar(INTENCOES);

/**
 * Classifica um texto retornando os temas e intenções encontrados.
 * Casamento com fronteira de palavra: "cego" não casa dentro de "cegonha".
 */
export function classificarTexto(texto) {
  const t = normalizar(texto);
  const temas = [];
  const intencoes = [];
  if (!t) return { temas, intencoes };

  for (const [chave, regex] of REGEX_TEMAS) {
    regex.lastIndex = 0;
    const acertos = (t.match(regex) || []).length;
    if (acertos > 0) temas.push({ tema: chave, acertos });
  }

  for (const [chave, regex] of REGEX_INTENCOES) {
    regex.lastIndex = 0;
    if (regex.test(t)) intencoes.push({ intencao: chave, peso: INTENCOES[chave].peso });
  }

  return { temas, intencoes };
}

export const rotuloTema = (chave) => TEMAS[chave]?.rotulo ?? chave;
export const corTema = (chave) => TEMAS[chave]?.cor ?? '#94a3b8';
