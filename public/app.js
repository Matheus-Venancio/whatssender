// Painel da rede de apoio. Sem framework e sem build: o servidor entrega
// este arquivo direto. Toda a leitura vem de /api.

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const conteudo = $('#conteudo');
const gaveta = $('#gaveta');
const overlay = $('#overlay');

const estado = {
  vista: 'panorama',
  panorama: null,
  config: null,
  filtros: { busca: '', faixa: '', grupo: '', tema: '', intencao: '', cadastro: '', tag: '', abaixo: '', uf: '', semGrupo: '', apoio: '', origem: '', ordenar: 'engajamento', pagina: 1, porPagina: 25 },
  lista: null,
  fila: null,
  whatsapp: null,
  pessoaAberta: null,
  inbox: { filtro: '', busca: '', mostrandoThread: false },
  conversaAberta: null,
  adicionar: null,
  usuario: null,
  campanha: null,
  campanhas: [],
  permissoes: {}
};

// ------------------------------------------------------------------ utilidades
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const num = (n) => new Intl.NumberFormat('pt-BR').format(n ?? 0);

function quando(ts) {
  if (!ts) return null;
  const dif = Date.now() - ts;
  const min = Math.floor(dif / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ontem';
  if (d < 30) return `há ${d} dias`;
  const m = Math.floor(d / 30);
  return m < 12 ? `há ${m} ${m === 1 ? 'mês' : 'meses'}` : `há ${Math.floor(m / 12)} ano(s)`;
}

const dataCurta = (ts) => ts
  ? new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' })
  : '—';

const PALETA_AVATAR = ['#5b21b6', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#db2777', '#7c3aed'];
function corDoNome(nome) {
  let h = 0;
  for (const c of String(nome)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return PALETA_AVATAR[h % PALETA_AVATAR.length];
}
function iniciais(nome) {
  const partes = String(nome || '?').trim().split(/\s+/);
  return ((partes[0]?.[0] || '') + (partes.length > 1 ? partes.at(-1)[0] : '')).toUpperCase();
}

const corFaixa = (faixa) => estado.config?.cores_faixa?.[faixa] || '#94a3b8';
const corApoio = (faixa) => estado.config?.cores_apoio?.[faixa] || '#94a3b8';

function badgeFaixa(faixa) {
  const cor = corFaixa(faixa);
  return `<span class="faixa-badge" style="background:${cor}1a;color:${cor}">${esc(faixa || '—')}</span>`;
}

function chip(rotulo, cor, extra = '') {
  return `<span class="chip" style="background:${cor}14;color:${cor};border-color:${cor}2e" ${extra}>${esc(rotulo)}</span>`;
}

async function api(caminho, opcoes) {
  const r = await fetch(`/api${caminho}`, {
    headers: {
      'Content-Type': 'application/json',
      // Toda chamada declara em qual campanha está trabalhando.
      ...(estado.campanha ? { 'x-campanha': estado.campanha.slug } : {})
    },
    ...opcoes,
    body: opcoes?.body ? JSON.stringify(opcoes.body) : undefined
  });
  if (r.status === 401) { location.href = '/login'; return {}; }
  if (r.status === 403) {
    const erro = await r.json().catch(() => ({}));
    toast('Sem permissão', erro.erro || 'Seu acesso não permite essa ação.', 'critico');
    return { erro: erro.erro || 'sem permissão' };
  }
  return r.json();
}

const podeFazer = (acao) => Boolean(estado.permissoes?.[acao]);

const queryFiltros = () => new URLSearchParams(
  Object.entries(estado.filtros).filter(([, v]) => v !== '' && v != null)
).toString();

// ---------------------------------------------------------------------- vistas
const VISTAS = {};

// ============================================================ PANORAMA
VISTAS.panorama = async () => {
  const p = estado.panorama = await api('/panorama');
  estado.config ??= await api('/config');

  $('#conta-pessoas').textContent = num(p.pessoas);
  $('#conta-grupos').textContent = num(p.grupos);
  $('#conta-coletar').textContent = num(p.captadas_indicacao || 0);

  $('#conta-abaixos').textContent = num(p.abaixos.length);
  pintarAlertas(p.alertas);

  const pctCadastro = p.pessoas ? Math.round((p.cadastradas / p.pessoas) * 100) : 0;
  const pctNoGrupo = p.cadastradas
    ? Math.round(((p.cadastradas - p.assinantes_sem_grupo) / p.cadastradas) * 100) : 0;
  const serieVisivel = p.grupos === 0 ? p.serie_assinaturas : p.serie_mensagens;
  const maxSerie = Math.max(1, ...serieVisivel);
  const totalFaixas = p.faixas.reduce((s, f) => s + f.n, 0) || 1;
  const ordemFaixas = ['Embaixador', 'Ativo', 'Morno', 'Observador', 'Adormecido'];
  const faixas = ordemFaixas
    .map((nome) => ({ nome, n: p.faixas.find((f) => f.faixa === nome)?.n || 0 }))
    .filter((f) => f.n > 0);

  const maxTema = Math.max(1, ...p.temas.map((t) => t.pessoas));
  const intencoes = Object.entries(p.intencoes).filter(([, v]) => v.n > 0).sort((a, b) => b[1].n - a[1].n);

  const semWhatsapp = p.grupos === 0;

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Panorama da rede</h2>
        <p>${num(p.pessoas)} pessoas · ${num(p.assinaturas)} assinaturas${
          semWhatsapp ? ' · WhatsApp ainda não conectado'
            : ` · ${p.grupos} grupos · ${num(p.mensagens)} mensagens lidas`}</p>
      </div>
      <div class="acoes">
        <button class="btn" data-acao="recalcular">↻ Recalcular perfis</button>
        <button class="btn primario" data-vista="pessoas">Ver todas as pessoas</button>
      </div>
    </div>

    ${semWhatsapp ? `
      <div class="alerta info" style="margin-bottom:16px">
        <b>A base dos abaixo-assinados já está em produção.</b>
        Falta conectar o WhatsApp para começar a medir participação, interesse por conversa
        e saída de grupo — hoje todo mundo aparece como <i>Observador</i> porque ainda não há
        nenhum grupo sendo lido.
        <button class="btn primario" style="margin-top:10px" data-vista="conexao">Conectar WhatsApp agora</button>
      </div>` : ''}

    <div class="grade g-kpi" style="margin-bottom:16px">
      ${kpi('Pessoas na base', num(p.pessoas), `${num(p.novos_7d)} nova(s) nos últimos 7 dias`)}
      ${kpi('Assinaturas', num(p.assinaturas), `${num(p.abaixos.length)} abaixo-assinados · ${num(p.assinaturas - p.cadastradas)} pessoa(s) assinaram mais de um`)}
      ${kpi('Já estão em grupo', `${pctNoGrupo}%`, p.assinantes_sem_grupo
        ? `<b style="color:#dc2626">${num(p.assinantes_sem_grupo)}</b> assinaram e não estão em nenhum grupo`
        : 'toda a base assinante está em algum grupo')}
      ${kpi('Ativos (7 dias)', num(p.ativos_7d), `${Math.round((p.ativos_7d / (p.pessoas || 1)) * 100)}% da base falou essa semana`)}
      ${kpi('Perfil preenchido', `${p.completude_media}%`, 'média de completude das fichas')}
      ${kpi('Saídas de grupo (30d)', num(p.saidas_30d), p.alertas.total
        ? `<b style="color:#dc2626">${num(p.alertas.total)}</b> alerta(s) não lido(s)`
        : 'nenhum alerta pendente')}
    </div>

    ${p.abaixos.length ? `
    <section class="card" style="margin-bottom:16px">
      <header><h3>Abaixo-assinados em campanha</h3><span class="dica">clique para filtrar as pessoas</span></header>
      <div class="corpo grade g-3">
        ${p.abaixos.map((a) => `
          <div class="abaixo-card" data-filtro-abaixo="${esc(a.chave)}" style="cursor:pointer">
            <div>
              ${a.bandeira ? chip(a.bandeira, '#5b21b6') : ''}
              <div class="titulo" style="margin-top:7px">${esc(a.titulo)}</div>
            </div>
            <div class="numeros">
              <div><b>${num(a.assinaturas)}</b> assinaturas</div>
              <div><b>${num(a.ja_no_grupo)}</b> já no grupo</div>
              <div><b>${num(a.instagram)}</b> via Instagram</div>
            </div>
            <div class="barra"><i style="width:${(a.ja_no_grupo / (a.assinaturas || 1)) * 100}%;background:var(--verde)"></i></div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              ${a.temas.map((t) => chip(t.rotulo, t.cor)).join('')}
            </div>
          </div>`).join('')}
      </div>
    </section>` : ''}

    <div class="grade g-2" style="margin-bottom:16px">
      <section class="card">
        <header><h3>${semWhatsapp ? 'Assinaturas por dia · 30 dias' : 'Movimento dos grupos · 30 dias'}</h3>
          <span class="dica">${semWhatsapp ? 'captação por anúncio' : 'mensagens por dia'}</span></header>
        <div class="corpo">
          ${serieVisivel.some(Boolean) ? `
            <div class="sparkline" style="height:120px">
              ${serieVisivel.map((v, i) => `<i class="${i >= 23 ? 'forte' : ''}" style="height:${Math.max(3, (v / maxSerie) * 100)}%" title="${v}"></i>`).join('')}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--tinta-4);margin-top:8px">
              <span>30 dias atrás</span><span>última semana</span>
            </div>`
          : '<p class="vazio" style="padding:34px 0;text-align:center">Sem movimento nos últimos 30 dias.</p>'}
        </div>
      </section>

      <section class="card">
        <header><h3>Classificação de participação</h3></header>
        <div class="corpo">
          <div class="empilhada">
            ${faixas.map((f) => `<span style="flex:${f.n};background:${corFaixa(f.nome)}" title="${f.nome}: ${f.n}">${(f.n / totalFaixas) > .09 ? f.n : ''}</span>`).join('')}
          </div>
          <div class="legenda">
            ${faixas.map((f) => `
              <span class="item" data-filtro-faixa="${esc(f.nome)}">
                <i class="cor" style="background:${corFaixa(f.nome)}"></i>${esc(f.nome)}
                <b style="color:var(--tinta)">${f.n}</b>
              </span>`).join('')}
          </div>
          <p style="font-size:12px;color:var(--tinta-3);margin:14px 0 0;line-height:1.5">
            ${semWhatsapp
              ? 'A classificação mede participação nos grupos. Enquanto o WhatsApp não estiver conectado, todo mundo fica como <b>Observador</b> — a régua só começa a rodar quando as mensagens chegam.'
              : 'O <b>Embaixador</b> fala, é respondido e está em vários grupos. O <b>Observador</b> entrou e nunca escreveu — costuma ser a maior fatia e o maior potencial escondido da rede.'}
          </p>
        </div>
      </section>
    </div>

    <div class="grade g-2" style="margin-bottom:16px">
      <section class="card">
        <header><h3>O que a rede quer resolver</h3><span class="dica">clique para filtrar</span></header>
        <div class="corpo">
          <div class="barras-h">
            ${p.temas.slice(0, 10).map((t) => `
              <div class="barra-h" data-filtro-tema="${esc(t.tema)}">
                <span class="rot">${esc(t.rotulo)}</span>
                <span class="barra"><i style="width:${(t.pessoas / maxTema) * 100}%;background:${t.cor}"></i></span>
                <span class="n">${t.pessoas}</span>
              </div>`).join('')}
          </div>
        </div>
      </section>

      <section class="card">
        <header><h3>Sinais para agir</h3><span class="dica">extraídos das mensagens</span></header>
        <div class="corpo" style="display:grid;gap:9px">
          ${intencoes.length ? intencoes.map(([chave, v]) => `
            <div class="barra-h" data-filtro-intencao="${esc(chave)}" style="grid-template-columns:1fr auto">
              <span class="rot">${chip(v.rotulo, v.cor)}</span>
              <span class="n" style="font-weight:650;color:var(--tinta)">${v.n}</span>
            </div>`).join('')
          : `<p class="vazio" style="padding:8px 0">Nenhum sinal ainda — eles nascem do que as pessoas escrevem nos grupos.</p>`}
          <p style="font-size:12px;color:var(--tinta-3);margin:6px 0 0;line-height:1.5">
            Cada sinal vem de expressões reais no grupo — “conta comigo”, “já compartilhei”,
            “sou presidente da associação”. É o que transforma conversa em lista de tarefas.
          </p>
        </div>
      </section>
    </div>

    <div class="grade g-2">
      <section class="card">
        <header><h3>Onde a rede está</h3><span class="dica">cidade e estado</span></header>
        <div class="corpo">
          ${p.ufs.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:16px">
            ${p.ufs.map((u) => `<span class="chip clicavel" data-filtro-uf="${esc(u.uf)}"
              style="background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe">${esc(u.uf)} <b>${u.n}</b></span>`).join('')}
          </div>` : ''}
          <div class="barras-h">
            ${p.cidades.map((c) => `
              <div class="barra-h">
                <span class="rot">${esc(c.cidade)}</span>
                <span class="barra"><i style="width:${(c.n / p.cidades[0].n) * 100}%;background:var(--azul)"></i></span>
                <span class="n">${c.n}</span>
              </div>`).join('') || '<p class="vazio">Ninguém preencheu cidade ainda.</p>'}
          </div>
        </div>
      </section>
      <section class="card">
        <header><h3>Quem é a rede</h3><span class="dica">atuação declarada</span></header>
        <div class="corpo">
          <div class="barras-h">
            ${p.atuacoes.slice(0, 9).map((a) => `
              <div class="barra-h">
                <span class="rot" title="${esc(a.atuacao)}">${esc(a.atuacao)}</span>
                <span class="barra"><i style="width:${(a.n / p.atuacoes[0].n) * 100}%;background:var(--laranja)"></i></span>
                <span class="n">${a.n}</span>
              </div>`).join('') || '<p class="vazio">Ninguém preencheu atuação ainda.</p>'}
          </div>
        </div>
      </section>
    </div>
  `;
};

const kpi = (rotulo, valor, nota) => `
  <div class="card kpi">
    <div class="rotulo">${rotulo}</div>
    <div class="valor">${valor}</div>
    <div class="nota">${nota}</div>
  </div>`;

// ============================================================ PESSOAS
VISTAS.pessoas = async () => {
  estado.config ??= await api('/config');
  estado.panorama ??= await api('/panorama');
  const p = estado.panorama;
  const dados = estado.lista = await api(`/pessoas?${queryFiltros()}`);
  const f = estado.filtros;

  const opcoes = (lista, atual, vazio) =>
    `<option value="">${vazio}</option>` +
    lista.map(([v, r]) => `<option value="${esc(v)}" ${atual === v ? 'selected' : ''}>${esc(r)}</option>`).join('');

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Pessoas da rede</h2>
        <p>${num(dados.total)} pessoa(s) no filtro atual · a ficha de cada uma abre com um clique</p>
      </div>
      <div class="acoes">
        <a class="btn" href="/api/export.csv?${queryFiltros()}">⬇ Exportar CSV</a>
        <button class="btn primario" data-vista="fila">🎯 Fila de ação</button>
      </div>
    </div>

    <div class="filtros">
      <input type="search" id="busca" placeholder="Buscar por nome, telefone, cidade ou atuação…" value="${esc(f.busca)}">
      <select id="fx-faixa">${opcoes(estado.config.faixas.map((x) => [x, x]), f.faixa, 'Toda classificação')}</select>
      <select id="fx-grupo">${opcoes(p.grupos_lista.map((g) => [String(g.id), g.nome]), f.grupo, 'Todos os grupos')}</select>
      <select id="fx-tema">${opcoes(Object.entries(estado.config.temas).map(([k, v]) => [k, v.rotulo]), f.tema, 'Todo interesse')}</select>
      <select id="fx-intencao">${opcoes(Object.entries(estado.config.intencoes).map(([k, v]) => [k, v.rotulo]), f.intencao, 'Todo sinal')}</select>
      <select id="fx-abaixo">${opcoes(p.abaixos.map((a) => [a.chave, a.titulo]), f.abaixo, 'Todo abaixo-assinado')}</select>
      <select id="fx-uf">${opcoes(p.ufs.map((u) => [u.uf, `${u.uf} (${u.n})`]), f.uf, 'Todo estado')}</select>
      <select id="fx-apoio">${opcoes((estado.config.faixas_apoio || []).map((x) => [x, x]), f.apoio, 'Toda propensão')}</select>
      <select id="fx-origem">${opcoes([['contato','Contato do celular'],['grupo','Veio de grupo'],['abaixo-assinado','Assinou'],['formulario_pautas','Formulário']], f.origem, 'Toda origem')}</select>
      <select id="fx-cadastro">${opcoes([['sim', 'Só quem assinou'], ['nao', 'Só quem falta assinar']], f.cadastro, 'Cadastro: todos')}</select>
      <select id="fx-semGrupo">${opcoes([['sim', 'Fora dos grupos']], f.semGrupo, 'Grupo: todos')}</select>
      <select id="fx-ordenar">${opcoes([
        ['engajamento', 'Mais engajados'], ['recentes', 'Falaram por último'],
        ['antigos', 'Sumiram há mais tempo'], ['completude', 'Fichas mais incompletas'],
        ['novos', 'Entraram recentemente'], ['nome', 'Nome A–Z']
      ], f.ordenar, '')}</select>
      ${Object.values({ ...f, ordenar: '', pagina: '', porPagina: '' }).some(Boolean)
        ? '<button class="btn fantasma" data-acao="limpar-filtros">limpar filtros</button>' : ''}
    </div>

    <section class="card">
      <div class="tabela-rolagem">
      <table class="tabela">
        <thead>
          <tr>
            <th>Pessoa</th><th>Cidade</th><th>Atuação</th>
            <th>Última resposta no grupo</th><th>Chance de apoiar</th><th>Classificação</th><th>Interesse</th>
          </tr>
        </thead>
        <tbody>
          ${dados.itens.map(linhaPessoa).join('') || '<tr><td colspan="6" style="padding:40px;text-align:center" class="vazio">Nenhuma pessoa com esses filtros.</td></tr>'}
        </tbody>
      </table>
      </div>
      <div class="paginacao">
        <button class="btn" data-pagina="${dados.pagina - 1}" ${dados.pagina <= 1 ? 'disabled' : ''}>‹ anterior</button>
        <span>página ${dados.pagina} de ${dados.paginas}</span>
        <button class="btn" data-pagina="${dados.pagina + 1}" ${dados.pagina >= dados.paginas ? 'disabled' : ''}>próxima ›</button>
        <span style="margin-left:auto">${num(dados.total)} resultado(s)</span>
      </div>
    </section>
  `;

  $('#busca').addEventListener('input', debounce((e) => {
    estado.filtros.busca = e.target.value;
    estado.filtros.pagina = 1;
    render();
  }, 280));

  for (const [id, chave] of [['#fx-faixa', 'faixa'], ['#fx-grupo', 'grupo'], ['#fx-tema', 'tema'],
    ['#fx-intencao', 'intencao'], ['#fx-cadastro', 'cadastro'], ['#fx-ordenar', 'ordenar'],
    ['#fx-abaixo', 'abaixo'], ['#fx-uf', 'uf'], ['#fx-semGrupo', 'semGrupo'],
    ['#fx-apoio', 'apoio'], ['#fx-origem', 'origem']]) {
    $(id).addEventListener('change', (e) => {
      estado.filtros[chave] = e.target.value;
      estado.filtros.pagina = 1;
      render();
    });
  }
};

function linhaPessoa(x) {
  const cor = corDoNome(x.exibicao);
  const semNome = !x.nome;
  return `
    <tr data-pessoa="${x.id}">
      <td>
        <div class="pessoa-celula">
          <span class="avatar" style="background:${cor}">${esc(iniciais(x.exibicao))}</span>
          <span>
            <span class="nome">${esc(x.exibicao)}</span>
            ${semNome ? '<span class="chip" style="background:#fef3c7;color:#92400e;margin-left:6px">só WhatsApp</span>' : ''}
            <span class="sub" style="display:block">${esc(x.telefone_fmt)}</span>
          </span>
        </div>
      </td>
      <td>${x.cidade
          ? esc(x.cidade) + (x.uf ? `<span class="sub" style="display:block">${esc(x.uf)}${x.bairro ? ` · ${esc(x.bairro)}` : ''}</span>` : '')
          : x.uf ? `${esc(x.uf)}<span class="sub" style="display:block">cidade não informada</span>`
            : '<span class="vazio">não preencheu</span>'}</td>
      <td>${x.atuacao ? esc(x.atuacao) : '<span class="vazio">não preencheu</span>'}</td>
      <td class="ultima-msg">
        ${x.ultima_msg_texto
          ? `<div class="txt">${esc(x.ultima_msg_texto)}</div>
             <div class="meta">${quando(x.ultima_msg_ts)} · ${esc(x.ultima_msg_grupo || '')}</div>`
          : x.grupos.length
            ? '<span class="vazio">está no grupo e nunca escreveu</span>'
            : '<span class="vazio">ainda não está em nenhum grupo</span>'}
      </td>
      <td style="min-width:150px">
        ${x.faixa_apoio ? `
          <span class="faixa-badge" style="background:${corApoio(x.faixa_apoio)}1a;color:${corApoio(x.faixa_apoio)}">
            ${esc(x.faixa_apoio)}
          </span>
          <div style="margin-top:6px">
            <span class="barra" style="display:block"><i style="width:${x.propensao || 0}%;background:${corApoio(x.faixa_apoio)}"></i></span>
            <span class="sub">${x.propensao || 0}/100${x.na_agenda ? ' · na agenda' : ''}</span>
          </div>
          ${x.motivos_apoio?.length ? `<div class="sub" style="margin-top:4px;line-height:1.35">${esc(x.motivos_apoio[0])}</div>` : ''}
        ` : '<span class="vazio">—</span>'}
      </td>
      <td style="min-width:130px">
        ${badgeFaixa(x.faixa)}
        <div style="margin-top:7px">
          <span class="barra" style="display:block"><i style="width:${x.engajamento || 0}%;background:${corFaixa(x.faixa)}"></i></span>
          <span class="sub">${x.engajamento || 0}/100 · ${num(x.msgs_total)} msgs</span>
        </div>
      </td>
      <td style="min-width:200px">
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${x.tema_principal_rotulo ? chip(x.tema_principal_rotulo, x.tema_principal_cor) : '<span class="vazio">sem sinal ainda</span>'}
          ${x.intencoes_rotulos.slice(0, 2).map((i) => chip(i.rotulo, i.cor)).join('')}
        </div>
        ${x.abaixos.length ? `<div class="sub" style="margin-top:5px">✍️ ${x.abaixos.length === 1
            ? esc(x.abaixos[0].bandeira || x.abaixos[0].titulo.slice(0, 34))
            : `assinou ${x.abaixos.length} abaixo-assinados`}</div>` : ''}
      </td>
    </tr>`;
}

// ============================================================ FILA DE AÇÃO
// ============================================== POTENCIAL DE APOIO
//
// Responde uma pergunta só: dos contatos que existem nesta base, quem tem
// chance real de entrar num grupo de apoio?
//
// A leitura é da conversa, não do cadastro. Quem troca mensagem nos DOIS
// sentidos e em tom positivo sobe; quem só recebe da campanha, quem responde
// mal ou quem já gerou atrito não entra. Ver PESOS_APOIO em scoring.js.
VISTAS.apoio = async () => {
  const faixa = estado.filtroApoio ?? 'Provável apoiador';
  const [dados, resumo] = await Promise.all([
    api(`/pessoas?ordenar=propensao&porPagina=50${faixa ? `&apoio=${encodeURIComponent(faixa)}` : ''}`),
    api('/panorama')
  ]);

  const porFaixa = Object.fromEntries((resumo.apoio || []).map((x) => [x.faixa, x.n]));
  const total = Object.values(porFaixa).reduce((a, b) => a + b, 0);
  const elConta = $('#conta-apoio');
  if (elConta) elConta.textContent = num(porFaixa['Provável apoiador'] || 0);

  const faixas = estado.config?.faixas_apoio || [];

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Potencial de apoio</h2>
        <p>${num(total)} contato(s) analisados pelas conversas. A classificação lê troca real de
           mensagens e tom — não lista de transmissão.</p>
      </div>
      <div class="acoes">
        <button class="btn" data-acao="reclassificar">↻ Reclassificar agora</button>
      </div>
    </div>

    <div class="grade g-kpi" style="margin-bottom:16px">
      ${faixas.map((f) => `
        <button class="kpi" data-faixa-apoio="${esc(f)}"
                style="text-align:left;cursor:pointer;border:1px solid ${f === faixa ? corApoio(f) : 'var(--linha)'}">
          <div class="rotulo" style="color:${corApoio(f)}">${esc(f)}</div>
          <div class="valor">${num(porFaixa[f] || 0)}</div>
        </button>`).join('')}
    </div>

    <section class="card">
      <header>
        <h3>${esc(faixa || 'Todos')}</h3>
        <span class="dica">${num(dados.total)} pessoa(s) · mais provável primeiro</span>
      </header>
      <div class="corpo" style="padding-top:6px">
        ${dados.itens.length ? dados.itens.map((x) => `
          <div class="fila-item" data-pessoa="${x.id}">
            <span class="avatar" style="background:${corDoNome(x.exibicao)}">${esc(iniciais(x.exibicao))}</span>
            <span style="min-width:0;flex:1">
              <div class="nome">${esc(x.exibicao)}${x.na_agenda ? ' <span class="dica">· na agenda</span>' : ''}</div>
              <div class="porque">${esc((x.motivos_apoio || []).join(' · ') || 'sem sinal registrado')}</div>
            </span>
            <span style="display:flex;align-items:center;gap:10px;margin-left:auto">
              <b style="font-variant-numeric:tabular-nums;color:${corApoio(x.faixa_apoio)}">${x.propensao ?? 0}</b>
              <span class="chip" style="background:${corApoio(x.faixa_apoio)}22;color:${corApoio(x.faixa_apoio)}">${esc(x.faixa_apoio || '—')}</span>
            </span>
          </div>`).join('')
        : `<p class="vazio">Ninguém nesta faixa ainda. ${
            total ? 'Escolha outra faixa acima.'
                  : 'Conecte o WhatsApp: a classificação nasce das conversas.'}</p>`}
      </div>
    </section>

    <div class="alerta info" style="margin-top:14px">
      <b>Como o número é formado.</b> Conversa nos dois sentidos pesa mais que volume:
      quarenta mensagens só da campanha para alguém que nunca respondeu não é apoio,
      é incômodo. Tom positivo no privado sobe até 25%; tom negativo derruba.
      Quem gerou atrito vai para <b>Não abordar</b> e nunca entra em fila de adição.
    </div>`;
};

// ================================================== TRANSMISSÃO
//
// Disparo privado, um a um. A tela existe tanto para operar quanto para deixar
// visível o que o sistema RECUSA — é a recusa que protege a campanha.

VISTAS.fila = async () => {
  const f = estado.fila = await api('/fila');

  const coluna = (titulo, dica, itens, porque) => `
    <section class="card">
      <header><h3>${titulo}</h3><span class="dica">${itens.length}</span></header>
      <div class="corpo" style="padding-top:4px">
        <p style="font-size:12px;color:var(--tinta-3);margin:6px 0 10px;line-height:1.5">${dica}</p>
        ${itens.map((x) => `
          <div class="fila-item" data-pessoa="${x.id}">
            <span class="avatar" style="background:${corDoNome(x.exibicao)}">${esc(iniciais(x.exibicao))}</span>
            <span style="min-width:0">
              <div class="nome">${esc(x.exibicao)}</div>
              <div class="porque">${porque(x)}</div>
            </span>
            <span style="margin-left:auto">${badgeFaixa(x.faixa)}</span>
          </div>`).join('') || '<p class="vazio">Nada pendente aqui. 👏</p>'}
      </div>
    </section>`;

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Fila de ação</h2>
        <p>O sistema não entrega só relatório: entrega a lista de quem tocar hoje, e por quê.</p>
      </div>
    </div>
    <div class="colunas-fila">
      ${coluna('🚪 Assinaram e não estão em grupo',
        'Já disseram sim publicamente e continuam fora da rede. É a conversão mais barata que existe: mandar o convite do grupo.',
        f.foraDoGrupo, (x) => `${esc(x.abaixos.map((a) => a.bandeira || a.titulo).join(' · ') || 'assinou')} · ${esc(x.local || 'sem local')}`)}

      ${coluna('⚠️ Saíram dos grupos',
        'Não estão mais em nenhum grupo. Vale entender o motivo antes de reconvidar — principalmente quem participava.',
        f.saidas, (x) => `${esc(x.faixa)} · ${num(x.msgs_total)} mensagens · ${esc(x.local || 'sem local')}`)}

      ${coluna('🤝 Se ofereceram para ajudar',
        'Escreveram “conta comigo”, “quero participar” ou se apresentaram como liderança. Prioridade máxima: contato individual em até 48h.',
        f.oportunidades, (x) => `${esc(x.intencoes_rotulos.map((i) => i.rotulo).join(' · '))} · ${esc(x.cidade || 'cidade não informada')}`)}

      ${coluna('📝 Engajados sem cadastro',
        'Participam bastante mas nunca preencheram o abaixo-assinado. São nomes que a campanha ainda não “tem”.',
        f.semCadastro, (x) => `engajamento ${x.engajamento} · ${num(x.msgs_total)} mensagens · falta nome, cidade e atuação`)}

      ${coluna('🌡️ Esfriando',
        'Já foram ativos e pararam de falar. Reativar quem já gostava custa muito menos que conquistar alguém novo.',
        f.esfriando, (x) => `${x.dias_sem_falar} dias em silêncio · era ativo com ${num(x.msgs_total)} mensagens`)}

      ${coluna('🆘 Demandas em aberto',
        'Trouxeram um problema concreto no grupo. Cada retorno dado aqui vira relato de caso resolvido.',
        f.demandas, (x) => `${esc(x.tema_principal_rotulo || 'demanda')} · ${esc((x.ultima_msg_texto || '').slice(0, 60))}`)}
    </div>`;
};

// ============================================================ CONVERSAS
const CORES_SENTIMENTO = {
  positivo: '#16a34a', neutro: '#94a3b8', negativo: '#f59e0b', critico: '#dc2626'
};
const ROTULOS_SENTIMENTO = {
  positivo: 'Clima positivo', neutro: 'Clima neutro',
  negativo: 'Clima negativo', critico: 'Atenção — risco'
};
const CORES_TOM = { acolhedor: '#16a34a', direto: '#2563eb', formal: '#64748b' };

const ABAS_INBOX = [
  ['', 'Tudo'], ['nao_lidas', 'Não lidas'], ['aguardando', 'Aguardando resposta'],
  ['privadas', 'Privadas'], ['grupos', 'Grupos'], ['atrito', 'Atrito']
];

VISTAS.conversas = async () => {
  const { itens, contagem } = await api(
    `/conversas?filtro=${estado.inbox.filtro}&busca=${encodeURIComponent(estado.inbox.busca)}`
  );
  pintarConversas(contagem);

  // Abre a primeira conversa que precisa de resposta, se nada estiver selecionado.
  if (!estado.conversaAberta && itens.length) {
    const alvo = itens.find((c) => c.nao_lidas > 0) || itens.find((c) => c.aguardando) || itens[0];
    estado.conversaAberta = { tipo: alvo.tipo, id: alvo.tipo === 'grupo' ? alvo.grupo_id : alvo.pessoa_id };
  }

  conteudo.innerHTML = `
    <div class="cabecalho" style="margin-bottom:16px">
      <div>
        <h2>Conversas</h2>
        <p>${num(contagem.naoLidas)} não lida(s) · ${num(contagem.aguardando)} esperando resposta ·
           ${num(contagem.privadas)} privadas · ${num(contagem.grupos)} grupos</p>
      </div>
      <div class="acoes"><button class="btn" data-vista="alertas">🔔 Alertas</button></div>
    </div>

    <div class="inbox ${estado.inbox.mostrandoThread ? 'mostrando-thread' : ''}">
      <aside class="inbox-lista">
        <div class="inbox-topo">
          <input type="search" id="busca-conversa" placeholder="Buscar conversa…" value="${esc(estado.inbox.busca)}">
          <div class="inbox-abas">
            ${ABAS_INBOX.map(([v, r]) => `
              <button class="inbox-aba ${estado.inbox.filtro === v ? 'ativa' : ''}" data-aba="${v}">${r}</button>
            `).join('')}
          </div>
        </div>
        <div class="inbox-itens">
          ${itens.map(itemConversa).join('') ||
            '<p class="vazio" style="padding:26px;text-align:center">Nenhuma conversa aqui.</p>'}
        </div>
      </aside>

      <section class="inbox-thread" id="thread">
        <div class="thread-vazia">carregando…</div>
      </section>
    </div>`;

  $('#busca-conversa').addEventListener('input', debounce((e) => {
    estado.inbox.busca = e.target.value;
    render();
  }, 300));

  await desenharThread();
};

function itemConversa(c) {
  const ativa = estado.conversaAberta &&
    estado.conversaAberta.tipo === c.tipo &&
    estado.conversaAberta.id === (c.tipo === 'grupo' ? c.grupo_id : c.pessoa_id);
  const cor = corDoNome(c.titulo);
  const sent = c.sentimento && c.tipo === 'privada' ? CORES_SENTIMENTO[c.sentimento] : null;

  return `
    <div class="conversa-item ${ativa ? 'ativa' : ''}"
         data-conversa="${c.tipo}" data-id="${c.tipo === 'grupo' ? c.grupo_id : c.pessoa_id}">
      <span class="avatar" style="background:${cor};${c.tipo === 'grupo' ? 'border-radius:50%' : ''}">
        ${esc(iniciais(c.titulo))}
      </span>
      <span class="corpo">
        <span class="linha1">
          ${sent ? `<i class="pino-sentimento" style="background:${sent}" title="${ROTULOS_SENTIMENTO[c.sentimento]}"></i>` : ''}
          <span class="nome">${esc(c.titulo)}</span>
          <span class="hora">${c.ts ? quando(c.ts) : ''}</span>
        </span>
        <div class="previa">${c.ultimo_de_mim ? '<span style="color:var(--tinta-4)">você: </span>' : ''}${esc(c.previa || 'sem mensagens')}</div>
        <div class="sub">${esc(c.subtitulo)}${c.atritos ? ` · <b style="color:#dc2626">${c.atritos} atrito</b>` : ''}</div>
      </span>
      ${c.nao_lidas ? `<span class="badge-nao-lidas">${c.nao_lidas}</span>` : ''}
    </div>`;
}

async function desenharThread() {
  const thread = $('#thread');
  if (!thread) return;
  const alvo = estado.conversaAberta;
  if (!alvo) {
    thread.innerHTML = '<div class="thread-vazia">Escolha uma conversa à esquerda.</div>';
    return;
  }

  const dados = alvo.tipo === 'grupo'
    ? await api(`/conversas/grupo/${alvo.id}`)
    : await api(`/conversas/pessoa/${alvo.id}`);

  thread.innerHTML = alvo.tipo === 'grupo' ? threadDeGrupo(dados) : threadPrivada(dados);

  const msgs = $('.thread-msgs', thread);
  if (msgs) msgs.scrollTop = msgs.scrollHeight;

  const campo = $('#compositor', thread);
  if (campo) {
    campo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarResposta(); }
    });
    campo.focus();
  }
}

const bolha = (m, mostrarAutor) => `
  <div class="bolha ${m.de_mim ? 'minha' : 'deles'}">
    ${mostrarAutor && !m.de_mim && m.autor ? `<div class="autor">${esc(m.autor)}</div>` : ''}
    <div>${m.texto ? esc(m.texto) : `<i style="color:var(--tinta-4)">${esc(m.tipo)}</i>`}</div>
    <div class="hora">${new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
  </div>`;

function threadPrivada(c) {
  const p = c.pessoa;
  const cor = corDoNome(p.nomeExibicao);
  const sent = CORES_SENTIMENTO[c.sentimento];

  return `
    <div class="thread-topo">
      <button class="btn voltar-lista" data-acao="voltar-lista" title="Voltar">‹</button>
      <span class="avatar" style="background:${cor}">${esc(iniciais(p.nomeExibicao))}</span>
      <div style="min-width:0">
        <div style="font-weight:650;letter-spacing:-.01em">${esc(p.nomeExibicao)}</div>
        <div style="font-size:11.5px;color:var(--tinta-3)">
          ${esc(formatarTel(p.telefone))}${p.cidade ? ` · ${esc(p.cidade)}${p.uf ? `/${p.uf}` : ''}` : ''}
          ${p.faixa ? ` · ${esc(p.faixa)}` : ''}
        </div>
      </div>
      <div style="margin-left:auto;display:flex;gap:7px;align-items:center">
        <span class="chip" style="background:${sent}14;color:${sent};border-color:${sent}30">
          ${ROTULOS_SENTIMENTO[c.sentimento]}
        </span>
        <button class="btn" data-pessoa="${p.id}">Ver ficha</button>
      </div>
    </div>

    ${c.risco ? `<div class="alerta" style="margin:12px 16px 0;border-radius:0 9px 9px 0">
      <b>${esc(c.risco.rotulo)}.</b> ${esc(c.risco.acao)}
    </div>` : ''}

    <div class="thread-msgs">
      ${c.total > c.mensagens.length
        ? `<div class="bolha sistema">mostrando as últimas ${c.mensagens.length} de ${c.total} mensagens</div>` : ''}
      ${c.mensagens.map((m) => bolha(m, false)).join('') ||
        '<div class="bolha sistema">nenhuma mensagem trocada ainda</div>'}
    </div>

    ${c.sugestoes?.length ? `
      <div class="sugestoes">
        <h4>💡 Sugestões de resposta
          <span style="text-transform:none;letter-spacing:0;font-weight:500">
            — clique para usar e editar antes de enviar
          </span>
        </h4>
        ${c.sugestoes.map((s, i) => `
          <div class="sugestao" data-sugestao="${i}">
            <div class="t">
              ${esc(s.titulo)}
              <span class="tom" style="background:${CORES_TOM[s.tom]}18;color:${CORES_TOM[s.tom]}">${esc(s.tom)}</span>
            </div>
            <div class="texto">${esc(s.texto)}</div>
            <div class="porque">Por quê: ${esc(s.porque)}</div>
          </div>`).join('')}
      </div>` : ''}

    <div class="compositor">
      <textarea id="compositor" rows="2" placeholder="Escreva a resposta…  (Enter envia, Shift+Enter quebra linha)"></textarea>
      <button class="btn primario" data-acao="enviar-resposta">Enviar</button>
    </div>`;
}

function threadDeGrupo(c) {
  const g = c.grupo;
  return `
    <div class="thread-topo">
      <button class="btn voltar-lista" data-acao="voltar-lista" title="Voltar">‹</button>
      <span class="avatar" style="background:${corDoNome(g.nome)};border-radius:50%">${esc(iniciais(g.nome))}</span>
      <div style="min-width:0">
        <div style="font-weight:650;letter-spacing:-.01em">${esc(g.nome)}</div>
        <div style="font-size:11.5px;color:var(--tinta-3)">${num(g.membros)} membros</div>
      </div>
      <div style="margin-left:auto">
        <button class="btn" data-abrir-grupo="${g.id}">Ver as pessoas</button>
      </div>
    </div>

    ${c.alertas?.length ? `<div class="alerta" style="margin:12px 16px 0;border-radius:0 9px 9px 0">
      <b>${c.alertas.length} alerta(s) recente(s) neste grupo.</b>
      ${esc(c.alertas[0].titulo)}
    </div>` : ''}

    <div class="thread-msgs">
      ${c.mensagens.map((m) => bolha(m, true)).join('') ||
        '<div class="bolha sistema">nenhuma mensagem capturada ainda neste grupo</div>'}
    </div>

    <div class="compositor">
      <textarea id="compositor" rows="2" placeholder="Escrever no grupo…"></textarea>
      <button class="btn primario" data-acao="enviar-resposta">Enviar</button>
    </div>`;
}

function formatarTel(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (d.length < 12) return tel || '';
  const resto = d.slice(4);
  return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${resto.length > 8 ? resto.slice(0, 5) : resto.slice(0, 4)}-${resto.length > 8 ? resto.slice(5) : resto.slice(4)}`;
}

async function enviarResposta() {
  const campo = $('#compositor');
  const alvo = estado.conversaAberta;
  if (!campo?.value.trim() || !alvo) return;
  const texto = campo.value.trim();
  const botao = $('[data-acao="enviar-resposta"]');

  campo.disabled = true;
  if (botao) { botao.disabled = true; botao.textContent = 'enviando…'; }

  const r = await api(`/conversas/${alvo.tipo === 'grupo' ? 'grupo' : 'pessoa'}/${alvo.id}/responder`,
    { method: 'POST', body: { texto } });

  if (r.erro) {
    toast('Não foi possível enviar', r.erro, 'critico');
    campo.disabled = false;
    if (botao) { botao.disabled = false; botao.textContent = 'Enviar'; }
    return;
  }
  await render();
}

// ============================================================ ALERTAS
const ICONE_ALERTA = {
  saiu_grupo: ['🚪', '#f59e0b'],
  removido_grupo: ['⛔', '#dc2626'],
  entrou_grupo: ['👋', '#16a34a'],
  atrito: ['⚡', '#dc2626']
};

VISTAS.alertas = async () => {
  const { itens, contagem } = await api('/alertas?limite=120');
  const wa = await api('/whatsapp/status');
  pintarAlertas(contagem);

  const conectado = wa.status === 'conectado';
  const atrito = itens.filter((a) => a.tipo.startsWith('atrito:') || a.tipo === 'conflito_grupo');
  const criticosAbertos = itens.filter((a) => !a.lido && a.gravidade === 'critico');

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Alertas</h2>
        <p>Conflito, saída e entrada nos grupos — em tempo real, com o que fazer em cada caso.</p>
      </div>
      <div class="acoes">
        ${contagem.total ? '<button class="btn" data-acao="ler-alertas">Marcar tudo como lido</button>' : ''}
        <button class="btn" data-vista="conexao">${conectado ? '🟢 WhatsApp Conectado' : '🔌 WhatsApp'}</button>
      </div>
    </div>

    ${criticosAbertos.length ? `
      <div class="alerta" style="margin-bottom:16px">
        <b>${criticosAbertos.length} alerta(s) de prioridade esperando resposta.</b>
        Atrito não resolvido no privado vira saída — e, no pior caso, denúncia do número da campanha.
      </div>` : ''}

    ${atrito.length ? `<div class="grade g-kpi" style="margin-bottom:16px">
      ${kpi('Sinais de atrito', num(atrito.length), 'detectados nas conversas')}
      ${kpi('Prioridade', num(atrito.filter((a) => a.gravidade === 'critico').length), 'exigem contato no privado')}
      ${kpi('Pessoas envolvidas', num(new Set(atrito.map((a) => a.pessoa_id).filter(Boolean)).size), 'marcadas com "Atenção / atrito"')}
    </div>` : ''}

    ${itens.length ? '' : `
      <div class="alerta ${conectado ? 'sucesso' : 'info'}">
        ${conectado
          ? `🟢 <b>WhatsApp conectado (${esc(wa.telefone || 'Ativo')}).</b> Nenhum alerta registrado no momento.<br>O sistema está monitorando os grupos. Quando ocorrer qualquer movimentação (participante entrar, sair ou for removido), o alerta aparecerá aqui em tempo real.`
          : `<b>Nenhum alerta ainda.</b> Assim que o WhatsApp estiver conectado, toda entrada e saída de participante nos grupos aparece aqui.`
        }
      </div>`}

    <section class="card">
      ${itens.map((a) => {
        // `def` vem do dicionário de risco no servidor; o mapa local é só fallback.
        const [iconePadrao, corPadrao] = ICONE_ALERTA[a.tipo] || ['🔔', '#64748b'];
        const icone = a.def?.icone || iconePadrao;
        const cor = a.def?.cor || corPadrao;
        const d = a.dados || {};
        return `
        <div class="alerta-linha ${a.lido ? '' : 'nao-lido'}" ${a.pessoa_id ? `data-pessoa="${a.pessoa_id}"` : ''}>
          <span class="icone" style="background:${cor}18;color:${cor}">${icone}</span>
          <span style="min-width:0;flex:1">
            <div class="t">${esc(a.titulo)}</div>
            <div class="d">${esc(a.detalhe || '')}</div>
            ${d.contexto ? `<div class="d" style="color:var(--tinta-4)">${esc(d.contexto)}</div>` : ''}
            ${a.acao ? `<div class="acao-alerta" style="border-color:${cor}">
              <b>O que fazer:</b> ${esc(a.acao)}
            </div>` : ''}
            ${d.assinou?.length ? `<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">
              ${d.assinou.map((t) => chip(t.length > 40 ? `${t.slice(0, 40)}…` : t, '#5b21b6')).join('')}
            </div>` : ''}
          </span>
          <span class="q">
            ${a.gravidade === 'critico' ? '<span class="faixa-badge" style="background:#fee2e2;color:#b91c1c;margin-right:8px">prioridade</span>' : ''}
            ${quando(a.ts)}
          </span>
        </div>`;
      }).join('')}
    </section>`;
};

// ============================================================ ABAIXO-ASSINADOS
VISTAS.abaixos = async () => {
  const abaixos = await api('/abaixos');
  const total = abaixos.reduce((s, a) => s + a.assinaturas, 0);

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Abaixo-assinados</h2>
        <p>${num(total)} assinaturas captadas por anúncio. Cada uma vira uma ficha e um tema de interesse.</p>
      </div>
      <div class="acoes">
        <!-- O input fica escondido: o botão é que tem o visual do painel. -->
        <input type="file" id="csv-upload" accept=".csv,.tsv,.txt,text/csv" multiple hidden>
        <button class="btn primario" data-acao="subir-csv">⬆ Subir CSV do Meta</button>
        <a class="btn" href="/api/export.csv?cadastro=sim">⬇ Exportar assinantes</a>
      </div>
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="corpo">
        <p style="font-size:12.5px;color:var(--tinta-3);line-height:1.6;margin:0">
          Exporte o CSV no Gerenciador de Anúncios e arraste aqui — ou clique em
          <b>Subir CSV do Meta</b>. Vale mais de um arquivo de uma vez, e não importa
          se o Meta exportou em UTF-8 com vírgula ou em UTF-16 com TAB: o sistema
          detecta. Quem já está na base não duplica, e cada assinatura repetida é
          ignorada pelo id do lead.
        </p>
        <div id="area-csv" style="margin-top:12px;border:2px dashed var(--linha);border-radius:12px;
                    padding:22px;text-align:center;color:var(--tinta-4);font-size:12.5px;cursor:pointer">
          Arraste os arquivos aqui
        </div>
        <div id="resultado-csv" style="margin-top:12px"></div>
      </div>
    </section>

    <div class="grade g-3">
      ${abaixos.map((a) => `
        <section class="card">
          <div class="corpo abaixo-card">
            <div>
              ${a.bandeira ? chip(a.bandeira, '#5b21b6') : ''}
              <div class="titulo" style="margin-top:8px">${esc(a.titulo)}</div>
            </div>
            <div class="numeros">
              <div><b>${num(a.assinaturas)}</b> assinaturas</div>
              <div><b>${num(a.ja_no_grupo)}</b> no grupo</div>
              <div><b>${num(a.assinaturas - a.ja_no_grupo)}</b> fora</div>
            </div>
            <div>
              <div class="barra"><i style="width:${(a.ja_no_grupo / (a.assinaturas || 1)) * 100}%;background:var(--verde)"></i></div>
              <div class="sub" style="margin-top:5px;color:var(--tinta-4)">
                ${Math.round((a.ja_no_grupo / (a.assinaturas || 1)) * 100)}% dos assinantes já entraram num grupo
              </div>
            </div>
            <div class="linha-dado"><span class="k">Origem</span><span class="v">${num(a.assinaturas - a.instagram)} Facebook · ${num(a.instagram)} Instagram</span></div>
            <div class="linha-dado"><span class="k">Período</span><span class="v">${dataCurta(a.primeira)} → ${dataCurta(a.ultima)}</span></div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">${a.temas.map((t) => chip(t.rotulo, t.cor)).join('')}</div>
            <button class="btn" style="width:100%;justify-content:center" data-filtro-abaixo="${esc(a.chave)}">
              Ver as ${num(a.assinaturas)} pessoas
            </button>
          </div>
        </section>`).join('')}
    </div>`;

  ligarUploadDeCsv();
};

/**
 * Sobe CSV de lead pela tela — clique ou arrastar.
 *
 * O arquivo vai em base64 de propósito: o export do Meta às vezes vem em
 * UTF-16, e ler como texto no navegador antes de enviar destruiria a
 * codificação. Mandando os bytes crus, quem decide é o servidor.
 */
function ligarUploadDeCsv() {
  const entrada = $('#csv-upload');
  const area = $('#area-csv');
  const saida = $('#resultado-csv');
  if (!entrada || !area) return;

  const lerBase64 = (arquivo) => new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result).split(',')[1] ?? '');
    leitor.onerror = () => reject(new Error(`Não consegui ler ${arquivo.name}`));
    leitor.readAsDataURL(arquivo);
  });

  async function enviar(lista) {
    const arquivos = [...lista].filter((f) => f.size > 0);
    if (!arquivos.length) return;

    saida.innerHTML = `<p class="sub">lendo ${arquivos.length} arquivo(s)…</p>`;
    let corpo;
    try {
      corpo = await Promise.all(arquivos.map(async (f) => ({
        nome: f.name, conteudo: await lerBase64(f)
      })));
    } catch (erro) {
      saida.innerHTML = `<p class="alerta">${esc(erro.message)}</p>`;
      return;
    }

    saida.innerHTML = '<p class="sub">importando…</p>';
    const r = await api('/leads/upload', { method: 'POST', body: { arquivos: corpo } })
      .catch((erro) => ({ erro: erro.message }));

    if (r.erro) {
      saida.innerHTML = `<p class="alerta">${esc(r.erro)}</p>`;
      return;
    }

    estado.panorama = null;
    saida.innerHTML = `
      <div class="alerta info" style="margin:0">
        <b>${num(r.total.importados)} assinatura(s) importada(s)</b> ·
        ${num(r.total.novos)} pessoa(s) nova(s) ·
        ${num(r.total.jaExistiam)} já estavam na base ·
        ${num(r.total.repetidos)} repetida(s) ignorada(s)
        ${r.total.invalidos ? ` · <b>${num(r.total.invalidos)} sem telefone válido</b>` : ''}
      </div>
      ${r.espelhado
        ? '<p class="sub" style="margin:8px 0 0">✓ Já espelhado no Firebase — sobrevive ao próximo deploy.</p>'
        : `<p class="alerta" style="margin:8px 0 0">⚠ O Firebase não está conectado: isto entrou
             só no banco local e some se o servidor for recriado. Veja a faixa no topo da tela.</p>`}
      ${r.arquivos.map((a) => `
        <div class="linha-dado">
          <span class="k">${esc(a.arquivo)}</span>
          <span class="v">${a.erro ? `<b style="color:#dc2626">${esc(a.erro)}</b>`
            : `${num(a.lidos)} linha(s) · ${num(a.importados)} importada(s)`}</span>
        </div>`).join('')}`;

    // Recarrega os números da tela, mantendo o resultado visível.
    const html = saida.innerHTML;
    await VISTAS.abaixos();
    const novaSaida = $('#resultado-csv');
    if (novaSaida) novaSaida.innerHTML = html;
  }

  entrada.addEventListener('change', () => enviar(entrada.files));

  // Ligado DIRETO no botão, e não pelo clique delegado do documento.
  //
  // Abrir o seletor de arquivo só é permitido dentro do gesto do usuário. O
  // listener delegado é `async` e tem `await` em ramos anteriores; se um deles
  // rodar antes de chegar aqui, o gesto já terminou e o Firefox e o Safari
  // recusam o `.click()` sem avisar — o botão simplesmente não faz nada.
  $('[data-acao="subir-csv"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    entrada.click();
  });

  area.addEventListener('click', () => entrada.click());
  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.style.borderColor = 'var(--roxo)';
  });
  area.addEventListener('dragleave', () => { area.style.borderColor = ''; });
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.style.borderColor = '';
    enviar(e.dataTransfer.files);
  });
}

// ============================================================ FIREBASE
VISTAS.firebase = async () => {
  const s = await api('/firebase/status');
  pintarFirebase(s);

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Firebase — base de produção</h2>
        <p>${s.conectado
          ? `Conectado ao projeto <b>${esc(s.projeto)}</b>`
          : 'Os dados ficam na fila local até a credencial ser configurada. Nada se perde.'}</p>
      </div>
      <div class="acoes">
        <button class="btn" data-acao="fb-restaurar" ${s.conectado ? '' : 'disabled'}
                title="Traz pessoas, grupos e assinaturas do Firestore para este servidor">⬇ Trazer base</button>
        <button class="btn" data-acao="fb-enviar" ${s.pendentes ? '' : 'disabled'}>⬆ Enviar fila (${num(s.pendentes)})</button>
        <button class="btn primario" data-acao="fb-sync">↻ Sincronizar tudo</button>
      </div>
    </div>

    <div class="grade g-2">
      <div style="display:grid;gap:16px;align-content:start">
        <div class="grade g-kpi">
          ${kpi('Status', s.conectado ? 'Conectado' : s.configurado ? 'Erro' : 'Aguardando', s.projeto ? esc(s.projeto) : 'projeto não configurado')}
          ${kpi('Na fila', num(s.pendentes), 'documentos esperando envio')}
          ${kpi('Enviados', num(s.enviados), s.ultimoEnvio ? `último ${quando(s.ultimoEnvio)}` : 'nesta sessão')}
        </div>

        ${s.erro ? `<div class="alerta"><b>Firebase:</b> ${esc(s.erro)}</div>` : ''}
        ${s.erros?.length ? `<div class="alerta">${s.erros.map((e) => `${esc(e.erro)} <b>(${e.n}×)</b>`).join('<br>')}</div>` : ''}

        <section class="card">
          <header><h3>O que vai para o Firestore</h3></header>
          <div class="corpo">
            <div class="linha-dado"><span class="k">pessoas</span><span class="v">ficha completa, uma por telefone — perfil, interesse, tags, grupos e assinaturas juntos</span></div>
            <div class="linha-dado"><span class="k">assinaturas</span><span class="v">cada lead do Meta, com anúncio e plataforma de origem</span></div>
            <div class="linha-dado"><span class="k">abaixos</span><span class="v">os abaixo-assinados e seus totais</span></div>
            <div class="linha-dado"><span class="k">grupos</span><span class="v">grupos do WhatsApp e tamanho</span></div>
            <div class="linha-dado"><span class="k">alertas</span><span class="v">saídas e entradas de grupo</span></div>
            <div class="linha-dado"><span class="k">eventos</span><span class="v">linha do tempo de cada pessoa</span></div>
            <div class="linha-dado"><span class="k">mensagens</span><span class="v">só se <code>FIRESTORE_ESPELHAR_MENSAGENS=true</code> — volume alto</span></div>
            <p style="font-size:12px;color:var(--tinta-3);line-height:1.55;margin:14px 0 0">
              O SQLite local continua sendo o motor de cálculo (score, cruzamentos, filtros).
              O Firestore é onde o dado <b>mora</b>: compartilhado com a equipe, com backup do
              Google e acessível por qualquer app que você fizer depois.
            </p>
          </div>
        </section>
      </div>

      <section class="card">
        <header><h3>Como ligar (5 minutos)</h3></header>
        <div class="corpo passo-firebase">
          <ol class="passos">
            <li>Acesse <b>console.firebase.google.com</b> e crie um projeto (ex.: <i>rede-apoio-claudia</i>).</li>
            <li>No menu, abra <b>Firestore Database → Criar banco de dados</b>. Escolha o modo de produção e a região <b>southamerica-east1</b>.</li>
            <li>Vá em <b>⚙ Configurações do projeto → Contas de serviço → Gerar nova chave privada</b>. Baixa um arquivo <code>.json</code>.</li>
            <li>Abra o arquivo baixado, copie <b>todo</b> o conteúdo e cole no campo abaixo.</li>
            <li>Confira a pasta no Firestore e clique em <b>Salvar credencial</b>.</li>
          </ol>

          <div class="campo" style="margin-top:12px">
            <label>Chave da conta de serviço (JSON)</label>
            <textarea id="fb-chave" rows="5" spellcheck="false"
              style="font-family:ui-monospace,monospace;font-size:11.5px;resize:vertical"
              placeholder='{ "type": "service_account", "project_id": "...", ... }'></textarea>
          </div>
          <div class="campo">
            <label>Pasta desta campanha no Firestore</label>
            <input id="fb-pasta" value="${esc(s.pasta ?? estado.campanha.slug)}">
            <small style="display:block;margin-top:5px;font-size:11.5px;color:var(--tinta-3);line-height:1.5">
              Os dados ficam em <code>campanhas/<span id="fb-previa">${esc(s.pasta ?? estado.campanha.slug)}</span>/…</code>.
              Se a base desta campanha <b>já existe</b> no Firebase com outro nome, escreva
              esse nome aqui — senão o sistema procura numa pasta vazia e parece que os
              dados sumiram.
            </small>
          </div>
          <button class="btn primario" style="width:100%;justify-content:center;padding:11px"
                  data-acao="fb-credencial">Salvar credencial</button>

          <div class="alerta info" style="margin-top:10px">
            A chave é gravada em <code>data/campanhas/${esc(estado.campanha.slug)}/firebase-key.json</code>,
            só para esta campanha. É o que impede a base de um candidato aparecer no
            Firebase do outro.
          </div>
          <p style="font-size:12.5px;color:var(--tinta-3);line-height:1.55;margin:4px 0 0">
            Para publicar as regras de segurança e os índices (já prontos no projeto):
          </p>
          <div class="codigo">npx firebase-tools deploy --only firestore</div>
          <div class="alerta info" style="margin-top:6px">
            As regras em <code>firestore.rules</code> bloqueiam <b>todo</b> acesso de cliente.
            Só o servidor escreve, e a leitura exige um usuário com a claim <code>equipe</code>.
            Isso é o mínimo para uma base de dado pessoal com finalidade política.
          </div>
          <div class="alerta">
            <b>Nunca versione</b> a chave nem os CSV de leads — o <code>.gitignore</code>
            já cobre <code>data/campanhas/*/firebase-key.json</code> e
            <code>data/campanhas/*/leads/*.csv</code>.
          </div>
        </div>
      </section>
    </div>`;

  // O caminho no Firestore muda enquanto se digita: ver o destino antes de
  // salvar evita descobrir a pasta errada só depois de uma restauração vazia.
  const campoPasta = $('#fb-pasta');
  campoPasta?.addEventListener('input', () => {
    $('#fb-previa').textContent = campoPasta.value.trim() || estado.campanha.slug;
  });
};

// ============================================================ FORMULÁRIOS / PAUTAS
VISTAS.formularios = async () => {
  const dados = await api('/formularios');
  const urlFormulario = `${location.origin}/formulario/${estado.campanha.slug}`;
  const elConta = $('#conta-formularios');
  if (elConta) elConta.textContent = num(dados.total);

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Formulários de Pautas & Causas</h2>
        <p>Respostas da pesquisa de perfilamento dos apoiadores — saiba exatamente o que a base defende e luta.</p>
      </div>
      <div class="acoes">
        <a class="btn primario" href="/formulario/${esc(estado.campanha.slug)}" target="_blank">📋 Abrir Formulário Público</a>
        <button class="btn" data-acao="copiar-link-form" data-link="${esc(urlFormulario)}">🔗 Copiar Link para Enviar</button>
      </div>
    </div>

    <div class="grade g-kpi" style="margin-bottom:20px">
      <div class="card kpi">
        <div class="rotulo">Total de Pesquisas</div>
        <div class="valor">${num(dados.total)}</div>
        <div class="nota">apoiadores perfilados</div>
      </div>
      <div class="card kpi">
        <div class="rotulo">Pauta Mais Defendida</div>
        <div class="valor" style="font-size:20px;color:var(--roxo)">${esc(dados.rankings[0]?.rotulo || 'Nenhuma')}</div>
        <div class="nota">${dados.rankings[0] ? `${num(dados.rankings[0].total)} apoiadores (${Math.round((dados.rankings[0].total / (dados.total || 1)) * 100)}%)` : 'aguardando respostas'}</div>
      </div>
      <div class="card kpi">
        <div class="rotulo">Causas Mapeadas</div>
        <div class="valor" style="color:var(--verde)">${num(dados.rankings.length)}</div>
        <div class="nota">pautas ativas</div>
      </div>
    </div>

    <div class="grade g-2" style="margin-bottom:20px">
      <section class="card">
        <header><h3>📊 Mensuração das Causas Mais Relevantes</h3></header>
        <div class="corpo">
          ${dados.rankings.length ? `
            <div class="barras-h">
              ${dados.rankings.map((r) => {
                const pct = Math.round((r.total / (dados.total || 1)) * 100);
                return `
                  <div class="barra-h">
                    <span class="rot" style="display:flex;align-items:center;gap:6px">
                      <span style="width:10px;height:10px;border-radius:50%;background:${r.cor}"></span>
                      ${esc(r.rotulo)}
                    </span>
                    <div class="barra" style="height:12px;background:#f1f5f9;border-radius:6px;overflow:hidden">
                      <i style="width:${pct}%;background:${r.cor};height:100%;display:block"></i>
                    </div>
                    <span class="n">${num(r.total)} <span style="font-size:11px;color:var(--tinta-4)">(${pct}%)</span></span>
                  </div>`;
              }).join('')}
            </div>` : '<div style="color:var(--tinta-4);font-size:13px;padding:10px 0">Nenhum dado de pauta coletado ainda. Compartilhe o formulário!</div>'}
        </div>
      </section>

      <section class="card">
        <header><h3>🔗 Divulgação da Pesquisa de Pautas</h3></header>
        <div class="corpo">
          <p style="font-size:13px;color:var(--tinta-3);margin-top:0">
            Envie este link nos grupos do WhatsApp ou status para que os eleitores digam quais são suas principais lutas e entrem automaticamente no grupo temático correto:
          </p>
          <div class="codigo" style="font-size:13px;word-break:break-all;user-select:all;margin-bottom:12px">
            ${esc(urlFormulario)}
          </div>
          <button class="btn primario" style="width:100%;justify-content:center" data-acao="copiar-link-form" data-link="${esc(urlFormulario)}">
            📋 Copiar Link do Formulário
          </button>
        </div>
      </section>
    </div>

    <section class="card">
      <header><h3>👥 Apoiadores Perfilados (${num(dados.respostas.length)})</h3></header>
      <div class="corpo" style="padding:0">
        ${dados.respostas.length ? `
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="border-bottom:1px solid var(--linha);background:#f8fafc;text-align:left;color:var(--tinta-4);font-size:11.5px;text-transform:uppercase">
                  <th style="padding:10px 14px">Apoiador</th>
                  <th style="padding:10px 14px">Cidade / Bairro</th>
                  <th style="padding:10px 14px">Atuação</th>
                  <th style="padding:10px 14px">Luta / Pautas</th>
                  <th style="padding:10px 14px">Engajamento</th>
                  <th style="padding:10px 14px">Ação</th>
                </tr>
              </thead>
              <tbody>
                ${dados.respostas.map((p) => `
                  <tr style="border-bottom:1px solid var(--linha)">
                    <td style="padding:12px 14px">
                      <div style="font-weight:600;color:var(--tinta)" data-pessoa="${p.id}" class="clicavel">${esc(p.exibicao)}</div>
                      <div style="font-size:11.5px;color:var(--tinta-4)">${esc(p.telefone_fmt)}</div>
                    </td>
                    <td style="padding:12px 14px">
                      ${esc(p.cidade || '—')}${p.bairro ? ` <span style="color:var(--tinta-4)">(${esc(p.bairro)})</span>` : ''}
                    </td>
                    <td style="padding:12px 14px">${esc(p.atuacao || '—')}</td>
                    <td style="padding:12px 14px">
                      <div style="display:flex;gap:4px;flex-wrap:wrap">
                        ${p.interesses_rotulos.map((i) => chip(i.rotulo, i.cor)).join('') || '<span style="color:var(--tinta-4);font-style:italic">Geral</span>'}
                      </div>
                    </td>
                    <td style="padding:12px 14px">
                      ${badgeFaixa(p.faixa)}
                    </td>
                    <td style="padding:12px 14px">
                      <button class="btn fantasma" style="padding:4px 8px;font-size:12px" data-pessoa="${p.id}">🔍 Ver Ficha</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<div style="padding:20px;text-align:center;color:var(--tinta-4)">Nenhum formulário respondido até o momento.</div>'}
      </div>
    </section>`;
};

// ============================================================ GRUPOS
VISTAS.grupos = async () => {
  const grupos = await api('/grupos');
  const fila = await api('/fila-adicao');
  const wa = await api('/whatsapp/status');
  const conectado = wa.status === 'conectado';

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Grupos monitorados</h2>
        <p>${grupos.length
          ? `${grupos.length} grupo(s) sendo lidos ao mesmo tempo — o sistema cruza quem está em mais de um.`
          : conectado
            ? 'WhatsApp conectado. Aguardando sincronização dos grupos.'
            : 'Nenhum grupo ainda. Os grupos aparecem sozinhos assim que o WhatsApp for conectado.'}</p>
      </div>
      <div class="acoes"><button class="btn ${grupos.length ? '' : 'primario'}" data-vista="conexao">${conectado ? '🟢 WhatsApp Conectado' : '🔌 Conectar WhatsApp'}</button></div>
    </div>
    ${grupos.length ? '' : `
      <div class="alerta ${conectado ? 'sucesso' : 'info'}">
        ${conectado
          ? `🟢 <b>WhatsApp conectado (${esc(wa.telefone || 'Ativo')}).</b> O sistema está acompanhando mensagens, reações e saídas dos grupos.`
          : `Ao ler o QR Code, o sistema importa automaticamente os grupos, participantes e passa a acompanhar mensagens, reações e saídas.`
        }
      </div>`}

    ${painelDaFila(fila)}

    <div class="grade g-4">
      ${grupos.map((g) => `
        <section class="card">
          <div class="corpo">
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
              <span class="avatar" style="background:${corDoNome(g.nome)};border-radius:12px">${esc(iniciais(g.nome))}</span>
              <div>
                <div style="font-weight:650;letter-spacing:-.01em">${esc(g.nome)}</div>
                <div class="sub" style="color:var(--tinta-4);font-size:11.5px">${esc(g.descricao || '')}</div>
              </div>
              <span class="chip" style="margin-left:auto;flex-shrink:0;background:${g.da_campanha ? '#dcfce7' : '#f1f5f9'};color:${g.da_campanha ? '#166534' : '#64748b'}"
                    title="${g.da_campanha
                      ? 'Grupo da campanha: pode receber pessoas da base.'
                      : 'Grupo de terceiro (o telefone da campanha está nele, mas ele não é da campanha). A fila de adição recusa este grupo de propósito. Para liberar: npm run grupos -- --marcar ' + g.id}">
                ${g.da_campanha ? (g.tema_rotulo ? esc(g.tema_rotulo) : 'campanha') : 'externo'}
              </span>
            </div>
            <div class="linha-dado"><span class="k">Membros</span><span class="v">${num(g.membros)}</span></div>
            <div class="linha-dado"><span class="k">Falaram em 7 dias</span><span class="v">${num(g.ativos_7d)} <span style="color:var(--tinta-4);font-weight:400">(${Math.round((g.ativos_7d / (g.membros || 1)) * 100)}%)</span></span></div>
            <div class="linha-dado"><span class="k">Mensagens</span><span class="v">${num(g.mensagens)} <span style="color:var(--tinta-4);font-weight:400">· ${num(g.mensagens_7d)} na semana</span></span></div>
            <div class="linha-dado"><span class="k">Última atividade</span><span class="v">${quando(g.ultima_msg) || '—'}</span></div>
            <div style="display:flex;gap:7px;margin-top:12px">
              <button class="btn" style="flex:1;justify-content:center" data-abrir-grupo="${g.id}">Ver pessoas</button>
              ${g.da_campanha
                ? `<button class="btn primario" style="flex:1;justify-content:center" data-adicionar="${g.id}">➕ Adicionar</button>`
                : `<button class="btn" style="flex:1;justify-content:center;opacity:.55;cursor:not-allowed" disabled
                     title="Grupo de terceiro — a fila de adição recusa. Libere com: npm run grupos -- --marcar ${g.id}">🔒 Externo</button>`}
            </div>
          </div>
        </section>`).join('')}
    </div>`;
};

// ---------------------------------------- fila de adição (painel + gaveta)
function painelDaFila(f) {
  const total = f.pendentes + f.adicionados + f.convidados + f.falharam;
  if (!total) return '';

  const feitos = f.adicionados + f.convidados;
  const pct = Math.round((feitos / (total || 1)) * 100);
  const est = f.estado;
  const parada = est.pausada || est.impedimento;

  return `
    <section class="card" style="margin-bottom:16px">
      <header>
        <h3>Fila de adição aos grupos</h3>
        <span class="dica">${f.feitosHoje}/${f.limites.porDia} hoje · restam ${f.restamHoje}</span>
      </header>
      <div class="corpo">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
          <span class="chip" style="background:${parada ? '#fef3c7' : '#dcfce7'};color:${parada ? '#92400e' : '#166534'}">
            ${parada ? `⏸ ${esc(est.motivoPausa || est.impedimento)}` : '▶ em andamento'}
          </span>
          ${f.pendentes && !parada && est.proximoEm
            ? `<span class="sub">próxima em ${Math.max(0, Math.round((est.proximoEm - Date.now()) / 1000))}s</span>` : ''}
          ${f.pendentes ? `<span class="sub">término estimado: ${esc(f.estimativa || '—')}</span>` : ''}
          <span style="margin-left:auto;display:flex;gap:7px">
            ${est.pausada
              ? '<button class="btn primario" data-acao="fila-retomar">Retomar</button>'
              : '<button class="btn" data-acao="fila-pausar">Pausar</button>'}
            ${f.pendentes ? '<button class="btn" data-acao="fila-cancelar">Cancelar pendentes</button>' : ''}
          </span>
        </div>

        <div class="barra" style="height:9px"><i style="width:${pct}%;background:var(--verde)"></i></div>

        <div style="display:flex;gap:20px;margin-top:12px;flex-wrap:wrap;font-size:12px;color:var(--tinta-3)">
          <span><b style="color:var(--verde);font-size:16px">${num(f.adicionados)}</b> adicionadas</span>
          <span><b style="color:var(--azul);font-size:16px">${num(f.convidados)}</b> convidadas por link</span>
          <span><b style="color:var(--tinta);font-size:16px">${num(f.pendentes)}</b> na fila</span>
          ${f.falharam ? `<span><b style="color:#dc2626;font-size:16px">${num(f.falharam)}</b> não deu</span>` : ''}
        </div>

        ${f.itens?.filter((i) => i.situacao === 'falhou').length ? `
          <details style="margin-top:12px">
            <summary style="cursor:pointer;font-size:12px;color:var(--tinta-3)">ver quem não deu certo</summary>
            <div style="margin-top:8px">
              ${f.itens.filter((i) => i.situacao === 'falhou').slice(0, 15).map((i) => `
                <div class="linha-dado">
                  <span class="k" style="width:auto;flex:1">${esc(i.pessoa)}</span>
                  <span class="v" style="font-weight:400;color:var(--tinta-3)">${esc(i.erro || '')}</span>
                </div>`).join('')}
            </div>
          </details>` : ''}
      </div>
    </section>`;
}

async function abrirAdicionar(grupoId) {
  const grupos = await api('/grupos');
  const grupo = grupos.find((g) => g.id === grupoId);
  estado.panorama ??= await api('/panorama');
  estado.adicionar = { grupoId, filtros: { somenteSemGrupo: 'sim', somenteAssinantes: '', abaixo: '', uf: '', cidade: '', apoio: '' } };

  gaveta.classList.add('aberto');
  overlay.classList.add('aberto');
  await desenharAdicionar(grupo);
}

async function desenharAdicionar(grupo) {
  const { grupoId, filtros } = estado.adicionar;
  const q = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v)).toString();
  const previa = await api(`/grupos/${grupoId}/elegiveis?${q}`);
  const f = await api(`/fila-adicao?grupo=${grupoId}`);
  const minutos = Math.round((previa.total * (f.limites.intervaloMin + f.limites.intervaloMax) / 2) / 60);
  const dias = Math.ceil(previa.total / f.limites.porDia);

  const opcoes = (lista, atual, vazio) =>
    `<option value="">${vazio}</option>` +
    lista.map(([v, r]) => `<option value="${esc(v)}" ${atual === v ? 'selected' : ''}>${esc(r)}</option>`).join('');

  gaveta.innerHTML = `
    <div class="topo">
      <span class="avatar" style="background:${corDoNome(grupo.nome)};border-radius:50%">${esc(iniciais(grupo.nome))}</span>
      <div style="min-width:0">
        <div style="font-size:16px;font-weight:660;letter-spacing:-.02em">Adicionar ao grupo</div>
        <div style="font-size:12.5px;color:var(--tinta-3)">${esc(grupo.nome)} · ${num(grupo.membros)} membros</div>
      </div>
      <button class="fechar" data-acao="fechar-gaveta">✕</button>
    </div>

    <div class="rolagem">
      <div class="bloco">
        <h4>Quem entra na fila</h4>
        <div class="campo">
          <label>Chance de apoiar</label>
          <select id="ad-apoio">${opcoes(
            (estado.config.faixas_apoio || []).filter((x) => x !== 'Não abordar').map((x) => [x, x]),
            filtros.apoio, 'Qualquer uma'
          )}</select>
        </div>
        <div class="campo">
          <label>Abaixo-assinado</label>
          <select id="ad-abaixo">${opcoes(estado.panorama.abaixos.map((a) => [a.chave, a.titulo]), filtros.abaixo, 'Qualquer um')}</select>
        </div>
        <div class="grade" style="grid-template-columns:1fr 1.4fr;gap:10px">
          <div class="campo">
            <label>Estado</label>
            <select id="ad-uf">${opcoes(estado.panorama.ufs.map((u) => [u.uf, `${u.uf} (${u.n})`]), filtros.uf, 'Todos')}</select>
          </div>
          <div class="campo">
            <label>Cidade (opcional)</label>
            <input id="ad-cidade" value="${esc(filtros.cidade)}" placeholder="Ex.: Campinas">
          </div>
        </div>
        <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin-bottom:7px">
          <input type="checkbox" id="ad-semgrupo" ${filtros.somenteSemGrupo ? 'checked' : ''}>
          Só quem ainda não está em nenhum grupo
        </label>
        <label style="display:flex;gap:8px;align-items:center;font-size:12.5px">
          <input type="checkbox" id="ad-assinantes" ${filtros.somenteAssinantes ? 'checked' : ''}>
          Só quem assinou algum abaixo-assinado
        </label>
      </div>

      <div class="bloco destaque">
        <h4>Prévia</h4>
        <div style="font-size:30px;font-weight:680;letter-spacing:-.03em">${num(previa.total)}</div>
        <div style="font-size:12.5px;color:var(--tinta-3);margin-bottom:12px">pessoa(s) elegíveis para este grupo</div>
        ${previa.amostra.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap">
          ${previa.amostra.slice(0, 8).map((p) => chip(
            `${p.nome.split(' ').slice(0, 2).join(' ')} · ${p.propensao ?? 0}`,
            corApoio(p.faixa_apoio)
          )).join('')}
          ${previa.total > 8 ? `<span class="sub" style="align-self:center">e mais ${num(previa.total - 8)}</span>` : ''}
        </div>` : '<p class="vazio">Ninguém corresponde a esses filtros.</p>'}
        ${previa.total ? `
          <div class="campo" style="margin-top:14px">
            <label>Quantas adicionar agora</label>
            <input id="ad-limite" type="number" min="1" max="${previa.total}" value="${previa.total}">
          </div>` : ''}
      </div>

      <div class="bloco">
        <h4>Como isso vai acontecer</h4>
        <div class="alerta" style="margin-bottom:12px">
          <b>Não dá para adicionar 100 pessoas de uma vez.</b> Foi exatamente isso que
          derrubou seu número antes — o WhatsApp bloqueia por comportamento, e nenhuma
          biblioteca contorna. O que dá para fazer é o que este painel faz: você clica
          <b>uma vez</b> e o sistema adiciona sozinho, devagar, por horas.
        </div>
        <div class="linha-dado"><span class="k">Ordem</span><span class="v">quem tem mais chance de apoiar entra primeiro</span></div>
        <div class="linha-dado"><span class="k">Ritmo</span><span class="v">1 pessoa a cada ${f.limites.intervaloMin}–${f.limites.intervaloMax}s (aleatório)</span></div>
        <div class="linha-dado"><span class="k">Teto</span><span class="v">${f.limites.porDia}/dia · ${f.limites.porHora}/hora</span></div>
        <div class="linha-dado"><span class="k">Horário</span><span class="v">${f.limites.horaInicio}h às ${f.limites.horaFim}h</span></div>
        <div class="linha-dado"><span class="k">Pausa longa</span><span class="v">${f.limites.pausaLongaMin} min a cada ${f.limites.pausaLongaACada} pessoas</span></div>
        <div class="linha-dado"><span class="k">Segurança</span><span class="v">para sozinho após ${f.limites.falhasSeguidasParaPausar} erros seguidos</span></div>
        ${previa.total ? `<div class="linha-dado"><span class="k">Vai levar</span><span class="v" style="color:var(--roxo);font-weight:620">
          ${dias > 1 ? `~${dias} dias` : `~${minutos} min`}</span></div>` : ''}
        <p style="font-size:12px;color:var(--tinta-3);line-height:1.55;margin:12px 0 0">
          Quem tiver a privacidade fechada não pode ser adicionada direto — para essas,
          o sistema manda o <b>link de convite no privado</b>, com o motivo explicado.
          Pode fechar esta janela: a fila continua rodando em segundo plano.
        </p>
      </div>

      ${previa.total ? `
        <button class="btn primario" style="width:100%;justify-content:center;padding:12px"
                data-acao="fila-enfileirar">
          Adicionar ${num(previa.total)} pessoa(s) com segurança
        </button>` : ''}
    </div>`;

  for (const [id, chave] of [['#ad-abaixo', 'abaixo'], ['#ad-uf', 'uf'], ['#ad-cidade', 'cidade'],
    ['#ad-apoio', 'apoio']]) {
    const el = $(id, gaveta);
    el?.addEventListener('change', () => {
      estado.adicionar.filtros[chave] = el.value;
      desenharAdicionar(grupo);
    });
  }
  for (const [id, chave] of [['#ad-semgrupo', 'somenteSemGrupo'], ['#ad-assinantes', 'somenteAssinantes']]) {
    const el = $(id, gaveta);
    el?.addEventListener('change', () => {
      estado.adicionar.filtros[chave] = el.checked ? 'sim' : '';
      desenharAdicionar(grupo);
    });
  }
}

// ============================================================ CADASTRAR PESSOA
VISTAS.cadastrar = async () => {
  const c = estado.campanha;
  const link = `${location.origin}/cadastro/${c.slug}`;

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Cadastrar pessoa</h2>
        <p>Preencha na hora, com a pessoa do lado — ou mande o link para ela mesma preencher.</p>
      </div>
    </div>

    <div class="grade g-2">
      <section class="card">
        <header><h3>Preencher agora</h3><span class="dica">entra direto na base</span></header>
        <div class="corpo">
          <form id="form-rapido">
            <div class="campo"><label>Nome completo *</label>
              <input name="nome" required placeholder="Como ela quer ser chamada"></div>
            <div class="campo"><label>WhatsApp (com DDD) *</label>
              <input name="telefone" required inputmode="tel" placeholder="(19) 99999-8888"></div>
            <div class="grade" style="grid-template-columns:1.4fr 1fr;gap:10px">
              <div class="campo"><label>Cidade *</label>
                <input name="cidade" required placeholder="Campinas"></div>
              <div class="campo"><label>Bairro</label>
                <input name="bairro" placeholder="Ouro Verde"></div>
            </div>
            <div class="campo"><label>Atuação *</label>
              <input name="atuacao" required list="atuacoes"
                     placeholder="professora, comerciante, líder comunitária…">
              <datalist id="atuacoes">
                <option>Professor(a) ou educador(a)</option><option>Mãe, pai ou responsável</option>
                <option>Apoiador da causa</option><option>Profissional de psicologia</option>
                <option>Agente comunitária de saúde</option><option>Líder comunitária</option>
                <option>Comerciante</option><option>Autônoma</option><option>Aposentado</option>
              </datalist>
            </div>
            <div class="campo"><label>E-mail (opcional)</label>
              <input name="email" type="email"></div>
            <div class="campo"><label>O que ela te contou (opcional)</label>
              <textarea name="observacoes" rows="3"
                        placeholder="A demanda dela, o bairro, o que precisa…"></textarea></div>
            <button class="btn primario" type="submit"
                    style="width:100%;justify-content:center;padding:12px">
              Cadastrar na rede
            </button>
            <p id="aviso-rapido" style="display:none;margin-top:12px"></p>
          </form>
        </div>
      </section>

      <div style="display:grid;gap:16px;align-content:start">
        <section class="card">
          <header><h3>Link do formulário</h3></header>
          <div class="corpo">
            <p style="font-size:12.5px;color:var(--tinta-3);line-height:1.55;margin:0 0 10px">
              Mande nos grupos ou coloque na bio. Quem preencher entra direto na base
              de <b>${esc(c.nome)}</b> — e se já estiver num grupo, o telefone junta tudo
              numa ficha só.
            </p>
            <div class="codigo">${esc(link)}</div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn" data-copiar="${esc(link)}">Copiar link</button>
              <a class="btn" href="/cadastro/${esc(c.slug)}" target="_blank">Abrir ↗</a>
            </div>
          </div>
        </section>

        <section class="card">
          <header><h3>QR Code</h3><span class="dica">para eventos e panfletos</span></header>
          <div class="corpo" style="text-align:center">
            <img src="/api/qr?texto=${encodeURIComponent(link)}" alt="QR do formulário"
                 style="width:230px;max-width:100%;border:1px solid var(--linha);border-radius:12px">
            <p style="font-size:12px;color:var(--tinta-3);line-height:1.55;margin:10px 0 0">
              Imprima ou mostre na tela do celular: a pessoa aponta a câmera e
              preenche sozinha.
            </p>
          </div>
        </section>
      </div>
    </div>`;

  $('#form-rapido').addEventListener('submit', async (e) => {
    e.preventDefault();
    const aviso = $('#aviso-rapido');
    const botao = e.target.querySelector('button[type=submit]');
    botao.disabled = true; botao.textContent = 'cadastrando…';

    const dados = Object.fromEntries(new FormData(e.target));
    const r = await fetch(`/api/cadastro/${c.slug}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados)
    }).then((x) => x.json());

    aviso.style.display = 'block';
    if (r.erro) {
      aviso.className = 'alerta';
      aviso.textContent = r.erro;
    } else {
      aviso.className = 'alerta info';
      aviso.innerHTML = r.novo
        ? `✅ <b>${esc(dados.nome)}</b> entrou na rede.`
        : `✅ <b>${esc(dados.nome)}</b> já estava na base — a ficha foi completada.`;
      e.target.reset();
      estado.panorama = null;
      api('/conversas?filtro=nao_lidas').then((x) => pintarConversas(x.contagem)).catch(() => {});
    }
    botao.disabled = false; botao.textContent = 'Cadastrar na rede';
    e.target.querySelector('[name=nome]').focus();
  });
};

// ====================================================== COLETAR DADOS
// ====================================================== COLETAR DADOS
//
// Ler o QR uma vez e a agenda inteira do celular entra na base — sem ninguém
// digitar contato nenhum.
//
// A importação já acontecia no pareamento (guardarContatos, em whatsapp.js).
// O que faltava era uma tela que a mostrasse: quantos entraram, quando, e o
// que fazer com eles depois.
VISTAS.coletar = async () => {
  const s = estado.whatsapp = await api('/whatsapp/status');
  const conectado = s.status === 'conectado';
  const a = s.agenda || { naAgenda: 0, contatos: 0, importadaEm: null };
  const { itens: coletores = [] } = await api('/coletores');

  const elConta = $('#conta-coletar');
  if (elConta) elConta.textContent = num(a.contatos);

  // Amostra do que entrou: número seco não convence, nome na tela sim.
  const recentes = a.contatos
    ? await api('/pessoas?origem=contato&ordenar=novos&porPagina=8').catch(() => null)
    : null;

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Coletar dados</h2>
        <p>Leia o QR uma vez. A agenda do celular vira ficha na base — nenhum
           contato é digitado à mão.</p>
      </div>
      <div class="acoes">
        <button class="btn" data-acao="coletar-recarregar">↻ Atualizar</button>
        <button class="btn primario" data-acao="coletor-novo">+ Adicionar celular</button>
      </div>
    </div>

    <div class="grade g-kpi" style="margin-bottom:16px">
      ${kpi('Celulares', num(coletores.length), 'ligados a esta base')}
      ${kpi('Na agenda', num(a.naAgenda), 'salvos em algum celular')}
      ${kpi('Importados', num(a.contatos), 'fichas criadas sozinhas')}
    </div>

    ${coletores.length ? `
      <div class="grade g-2">
        ${coletores.map((c) => {
          const cor = { conectado: '#16a34a', qr: '#d97706', conectando: '#2563eb' }[c.status] || '#64748b';
          return `
          <section class="card">
            <header>
              <h3>${esc(c.nome)}</h3>
              <span class="chip" style="background:${cor}22;color:${cor}">${esc(c.status)}</span>
            </header>
            <div class="corpo">
              ${c.qr ? `
                <div class="qr-caixa">
                  <img src="${c.qr}" alt="QR de ${esc(c.nome)}" style="max-width:230px">
                  <p style="font-size:12px;color:var(--tinta-3);max-width:320px;margin:0;line-height:1.6">
                    Neste celular: <b>WhatsApp → Dispositivos conectados → Conectar
                    dispositivo</b>. Deixe já nessa tela antes de olhar o código.
                  </p>
                </div>
              ` : `
                <div class="linha-dado"><span class="k">Número</span>
                  <span class="v">${c.telefone ? esc(c.telefone) : '<span class="vazio">não pareado</span>'}</span></div>
                <div class="linha-dado"><span class="k">Contatos trazidos</span>
                  <span class="v">${num(c.contatos)}</span></div>
                <div class="linha-dado"><span class="k">Última agenda</span>
                  <span class="v">${c.ultimo_em ? quando(c.ultimo_em) : '<span class="vazio">nunca</span>'}</span></div>
                ${c.erro ? `<div class="alerta" style="margin-top:8px;font-size:12px">${esc(c.erro)}</div>` : ''}
                ${c.status === 'conectado' && !c.contatos ? `
                  <div class="alerta info" style="margin-top:8px;font-size:12px">
                    Conectado, mas sem agenda. O WhatsApp só manda a lista completa
                    <b>no pareamento</b> — use <b>Reparear</b> para trazê-la.
                  </div>` : ''}
              `}
              <div style="display:flex;gap:7px;margin-top:12px;flex-wrap:wrap">
                ${c.status === 'conectado'
                  ? `<button class="btn" data-coletor-repar="${c.id}">↻ Reparear</button>
                     <button class="btn" data-coletor-desligar="${c.id}">Desligar</button>`
                  : `<button class="btn primario" style="flex:1;justify-content:center" data-coletor-ligar="${c.id}">Gerar QR Code</button>`}
                <button class="btn" data-coletor-remover="${c.id}" title="Remover este celular">✕</button>
              </div>
            </div>
          </section>`;
        }).join('')}
      </div>
    ` : `
      <section class="card">
        <div class="corpo" style="text-align:center;padding:34px 18px">
          <div style="font-size:46px">📇</div>
          <p style="margin:10px 0 0;font-weight:600">Nenhum celular ligado ainda</p>
          <p style="font-size:13px;color:var(--tinta-3);max-width:420px;margin:8px auto 0;line-height:1.6">
            Clique em <b>+ Adicionar celular</b> e leia o QR. Pode ligar quantos
            quiser — o do candidato, o da coordenação, o do escritório — e todas
            as agendas caem nesta mesma base, sem duplicar quem se repete.
          </p>
        </div>
      </section>
    `}

    ${conectado && s.modo === 'completo' ? `
      <div class="alerta" style="margin-top:16px">
        <b>Esta conexão está em modo completo.</b> Ela foi aberta pela aba
        🔌 WhatsApp e está lendo conversas também. Para trocar para só contatos,
        desconecte ali e leia o QR de novo por aqui.
      </div>` : ''}

    <div class="alerta info" style="margin-top:16px">
      <b>Esta tela não lê suas conversas.</b> O QR daqui conecta em modo
      <i>somente contatos</i>: entra o número, o nome que <b>você</b> salvou na
      agenda e o nome de perfil. Mensagem nenhuma é lida ou guardada — nem o
      histórico, nem as que chegarem depois.
      <br><br>
      Para acompanhar grupos, conversas e alertas, use a aba <b>🔌 WhatsApp</b>:
      lá o QR conecta em modo completo.
      <br><br>
      Quem está salvo na sua agenda é marcado como tal, e isso pesa na
      classificação: um número que você guardou tem vínculo real, e é mais
      provável que aceite entrar num grupo do que um desconhecido.
      <br><br>
      <b>Antes de disparar para esta base</b>, lembre que a lei eleitoral veda usar
      cadastro de terceiros (Lei 9.504/97, art. 57-E). Agenda própria da campanha
      é vínculo legítimo; lista comprada ou cedida, não.
    </div>`;
};

// ============================================================ ACESSOS
VISTAS.contas = async () => {
  const [campanhas, usuarios] = await Promise.all([api('/campanhas'), api('/usuarios')]);
  const admin = estado.usuario.papel === 'admin';

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>Acessos</h2>
        <p>${campanhas.length} campanha(s) · ${usuarios.length} usuário(s).
           Cada campanha tem banco, WhatsApp e Firebase próprios.</p>
      </div>
      ${admin ? `<div class="acoes">
        <button class="btn" data-acao="novo-usuario">+ Usuário</button>
        <button class="btn primario" data-acao="nova-campanha">+ Campanha</button>
      </div>` : ''}
    </div>

    <div class="grade g-3" style="margin-bottom:18px">
      ${campanhas.map((c) => `
        <section class="card">
          <div class="corpo campanha-card">
            <div class="titulo">
              <span class="avatar" style="background:${esc(c.cor)}">${esc(iniciais(c.nome))}</span>
              <div style="min-width:0">
                <div style="font-weight:650;letter-spacing:-.01em">${esc(c.nome)}</div>
                <div class="sub" style="color:var(--tinta-4)">${esc(c.cargo || c.slug)}</div>
              </div>
              <span style="margin-left:auto">
                <span class="ponto ${c.whatsapp === 'conectado' ? 'on' : c.whatsapp === 'qr' ? 'qr' : ''}"
                      title="WhatsApp: ${esc(c.whatsapp)}"></span>
              </span>
            </div>
            <div class="numeros">
              <div><b>${num(c.resumo.pessoas)}</b> pessoas</div>
              <div><b>${num(c.resumo.grupos)}</b> grupos</div>
              <div><b>${num(c.resumo.assinaturas)}</b> assinaturas</div>
              <div><b>${num(c.usuarios)}</b> acessos</div>
            </div>
            <div class="linha-dado"><span class="k">Formulário</span>
              <span class="v"><a href="/cadastro/${esc(c.slug)}" target="_blank">/cadastro/${esc(c.slug)}</a></span></div>
            <div class="linha-dado"><span class="k">Firebase</span>
              <span class="v">${c.firebase_key ? '✅ projeto próprio' : '<span class="vazio">não configurado</span>'}</span></div>
            ${c.resumo.naoLidas || c.resumo.alertas ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
              ${c.resumo.naoLidas ? chip(`${c.resumo.naoLidas} não lidas`, '#16a34a') : ''}
              ${c.resumo.alertas ? chip(`${c.resumo.alertas} alertas`, '#dc2626') : ''}
            </div>` : ''}
            ${admin ? `
              <div class="linha-dado"><span class="k">Avisos no WhatsApp</span>
                <span class="v">${c.alerta_whatsapp
                  ? esc(c.alerta_whatsapp)
                  : '<span class="vazio">ninguém recebe</span>'}</span></div>
              <button class="btn" style="width:100%;justify-content:center"
                      data-avisos="${esc(c.slug)}">🔔 Número que recebe avisos</button>` : ''}
            ${admin && c.slug !== estado.campanha.slug
              ? `<button class="btn" style="width:100%;justify-content:center" data-ir-campanha="${esc(c.slug)}">Trabalhar nesta campanha</button>`
              : '<div class="sub" style="text-align:center;color:var(--tinta-4)">você está aqui</div>'}
          </div>
        </section>`).join('')}
    </div>

    <section class="card">
      <header><h3>Usuários</h3><span class="dica">senha só aparece na criação</span></header>
      <div class="tabela-rolagem">
        <table class="tabela" style="min-width:640px">
          <thead><tr><th>Pessoa</th><th>Papel</th><th>Campanha</th><th>Último acesso</th><th></th></tr></thead>
          <tbody>
            ${usuarios.map((u) => `
              <tr style="cursor:default">
                <td>
                  <div style="font-weight:600">${esc(u.nome)}</div>
                  <div class="sub">${esc(u.email)}</div>
                </td>
                <td><span class="papel-badge" style="background:${CORES_PAPEL[u.papel]}20;color:${CORES_PAPEL[u.papel]}">${esc(u.papel)}</span></td>
                <td>${esc(u.campanha_nome || (u.papel === 'admin' ? 'todas' : '—'))}</td>
                <td class="sub">${u.ultimo_acesso ? quando(u.ultimo_acesso) : 'nunca entrou'}</td>
                <td style="text-align:right;white-space:nowrap">
                  ${admin ? `
                    <button class="btn" data-senha-de="${esc(u.email)}">Nova senha</button>
                    ${u.email !== estado.usuario.email
                      ? `<button class="btn" data-ativo-de="${esc(u.email)}" data-ativo="${u.ativo ? 0 : 1}">
                          ${u.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}
                  ` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <div class="alerta info" style="margin-top:16px">
      <b>Como os papéis funcionam.</b>
      <b>Admin</b> vê todas as campanhas e cria acessos.
      <b>Equipe</b> trabalha numa campanha só — responde, adiciona, edita ficha.
      <b>Candidato</b> vê a base dele e usa o formulário de cadastro para preencher com as
      pessoas; não conecta WhatsApp, não mexe no Firebase e não dispara adição em massa.
    </div>`;
};

async function formularioNovaCampanha() {
  gaveta.innerHTML = `
    <div class="topo">
      <div style="min-width:0">
        <div style="font-size:16px;font-weight:660;letter-spacing:-.02em">Nova campanha</div>
        <div style="font-size:12.5px;color:var(--tinta-3)">banco, WhatsApp e Firebase separados</div>
      </div>
      <button class="fechar" data-acao="fechar-gaveta">✕</button>
    </div>
    <div class="rolagem">
      <div class="bloco">
        <div class="campo"><label>Nome do candidato *</label>
          <input id="nc-nome" placeholder="Ex.: Fernando Souza"></div>
        <div class="campo"><label>Cargo</label>
          <input id="nc-cargo" placeholder="Ex.: Vereador · Campinas"></div>
        <div class="campo"><label>Identificador (slug)</label>
          <input id="nc-slug" placeholder="preenchido a partir do nome">
          <small style="display:block;margin-top:5px;font-size:11.5px;color:var(--tinta-3);line-height:1.5">
            Nomeia a pasta dos dados e a árvore no Firestore
            (<code>campanhas/&lt;slug&gt;</code>). Se esta campanha já tem base no
            Firebase, use <b>exatamente</b> o mesmo identificador — senão a
            restauração procura no lugar errado e volta vazia.
          </small>
        </div>
        <div class="campo"><label>Cor da campanha</label>
          <input id="nc-cor" type="color" value="#2563eb" style="height:40px;padding:4px"></div>
        <div class="campo"><label>E-mail da equipe</label>
          <input id="nc-equipe" type="email" placeholder="equipe@campanha.com"></div>
        <div class="campo"><label>E-mail do candidato</label>
          <input id="nc-candidato" type="email" placeholder="candidato@email.com"></div>
      </div>
      <div class="alerta info">
        Ao criar, o sistema já gera <b>dois acessos</b> (equipe e candidato) com senhas
        aleatórias. Anote-as: elas aparecem uma única vez.
      </div>
      <button class="btn primario" style="width:100%;justify-content:center;padding:12px"
              data-acao="salvar-campanha">Criar campanha</button>
    </div>`;
  gaveta.classList.add('aberto');
  overlay.classList.add('aberto');

  // O slug acompanha o nome enquanto ninguém o editar à mão. Quem digitar um
  // identificador próprio (para casar com uma árvore que já existe no
  // Firestore) não pode vê-lo ser sobrescrito ao corrigir o nome.
  const campoSlug = $('#nc-slug', gaveta);
  $('#nc-nome', gaveta).addEventListener('input', (e) => {
    if (campoSlug.dataset.editado) return;
    campoSlug.value = slugificar(e.target.value);
  });
  campoSlug.addEventListener('input', () => { campoSlug.dataset.editado = '1'; });

  $('#nc-nome', gaveta)?.focus();
}

/** Mesma regra do servidor (contas.js), para o painel mostrar o slug antes de criar. */
const slugificar = (texto) => String(texto || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function formularioNovoUsuario() {
  const campanhas = estado.campanhas;
  gaveta.innerHTML = `
    <div class="topo">
      <div style="min-width:0">
        <div style="font-size:16px;font-weight:660;letter-spacing:-.02em">Novo acesso</div>
        <div style="font-size:12.5px;color:var(--tinta-3)">a senha é gerada automaticamente</div>
      </div>
      <button class="fechar" data-acao="fechar-gaveta">✕</button>
    </div>
    <div class="rolagem">
      <div class="bloco">
        <div class="campo"><label>Nome *</label><input id="nu-nome"></div>
        <div class="campo"><label>E-mail *</label><input id="nu-email" type="email"></div>
        <div class="campo"><label>Papel *</label>
          <select id="nu-papel">
            <option value="equipe">Equipe — trabalha na campanha</option>
            <option value="candidato">Candidato — vê a base e usa o formulário</option>
            <option value="admin">Admin — vê todas as campanhas</option>
          </select>
        </div>
        <div class="campo" id="nu-campo-campanha"><label>Campanha *</label>
          <select id="nu-campanha">
            ${campanhas.map((c) => `<option value="${esc(c.slug)}">${esc(c.nome)}</option>`).join('')}
          </select>
        </div>
      </div>
      <button class="btn primario" style="width:100%;justify-content:center;padding:12px"
              data-acao="salvar-usuario">Criar acesso</button>
    </div>`;
  gaveta.classList.add('aberto');
  overlay.classList.add('aberto');
  $('#nu-papel', gaveta).addEventListener('change', (e) => {
    $('#nu-campo-campanha', gaveta).hidden = e.target.value === 'admin';
  });
  $('#nu-nome', gaveta)?.focus();
}

function mostrarCredencial(titulo, itens) {
  gaveta.innerHTML = `
    <div class="topo">
      <div style="min-width:0">
        <div style="font-size:16px;font-weight:660;letter-spacing:-.02em">${esc(titulo)}</div>
        <div style="font-size:12.5px;color:var(--tinta-3)">anote agora — não aparece de novo</div>
      </div>
      <button class="fechar" data-acao="fechar-gaveta">✕</button>
    </div>
    <div class="rolagem">
      <div class="alerta"><b>Guarde estas senhas.</b> Elas não ficam salvas em texto em
        lugar nenhum — só o resumo criptográfico. Se perder, gere uma nova.</div>
      <div class="credencial">
        ${itens.map((i) => `${esc(i.rotulo)}<br><b>${esc(i.email)}</b> · senha <b>${esc(i.senha)}</b><br><br>`).join('')}
      </div>
      <button class="btn" style="width:100%;justify-content:center" data-acao="copiar-credencial">
        Copiar tudo
      </button>
    </div>`;
  gaveta.dataset.credencial = itens
    .map((i) => `${i.rotulo}\n${i.email}\nsenha: ${i.senha}`).join('\n\n');
  gaveta.classList.add('aberto');
  overlay.classList.add('aberto');
}

// ============================================================ CONEXÃO
VISTAS.conexao = async () => {
  const s = estado.whatsapp = await api('/whatsapp/status');
  const rotulo = {
    desconectado: 'Desconectado', conectando: 'Conectando…', qr: 'Aguardando leitura do QR',
    conectado: 'Conectado', erro: 'Erro'
  }[s.status] || s.status;

  const c = estado.campanha;
  const outras = estado.campanhas.filter((x) => x.slug !== c.slug);

  conteudo.innerHTML = `
    <div class="cabecalho">
      <div>
        <h2>WhatsApp de ${esc(c.nome)}</h2>
        <p>Status atual: <b>${rotulo}</b>${s.telefone ? ` · número ${esc(s.telefone)}` : ''}</p>
      </div>
      <div class="acoes">
        ${s.status === 'conectado'
          ? `<button class="btn" data-acao="wa-sincronizar">↻ Sincronizar grupos</button>
             <button class="btn" data-acao="wa-desconectar">Desconectar</button>`
          : `<button class="btn" data-acao="wa-provedor">⚙ Origem: ${s.provedor === 'wacore' ? 'WA-Core2' : 'Baileys'}</button>
             <button class="btn" data-acao="wa-parear">📱 Conectar por número</button>
             <button class="btn primario" data-acao="wa-conectar">Gerar QR Code</button>`}
      </div>
    </div>

    <!-- Multi-campanha: conectar o número do candidato errado bagunça duas
         bases de uma vez. O aviso é proposital e não some. -->
    <div class="alerta ${s.status === 'conectado' ? 'info' : ''}" style="margin-bottom:16px;
         border-left-color:${esc(c.cor)}">
      <b>Você está conectando o WhatsApp de ${esc(c.nome)}${c.cargo ? ` (${esc(c.cargo)})` : ''}.</b>
      Use o chip dedicado desta campanha — o número lido aqui passa a alimentar
      só a base dela.
      ${outras.length ? `<br><span style="font-size:12px">Para outro candidato, troque a campanha
        no seletor à esquerda: ${outras.map((o) => esc(o.nome)).join(' · ')}.</span>` : ''}
    </div>

    <div class="grade g-2">
      <section class="card">
        <header><h3>${s.status === 'conectado' ? 'Conexão ativa' : 'Leia o QR com o celular âncora'}</h3></header>
        <div class="corpo">
          ${s.disponivel === false ? `
            <div class="alerta">
              <b>Falta instalar a biblioteca de conexão.</b><br>
              O painel funciona em modo demonstração. Para plugar o WhatsApp de verdade, rode na pasta do projeto:
            </div>
            <div class="codigo" style="margin-top:12px">npm install @whiskeysockets/baileys qrcode</div>
            <p style="font-size:12.5px;color:var(--tinta-3);line-height:1.55;margin-bottom:0">
              Depois reinicie o servidor e clique em <b>Gerar QR Code</b>.
            </p>
          ` : s.codigo ? `
            <div class="qr-caixa">
              <div style="font-size:12px;color:var(--tinta-3);letter-spacing:.08em">CÓDIGO PARA ${esc(s.codigoPara)}</div>
              <div style="font-family:ui-monospace,monospace;font-size:38px;font-weight:700;
                          letter-spacing:.18em;margin:6px 0">${esc(s.codigo)}</div>
              <p style="font-size:12.5px;color:var(--tinta-3);max-width:340px;margin:0;line-height:1.6">
                No celular desse número: <b>WhatsApp → Dispositivos conectados → Conectar dispositivo
                → Conectar com número de telefone</b>. Digite o código acima.
              </p>
              <p style="font-size:12px;color:var(--tinta-3);margin:0">
                Vale poucos minutos. Se vencer, peça outro.
              </p>
            </div>
          ` : s.qr ? `
            <div class="qr-caixa">
              <img src="${s.qr}" alt="QR Code do WhatsApp">
              <p style="font-size:12.5px;color:var(--tinta-3);max-width:340px;margin:0;line-height:1.6">
                No celular que já está nos grupos: <b>WhatsApp → Dispositivos conectados →
                Conectar dispositivo</b>. Deixe o celular já nessa tela <b>antes</b> de olhar o código:
                ele expira e é renovado sozinho, e escanear um vencido dá
                "Verifique sua conexão e tente novamente".
              </p>
              <div class="alerta info" style="text-align:left;font-size:12.5px">
                Sem conseguir escanear? Use <b>Conectar por número</b> — a pessoa digita um código
                de 8 letras no próprio celular, sem câmera nenhuma.
              </div>
            </div>
          ` : s.status === 'conectado' ? `
            <div class="qr-caixa">
              <div style="font-size:46px">✅</div>
              <p style="margin:0;font-weight:600">Ouvindo ${s.grupos.length} grupo(s) em tempo real</p>
              <p style="font-size:12.5px;color:var(--tinta-3);margin:0">
                ${num(s.recebidas)} mensagem(ns) capturada(s) nesta sessão${s.ultimaMensagem ? ` · última ${quando(s.ultimaMensagem.ts)}` : ''}
              </p>
              <div style="display:grid;gap:6px;width:100%;margin-top:10px">
                ${s.grupos.map((g) => `<div class="linha-dado"><span class="k" style="width:auto;flex:1">${esc(g.nome)}</span><span class="v">${num(g.membros)} membros</span></div>`).join('')}
              </div>
            </div>
          ` : `
            <div class="qr-caixa">
              <div style="font-size:46px">📱</div>
              <p style="margin:0;color:var(--tinta-3);font-size:13px;max-width:330px">
                Clique em <b>Gerar QR Code</b> e escaneie com o celular que já participa dos cinco grupos.
              </p>
              ${s.erro ? `<div class="alerta" style="text-align:left">${esc(s.erro)}</div>` : ''}
            </div>`}
        </div>
      </section>

      <div style="display:grid;gap:16px;align-content:start">
        <section class="card">
          <header>
            <h3>📇 Agenda do celular</h3>
            <span class="dica">${s.agenda?.importadaEm ? quando(s.agenda.importadaEm) : 'aguardando'}</span>
          </header>
          <div class="corpo">
            ${s.agenda?.naAgenda ? `
              <div class="grade g-kpi" style="margin-bottom:10px">
                ${kpi('Na agenda', num(s.agenda.naAgenda), 'contatos salvos no celular')}
                ${kpi('Importados', num(s.agenda.contatos), 'entraram pela conexão')}
              </div>
              <p style="font-size:12.5px;color:var(--tinta-3);line-height:1.6;margin:0">
                Importados sozinhos ao ler o QR — nenhum foi digitado. Cada um virou ficha
                em <b>👥 Pessoas</b> e já conta na classificação de <b>🤝 Potencial de apoio</b>.
              </p>
            ` : `
              <p style="font-size:13px;color:var(--tinta-3);line-height:1.6;margin:0">
                Ainda não há contatos importados. Ao ler o QR, o sistema recebe a agenda
                do celular e cria uma ficha por número — automaticamente, sem cadastro manual.
              </p>
              <div class="alerta info" style="margin-top:10px;font-size:12.5px">
                Quem está salvo na sua agenda entra marcado como tal. Esse sinal pesa na
                classificação: alguém que você guardou no celular tem vínculo real, e é
                mais provável que aceite entrar num grupo.
              </div>`}
          </div>
        </section>

        <section class="card">
          <header><h3>Como funciona</h3></header>
          <div class="corpo">
            <ol class="passos">
              <li>O sistema entra como <b>dispositivo conectado</b> — o mesmo mecanismo do WhatsApp Web. O celular continua funcionando normal.</li>
              <li>Ao conectar, ele lê a lista dos grupos e de todos os participantes, criando uma ficha por telefone.</li>
              <li>Cada mensagem, resposta e reação nova alimenta o perfil em tempo real.</li>
              <li>O link do abaixo-assinado costura nome, cidade e atuação ao telefone que já está na base.</li>
            </ol>
          </div>
        </section>

        <section class="card">
          <header><h3>O que você precisa saber</h3></header>
          <div class="corpo" style="display:grid;gap:10px">
            <div class="alerta">
              <b>Use um número dedicado da campanha.</b> Essa integração não é oficial do WhatsApp:
              contas que disparam em massa podem ser bloqueadas. Aqui o sistema só <i>escuta</i>,
              o que é bem mais seguro — mas o número da candidata não deve ser o âncora.
            </div>
            <div class="alerta info">
              <b>LGPD.</b> Você está tratando dado pessoal com finalidade política.
              O ideal é: aviso no grupo de que ele é monitorado pela equipe, link do cadastro
              com consentimento explícito, e um responsável pela base. Exclusão a pedido do titular
              deve ser possível — o botão existe na ficha de cada pessoa.
            </div>
          </div>
        </section>

        <section class="card">
          <header><h3>Formulário do abaixo-assinado</h3></header>
          <div class="corpo">
            <p style="font-size:12.5px;color:var(--tinta-3);margin:0 0 10px;line-height:1.55">
              Mande esse link nos grupos. Quem preenche vira ficha completa automaticamente,
              casada pelo telefone com quem já está no grupo.
            </p>
            <div class="codigo">${location.origin}/cadastro</div>
            <a class="btn" style="margin-top:10px" href="/cadastro" target="_blank">Abrir formulário ↗</a>
          </div>
        </section>
      </div>
    </div>`;
};

// ------------------------------------------------------------------- a ficha
async function abrirPessoa(id) {
  gaveta.innerHTML = '<div class="carregando">carregando ficha…</div>';
  gaveta.classList.add('aberto');
  overlay.classList.add('aberto');

  const x = estado.pessoaAberta = await api(`/pessoas/${id}`);
  const tags = estado.panorama?.tags || await api('/tags');
  const cor = corDoNome(x.exibicao);
  const partes = x.score_detalhe?.partes || {};
  const rotulosScore = {
    volume: 'Fala', recencia: 'Recência', interacao: 'Interage',
    influencia: 'É respondida', alcance: 'Alcance'
  };
  const maxSemana = Math.max(1, ...x.atividade_semanal);
  const maxTema = Math.max(1, ...x.temas.map((t) => t.score));

  const dado = (k, v, falta) => `
    <div class="linha-dado"><span class="k">${k}</span>
      <span class="v ${v ? '' : 'falta'}">${v ? esc(v) : falta}</span></div>`;

  gaveta.innerHTML = `
    <div class="topo">
      <span class="avatar" style="background:${cor};width:46px;height:46px;font-size:16px;border-radius:13px">${esc(iniciais(x.exibicao))}</span>
      <div style="min-width:0">
        <div style="font-size:17px;font-weight:660;letter-spacing:-.02em">${esc(x.exibicao)}</div>
        <div style="font-size:12.5px;color:var(--tinta-3);font-variant-numeric:tabular-nums">${esc(x.telefone_fmt)}</div>
        <div style="display:flex;gap:5px;margin-top:7px;flex-wrap:wrap">
          ${badgeFaixa(x.faixa)}
          ${x.tags.map((t) => chip(t.nome, t.cor)).join('')}
        </div>
      </div>
      <button class="fechar" data-acao="fechar-gaveta">✕</button>
    </div>

    <div class="rolagem">
      <div class="bloco destaque">
        <h4>Próxima ação sugerida</h4>
        <p style="margin:0;font-size:13.5px;font-weight:560;line-height:1.5">${esc(x.proxima_acao || '—')}</p>
        <div style="display:flex;gap:9px;align-items:center;margin-top:13px">
          <span class="barra" style="flex:1"><i style="width:${x.completude}%;background:${x.completude >= 70 ? 'var(--verde)' : x.completude >= 40 ? 'var(--laranja)' : '#ef4444'}"></i></span>
          <span style="font-size:12px;color:var(--tinta-3);white-space:nowrap">ficha ${x.completude}% completa</span>
        </div>
      </div>

      <div class="bloco" id="bloco-cadastro">
        <h4>Cadastro (abaixo-assinado)</h4>
        ${dado('Nome', x.nome, 'não preencheu')}
        ${dado('Cidade', x.cidade, 'não preencheu')}
        ${dado('Bairro', x.bairro, '—')}
        ${dado('Atuação', x.atuacao, 'não preencheu')}
        ${dado('E-mail', x.email, '—')}
        ${dado('Assinou em', x.cadastro_em ? dataCurta(x.cadastro_em) : null, 'ainda não assinou')}
        ${dado('Nome no WhatsApp', x.nome_wa, 'sem nome salvo')}
        ${x.observacoes ? `
          <div style="margin-top:12px;padding:11px 13px;background:#fffbeb;border-radius:9px;
                      border-left:3px solid var(--laranja);font-size:12.5px;line-height:1.55">
            <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;
                        color:#92400e;font-weight:650;margin-bottom:5px">O que ela escreveu</div>
            ${esc(x.observacoes)}
          </div>` : ''}
        <button class="btn" style="margin-top:11px;width:100%;justify-content:center" data-acao="editar">✎ Completar ficha manualmente</button>
      </div>

      ${x.abaixos.length ? `
      <div class="bloco">
        <h4>Abaixo-assinados que assinou (${x.abaixos.length})</h4>
        ${x.abaixos.map((a) => `
          <div style="padding:9px 0;border-bottom:1px solid var(--linha)">
            <div style="font-weight:560;line-height:1.4">${esc(a.titulo)}</div>
            <div class="sub" style="color:var(--tinta-4);margin-top:3px">
              ${dataCurta(a.criado_em)} · ${esc(a.plataforma || 'anúncio')}${a.anuncio ? ` · ${esc(a.anuncio.slice(0, 46))}` : ''}
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div class="bloco">
        <h4>Classificação · ${x.engajamento}/100</h4>
        ${Object.entries(rotulosScore).map(([chave, rot]) => {
          const maximo = estado.config.pesos[chave];
          const valor = partes[chave] || 0;
          return `<div class="score-linha">
            <span>${rot}</span>
            <span class="barra"><i style="width:${(valor / maximo) * 100}%;background:${corFaixa(x.faixa)}"></i></span>
            <span class="n">${valor}/${maximo}</span>
          </div>`;
        }).join('')}
        <div style="display:flex;gap:16px;margin-top:12px;font-size:12px;color:var(--tinta-3);flex-wrap:wrap">
          <span><b style="color:var(--tinta)">${num(x.msgs_total)}</b> mensagens</span>
          <span><b style="color:var(--tinta)">${num(x.msgs_30d)}</b> em 30d</span>
          <span><b style="color:var(--tinta)">${num(x.reacoes_recebidas)}</b> reações recebidas</span>
          <span><b style="color:var(--tinta)">${num(x.respostas_recebidas)}</b> respostas recebidas</span>
        </div>
        <h4 style="margin-top:16px">Atividade · 12 semanas</h4>
        <div class="sparkline">
          ${x.atividade_semanal.map((v, i) => `<i class="${i >= 9 ? 'forte' : ''}" style="height:${Math.max(4, (v / maxSemana) * 100)}%" title="${v} mensagens"></i>`).join('')}
        </div>
      </div>

      <div class="bloco">
        <h4>Interesse — o que ela fala</h4>
        ${x.intencoes_rotulos.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:13px">
          ${x.intencoes_rotulos.map((i) => chip(i.rotulo, i.cor)).join('')}</div>` : ''}
        ${x.temas.length ? `<div class="barras-h">
          ${x.temas.slice(0, 7).map((t) => `
            <div class="barra-h" style="cursor:default">
              <span class="rot">${esc(t.rotulo)}</span>
              <span class="barra"><i style="width:${(t.score / maxTema) * 100}%;background:${t.cor}"></i></span>
              <span class="n">${t.mencoes}×</span>
            </div>`).join('')}</div>`
          : '<p class="vazio">Ainda não escreveu o suficiente para o sistema entender o interesse dela.</p>'}
      </div>

      <div class="bloco">
        <h4>Grupos (${x.grupos.length})</h4>
        ${x.grupos.map((g) => `<div class="linha-dado">
          <span class="k" style="width:auto;flex:1">${esc(g.nome)}</span>
          <span class="v">${g.admin ? '<span class="chip" style="background:#ede9fe;color:#5b21b6">admin</span>' : ''} desde ${dataCurta(g.entrou_em)}</span>
        </div>`).join('') || '<p class="vazio">Sem grupo.</p>'}
        <h4 style="margin-top:16px">Marcações da equipe</h4>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${tags.map((t) => {
            const tem = x.tags.some((y) => y.id === t.id);
            return `<span class="chip clicavel" data-tag="${t.id}" data-remover="${tem ? 1 : 0}"
              style="background:${tem ? t.cor + '20' : '#f1f5f9'};color:${tem ? t.cor : '#94a3b8'};border-color:${tem ? t.cor + '40' : 'transparent'}">
              ${tem ? '✓ ' : '+ '}${esc(t.nome)}</span>`;
          }).join('')}
        </div>
      </div>

      <div class="bloco">
        <h4>Últimas mensagens</h4>
        ${x.mensagens.map((m) => `
          <div class="msg-item">
            <div>${m.texto ? esc(m.texto) : `<span class="vazio">${esc(m.tipo)}</span>`}</div>
            <div class="meta">
              <span>${esc(m.grupo || '')}</span><span>${quando(m.ts)}</span>
              ${m.reacoes ? `<span>❤ ${m.reacoes}</span>` : ''}
              ${m.respostas ? `<span>↩ ${m.respostas} resposta(s)</span>` : ''}
            </div>
          </div>`).join('') || '<p class="vazio">Nunca escreveu nos grupos.</p>'}
      </div>

      <div class="bloco">
        <h4>Linha do tempo</h4>
        <div class="campo">
          <textarea id="nova-nota" rows="2" placeholder="Anotar algo sobre essa pessoa…"></textarea>
        </div>
        <button class="btn" style="margin-bottom:14px" data-acao="salvar-nota">Salvar anotação</button>
        <div class="timeline">
          ${x.timeline.map((e) => `
            <div class="ev ${esc(e.tipo)}">
              <div>${esc(e.descricao)}</div>
              <div class="quando">${dataCurta(e.ts)} · ${quando(e.ts)}</div>
            </div>`).join('') || '<p class="vazio">Sem eventos.</p>'}
        </div>
      </div>
    </div>`;
}

function formularioEdicao() {
  const x = estado.pessoaAberta;
  const campo = (id, rot, valor, tipo = 'text') =>
    `<div class="campo"><label>${rot}</label><input id="ed-${id}" type="${tipo}" value="${esc(valor || '')}"></div>`;

  const bloco = $('#bloco-cadastro', gaveta);
  bloco.innerHTML = `
    <h4>Completar ficha</h4>
    ${campo('nome', 'Nome completo', x.nome)}
    ${campo('cidade', 'Cidade', x.cidade)}
    ${campo('bairro', 'Bairro', x.bairro)}
    ${campo('atuacao', 'Atuação / profissão', x.atuacao)}
    ${campo('email', 'E-mail', x.email, 'email')}
    <div class="campo"><label>Observações</label><textarea id="ed-observacoes" rows="3">${esc(x.observacoes || '')}</textarea></div>
    <div style="display:flex;gap:8px">
      <button class="btn primario" data-acao="salvar-ficha">Salvar</button>
      <button class="btn" data-acao="cancelar-edicao">Cancelar</button>
    </div>`;
}

function fecharGaveta() {
  gaveta.classList.remove('aberto');
  overlay.classList.remove('aberto');
  estado.pessoaAberta = null;
}

// ------------------------------------------------------------------- eventos
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

document.addEventListener('click', async (e) => {
  const alvo = (sel) => e.target.closest(sel);

  const nav = alvo('[data-vista]');
  if (nav) { irPara(nav.dataset.vista); return; }

  if (alvo('[data-acao="fechar-gaveta"]')) return fecharGaveta();

  // --- caixa de entrada ---------------------------------------------------
  const conversa = alvo('[data-conversa]');
  if (conversa) {
    estado.conversaAberta = { tipo: conversa.dataset.conversa, id: Number(conversa.dataset.id) };
    estado.inbox.mostrandoThread = true;   // no celular, troca a lista pela conversa
    return render();
  }

  if (alvo('[data-acao="voltar-lista"]')) {
    estado.inbox.mostrandoThread = false;
    return render();
  }

  const aba = alvo('[data-aba]');
  if (aba) {
    estado.inbox.filtro = aba.dataset.aba;
    return render();
  }

  const sugestao = alvo('[data-sugestao]');
  if (sugestao) {
    // Nunca envia sozinho: joga no campo para a equipe revisar.
    const campo = $('#compositor');
    if (campo) {
      campo.value = $('.texto', sugestao).textContent.trim();
      campo.focus();
      campo.setSelectionRange(campo.value.length, campo.value.length);
    }
    return;
  }

  if (alvo('[data-acao="enviar-resposta"]')) return enviarResposta();

  // --- acessos -------------------------------------------------------------
  if (alvo('[data-acao="nova-campanha"]')) return formularioNovaCampanha();
  if (alvo('[data-acao="novo-usuario"]')) return formularioNovoUsuario();

  const faixaApoio = alvo('[data-faixa-apoio]');
  if (faixaApoio) {
    // Clicar na faixa já selecionada volta para "todas".
    const escolhida = faixaApoio.dataset.faixaApoio;
    estado.filtroApoio = estado.filtroApoio === escolhida ? '' : escolhida;
    return render();
  }

  if (alvo('[data-acao="reclassificar"]')) {
    const b = alvo('[data-acao="reclassificar"]');
    b.disabled = true; b.textContent = 'lendo conversas…';
    const r = await api('/recalcular', { method: 'POST' });
    b.disabled = false; b.textContent = '↻ Reclassificar agora';
    toast('Classificação refeita', `${num(r.pessoas ?? 0)} contato(s) reavaliados.`);
    estado.panorama = null;
    return render();
  }

  const avisos = alvo('[data-avisos]');
  if (avisos) {
    const slug = avisos.dataset.avisos;
    const atual = estado.campanhas.find((c) => c.slug === slug)?.alerta_whatsapp || '';
    const numero = prompt(
      'Número que recebe os avisos desta campanha no WhatsApp.\n\n'
      + 'Só dígitos, com país e DDD — ex.: 5519981466623\n'
      + 'Deixe em branco para desligar os avisos.\n\n'
      + 'Chegam: saída de grupo, atrito detectado e mensagem no privado.\n'
      + 'O aviso sai pelo WhatsApp desta campanha, então ele precisa estar conectado.',
      atual
    );
    if (numero === null) return;

    const limpo = numero.replace(/\D/g, '');
    if (limpo && (limpo.length < 12 || limpo.length > 15)) {
      return toast('Número inválido', 'Use país + DDD + número, só dígitos.', 'critico');
    }
    await api(`/campanhas/${slug}`, { method: 'PATCH', body: { alerta_whatsapp: limpo || null } });
    estado.campanhas = (await api('/eu')).campanhas;
    toast('Avisos atualizados', limpo ? `Vão para ${limpo}.` : 'Desligados.');
    return render();
  }

  const irCampanha = alvo('[data-ir-campanha]');
  if (irCampanha) {
    const seletor = $('#troca-campanha');
    seletor.value = irCampanha.dataset.irCampanha;
    seletor.dispatchEvent(new Event('change'));
    return;
  }

  if (alvo('[data-acao="salvar-campanha"]')) {
    const b = alvo('[data-acao="salvar-campanha"]');
    const nome = $('#nc-nome').value.trim();
    if (!nome) return toast('Falta o nome', 'Informe o nome do candidato.', 'critico');
    b.disabled = true; b.textContent = 'criando…';

    const r = await api('/campanhas', {
      method: 'POST',
      body: {
        nome, cargo: $('#nc-cargo').value.trim() || null, cor: $('#nc-cor').value,
        slug: $('#nc-slug').value.trim() || null,
        emailEquipe: $('#nc-equipe').value.trim() || null,
        emailCandidato: $('#nc-candidato').value.trim() || null
      }
    });
    if (r.erro) { toast('Não deu', r.erro, 'critico'); b.disabled = false; b.textContent = 'Criar campanha'; return; }

    const eu = await api('/eu');
    estado.campanhas = eu.campanhas;
    // Primeira campanha do servidor: ela vira a ativa na hora, senão o painel
    // continuaria mostrando a tela de "nenhuma campanha" recém-resolvida.
    if (!estado.campanha) estado.campanha = eu.campanhaAtiva || estado.campanhas[0] || null;

    if (r.acessos?.length) mostrarCredencial(`Campanha "${r.nome}" criada`, r.acessos);
    else { fecharGaveta(); toast('Campanha criada', r.nome); }
    pintarIdentidade();
    return render();
  }

  if (alvo('[data-acao="salvar-usuario"]')) {
    const b = alvo('[data-acao="salvar-usuario"]');
    const papel = $('#nu-papel').value;
    const corpo = {
      nome: $('#nu-nome').value.trim(),
      email: $('#nu-email').value.trim(),
      papel,
      campanhaSlug: papel === 'admin' ? null : $('#nu-campanha').value
    };
    if (!corpo.nome || !corpo.email) return toast('Faltam dados', 'Nome e e-mail são obrigatórios.', 'critico');
    b.disabled = true; b.textContent = 'criando…';

    const r = await api('/usuarios', { method: 'POST', body: corpo });
    if (r.erro) { toast('Não deu', r.erro, 'critico'); b.disabled = false; b.textContent = 'Criar acesso'; return; }
    mostrarCredencial('Acesso criado',
      [{ rotulo: `${r.nome} (${r.papel})`, email: r.email, senha: r.senhaGerada }]);
    return render();
  }

  const novaSenha = alvo('[data-senha-de]');
  if (novaSenha) {
    const email = novaSenha.dataset.senhaDe;
    const r = await api(`/usuarios/${encodeURIComponent(email)}/senha`, { method: 'POST' });
    if (r.erro) return toast('Não deu', r.erro, 'critico');
    mostrarCredencial('Senha redefinida', [{ rotulo: email, email, senha: r.senha }]);
    return;
  }

  const trocarAtivo = alvo('[data-ativo-de]');
  if (trocarAtivo) {
    await api(`/usuarios/${encodeURIComponent(trocarAtivo.dataset.ativoDe)}/ativo`, {
      method: 'POST', body: { ativo: trocarAtivo.dataset.ativo === '1' }
    });
    return render();
  }

  const copiar = alvo('[data-copiar]');
  if (copiar) {
    await navigator.clipboard.writeText(copiar.dataset.copiar);
    toast('Copiado', 'O link está na área de transferência.');
    return;
  }

  if (alvo('[data-acao="copiar-credencial"]')) {
    await navigator.clipboard.writeText(gaveta.dataset.credencial || '');
    toast('Copiado', 'As credenciais estão na área de transferência.');
    return;
  }

  // --- fila de adição ------------------------------------------------------
  const adicionar = alvo('[data-adicionar]');
  if (adicionar) return abrirAdicionar(Number(adicionar.dataset.adicionar));

  if (alvo('[data-acao="fila-pausar"]')) { await api('/fila-adicao/pausar', { method: 'POST' }); return render(); }
  if (alvo('[data-acao="fila-retomar"]')) { await api('/fila-adicao/retomar', { method: 'POST' }); return render(); }
  if (alvo('[data-acao="fila-cancelar"]')) {
    const r = await api('/fila-adicao/cancelar', { method: 'POST', body: {} });
    toast('Fila', `${r.cancelados} pendente(s) cancelado(s).`);
    return render();
  }

  if (alvo('[data-acao="fila-enfileirar"]')) {
    const b = alvo('[data-acao="fila-enfileirar"]');
    b.disabled = true; b.textContent = 'enfileirando…';
    const { grupoId, filtros } = estado.adicionar;
    const limite = Number($('#ad-limite')?.value) || null;
    const r = await api(`/grupos/${grupoId}/adicionar`, { method: 'POST', body: { filtros, limite } });
    if (r.erro) { toast('Não deu', r.erro, 'critico'); return; }
    fecharGaveta();
    toast('Fila criada',
      `${r.enfileirados} pessoa(s) na fila do grupo ${r.grupo}. Término estimado: ${r.estimativa}.`);
    return render();
  }

  const pessoa = alvo('[data-pessoa]');
  if (pessoa) return abrirPessoa(Number(pessoa.dataset.pessoa));

  const pag = alvo('[data-pagina]');
  if (pag && !pag.disabled) { estado.filtros.pagina = Number(pag.dataset.pagina); return render(); }

  const faixa = alvo('[data-filtro-faixa]');
  if (faixa) { estado.filtros = { ...estado.filtros, faixa: faixa.dataset.filtroFaixa, pagina: 1 }; return irPara('pessoas'); }

  const tema = alvo('[data-filtro-tema]');
  if (tema) { estado.filtros = { ...estado.filtros, tema: tema.dataset.filtroTema, pagina: 1 }; return irPara('pessoas'); }

  const intencao = alvo('[data-filtro-intencao]');
  if (intencao) { estado.filtros = { ...estado.filtros, intencao: intencao.dataset.filtroIntencao, pagina: 1 }; return irPara('pessoas'); }

  const grupo = alvo('[data-abrir-grupo]');
  if (grupo) { estado.filtros = { ...estado.filtros, grupo: grupo.dataset.abrirGrupo, pagina: 1 }; return irPara('pessoas'); }

  const abaixo = alvo('[data-filtro-abaixo]');
  if (abaixo) { estado.filtros = { ...estado.filtros, abaixo: abaixo.dataset.filtroAbaixo, pagina: 1 }; return irPara('pessoas'); }

  const uf = alvo('[data-filtro-uf]');
  if (uf) { estado.filtros = { ...estado.filtros, uf: uf.dataset.filtroUf, pagina: 1 }; return irPara('pessoas'); }

  if (alvo('[data-acao="ler-alertas"]')) {
    pintarAlertas(await api('/alertas/lidos', { method: 'POST', body: { todos: true } }));
    return render();
  }

  if (alvo('[data-acao="fb-sync"]') || alvo('[data-acao="fb-enviar"]')) {
    const b = alvo('[data-acao="fb-sync"]') || alvo('[data-acao="fb-enviar"]');
    const tudo = b.dataset.acao === 'fb-sync';
    b.disabled = true; b.textContent = 'enviando…';
    const r = await api(tudo ? '/firebase/sincronizar' : '/firebase/enviar', { method: 'POST' });
    if (r.status?.conectado) toast('Firebase', `${r.enviados || 0} documento(s) enviados.`);
    else toast('Firebase', r.status?.erro || 'Credencial não configurada — a fila continua guardada.', 'critico');
    return render();
  }

  if (alvo('[data-acao="fb-restaurar"]')) {
    const b = alvo('[data-acao="fb-restaurar"]');
    b.disabled = true; b.textContent = 'lendo…';

    // Sempre em duas etapas: primeiro conta o que existe lá, depois grava.
    // Restaurar sobre uma base já povoada é uma mesclagem, não um desastre —
    // mas a equipe precisa ver os números antes de mandar escrever.
    const previa = await api('/firebase/restaurar', { method: 'POST', body: { confirmar: false } });
    b.disabled = false; b.textContent = '⬇ Trazer base';
    if (previa.erro) return toast('Não deu para ler', previa.erro, 'critico');

    const f = previa.noFirestore;
    const total = f.pessoas + f.grupos + f.abaixos + f.assinaturas;
    if (!total) {
      return toast('Firestore vazio',
        `Nada encontrado em ${previa.caminho}. Confira a pasta desta campanha.`, 'critico');
    }
    const ok = confirm(
      `Trazer do Firestore (${previa.caminho}):\n\n`
      + `  ${f.pessoas} pessoas\n  ${f.grupos} grupos\n`
      + `  ${f.abaixos} abaixo-assinados\n  ${f.assinaturas} assinaturas\n\n`
      + `Neste servidor hoje: ${previa.antes.pessoas} pessoas, ${previa.antes.grupos} grupos.\n\n`
      + 'Os dados são mesclados; nada é apagado. Continuar?'
    );
    if (!ok) return;

    b.disabled = true; b.textContent = 'trazendo…';
    const r = await api('/firebase/restaurar', { method: 'POST', body: { confirmar: true } });
    b.disabled = false; b.textContent = '⬇ Trazer base';
    if (r.erro) return toast('Falhou', r.erro, 'critico');

    toast('Base restaurada',
      `${r.depois.pessoas} pessoas · ${r.depois.grupos} grupos · ${r.depois.assinaturas} assinaturas.`);
    estado.panorama = null;
    return render();
  }

  if (alvo('[data-acao="fb-credencial"]')) {
    const b = alvo('[data-acao="fb-credencial"]');
    const chave = $('#fb-chave').value.trim();
    if (!chave) return toast('Falta a chave', 'Cole o JSON da conta de serviço.', 'critico');

    b.disabled = true; b.textContent = 'salvando…';
    const r = await api('/firebase/credencial', {
      method: 'POST',
      body: { chave, pasta: $('#fb-pasta').value.trim() }
    });
    b.disabled = false; b.textContent = 'Salvar credencial';

    if (r.erro) return toast('Credencial recusada', r.erro, 'critico');
    toast(
      r.status?.conectado ? 'Firebase conectado' : 'Credencial salva',
      r.status?.conectado ? `Projeto ${r.projeto}.` : (r.status?.erro || 'Ainda não conectou.'),
      r.status?.conectado ? 'aviso' : 'critico'
    );
    return render();
  }

  if (alvo('[data-acao="limpar-filtros"]')) {
    estado.filtros = { busca: '', faixa: '', grupo: '', tema: '', intencao: '', cadastro: '', tag: '', abaixo: '', uf: '', semGrupo: '', apoio: '', origem: '', ordenar: 'engajamento', pagina: 1, porPagina: 25 };
    return render();
  }

  if (alvo('[data-acao="recalcular"]')) {
    const b = alvo('[data-acao="recalcular"]');
    b.disabled = true; b.textContent = 'recalculando…';
    await api('/recalcular', { method: 'POST' });
    estado.panorama = null;
    return render();
  }

  if (alvo('[data-acao="editar"]')) return formularioEdicao();
  if (alvo('[data-acao="cancelar-edicao"]')) return abrirPessoa(estado.pessoaAberta.id);

  if (alvo('[data-acao="salvar-ficha"]')) {
    const val = (id) => $(`#ed-${id}`).value.trim();
    await api(`/pessoas/${estado.pessoaAberta.id}`, {
      method: 'PATCH',
      body: {
        nome: val('nome'), cidade: val('cidade'), bairro: val('bairro'),
        atuacao: val('atuacao'), email: val('email'), observacoes: val('observacoes')
      }
    });
    const id = estado.pessoaAberta.id;
    estado.panorama = null;
    await abrirPessoa(id);
    return render();
  }

  if (alvo('[data-acao="salvar-nota"]')) {
    const texto = $('#nova-nota').value.trim();
    if (!texto) return;
    await api(`/pessoas/${estado.pessoaAberta.id}/nota`, { method: 'POST', body: { texto } });
    return abrirPessoa(estado.pessoaAberta.id);
  }

  const tag = alvo('[data-tag]');
  if (tag && estado.pessoaAberta) {
    await api(`/pessoas/${estado.pessoaAberta.id}/tags`, {
      method: 'POST',
      body: { tagId: Number(tag.dataset.tag), remover: tag.dataset.remover === '1' }
    });
    return abrirPessoa(estado.pessoaAberta.id);
  }

  if (alvo('[data-acao="coletar-recarregar"]')) return render();

  if (alvo('[data-acao="coletor-novo"]')) {
    const nome = prompt(
      'De qual celular é esta agenda?\n\n'
      + 'Ex.: "Celular da Cláudia", "Coordenação", "Escritório".\n'
      + 'O nome serve para você saber de onde veio cada contato.'
    );
    if (!nome?.trim()) return;
    const r = await api('/coletores', { method: 'POST', body: { nome } });
    if (r.erro) return toast('Não deu', r.erro, 'critico');
    toast('Celular adicionado', 'Clique em Gerar QR Code para ler a agenda dele.');
    return render();
  }

  const ligar = alvo('[data-coletor-ligar]') || alvo('[data-coletor-repar]');
  if (ligar) {
    const id = ligar.dataset.coletorLigar || ligar.dataset.coletorRepar;
    const repar = Boolean(ligar.dataset.coletorRepar);

    // Reparear apaga a sessão de propósito: é a única forma de o WhatsApp
    // reenviar a agenda completa, e a tela avisa antes de fazer isso.
    if (repar && !confirm(
      'Reparear este celular?\n\n'
      + 'A sessão atual é encerrada e você lê o QR de novo. É assim que o '
      + 'WhatsApp reenvia a agenda inteira — reconectar sem isso não traz contato nenhum.'
    )) return;

    ligar.disabled = true; ligar.textContent = 'gerando…';
    const r = await api(`/coletores/${id}/conectar`, {
      method: 'POST', body: { apagarSessao: repar }
    });
    if (r?.erro) { toast('Não deu', r.erro, 'critico'); return render(); }
    return render();
  }

  const desligar = alvo('[data-coletor-desligar]');
  if (desligar) {
    await api(`/coletores/${desligar.dataset.coletorDesligar}/desconectar`, { method: 'POST' });
    toast('Desligado', 'Os contatos já importados continuam na base.');
    return render();
  }

  const removerColetor = alvo('[data-coletor-remover]');
  if (removerColetor) {
    if (!confirm('Remover este celular?\n\nA sessão é apagada. '
      + 'Os contatos que ele já trouxe permanecem na base.')) return;
    await api(`/coletores/${removerColetor.dataset.coletorRemover}`, { method: 'DELETE' });
    toast('Removido', 'Os contatos importados continuam na base.');
    return render();
  }

  if (alvo('[data-acao="wa-provedor"]')) {
    const atual = estado.whatsapp?.provedor || 'baileys';
    const novo = atual === 'wacore' ? 'baileys' : 'wacore';
    const texto = novo === 'wacore'
      ? 'Trocar para WA-Core2?\n\nA conexão passa a ser mantida pelo fornecedor — '
        + 'o número não cai a cada deploy. Exige WACORE_TOKEN configurado no servidor.'
      : 'Voltar para Baileys?\n\nA conexão volta a viver neste processo, com a sessão '
        + 'guardada no Firestore.';
    if (!confirm(texto)) return;

    const r = await api('/whatsapp/provedor', { method: 'POST', body: { provedor: novo } });
    if (r.erro) return toast('Não deu', r.erro, 'critico');
    toast('Origem alterada', `Agora usando ${novo === 'wacore' ? 'WA-Core2' : 'Baileys'}. Conecte de novo.`);
    return render();
  }

  if (alvo('[data-acao="wa-parear"]')) {
    const numero = prompt(
      'Número do WhatsApp que vai ser conectado.\n\n'
      + 'Só dígitos, com país e DDD — ex.: 5519998887766\n\n'
      + 'A pessoa vai digitar um código de 8 letras no próprio celular:\n'
      + 'WhatsApp → Dispositivos conectados → Conectar dispositivo\n'
      + '→ Conectar com número de telefone.'
    );
    if (!numero) return;

    const b = alvo('[data-acao="wa-parear"]');
    b.disabled = true; b.textContent = 'pedindo código…';
    const r = await api('/whatsapp/parear', { method: 'POST', body: { numero } });
    b.disabled = false; b.textContent = '📱 Conectar por número';
    if (r.erro) return toast('Número inválido', r.erro, 'critico');
    // O código chega pelo evento de status, alguns segundos depois.
    toast('Pedindo o código', 'Ele aparece na tela em instantes.');
    return render();
  }

  if (alvo('[data-acao="wa-conectar"]')) {
    const b = alvo('[data-acao="wa-conectar"]');
    b.disabled = true; b.textContent = 'gerando…';
    await api('/whatsapp/conectar', { method: 'POST', body: { modo: 'completo' } });
    return render();
  }
  if (alvo('[data-acao="wa-desconectar"]')) {
    await api('/whatsapp/desconectar', { method: 'POST', body: { apagarSessao: true } });
    return render();
  }
  if (alvo('[data-acao="wa-sincronizar"]')) {
    const b = alvo('[data-acao="wa-sincronizar"]');
    b.disabled = true; b.textContent = 'sincronizando…';
    await api('/whatsapp/sincronizar', { method: 'POST' });
    estado.panorama = null;
    return render();
  }
  if (alvo('[data-acao="copiar-link-form"]')) {
    const link = alvo('[data-acao="copiar-link-form"]').dataset.link;
    if (link) {
      navigator.clipboard.writeText(link).then(() => {
        toast('Link Copiado!', 'O link do formulário foi copiado para a sua área de transferência.', 'sucesso');
      }).catch(() => {
        toast('Erro ao copiar', link, 'aviso');
      });
    }
  }
});

overlay.addEventListener('click', fecharGaveta);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharGaveta(); });

function irPara(vista) {
  if (!VISTAS[vista]) return;
  estado.vista = vista;
  for (const b of document.querySelectorAll('#nav .nav-item')) {
    b.classList.toggle('ativo', b.dataset.vista === vista);
  }
  render();
}

/**
 * Nenhuma campanha no sistema (ou nenhuma vinculada ao acesso).
 *
 * São duas situações muito diferentes e a tela precisa distinguir: para o
 * administrador, isto é o primeiro uso de um servidor novo e ele mesmo resolve
 * em um clique; para equipe e candidato, é de fato falta de vínculo.
 */
function telaSemCampanha() {
  const podeCriar = podeFazer('gerirCampanhas');

  conteudo.innerHTML = podeCriar ? `
    <div class="cabecalho">
      <div>
        <h2>Nenhuma campanha ainda</h2>
        <p>Seu acesso é de administrador — você enxerga todas as campanhas do
           sistema. Só não existe nenhuma criada neste servidor.</p>
      </div>
      <div class="acoes">
        <button class="btn primario" data-acao="nova-campanha">+ Criar a primeira campanha</button>
      </div>
    </div>

    <div class="alerta info">
      <b>Por que o servidor nasce vazio?</b> A pasta <code>data/</code> guarda os dados
      pessoais das pessoas cadastradas e a chave do Firebase — ela nunca vai pelo git.
      Cada servidor cria a própria base. Depois de criar a campanha e colar a chave do
      Firebase, o botão <b>⬇ Trazer base</b> traz tudo de volta do Firestore.
    </div>

    <section class="card">
      <div class="corpo">
        <div class="titulo">Ordem das coisas</div>
        <ol style="margin:10px 0 0 18px;line-height:1.9;color:var(--tinta-2)">
          <li>Criar a campanha (gera os acessos de equipe e candidato)</li>
          <li>Colar a chave do Firebase em <b>🔥 Firebase</b></li>
          <li>Clicar em <b>⬇ Trazer base</b>, se a campanha já tem dados lá</li>
          <li>Conectar em <b>🔌 WhatsApp</b> — por QR ou por número</li>
        </ol>
      </div>
    </section>` : `
    <div class="alerta"><b>Nenhuma campanha vinculada ao seu acesso.</b>
      Peça ao administrador para te vincular a uma campanha.</div>`;
}

/**
 * Faixa de aviso quando o cadastro de hoje não sobrevive a um deploy.
 *
 * Fica no topo de TODAS as telas de propósito. O aviso existia só como linha de
 * log no servidor, que ninguém lê — e a perda aparecia depois, com a equipe já
 * tendo cadastrado gente na rua o dia inteiro.
 */
async function faixaDeProtecao() {
  const caixa = $('#faixa-protecao');
  if (!caixa || !estado.campanha) return;
  let p;
  try { p = await api('/protecao'); } catch { return; }
  estado.protecao = p;

  if (p.nivel === 'ok') { caixa.style.display = 'none'; caixa.innerHTML = ''; return; }

  const perda = p.nivel === 'perda';
  caixa.style.display = 'block';
  caixa.innerHTML = `
    <div style="border:2px solid ${perda ? '#dc2626' : '#f59e0b'};
                background:${perda ? '#fef2f2' : '#fffbeb'};
                border-radius:12px;padding:12px 14px;margin-bottom:16px">
      <div style="font-weight:800;font-size:13.5px;color:${perda ? '#991b1b' : '#92400e'}">
        ${perda
          ? '✗ Os cadastros feitos agora VÃO SUMIR no próximo deploy'
          : '⚠ Atenção à persistência dos cadastros'}
      </div>
      <ul style="margin:8px 0 0;padding-left:18px;font-size:12.5px;line-height:1.6;
                 color:${perda ? '#991b1b' : '#92400e'}">
        ${p.problemas.map((x) => `
          <li><b>${esc(x.o_que)}</b><br>${esc(x.por_que)}<br>
              <span style="opacity:.85">→ ${esc(x.como_resolver)}</span></li>`).join('')}
      </ul>
    </div>`;
}

async function render() {
  // Sem campanha ativa, toda rota da API responde 400: não adianta tentar.
  // A tela de Acessos é a exceção — é lá que a campanha é criada.
  if (!estado.campanha && estado.vista !== 'contas') return telaSemCampanha();
  try {
    await VISTAS[estado.vista]();
  } catch (erro) {
    conteudo.innerHTML = `<div class="alerta">Falha ao carregar: ${esc(erro.message)}</div>`;
  }
  // Depois da vista: a faixa vive fora do #conteudo e não é apagada por ela.
  faixaDeProtecao();
}

// --------------------------------------------------------- status ao vivo
function pintarAlertas(contagem) {
  const alvo = $('#conta-alertas');
  if (!alvo || !contagem) return;
  const total = contagem.total || 0;
  alvo.textContent = total;
  alvo.dataset.zero = total ? '0' : '1';
}

function pintarConversas(contagem) {
  const alvo = $('#conta-conversas');
  if (!alvo || !contagem) return;
  const n = contagem.naoLidas || 0;
  alvo.textContent = n;
  alvo.dataset.zero = n ? '0' : '1';
}

function pintarFirebase(s) {
  const ponto = $('#ponto-firebase');
  const texto = $('#texto-firebase');
  if (!ponto) return;
  if (s.conectado) {
    ponto.className = 'ponto on';
    texto.textContent = s.pendentes ? `firebase · ${s.pendentes} na fila` : 'firebase sincronizado';
  } else if (s.configurado) {
    ponto.className = 'ponto err';
    texto.textContent = 'firebase com erro';
  } else {
    ponto.className = 'ponto';
    // Sem campanha ativa a rota nem responde `pendentes` — mostrar "undefined
    // na fila" faz parecer defeito onde só falta escolher a campanha.
    texto.textContent = s.pendentes == null
      ? 'firebase não configurado'
      : `firebase · ${s.pendentes} na fila`;
  }
}

function toast(titulo, detalhe, gravidade = 'aviso', aoClicar = null) {
  const el = document.createElement('div');
  el.className = `aviso-toast ${gravidade}`;
  el.innerHTML = `<div class="t">${esc(titulo)}</div>${detalhe ? `<div class="d">${esc(detalhe)}</div>` : ''}`;
  el.addEventListener('click', () => { el.remove(); aoClicar?.(); });
  $('#avisos').append(el);
  setTimeout(() => el.remove(), gravidade === 'critico' ? 15000 : 8000);
}

function pintarStatus(s) {
  const ponto = $('#ponto-status');
  const texto = $('#texto-status');
  const mapa = {
    conectado: ['on', `conectado · ${s.telefone || ''}`],
    qr: ['qr', 'aguardando QR'],
    conectando: ['qr', 'conectando…'],
    erro: ['err', 'modo demonstração'],
    desconectado: ['', 'modo demonstração']
  };
  const [classe, rotulo] = mapa[s.status] || ['', s.status];
  ponto.className = `ponto ${classe}`;
  texto.textContent = rotulo;
}

const fluxo = new EventSource('/api/eventos');

// RECONEXAO DO FLUXO = O SERVIDOR REINICIOU.
//
// O EventSource se reconecta sozinho, e sem isto a tela seguia exibindo o que
// estava la antes — inclusive um QR do processo anterior. Quem escaneasse esse
// codigo recebia "Nao foi possivel conectar o dispositivo" do WhatsApp: o
// socket que gerou o QR tinha morrido no deploy. Aconteceu de verdade.
let jaAbriu = false;
fluxo.onopen = () => {
  if (!jaAbriu) { jaAbriu = true; return; }
  if (['conexao', 'coletar'].includes(estado.vista)) {
    toast('Servidor reiniciou', 'Se havia um QR na tela, ele venceu. Gere outro.', 'aviso');
    render();
  }
};

fluxo.onmessage = (e) => {
  const evento = JSON.parse(e.data);

  if (evento.tipo === 'status') {
    api('/whatsapp/status').then((s) => {
      pintarStatus(s);
      // "coletar" também mostra QR e contagem: sem isto o código novo aparecia
      // só na aba de infraestrutura, e a tela de coleta ficava parada.
      if (['conexao', 'coletar'].includes(estado.vista)) render();
    });
  }

  // Saída de grupo: o aviso que a equipe precisa ver na hora.
  if (evento.tipo === 'alerta') {
    const a = evento.alerta;
    toast(a.titulo, a.detalhe, a.gravidade, () => irPara('alertas'));
    api('/alertas?limite=1').then((r) => pintarAlertas(r.contagem));
    if (estado.vista === 'alertas') render();
  }

  // Mensagem privada chegando: a caixa de entrada precisa reagir na hora.
  if (evento.tipo === 'privada') {
    api('/conversas?filtro=nao_lidas').then((r) => pintarConversas(r.contagem));
    if (estado.vista === 'conversas') render();
    else if (!evento.deMim) toast('Nova mensagem no privado', evento.previa, 'aviso', () => irPara('conversas'));
  }

  if (evento.tipo === 'mensagem' && estado.vista === 'conversas') render();

  // Agenda chegando. Vem em lotes por vários segundos depois do pareamento, e
  // sem isto a tela ficava parada enquanto centenas de contatos entravam —
  // parecia que a importação não estava acontecendo.
  if (evento.tipo === 'contatos') {
    toast('Agenda importada', `${num(evento.atualizados)} contato(s) · ${num(evento.naAgenda)} salvos no celular`);
    estado.panorama = null;
    if (['conexao', 'coletar', 'pessoas', 'apoio', 'panorama'].includes(estado.vista)) render();
  }

  if (evento.tipo === 'historico' && estado.vista === 'conexao') render();

  // QR novo, contato entrando, coletor caindo — tudo chega por aqui.
  if (evento.tipo === 'coletores') {
    if (evento.novos) toast('Agenda chegando', `+${num(evento.novos)} contato(s)`);
    if (estado.vista === 'coletar') render();
  }

  if (evento.tipo === 'fila_progresso') {
    const feito = evento.resultado === 'adicionado' ? 'adicionada ao' : 'convidada para o';
    toast('Fila de adição', `${evento.pessoa} ${feito} grupo ${evento.grupo}.`);
    if (estado.vista === 'grupos') render();
  }
  if (evento.tipo === 'fila_estado' && estado.vista === 'grupos') render();

  if (evento.tipo === 'recalculado' || evento.tipo === 'grupos_sincronizados' ||
      evento.tipo === 'membros_alterados') {
    estado.panorama = null;
    if (!['conexao', 'firebase', 'conversas'].includes(estado.vista)) render();
  }
};

setInterval(() => {
  // Sem campanha ativa esta rota responde 400 — não vale poluir o console.
  if (!estado.campanha) return;
  api('/firebase/status').then(pintarFirebase).catch(() => {});
}, 20000);

// Enquanto houver QR na tela, conferir o estado a cada 12s.
//
// O QR do WhatsApp é renovado pelo servidor e morre junto com o processo. Sem
// esta ronda, a imagem ficava parada na tela dando a impressão de continuar
// válida — e a pessoa escaneava um código vencido, recebendo do WhatsApp um
// "não foi possível conectar o dispositivo" que não explica nada.
setInterval(() => {
  if (!estado.campanha) return;
  if (!['conexao', 'coletar'].includes(estado.vista)) return;

  // Só quando há QR de verdade na tela. A lista de coletores sozinha não
  // justifica re-renderizar a cada 12s.
  if (!document.querySelector('.qr-caixa img')) return;

  render().catch(() => { /* a próxima ronda tenta de novo */ });
}, 12000);

const CORES_PAPEL = { admin: '#7c3aed', equipe: '#2563eb', candidato: '#16a34a' };

function pintarIdentidade() {
  const { usuario, campanha, campanhas } = estado;

  $('#usuario-nome').innerHTML = `${esc(usuario.nome)} ` +
    `<span class="papel-badge" style="background:${CORES_PAPEL[usuario.papel]}28;color:${CORES_PAPEL[usuario.papel]}">${esc(usuario.papel)}</span>`;

  if (campanha) {
    $('#nome-campanha').textContent = campanha.nome;
    $('#cargo-campanha').textContent = campanha.cargo || 'Rede de apoio';
    $('#selo-campanha').textContent = iniciais(campanha.nome).slice(0, 2);
    $('#selo-campanha').style.background = campanha.cor || 'var(--roxo)';
    document.title = `${campanha.nome} · Rede de Apoio`;
  } else {
    $('#nome-campanha').textContent = 'Rede de Apoio';
    $('#cargo-campanha').textContent = 'nenhuma campanha criada';
    $('#selo-campanha').textContent = 'R';
    $('#selo-campanha').style.background = 'var(--roxo)';
    document.title = 'Rede de Apoio';
  }

  // Sem campanha, o único caminho útil é Acessos — o resto responderia 400.
  for (const item of document.querySelectorAll('.nav-item[data-vista]')) {
    item.classList.toggle('inerte', !campanha && item.dataset.vista !== 'contas');
  }
  if (!campanha) {
    $('#texto-status').textContent = 'sem campanha';
    $('#texto-firebase').textContent = 'sem campanha';
  }

  // O seletor só aparece para quem enxerga mais de uma campanha.
  const seletor = $('#troca-campanha');
  seletor.hidden = campanhas.length <= 1;
  if (!seletor.hidden) {
    seletor.innerHTML = campanhas.map((c) =>
      `<option value="${esc(c.slug)}" ${c.slug === campanha?.slug ? 'selected' : ''}>${esc(c.nome)}</option>`
    ).join('');
  }

  // Esconde o que o papel do usuário não pode usar.
  for (const item of document.querySelectorAll('[data-permissao]')) {
    item.hidden = !podeFazer(item.dataset.permissao);
  }
  const infra = document.querySelector('[data-so-admin]');
  if (infra) {
    infra.hidden = !['conectarWhatsapp', 'configurarFirebase', 'gerirUsuarios'].some(podeFazer);
  }
}

$('#troca-campanha').addEventListener('change', async (e) => {
  estado.campanha = estado.campanhas.find((c) => c.slug === e.target.value);
  // Trocar de campanha é trocar de base: nada do estado anterior serve.
  Object.assign(estado, {
    panorama: null, lista: null, fila: null, conversaAberta: null, pessoaAberta: null
  });
  fecharGaveta();
  await recarregarTudo();
});

$('#botao-sair').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = '/login';
});

async function recarregarTudo() {
  estado.config = await api('/config');
  pintarIdentidade();
  api('/whatsapp/status').then(pintarStatus).catch(() => {});
  api('/firebase/status').then(pintarFirebase).catch(() => {});
  api('/alertas?limite=1').then((r) => pintarAlertas(r.contagem)).catch(() => {});
  api('/conversas?filtro=nao_lidas').then((r) => pintarConversas(r.contagem)).catch(() => {});
  await render();
}

(async function iniciar() {
  const eu = await api('/eu');
  if (!eu?.usuario) { location.href = '/login'; return; }

  estado.usuario = eu.usuario;
  estado.campanhas = eu.campanhas || [];
  estado.campanha = eu.campanhaAtiva || estado.campanhas[0] || null;
  estado.permissoes = eu.permissoes || {};

  // Servidor novo: o administrador nasce de ADMIN_EMAIL, mas não existe
  // campanha nenhuma ainda. Ele pode tudo — só não tem o que ver.
  if (!estado.campanha) { pintarIdentidade(); return telaSemCampanha(); }

  await recarregarTudo();
})();
