import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { db, PASTA_PUBLICA, PASTA_DADOS, RAIZ, agora, getConfig, comCampanha, campanhasNoDisco, pastaDaCampanha } from './db.js';
import { salvarCadastro, salvarFormularioPautas, registrarEvento } from './ingest.js';
import { recomputar, PESOS, FAIXAS, CORES_FAIXA, FAIXAS_APOIO, CORES_APOIO } from './scoring.js';
import { TEMAS, INTENCOES } from './lexicon.js';
import {
  listarPessoas, obterPessoa, listarGrupos, listarTags, listarAbaixos,
  listarAlertas, marcarAlertas, contarAlertas,
  listarConversas, conversaDeGrupo, marcarConversaLida, definirSituacao, listarFormularios,
  panorama, filaDeAcao, exportarCsv
} from './repo.js';
import { lerConversa, sugerirRespostas } from './conversa.js';
import * as whatsapp from './whatsapp.js';
import * as firebase from './firestore.js';
import * as adicao from './adicionar-grupo.js';
import { importarPasta } from './importar-leads.js';
import * as contas from './contas.js';
import { tomarTrava, soltarTrava, mensagemDeTravada } from './trava.js';

const PORTA = Number(process.env.PORT || 3333);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

const json = (res, dados, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(dados));
};

async function lerCorpo(req) {
  const partes = [];
  for await (const pedaco of req) partes.push(pedaco);
  if (!partes.length) return {};
  try { return JSON.parse(Buffer.concat(partes).toString('utf8')); } catch { return {}; }
}

// ------------------------------------------------------------------ sessão
const COOKIE = 'rede_sessao';

function lerCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map((p) => p.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

// Atrás do proxy do Render a conexão chega como http, mas o usuário está em
// https. Sem olhar o x-forwarded-proto, o cookie sairia sem Secure em produção.
const ehHttps = (req) =>
  req.headers['x-forwarded-proto'] === 'https' || process.env.FORCAR_HTTPS === 'true';

const cookieDeSessao = (token, req, dias = 30) =>
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;` +
  `${ehHttps(req) ? ' Secure;' : ''} Max-Age=${dias * 86400}`;

function filtrosDaUrl(url) {
  const p = url.searchParams;
  const pegar = (nome, padrao = '') => p.get(nome) || padrao;
  return {
    busca: pegar('busca'), faixa: pegar('faixa'), grupo: pegar('grupo'),
    tema: pegar('tema'), intencao: pegar('intencao'), cadastro: pegar('cadastro'),
    tag: pegar('tag'), abaixo: pegar('abaixo'), uf: pegar('uf'),
    semGrupo: pegar('semGrupo'), apoio: pegar('apoio'), origem: pegar('origem'),
    ordenar: pegar('ordenar', 'engajamento'),
    pagina: Number(p.get('pagina') || 1), porPagina: Number(p.get('porPagina') || 25)
  };
}

// --- SSE: cada cliente só recebe eventos da campanha que está olhando -------
const clientesSse = new Set();
const transmitir = (evento) => {
  const pacote = `data: ${JSON.stringify(evento)}\n\n`;
  for (const cliente of clientesSse) {
    if (evento.campanha && cliente.campanha && evento.campanha !== cliente.campanha) continue;
    cliente.res.write(pacote);
  }
};
whatsapp.assinar(transmitir);
adicao.assinarFila((e) => transmitir({ ...e, tipo: `fila_${e.tipo}` }));

function abrirSse(res, campanha) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'
  });
  res.write('retry: 3000\n\n');
  const cliente = { res, campanha };
  clientesSse.add(cliente);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => { clearInterval(ping); clientesSse.delete(cliente); });
}

// --- estáticos --------------------------------------------------------------
async function servirArquivo(res, nome) {
  const caminho = join(PASTA_PUBLICA, normalize(nome).replace(/^(\.\.[/\\])+/, ''));
  try {
    const conteudo = await readFile(caminho);
    res.writeHead(200, { 'Content-Type': MIME[extname(caminho)] || 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  }
}

// ---------------------------------------------------------------- API pública
async function apiPublica(req, res, url) {
  const rota = url.pathname.replace('/api', '');

  // Health check do Render. Precisa responder sem sessão e sem tocar no banco
  // pesado — se demorar, o provedor considera o serviço morto e reinicia.
  if (rota === '/saude' && req.method === 'GET') {
    return json(res, {
      ok: true,
      emAr: Math.round(process.uptime()),
      // Qual commit está REALMENTE no ar. Quando um deploy falha, o Render
      // mantém a versão anterior servindo — o painel mostra "deploy live" e o
      // código rodando é outro. Sem isto, descobrir a diferença exige comparar
      // arquivos servidos com o repositório.
      versao: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'local',
      campanhas: contas.listarCampanhas({ apenasAtivas: true }).length,
      whatsapp: whatsapp.sessoesAtivas()
    });
  }

  // A tela de login pergunta isto antes de mostrar o formulário. Sem esta
  // rota, um deploy sem ADMIN_EMAIL vira "e-mail ou senha incorretos" para
  // sempre, sem pista do motivo.
  if (rota === '/estado-inicial' && req.method === 'GET') {
    return json(res, {
      configurado: contas.temAlgumUsuario(),
      campanhas: contas.listarCampanhas({ apenasAtivas: true }).length,
      // Só em produção: em desenvolvimento o caminho é `npm run configurar`.
      producao: process.env.NODE_ENV === 'production'
    });
  }

  if (rota === '/login' && req.method === 'POST') {
    const { email, senha } = await lerCorpo(req);
    const r = contas.entrar({ email, senha, origem: req.headers['user-agent']?.slice(0, 120) });
    if (r.erro) return json(res, r, 401);
    res.setHeader('Set-Cookie', cookieDeSessao(r.token, req));
    return json(res, {
      usuario: r.usuario,
      campanhas: contas.campanhasDoUsuario(r.usuario),
      permissoes: contas.PERMISSOES[r.usuario.papel]
    });
  }

  if (rota === '/logout' && req.method === 'POST') {
    contas.sair(lerCookies(req)[COOKIE]);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return json(res, { ok: true });
  }

  // Formulário público de cada campanha: /api/cadastro/<slug>
  const casaCadastro = rota.match(/^\/cadastro\/([a-z0-9-]+)$/);
  if (casaCadastro && req.method === 'POST') {
    const slug = casaCadastro[1];
    const campanha = contas.obterCampanha(slug);
    if (!campanha || !campanha.ativa) return json(res, { erro: 'Campanha não encontrada' }, 404);
    const corpo = await lerCorpo(req);
    try {
      return await comCampanha(slug, async () => {
        const r = salvarCadastro(corpo);
        recomputar();
        firebase.publicarPessoa(r.pessoaId);
        await firebase.processarFila();
        return json(res, { ok: true, ...r });
      });
    } catch (erro) {
      return json(res, { erro: erro.message }, 400);
    }
  }

  if (casaCadastro && req.method === 'GET') {
    const c = contas.obterCampanha(casaCadastro[1]);
    return c && c.ativa
      ? json(res, { slug: c.slug, nome: c.nome, cargo: c.cargo, cor: c.cor })
      : json(res, { erro: 'Campanha não encontrada' }, 404);
  }

  // Pesquisa de pautas — formulário público, um por campanha: /formulario/<slug>
  const casaFormulario = rota.match(/^\/formulario\/([a-z0-9-]+)$/);
  if (casaFormulario && req.method === 'POST') {
    const slug = casaFormulario[1];
    const campanha = contas.obterCampanha(slug);
    if (!campanha || !campanha.ativa) return json(res, { erro: 'Campanha não encontrada' }, 404);
    const corpo = await lerCorpo(req);
    try {
      return await comCampanha(slug, async () => {
        const r = salvarFormularioPautas(corpo);
        recomputar();
        firebase.publicarPessoa(r.pessoaId);
        await firebase.processarFila();
        return json(res, { ok: true, ...r });
      });
    } catch (erro) {
      return json(res, { erro: erro.message }, 400);
    }
  }

  // QR do formulário — usado em evento, panfleto e na tela do celular.
  if (rota === '/qr' && req.method === 'GET') {
    const texto = url.searchParams.get('texto');
    if (!texto) return json(res, { erro: 'Informe o texto' }, 400);
    try {
      const qrcode = await import('qrcode');
      const svg = await qrcode.default.toString(texto, { type: 'svg', margin: 1 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
      return res.end(svg);
    } catch {
      return json(res, { erro: 'Biblioteca de QR indisponível' }, 500);
    }
  }

  return null;   // não é rota pública
}

// ------------------------------------------------------------------- API
async function api(req, res, url, sessao) {
  const rota = url.pathname.replace('/api', '');
  const metodo = req.method;
  const { usuario, campanha } = sessao;
  const pode = (acao) => contas.podeFazer(usuario, acao);

  const negar = () => json(res, { erro: 'Seu acesso não permite essa ação' }, 403);

  // --- conta do próprio usuário -------------------------------------------
  if (rota === '/eu' && metodo === 'GET') {
    return json(res, {
      usuario,
      campanhas: contas.campanhasDoUsuario(usuario),
      campanhaAtiva: campanha,
      permissoes: contas.PERMISSOES[usuario.papel]
    });
  }

  if (rota === '/eu/senha' && metodo === 'POST') {
    const { senhaAtual, senhaNova } = await lerCorpo(req);
    const r = contas.trocarPropriaSenha({ email: usuario.email, senhaAtual, senhaNova });
    return json(res, r, r.erro ? 400 : 200);
  }

  // --- administração (só admin) -------------------------------------------
  if (rota.startsWith('/campanhas') || rota.startsWith('/usuarios')) {
    if (!pode('gerirCampanhas') && !pode('gerirUsuarios')) return negar();

    if (rota === '/campanhas' && metodo === 'GET') {
      return json(res, contas.listarCampanhas().map((c) => ({
        ...c,
        resumo: comCampanha(c.slug, () => ({
          pessoas: db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n,
          grupos: db.prepare('SELECT COUNT(*) AS n FROM grupos WHERE ativo = 1').get().n,
          assinaturas: db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get().n,
          naoLidas: db.prepare(
            'SELECT COUNT(*) AS n FROM mensagens WHERE privada = 1 AND lida = 0 AND de_mim = 0'
          ).get().n,
          alertas: db.prepare('SELECT COUNT(*) AS n FROM alertas WHERE lido = 0').get().n
        })),
        whatsapp: whatsapp.sessoesAtivas().find((s) => s.slug === c.slug)?.status ?? 'desconectado',
        usuarios: contas.listarUsuarios({ campanhaSlug: c.slug }).length
      })));
    }

    if (rota === '/campanhas' && metodo === 'POST') {
      const corpo = await lerCorpo(req);
      try {
        const nova = contas.criarCampanha(corpo);
        // Toda campanha nasce com os dois acessos que ela precisa.
        const acessos = [];
        for (const [papel, email, nome] of [
          ['equipe', corpo.emailEquipe || `equipe@${nova.slug}.local`, `Equipe ${nova.nome}`],
          ['candidato', corpo.emailCandidato || `${nova.slug}@candidato.local`, nova.nome]
        ]) {
          try {
            const u = contas.criarUsuario({ email, nome, papel, campanhaSlug: nova.slug });
            acessos.push({ rotulo: `${u.nome} (${papel})`, email: u.email, senha: u.senhaGerada });
          } catch (erro) {
            acessos.push({ rotulo: `${papel} — não criado`, email, senha: erro.message });
          }
        }
        return json(res, { ...nova, acessos });
      } catch (erro) { return json(res, { erro: erro.message }, 400); }
    }

    const casaCampanha = rota.match(/^\/campanhas\/([a-z0-9-]+)$/);
    if (casaCampanha && metodo === 'PATCH') {
      return json(res, contas.atualizarCampanha(casaCampanha[1], await lerCorpo(req)));
    }

    if (rota === '/usuarios' && metodo === 'GET') {
      return json(res, contas.listarUsuarios(
        usuario.papel === 'admin' ? {} : { campanhaSlug: usuario.campanha_slug }
      ));
    }

    if (rota === '/usuarios' && metodo === 'POST') {
      const corpo = await lerCorpo(req);
      try { return json(res, contas.criarUsuario(corpo)); }
      catch (erro) { return json(res, { erro: erro.message }, 400); }
    }

    const casaUsuario = rota.match(/^\/usuarios\/([^/]+)(\/[a-z]+)?$/);
    if (casaUsuario) {
      const email = decodeURIComponent(casaUsuario[1]);
      if (casaUsuario[2] === '/senha' && metodo === 'POST') {
        try { return json(res, contas.redefinirSenha(email)); }
        catch (erro) { return json(res, { erro: erro.message }, 400); }
      }
      if (casaUsuario[2] === '/ativo' && metodo === 'POST') {
        const { ativo } = await lerCorpo(req);
        return json(res, contas.definirAtivo(email, ativo));
      }
      if (!casaUsuario[2] && metodo === 'DELETE') {
        if (email === usuario.email) return json(res, { erro: 'Você não pode remover a si mesmo' }, 400);
        return json(res, contas.removerUsuario(email));
      }
    }
  }

  // --- daqui pra baixo, tudo roda dentro da campanha ativa -----------------
  if (!campanha) return json(res, { erro: 'Nenhuma campanha selecionada' }, 400);

  return comCampanha(campanha.slug, async () => {
    if (rota === '/panorama' && metodo === 'GET') {
      return json(res, {
        ...panorama(),
        grupos_lista: listarGrupos(),
        tags: listarTags(),
        ultimo_recalculo: Number(getConfig('ultimo_recalculo', 0)),
        whatsapp: {
          status: whatsapp.estadoDoWhatsapp().status,
          telefone: whatsapp.estadoDoWhatsapp().telefone
        },
        firebase: firebase.statusFirebase()
      });
    }

    if (rota === '/config' && metodo === 'GET') {
      return json(res, {
        temas: Object.fromEntries(Object.entries(TEMAS).map(([k, v]) => [k, { rotulo: v.rotulo, cor: v.cor }])),
        intencoes: Object.fromEntries(Object.entries(INTENCOES).map(([k, v]) => [k, { rotulo: v.rotulo, cor: v.cor }])),
        faixas: FAIXAS, cores_faixa: CORES_FAIXA, pesos: PESOS,
        faixas_apoio: FAIXAS_APOIO, cores_apoio: CORES_APOIO,
        campanha: { slug: campanha.slug, nome: campanha.nome, cargo: campanha.cargo, cor: campanha.cor },
        permissoes: contas.PERMISSOES[usuario.papel],
        papel: usuario.papel
      });
    }

    if (rota === '/abaixos' && metodo === 'GET') return json(res, listarAbaixos());

    if (rota === '/formularios' && metodo === 'GET') return json(res, listarFormularios());

    // --- caixa de entrada --------------------------------------------------
    if (rota === '/conversas' && metodo === 'GET') {
      return json(res, listarConversas({
        filtro: url.searchParams.get('filtro') || '',
        busca: url.searchParams.get('busca') || ''
      }));
    }

    const casaConversa = rota.match(/^\/conversas\/(pessoa|grupo)\/(\d+)(\/[a-z]+)?$/);
    if (casaConversa) {
      const [, alvo, idBruto, sub] = casaConversa;
      const id = Number(idBruto);

      if (alvo === 'grupo') {
        if (!sub && metodo === 'GET') {
          const c = conversaDeGrupo(id);
          return c ? json(res, c) : json(res, { erro: 'Grupo não encontrado' }, 404);
        }
        if (sub === '/responder' && metodo === 'POST') {
          if (!pode('responder')) return negar();
          const { texto } = await lerCorpo(req);
          const g = db.prepare('SELECT wa_jid FROM grupos WHERE id = ?').get(id);
          if (!g) return json(res, { erro: 'Grupo não encontrado' }, 404);
          try {
            await whatsapp.enviarMensagem(g.wa_jid, texto);
            return json(res, conversaDeGrupo(id));
          } catch (erro) { return json(res, { erro: erro.message }, 400); }
        }
      }

      if (alvo === 'pessoa') {
        if (!sub && metodo === 'GET') {
          const c = lerConversa(id);
          if (!c) return json(res, { erro: 'Pessoa não encontrada' }, 404);
          if (url.searchParams.get('marcarLida') !== 'nao') marcarConversaLida(id);
          return json(res, { tipo: 'privada', ...c, sugestoes: sugerirRespostas(id) });
        }
        if (sub === '/sugestoes' && metodo === 'GET') return json(res, sugerirRespostas(id));
        if (sub === '/lida' && metodo === 'POST') return json(res, marcarConversaLida(id));
        if (sub === '/situacao' && metodo === 'POST') {
          const { situacao } = await lerCorpo(req);
          return json(res, definirSituacao(id, situacao));
        }
        if (sub === '/responder' && metodo === 'POST') {
          if (!pode('responder')) return negar();
          const { texto } = await lerCorpo(req);
          const p = db.prepare('SELECT wa_jid FROM pessoas WHERE id = ?').get(id);
          if (!p) return json(res, { erro: 'Pessoa não encontrada' }, 404);
          try {
            await whatsapp.enviarMensagem(p.wa_jid, texto);
            return json(res, { tipo: 'privada', ...lerConversa(id), sugestoes: sugerirRespostas(id) });
          } catch (erro) { return json(res, { erro: erro.message }, 400); }
        }
      }
    }

    // --- alertas -----------------------------------------------------------
    if (rota === '/alertas' && metodo === 'GET') {
      return json(res, {
        itens: listarAlertas({
          limite: Number(url.searchParams.get('limite') || 60),
          apenasNaoLidos: url.searchParams.get('naoLidos') === 'true'
        }),
        contagem: contarAlertas()
      });
    }
    if (rota === '/alertas/lidos' && metodo === 'POST') {
      const { id, todos } = await lerCorpo(req);
      return json(res, marcarAlertas({ id, todos }));
    }

    // --- pessoas -----------------------------------------------------------
    if (rota === '/pessoas' && metodo === 'GET') return json(res, listarPessoas(filtrosDaUrl(url)));
    if (rota === '/fila' && metodo === 'GET') return json(res, filaDeAcao());
    if (rota === '/grupos' && metodo === 'GET') return json(res, listarGrupos());
    if (rota === '/tags' && metodo === 'GET') return json(res, listarTags());

    if (rota === '/tags' && metodo === 'POST') {
      if (!pode('editarFicha')) return negar();
      const { nome, cor = '#5b21b6' } = await lerCorpo(req);
      if (!nome?.trim()) return json(res, { erro: 'Informe o nome da marcação' }, 400);
      db.prepare('INSERT OR IGNORE INTO tags (nome, cor) VALUES (?, ?)').run(nome.trim(), cor);
      return json(res, listarTags());
    }

    const casaPessoa = rota.match(/^\/pessoas\/(\d+)(\/[a-z]+)?$/);
    if (casaPessoa) {
      const id = Number(casaPessoa[1]);
      const sub = casaPessoa[2];

      if (!sub && metodo === 'GET') {
        const pessoa = obterPessoa(id);
        return pessoa ? json(res, pessoa) : json(res, { erro: 'Pessoa não encontrada' }, 404);
      }

      if (!sub && metodo === 'PATCH') {
        if (!pode('editarFicha')) return negar();
        const corpo = await lerCorpo(req);
        const campos = ['nome', 'cidade', 'bairro', 'atuacao', 'email', 'observacoes'];
        const sets = [];
        const valores = [];
        for (const campo of campos) {
          if (campo in corpo) { sets.push(`${campo} = ?`); valores.push(corpo[campo] || null); }
        }
        if (sets.length) {
          db.prepare(`UPDATE pessoas SET ${sets.join(', ')} WHERE id = ?`).run(...valores, id);
          if (corpo.nome || corpo.cidade || corpo.atuacao) {
            db.prepare('UPDATE pessoas SET cadastro_em = COALESCE(cadastro_em, ?) WHERE id = ?').run(agora(), id);
          }
          registrarEvento({ pessoaId: id, tipo: 'nota', descricao: `Ficha atualizada por ${usuario.nome}` });
          recomputar();
          firebase.publicarPessoa(id);
        }
        return json(res, obterPessoa(id));
      }

      if (sub === '/nota' && metodo === 'POST') {
        if (!pode('editarFicha')) return negar();
        const { texto } = await lerCorpo(req);
        if (!texto?.trim()) return json(res, { erro: 'Nota vazia' }, 400);
        const evento = { tipo: 'nota', descricao: `${texto.trim()} — ${usuario.nome}`, ts: agora() };
        registrarEvento({ pessoaId: id, ...evento });
        firebase.publicarEvento(id, evento);
        return json(res, obterPessoa(id));
      }

      if (sub === '/tags' && metodo === 'POST') {
        if (!pode('editarFicha')) return negar();
        const { tagId, remover } = await lerCorpo(req);
        if (remover) db.prepare('DELETE FROM pessoa_tags WHERE pessoa_id = ? AND tag_id = ?').run(id, Number(tagId));
        else db.prepare('INSERT OR IGNORE INTO pessoa_tags (pessoa_id, tag_id) VALUES (?, ?)').run(id, Number(tagId));
        recomputar();
        firebase.publicarPessoa(id);
        return json(res, obterPessoa(id));
      }

      if (sub === '/mensagem' && metodo === 'POST') {
        if (!pode('responder')) return negar();
        const { texto } = await lerCorpo(req);
        const pessoa = db.prepare('SELECT wa_jid FROM pessoas WHERE id = ?').get(id);
        if (!pessoa) return json(res, { erro: 'Pessoa não encontrada' }, 404);
        try {
          await whatsapp.enviarMensagem(pessoa.wa_jid, texto);
          return json(res, { ok: true, pessoa: obterPessoa(id) });
        } catch (erro) { return json(res, { erro: erro.message }, 400); }
      }
    }

    if (rota === '/recalcular' && metodo === 'POST') return json(res, recomputar());

    if (rota === '/export.csv' && metodo === 'GET') {
      if (!pode('exportar')) return negar();
      const csv = exportarCsv(filtrosDaUrl(url));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${campanha.slug}-${new Date().toISOString().slice(0, 10)}.csv"`
      });
      return res.end(csv);
    }

    // --- fila de adição ----------------------------------------------------
    if (rota === '/fila-adicao' && metodo === 'GET') {
      const grupoId = url.searchParams.get('grupo');
      return json(res, {
        ...adicao.resumo(grupoId ? Number(grupoId) : null),
        itens: adicao.listarFila({ grupoId: grupoId ? Number(grupoId) : null, limite: 300 })
      });
    }
    if (rota.startsWith('/fila-adicao/') && metodo === 'POST') {
      if (!pode('adicionarEmMassa')) return negar();
      if (rota === '/fila-adicao/pausar') return json(res, adicao.pausar());
      if (rota === '/fila-adicao/retomar') return json(res, adicao.retomar());
      if (rota === '/fila-adicao/cancelar') {
        const { grupoId } = await lerCorpo(req);
        return json(res, adicao.cancelarPendentes(grupoId ? Number(grupoId) : null));
      }
    }

    const casaAdicao = rota.match(/^\/grupos\/(\d+)\/(elegiveis|adicionar)$/);
    if (casaAdicao) {
      const grupoId = Number(casaAdicao[1]);
      if (casaAdicao[2] === 'elegiveis' && metodo === 'GET') {
        const filtros = {
          abaixo: url.searchParams.get('abaixo') || '', uf: url.searchParams.get('uf') || '',
          cidade: url.searchParams.get('cidade') || '',
          somenteSemGrupo: url.searchParams.get('somenteSemGrupo') || '',
          somenteAssinantes: url.searchParams.get('somenteAssinantes') || '',
          apoio: url.searchParams.get('apoio') || '',
          propensaoMinima: url.searchParams.get('propensaoMinima') || ''
        };
        const lista = adicao.elegiveis({ grupoId, filtros });
        return json(res, { total: lista.length, amostra: lista.slice(0, 12) });
      }
      if (casaAdicao[2] === 'adicionar' && metodo === 'POST') {
        if (!pode('adicionarEmMassa')) return negar();
        const { filtros, pessoaIds, limite } = await lerCorpo(req);
        try { return json(res, adicao.enfileirar({ grupoId, filtros, pessoaIds, limite })); }
        catch (erro) { return json(res, { erro: erro.message }, 400); }
      }
    }

    // --- Firebase ----------------------------------------------------------
    if (rota === '/firebase/status' && metodo === 'GET') return json(res, firebase.statusFirebase());
    if (rota.startsWith('/firebase/') && metodo === 'POST') {
      if (!pode('configurarFirebase')) return negar();
      if (rota === '/firebase/conectar') {
        await firebase.iniciarFirebase();
        return json(res, firebase.statusFirebase());
      }
      if (rota === '/firebase/sincronizar') {
        const resumo = firebase.sincronizarTudo();
        const envio = await firebase.processarFila();
        return json(res, { ...resumo, ...envio, status: firebase.statusFirebase() });
      }
      if (rota === '/firebase/enviar') {
        const envio = await firebase.processarFila();
        return json(res, { ...envio, status: firebase.statusFirebase() });
      }

      // Credencial pela interface. Existe porque o Shell do servidor é
      // recurso de plano pago no Render: sem isto, uma campanha em produção
      // não tem como receber a chave do Firebase.
      if (rota === '/firebase/credencial') {
        const { chave, pasta, prefixo } = await lerCorpo(req);

        let conta;
        try {
          conta = typeof chave === 'string' ? JSON.parse(chave) : chave;
        } catch {
          return json(res, { erro: 'Isso não é um JSON válido. Cole o arquivo inteiro, das chaves { } externas.' }, 400);
        }
        if (conta?.type !== 'service_account' || !conta.project_id || !conta.private_key) {
          return json(res, {
            erro: 'Esse JSON não é uma chave de conta de serviço. Ele precisa ter '
                + '"type": "service_account", project_id e private_key — é o arquivo de '
                + 'Configurações do projeto → Contas de serviço → Gerar nova chave privada.'
          }, 400);
        }

        const destino = join(pastaDaCampanha(campanha.slug), 'firebase-key.json');
        await writeFile(destino, JSON.stringify(conta, null, 2), { mode: 0o600 });

        contas.atualizarCampanha(campanha.slug, {
          firebase_key: destino,
          firebase_pasta: (pasta || '').trim() || campanha.slug,
          firebase_prefixo: prefixo === undefined ? (campanha.firebase_prefixo ?? 'campanhas') : (prefixo || null)
        });

        await firebase.iniciarFirebase();
        return json(res, { ok: true, projeto: conta.project_id, status: firebase.statusFirebase() });
      }
    }

    if (rota === '/leads/importar' && metodo === 'POST') {
      if (!pode('importarLeads')) return negar();
      const resultado = importarPasta();
      if (resultado.erro) return json(res, resultado, 400);
      await firebase.processarFila();
      return json(res, resultado);
    }

    // --- WhatsApp ----------------------------------------------------------
    if (rota === '/whatsapp/status' && metodo === 'GET') {
      await whatsapp.checarDependencias();
      return json(res, {
        ...whatsapp.estadoDoWhatsapp(),
        campanha: campanha.slug,
        grupos: listarGrupos().map((g) => ({ nome: g.nome, membros: g.membros }))
      });
    }
    if (rota.startsWith('/whatsapp/') && metodo === 'POST') {
      if (!pode('conectarWhatsapp')) return negar();
      if (rota === '/whatsapp/conectar') return json(res, await whatsapp.conectar());
      if (rota === '/whatsapp/desconectar') {
        const { apagarSessao } = await lerCorpo(req);
        return json(res, await whatsapp.desconectar({ apagarSessao }));
      }
      if (rota === '/whatsapp/sincronizar') {
        try { return json(res, { grupos: await whatsapp.ressincronizar() }); }
        catch (erro) { return json(res, { erro: erro.message }, 400); }
      }
    }

    return json(res, { erro: 'Rota não encontrada' }, 404);
  });
}

// --- resolução da campanha do pedido ---------------------------------------
function resolverCampanha(req, url, usuario) {
  const pedida = url.searchParams.get('campanha') || req.headers['x-campanha'] || null;
  if (pedida && contas.podeAcessarCampanha(usuario, pedida)) return contas.obterCampanha(pedida);
  if (usuario.papel !== 'admin') return contas.obterCampanha(usuario.campanha_slug);
  return contas.listarCampanhas({ apenasAtivas: true })[0] ?? null;
}

// --- servidor ---------------------------------------------------------------
const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Rotas abertas: login, formulário público e os arquivos do painel.
    if (url.pathname.startsWith('/api/')) {
      const publica = await apiPublica(req, res, url);
      if (publica !== null) return publica;
    }

    const usuario = contas.usuarioDoToken(lerCookies(req)[COOKIE]);

    if (url.pathname === '/login') return servirArquivo(res, 'login.html');

    // Formulário público por campanha: /cadastro/<slug>
    if (/^\/cadastro\/[a-z0-9-]+$/.test(url.pathname)) return servirArquivo(res, 'cadastro.html');
    if (/^\/formulario\/[a-z0-9-]+$/.test(url.pathname)) return servirArquivo(res, 'formulario.html');
    if (url.pathname === '/formulario') {
      const primeira = contas.listarCampanhas({ apenasAtivas: true })[0];
      res.writeHead(302, { Location: primeira ? `/formulario/${primeira.slug}` : '/login' });
      return res.end();
    }
    if (url.pathname === '/cadastro') {
      const primeira = contas.listarCampanhas({ apenasAtivas: true })[0];
      res.writeHead(302, { Location: primeira ? `/cadastro/${primeira.slug}` : '/login' });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      if (!usuario) return json(res, { erro: 'Faça login para continuar' }, 401);
      const campanha = resolverCampanha(req, url, usuario);

      if (url.pathname === '/api/eventos') return abrirSse(res, campanha?.slug ?? null);
      return await api(req, res, url, { usuario, campanha });
    }

    if (url.pathname === '/' || url.pathname === '/painel') {
      if (!usuario) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return servirArquivo(res, 'index.html');
    }

    return servirArquivo(res, url.pathname);
  } catch (erro) {
    console.error('[erro]', erro);
    return json(res, { erro: erro.message }, 500);
  }
});

// Porta ocupada quase sempre significa "já tem um servidor rodando".
// Subir um segundo é perigoso: duas conexões com a MESMA sessão do WhatsApp
// fazem o WhatsApp invalidar o pareamento e pedir o QR de novo.
// Por isso o sistema para aqui, com instrução, em vez de despejar stack trace.
servidor.on('error', (erro) => {
  // Já tomamos a trava da pasta de dados antes de chegar aqui (linha abaixo).
  // Se o bind da porta falhar, saímos sem soltar essa trava e o próximo
  // `npm run dev` (ex.: o restart automático do --watch) fica bloqueado por
  // até 45s achando que ainda estamos vivos. Soltar antes de sair evita isso.
  soltarTrava();

  if (erro.code !== 'EADDRINUSE') {
    console.error('\n❌ Erro ao subir o servidor:', erro.message, '\n');
    process.exit(1);
  }

  console.error(`
  ⚠  A porta ${PORTA} já está em uso.

  Quase sempre é o próprio sistema já rodando em outra janela.
  Abra http://localhost:${PORTA} e confira antes de mais nada.

  NÃO suba uma segunda instância: duas conexões com a mesma sessão do
  WhatsApp derrubam o pareamento e você precisa ler o QR de novo.

  Se quiser mesmo encerrar o que está lá:

    Windows   netstat -ano | findstr :${PORTA}
              taskkill /PID <numero> /F

  Ou rode esta cópia em outra porta:

    $env:PORT=3334; npm run dev
`);
  process.exit(1);
});

// Antes de qualquer coisa: garantir que somos a única instância nesta pasta.
const trava = await tomarTrava();
if (!trava.ok) {
  console.error(mensagemDeTravada(trava));
  process.exit(1);
}

// Em produção, dados dentro da pasta do código significam dados descartáveis:
// o sistema de arquivos do container é recriado a cada deploy. Sem disco
// montado, cada deploy apagaria bancos, sessões do WhatsApp e chaves.
// Avisar alto é melhor do que descobrir depois de perder.
if (process.env.NODE_ENV === 'production') {
  const dentroDoCodigo = PASTA_DADOS.startsWith(RAIZ);
  if (!process.env.DATA_DIR || dentroDoCodigo) {
    console.error(`
  ⚠  PRODUÇÃO SEM DISCO PERSISTENTE

     Os dados estão em ${PASTA_DADOS}, dentro da pasta do código.
     Em container, isso é apagado a CADA deploy: você perderia os bancos das
     campanhas, as sessões do WhatsApp (voltaria a pedir QR toda vez) e as
     chaves do Firebase.

     No Render: adicione um Disk montado em /var/dados e a variável
     DATA_DIR=/var/dados. O render.yaml deste repositório já faz isso.

     Subindo assim mesmo — mas trate como ambiente descartável.
`);
  }
}

servidor.listen(PORTA, async () => {
  // Em produção o disco pode subir vazio no primeiro deploy.
  contas.semearAdministrador();

  const campanhas = contas.listarCampanhas({ apenasAtivas: true });

  console.log(`
  Rede de Apoio — multi-campanha
  ────────────────────────────────────────────
  Painel    http://localhost:${PORTA}
  Login     http://localhost:${PORTA}/login
  Campanhas ${campanhas.length ? campanhas.map((c) => c.slug).join(', ') : '(nenhuma — rode: npm run configurar)'}
`);

  for (const c of campanhas) {
    console.log(`  · ${c.nome} → /cadastro/${c.slug}`);
    try {
      await comCampanha(c.slug, () => firebase.iniciarFirebase());
    } catch (erro) {
      console.error(`[firebase:${c.slug}]`, erro.message);
    }
  }

  whatsapp.autoConectarTodas(campanhas.map((c) => c.slug))
    .catch((erro) => console.error('[whatsapp]', erro.message));

  // Campanhas no disco que não estão cadastradas indicam migração pendente.
  const orfas = campanhasNoDisco().filter((s) => !contas.obterCampanha(s));
  if (orfas.length) console.warn(`  ⚠ pastas sem campanha cadastrada: ${orfas.join(', ')}`);
});

// --- desligamento limpo -----------------------------------------------------
// O Render manda SIGTERM antes de todo deploy. Fechar o socket do WhatsApp
// com `end()` (e não `logout()`) preserva a sessão no disco: a nova instância
// reconecta sozinha, sem QR.
let encerrando = false;

async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`\n[${sinal}] encerrando…`);

  const prazo = setTimeout(() => process.exit(0), 10_000);
  prazo.unref?.();

  // Solta a pasta ANTES do trabalho lento (fechar WhatsApp, esvaziar fila do
  // Firestore). Segurar a trava durante um desligamento de até 10s é o que
  // fazia o reinício do --watch esbarrar na instância que já estava saindo.
  soltarTrava();

  try {
    for (const cliente of clientesSse) { try { cliente.res.end(); } catch { /* já fechou */ } }
    await whatsapp.encerrarTudo();

    // Última chance de subir o que ficou na fila do Firestore.
    for (const c of contas.listarCampanhas({ apenasAtivas: true })) {
      try { await comCampanha(c.slug, () => firebase.processarFila()); } catch { /* sem rede */ }
    }
    servidor.close();
    console.log('[encerrado] sessões do WhatsApp preservadas no disco.\n');
  } catch (erro) {
    console.error('[encerrar]', erro.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

// Um erro solto não pode derrubar o processo inteiro em produção: isso
// desconectaria o WhatsApp de todas as campanhas de uma vez.
process.on('unhandledRejection', (erro) => {
  console.error('[promessa rejeitada]', erro?.message ?? erro);
});
process.on('uncaughtException', (erro) => {
  console.error('[exceção não tratada]', erro?.message ?? erro);
});
