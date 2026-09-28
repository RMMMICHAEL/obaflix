// ==UserScript==
// @name         Obaflix Sync
// @namespace    obaflix
// @version      1.2
// @description  Duplica add_filme, add_serie e add_episodio do painel Megaflix para o Obaflix automaticamente
// @match        https://admin.megafrixapi.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @connect      obaflix.vercel.app
// ==/UserScript==

(function () {
  'use strict';

  const OBAFLIX = 'https://obaflix.vercel.app';

  // Tokens NAO vivem neste arquivo — um deles ja esteve comitado aqui uma vez.
  // Guarde no armazenamento do proprio userscript, uma unica vez:
  //   GM_setValue('obaflixCatalogToken', '<CATALOG_SYNC_TOKEN>')   // caminho final
  // ou, sem GM_setValue, no localStorage do painel Megaflix pela consola.
  //
  // Modo integracao (caminho final): /api/integracoes/catalogo/* com
  // Authorization: Bearer CATALOG_SYNC_TOKEN, que so escreve catalogo. Campos
  // vazios nao sao enviados, e o servidor tambem trata null como ausente.
  //
  // Escolha do modo: com obaflixCatalogToken configurado, integracao. Sem ele,
  // cai no legado de transicao (obaflixAdminToken + /api/admin/*, com aviso),
  // que deixa de existir no cutover (404). obaflixModo forca um dos dois.
  const setting = (key, fallback) =>
    (typeof GM_getValue === 'function' ? GM_getValue(key, '') : '') ||
    localStorage.getItem(key) ||
    fallback;
  const CATALOG_TOKEN = setting('obaflixCatalogToken', '');
  const MODO_FORCADO = setting('obaflixModo', '');
  const MODO = MODO_FORCADO === 'legado' ? 'legado'
    : MODO_FORCADO === 'integracao' ? 'integracao'
    : CATALOG_TOKEN ? 'integracao' : 'legado';
  const TOKEN = MODO === 'integracao' ? CATALOG_TOKEN : setting('obaflixAdminToken', '');
  if (MODO === 'legado') {
    console.warn('[Obaflix Sync] modo legado (x-admin-token) em descontinuacao: configure obaflixCatalogToken. Apos o cutover o legado responde 404.');
  }

  if (!TOKEN) {
    console.warn(`[Obaflix Sync] token ausente para o modo ${MODO} — configure ${MODO === 'integracao' ? 'obaflixCatalogToken' : 'obaflixAdminToken'}.`);
    return;
  }

  const PATHS = MODO === 'integracao'
    ? { filme: '/api/integracoes/catalogo/filme', serie: '/api/integracoes/catalogo/serie', episodios: '/api/integracoes/catalogo/episodios/bulk' }
    : { filme: '/api/admin/filme', serie: '/api/admin/serie', episodios: '/api/admin/episodio/bulk' };
  const AUTH = MODO === 'integracao' ? { Authorization: 'Bearer ' + TOKEN } : { 'x-admin-token': TOKEN };

  // Mesma regra de src/lib/catalog-destino.ts (pruneCatalogPayload).
  function prune(kind, body) {
    if (MODO !== 'integracao') return body;
    const out = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      if (kind === 'serie' && key === 'tipo' && value === 'serie') continue;
      if (kind === 'episodios' && key === 'episodios' && Array.isArray(value)) {
        out.episodios = value.map((ep) => prune('filme', ep));
        continue;
      }
      out[key] = value;
    }
    return out;
  }
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

  function fullImg(path) {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return TMDB_IMG + (path.startsWith('/') ? path : '/' + path);
  }

  function obaPost(kind, body) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: OBAFLIX + PATHS[kind],
        headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH),
        data: JSON.stringify(prune(kind, body)),
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch { resolve({ error: r.responseText }); }
        },
        onerror: () => resolve({ error: 'network error' }),
      });
    });
  }

  async function syncFilme(fields) {
    const id = fields.tmdb || fields.url;
    if (!id) { console.warn('[Obaflix] add_filme sem tmdb/url, ignorado'); return; }

    const result = await obaPost('filme', {
      id: String(id),
      tmdbId: fields.tmdb ? String(fields.tmdb) : null,
      titulo: fields.titulo || fields.title,
      tituloOriginal: fields.title || null,
      poster: fullImg(fields.poster),
      background: fullImg(fields.background),
      sinopse: fields.sinopse || null,
      ano: fields.ano ? Number(fields.ano) : null,
      nota: fields.nota ? Number(fields.nota) : null,
      duracao: fields.duracao ? Number(fields.duracao) : null,
      urlDub: fields.urlBR || null,
      urlLeg: fields.urlENG || null,
    });

    console.log(`[Obaflix] ✅ Filme "${fields.titulo}" →`, result);
  }

  async function syncSerie(fields) {
    const id = fields.tmdb || fields.url || fields.id;
    if (!id) { console.warn('[Obaflix] add_serie sem id, ignorado'); return; }

    const result = await obaPost('serie', {
      id: String(id),
      tmdbId: fields.tmdb ? String(fields.tmdb) : null,
      titulo: fields.titulo || fields.title,
      tituloOriginal: fields.title || null,
      poster: fullImg(fields.poster),
      background: fullImg(fields.background),
      sinopse: fields.sinopse || null,
      ano: fields.ano ? Number(fields.ano) : null,
      nota: fields.nota ? Number(fields.nota) : null,
      tipo: 'serie',
    });

    console.log(`[Obaflix] ✅ Série "${fields.titulo}" →`, result);
  }

  async function syncEpisodio(fields) {
    if (!fields.id || !fields.ep) { console.warn('[Obaflix] add_episodio sem id/ep, ignorado'); return; }

    const result = await obaPost('episodios', {
      serieId: String(fields.id),
      episodios: [{
        ep: Number(fields.ep),
        temp: Number(fields.temp ?? 1),
        urlDub: fields.urlBR || null,
        urlLeg: fields.urlENG || null,
      }],
    });

    console.log(`[Obaflix] ✅ Ep ${fields.temp}x${fields.ep} (série ${fields.id}) →`, result);
  }

  // ── Interceptar XHR ──────────────────────────────────────────────────────────

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._obaUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._obaUrl || '';
    const ajax = url.match(/[?&]ajax=([^&]+)/)?.[1];

    if (ajax && body) {
      const fields = {};
      // body pode ser string URLencoded ou FormData
      if (typeof body === 'string') {
        new URLSearchParams(body).forEach((v, k) => {
          if (k.endsWith('[]')) {
            const base = k.slice(0, -2);
            fields[base] = fields[base] ? [...fields[base], v] : [v];
          } else {
            fields[k] = v;
          }
        });
      } else if (body instanceof FormData) {
        body.forEach((v, k) => {
          if (k.endsWith('[]')) {
            const base = k.slice(0, -2);
            fields[base] = fields[base] ? [...fields[base], v] : [v];
          } else {
            fields[k] = v;
          }
        });
      }

      console.log(`[Obaflix] Interceptado: ${ajax}`, fields);

      if (ajax === 'add_filme' || ajax === 'edit_filme') syncFilme(fields);
      else if (ajax === 'add_serie' || ajax === 'edit_serie') syncSerie(fields);
      else if (ajax === 'add_episodio' || ajax === 'edit_episodio') syncEpisodio(fields);
    }

    return origSend.apply(this, arguments);
  };

  console.log(`[Obaflix Sync] ✅ Ativo (modo ${MODO}) — qualquer conteúdo adicionado será duplicado para o Obaflix`);
})();
