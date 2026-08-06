import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { db, PASTA_PUBLICA, agora, getConfig } from './db.js';
import { salvarCadastro, registrarEvento } from './ingest.js';
import { recomputar, PESOS, FAIXAS, CORES_FAIXA } from './scoring.js';
import { TEMAS, INTENCOES } from './lexicon.js';
import {
  listarPessoas, obterPessoa, listarGrupos, listarTags, listarAbaixos,
  listarAlertas, marcarAlertas, contarAlertas,
  listarConversas, conversaDeGrupo, marcarConversaLida, definirSituacao,
  panorama, filaDeAcao, exportarCsv
} from './repo.js';
import { lerConversa, sugerirRespostas } from './conversa.js';
import * as whatsapp from './whatsapp.js';
import * as firebase from './firestore.js';
import * as adicao from './adicionar-grupo.js';
import { importarPasta } from './importar-leads.js';

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
  const corpo = JSON.stringify(dados);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corpo);
};

async function lerCorpo(req) {
  const partes = [];
  for await (const pedaco of req) partes.push(pedaco);
  if (!partes.length) return {};
  const bruto = Buffer.concat(partes).toString('utf8');
  try { return JSON.parse(bruto); } catch { return {}; }
}

function filtrosDaUrl(url) {
  const p = url.searchParams;
  return {
    busca: p.get('busca') || '',
    faixa: p.get('faixa') || '',
    grupo: p.get('grupo') || '',
    tema: p.get('tema') || '',
    intencao: p.get('intencao') || '',
    cadastro: p.get('cadastro') || '',
    tag: p.get('tag') || '',
    abaixo: p.get('abaixo') || '',
    uf: p.get('uf') || '',
    semGrupo: p.get('semGrupo') || '',
    ordenar: p.get('ordenar') || 'engajamento',
    pagina: Number(p.get('pagina') || 1),
    porPagina: Number(p.get('porPagina') || 25)
  };
}

// --- SSE: painel atualiza sozinho quando chega mensagem nova ----------------
const clientesSse = new Set();
const transmitir = (evento) => {
  const pacote = `data: ${JSON.stringify(evento)}\n\n`;
  for (const res of clientesSse) res.write(pacote);
};
whatsapp.assinar(transmitir);
adicao.assinarFila((e) => transmitir({ ...e, tipo: `fila_${e.tipo}` }));

function abrirSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 3000\n\n');
  clientesSse.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => { clearInterval(ping); clientesSse.delete(res); });
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

// --- API --------------------------------------------------------------------
async function api(req, res, url) {
  const rota = url.pathname.replace('/api', '');
  const metodo = req.method;

  if (rota === '/panorama' && metodo === 'GET') {
    return json(res, {
      ...panorama(),
      grupos_lista: listarGrupos(),
      tags: listarTags(),
      ultimo_recalculo: Number(getConfig('ultimo_recalculo', 0)),
      whatsapp: { status: whatsapp.estado.status, telefone: whatsapp.estado.telefone },
      firebase: firebase.statusFirebase()
    });
  }

  if (rota === '/abaixos' && metodo === 'GET') return json(res, listarAbaixos());

  // --- Caixa de entrada (espelho do WhatsApp) -------------------------------
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

  if (rota === '/config' && metodo === 'GET') {
    return json(res, {
      temas: Object.fromEntries(Object.entries(TEMAS).map(([k, v]) => [k, { rotulo: v.rotulo, cor: v.cor }])),
      intencoes: Object.fromEntries(Object.entries(INTENCOES).map(([k, v]) => [k, { rotulo: v.rotulo, cor: v.cor }])),
      faixas: FAIXAS,
      cores_faixa: CORES_FAIXA,
      pesos: PESOS
    });
  }

  if (rota === '/pessoas' && metodo === 'GET') return json(res, listarPessoas(filtrosDaUrl(url)));

  if (rota === '/fila' && metodo === 'GET') return json(res, filaDeAcao());

  if (rota === '/grupos' && metodo === 'GET') return json(res, listarGrupos());

  if (rota === '/tags' && metodo === 'GET') return json(res, listarTags());

  if (rota === '/tags' && metodo === 'POST') {
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
        registrarEvento({ pessoaId: id, tipo: 'nota', descricao: 'Ficha atualizada pela equipe' });
        recomputar();
        firebase.publicarPessoa(id);
      }
      return json(res, obterPessoa(id));
    }

    if (sub === '/nota' && metodo === 'POST') {
      const { texto } = await lerCorpo(req);
      if (!texto?.trim()) return json(res, { erro: 'Nota vazia' }, 400);
      const evento = { tipo: 'nota', descricao: texto.trim(), ts: agora() };
      registrarEvento({ pessoaId: id, ...evento });
      firebase.publicarEvento(id, evento);
      return json(res, obterPessoa(id));
    }

    if (sub === '/tags' && metodo === 'POST') {
      const { tagId, remover } = await lerCorpo(req);
      if (remover) {
        db.prepare('DELETE FROM pessoa_tags WHERE pessoa_id = ? AND tag_id = ?').run(id, Number(tagId));
      } else {
        db.prepare('INSERT OR IGNORE INTO pessoa_tags (pessoa_id, tag_id) VALUES (?, ?)').run(id, Number(tagId));
      }
      recomputar();
      firebase.publicarPessoa(id);
      return json(res, obterPessoa(id));
    }

    if (sub === '/mensagem' && metodo === 'POST') {
      const { texto } = await lerCorpo(req);
      const pessoa = db.prepare('SELECT wa_jid FROM pessoas WHERE id = ?').get(id);
      if (!pessoa) return json(res, { erro: 'Pessoa não encontrada' }, 404);
      try {
        await whatsapp.enviarMensagem(pessoa.wa_jid, texto);
        return json(res, { ok: true, pessoa: obterPessoa(id) });
      } catch (erro) {
        return json(res, { erro: erro.message }, 400);
      }
    }
  }

  if (rota === '/cadastro' && metodo === 'POST') {
    const corpo = await lerCorpo(req);
    try {
      const r = salvarCadastro(corpo);
      recomputar();
      firebase.publicarPessoa(r.pessoaId);
      await firebase.processarFila();
      return json(res, { ok: true, ...r });
    } catch (erro) {
      return json(res, { erro: erro.message }, 400);
    }
  }

  if (rota === '/recalcular' && metodo === 'POST') return json(res, recomputar());

  if (rota === '/export.csv' && metodo === 'GET') {
    const csv = exportarCsv(filtrosDaUrl(url));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rede-apoio-${new Date().toISOString().slice(0, 10)}.csv"`
    });
    return res.end(csv);
  }

  // --- Fila de adição a grupo ----------------------------------------------
  if (rota === '/fila-adicao' && metodo === 'GET') {
    const grupoId = url.searchParams.get('grupo');
    return json(res, {
      ...adicao.resumo(grupoId ? Number(grupoId) : null),
      itens: adicao.listarFila({ grupoId: grupoId ? Number(grupoId) : null, limite: 300 })
    });
  }

  if (rota === '/fila-adicao/pausar' && metodo === 'POST') return json(res, adicao.pausar());
  if (rota === '/fila-adicao/retomar' && metodo === 'POST') return json(res, adicao.retomar());

  if (rota === '/fila-adicao/cancelar' && metodo === 'POST') {
    const { grupoId } = await lerCorpo(req);
    return json(res, adicao.cancelarPendentes(grupoId ? Number(grupoId) : null));
  }

  const casaAdicao = rota.match(/^\/grupos\/(\d+)\/(elegiveis|adicionar)$/);
  if (casaAdicao) {
    const grupoId = Number(casaAdicao[1]);
    if (casaAdicao[2] === 'elegiveis' && metodo === 'GET') {
      const filtros = {
        abaixo: url.searchParams.get('abaixo') || '',
        uf: url.searchParams.get('uf') || '',
        cidade: url.searchParams.get('cidade') || '',
        somenteSemGrupo: url.searchParams.get('somenteSemGrupo') || '',
        somenteAssinantes: url.searchParams.get('somenteAssinantes') || ''
      };
      const lista = adicao.elegiveis({ grupoId, filtros });
      return json(res, { total: lista.length, amostra: lista.slice(0, 12) });
    }
    if (casaAdicao[2] === 'adicionar' && metodo === 'POST') {
      const { filtros, pessoaIds, limite } = await lerCorpo(req);
      try {
        return json(res, adicao.enfileirar({ grupoId, filtros, pessoaIds, limite }));
      } catch (erro) { return json(res, { erro: erro.message }, 400); }
    }
  }

  // --- Firebase -------------------------------------------------------------
  if (rota === '/firebase/status' && metodo === 'GET') return json(res, firebase.statusFirebase());

  if (rota === '/firebase/conectar' && metodo === 'POST') {
    await firebase.iniciarFirebase();
    return json(res, firebase.statusFirebase());
  }

  if (rota === '/firebase/sincronizar' && metodo === 'POST') {
    const resumo = firebase.sincronizarTudo();
    const envio = await firebase.processarFila();
    return json(res, { ...resumo, ...envio, status: firebase.statusFirebase() });
  }

  if (rota === '/firebase/enviar' && metodo === 'POST') {
    const envio = await firebase.processarFila();
    return json(res, { ...envio, status: firebase.statusFirebase() });
  }

  if (rota === '/leads/importar' && metodo === 'POST') {
    const resultado = importarPasta();
    if (resultado.erro) return json(res, resultado, 400);
    await firebase.processarFila();
    return json(res, resultado);
  }

  // --- WhatsApp -------------------------------------------------------------
  if (rota === '/whatsapp/status' && metodo === 'GET') {
    await whatsapp.checarDependencias();
    return json(res, {
      ...whatsapp.estado,
      grupos: listarGrupos().map((g) => ({ nome: g.nome, membros: g.membros }))
    });
  }
  if (rota === '/whatsapp/conectar' && metodo === 'POST') return json(res, await whatsapp.conectar());
  if (rota === '/whatsapp/desconectar' && metodo === 'POST') {
    const { apagarSessao } = await lerCorpo(req);
    return json(res, await whatsapp.desconectar({ apagarSessao }));
  }
  if (rota === '/whatsapp/sincronizar' && metodo === 'POST') {
    try { return json(res, { grupos: await whatsapp.ressincronizar() }); } catch (erro) {
      return json(res, { erro: erro.message }, 400);
    }
  }

  return json(res, { erro: 'Rota não encontrada' }, 404);
}

// --- servidor ---------------------------------------------------------------
const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/eventos') return abrirSse(res);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/' || url.pathname === '/painel') return servirArquivo(res, 'index.html');
    if (url.pathname === '/cadastro') return servirArquivo(res, 'cadastro.html');
    return servirArquivo(res, url.pathname);
  } catch (erro) {
    console.error('[erro]', erro);
    return json(res, { erro: erro.message }, 500);
  }
});

servidor.on('error', (erro) => {
  if (erro.code === 'EADDRINUSE') {
    console.error(`\n[ERRO] A porta ${PORTA} já está em uso por outra instância do servidor.`);
    console.error(`Para resolver, finalize o processo anterior ou especifique outra porta:`);
    console.error(`  - No PowerShell: Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORTA}).OwningProcess -Force`);
    console.error(`  - Ou use outra porta: $env:PORT="3334"; npm run dev\n`);
    process.exit(1);
  } else {
    console.error('[ERRO no servidor]', erro);
  }
});

servidor.listen(PORTA, async () => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n;
  const assinaturas = db.prepare('SELECT COUNT(*) AS n FROM assinaturas').get().n;
  console.log(`
  Rede de Apoio — WhatsApp
  ────────────────────────────────────────────
  Painel      http://localhost:${PORTA}
  Cadastro    http://localhost:${PORTA}/cadastro
  Base atual  ${total} pessoas · ${assinaturas} assinaturas${total === 0 ? '  (rode: npm run importar)' : ''}
`);
  await firebase.iniciarFirebase();
  whatsapp.autoConectar().catch((erro) => console.error('[whatsapp]', erro.message));
});

