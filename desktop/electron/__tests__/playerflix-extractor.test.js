"use strict";

// Testes do extrator nativo do Player 1 (PlayerFlix) no Electron. Nenhuma
// requisição real: global.fetch é substituído. Rodar com: npm run test:extractors
//
// A mesma lógica existe em Kotlin (PlayerExtractors.extractPlayerflix) e no
// Website (src/app/api/player/extract/route.ts). Ao mudar uma, ajuste as outras
// — ver CLAUDE.md.

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractStream, detectProvider } = require("../extractors");

const AJAX = "https://playerflix.ink/inc/Ajax.php?id=1405&type=tv&season=1&episode=1";
const AJAX_FILME = "https://playerflix.ink/inc/Ajax.php?id=550&type=movie";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/**
 * Provedor falso. `opcoes` são as URLs de embed que o Ajax devolve; `respostas`
 * mapeia hostname → handler, para simular WatchPlay e EmbedPlayer.
 */
function comPlayerflix(opcoes, respostas = {}) {
  const original = global.fetch;
  const chamadas = [];
  global.fetch = async (url, init = {}) => {
    const alvo = new URL(String(url));
    chamadas.push({ url: alvo.href, host: alvo.hostname, headers: init.headers || {} });

    if (alvo.hostname === "playerflix.ink") {
      const corpo = JSON.stringify({ data: { options: opcoes.map((embed) => ({ embed })) } });
      return new Response(corpo, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const handler = respostas[alvo.hostname];
    if (!handler) throw new TypeError("fetch failed");
    return handler(alvo, init);
  };
  return { chamadas, restaurar: () => { global.fetch = original; } };
}

/**
 * Página do WatchPlay + API dele, no formato que extractWatchplayer lê:
 * série casa data-contentid/season/episode nessa ordem; filme usa
 * player_select_item; as duas terminam em getPlayer → data.video_url.
 */
function watchplayOk(streamUrl) {
  return async (alvo, init) => {
    if (alvo.pathname === "/api") {
      const corpo = String(init?.body ?? "");
      if (corpo.includes("action=getOptions")) {
        return new Response(JSON.stringify({ data: { options: [{ ID: "99" }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { video_url: streamUrl } }), { status: 200 });
    }
    return new Response(
      '<div data-contentid="77" data-season="1" data-episode="1"></div>' +
      '<div class="player_select_item" data-id="99"></div>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  };
}

test("detectProvider reconhece o Ajax do PlayerFlix", () => {
  assert.equal(detectProvider(AJAX), "playerflix");
  assert.equal(detectProvider(AJAX_FILME), "playerflix");
});

test("detectProvider não captura outras páginas do playerflix.ink", () => {
  assert.equal(detectProvider("https://playerflix.ink/serie/1405/1/1"), null);
});

test("WatchPlay vem primeiro, e o Referer é a página dele", async () => {
  const stream = "https://cdn-teste.invalid/_s3_/1/1405/s1e1/playlist.m3u8";
  const falso = comPlayerflix(
    ["https://embedplayer2.xyz/rola4/abc", "https://v1.watchplay.shop/tvshow/1405/1/1"],
    { "v1.watchplay.shop": watchplayOk(stream) },
  );
  try {
    const r = await extractStream(AJAX);
    assert.equal(r.stream, stream);
    // O CDN do WatchPlay devolve 403 se receber o Referer do EmbedPlayer.
    assert.equal(r.referer, "https://v1.watchplay.shop/tvshow/1405/1/1");
    assert.equal(r.provider, "playerflix");
    assert.equal(r.tipo, "hls");
  } finally { falso.restaurar(); }
});

test("opção em base64 é decodificada", async () => {
  const stream = "https://cdn-teste.invalid/x/playlist.m3u8";
  const falso = comPlayerflix(
    [b64("https://v1.watchplay.shop/movie/550")],
    { "v1.watchplay.shop": watchplayOk(stream) },
  );
  try {
    const r = await extractStream(AJAX_FILME);
    assert.equal(r.referer, "https://v1.watchplay.shop/movie/550");
  } finally { falso.restaurar(); }
});

test("sem WatchPlay, cai para o EmbedPlayer e o Referer acompanha", async () => {
  const stream = "https://cdn-teste.invalid/y/master.m3u8";
  const falso = comPlayerflix(
    ["https://embedplayer2.xyz/rola4/abc"],
    {
      "embedplayer2.xyz": (alvo) => {
        if (alvo.pathname.includes("index.php")) {
          return new Response(JSON.stringify({ videoSource: stream }), { status: 200 });
        }
        return new Response("<html></html>", { status: 200 });
      },
    },
  );
  try {
    const r = await extractStream(AJAX);
    assert.equal(r.referer, "https://embedplayer2.xyz/rola4/abc");
  } finally { falso.restaurar(); }
});

test("o Ajax recebe o Referer da página do PlayerFlix, não do app", async () => {
  const falso = comPlayerflix(
    ["https://v1.watchplay.shop/tvshow/1405/1/1"],
    { "v1.watchplay.shop": watchplayOk("https://cdn-teste.invalid/z/playlist.m3u8") },
  );
  try {
    await extractStream(AJAX);
    const ajax = falso.chamadas.find((c) => c.host === "playerflix.ink");
    assert.equal(ajax.headers.Referer, "https://playerflix.ink/serie/1405/1/1");
    assert.equal(ajax.headers["X-Requested-With"], "XMLHttpRequest");
  } finally { falso.restaurar(); }
});

test("nenhuma opção compatível vira erro nomeado", async () => {
  const falso = comPlayerflix(["https://ok.ru/videoembed/123"]);
  try {
    await assert.rejects(() => extractStream(AJAX), /servidor compatível não encontrado/);
  } finally { falso.restaurar(); }
});

test("WatchPlay quebrado não impede o EmbedPlayer", async () => {
  const stream = "https://cdn-teste.invalid/w/master.m3u8";
  const falso = comPlayerflix(
    ["https://v1.watchplay.shop/tvshow/1405/1/1", "https://embedplayer2.xyz/rola4/abc"],
    {
      "v1.watchplay.shop": () => new Response("erro", { status: 500 }),
      "embedplayer2.xyz": (alvo) => {
        if (alvo.pathname.includes("index.php")) {
          return new Response(JSON.stringify({ videoSource: stream }), { status: 200 });
        }
        return new Response("<html></html>", { status: 200 });
      },
    },
  );
  try {
    const r = await extractStream(AJAX);
    assert.equal(r.stream, stream);
    assert.equal(r.referer, "https://embedplayer2.xyz/rola4/abc");
  } finally { falso.restaurar(); }
});
