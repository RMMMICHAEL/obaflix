// ==UserScript==
// @name         Obaflix Sync
// @namespace    obaflix
// @version      1.0
// @description  Duplica add_filme, add_serie e add_episodio do painel Megaflix para o Obaflix automaticamente
// @match        https://admin.megafrixapi.com/*
// @grant        GM_xmlhttpRequest
// @connect      obaflix.vercel.app
// ==/UserScript==

(function () {
  'use strict';

  const OBAFLIX = 'https://obaflix.vercel.app';
  const TOKEN = '@Oba152535'; // seu admin token
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

  function fullImg(path) {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return TMDB_IMG + (path.startsWith('/') ? path : '/' + path);
  }

  function obaPost(path, body) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: OBAFLIX + path,
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': TOKEN,
        },
        data: JSON.stringify(body),
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

    const result = await obaPost('/api/admin/filme', {
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

    const result = await obaPost('/api/admin/serie', {
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

    const result = await obaPost('/api/admin/episodio/bulk', {
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

  console.log('[Obaflix Sync] ✅ Ativo — qualquer conteúdo adicionado será duplicado para o Obaflix');
})();
