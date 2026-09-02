"use strict";

// Testes de parser do extrator SuperFlix. Usam apenas fixtures inventadas: nenhum
// token, cookie ou assinatura real aparece aqui, e nenhuma requisição de rede é
// feita. Rodar com: npm run test:extractors
//
// A lógica coberta aqui é espelhada em Kotlin (SuperflixExtractor.kt e
// HlsManifest.kt); ao mudar uma das implementações, ajuste a outra e este arquivo.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _test,
  prepareSuperflixSession,
  SuperflixAuthorizationError,
  createResolutionAttemptTrace,
  isNativeOptionExpiredError,
  shareInFlightResolution,
  retryAuthorizationOnce,
  retryNativeOptionOnce,
} = require("../superflix-extractor");
const hlsManifest = require("../hls-manifest");

const {
  collectChainUrls,
  findPageToken,
  findSourceIds,
  findDirectMedia,
  findSubtitleTracks,
  findContentId,
  contentCoordinates,
  optionOrderScore,
  ehServidorIncorporado,
  decodeTokenPayload,
  secureTransportUrl,
  profileScore,
  tokenExpiry,
  createCookieJar,
  isServerProvidedNativeRoute,
  publicOptionLabel,
} = _test;

/** Opção como o /player/bootstrap devolve, para os testes de ranking. */
const opcao = (id, label, isFile) => ({ id, label, isFile });

/** Monta um token no formato payload.assinatura, com payload falso. */
function fakeToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${encoded}.${"a".repeat(43)}`;
}

const MASTER_MANIFEST = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Português",LANGUAGE="pt",DEFAULT=YES,URI="audio/pt.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Original",LANGUAGE="en",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Português",LANGUAGE="pt",URI="/subs/pt.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,AUDIO="aud"
1080/index.m3u8
`;

const MEDIA_MANIFEST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;

const MANIFEST_BASE = "https://cdn.exemplo.invalid/hls/abc/master.m3u8";

test("manifesto master expõe qualidades, áudios e legendas", () => {
  const info = hlsManifest.parse(MASTER_MANIFEST, MANIFEST_BASE);

  assert.equal(info.isMaster, true);
  // CODECS="avc1...,mp4a..." não pode quebrar a divisão dos atributos por vírgula.
  assert.deepEqual(info.variants.map((v) => v.label), ["1080p", "360p"]);
  assert.deepEqual(info.audioTracks, ["Português", "Original"]);
  assert.deepEqual(
    info.subtitles.map((s) => s.file),
    ["https://cdn.exemplo.invalid/subs/pt.m3u8"],
  );
});

test("playlist de mídia não é confundida com master", () => {
  const info = hlsManifest.parse(MEDIA_MANIFEST, MANIFEST_BASE);
  assert.equal(info.isMaster, false);
  assert.equal(info.variants.length, 0);
});

test("HTML não é aceito como manifesto", () => {
  const html = "<html><body>Just a moment...</body></html>";
  assert.equal(hlsManifest.looksLikeManifest(html), false);
  assert.equal(hlsManifest.parse(html, MANIFEST_BASE).isMaster, false);
});

test("ranking prefere master HLS a HLS simples e a MP4", () => {
  const master = hlsManifest.parse(MASTER_MANIFEST, MANIFEST_BASE);
  const simples = hlsManifest.parse(MEDIA_MANIFEST, MANIFEST_BASE);
  const embed = opcao("152777", "Servidor 152777", false);

  const notaMaster = profileScore("hls", master, true, embed);
  const notaSimples = profileScore("hls", simples, false, embed);
  const notaMp4 = profileScore("mp4", null, false, opcao("native_media_v2:1:2:1:1:3:abc", "MP4 Dublado", true));

  assert.ok(notaMaster > notaSimples, `${notaMaster} > ${notaSimples}`);
  assert.ok(notaSimples > notaMp4, `${notaSimples} > ${notaMp4}`);
  // Um MP4 com legenda ainda perde para um master completo — o master traz
  // qualidades e áudio, que não dá para reconstruir a partir de um MP4.
  assert.ok(notaMaster > profileScore("mp4", null, true, embed));
});

test("empate entre fontes iguais favorece o servidor incorporado", () => {
  const embed = opcao("152777", "Servidor 152777", false);
  const arquivo = opcao("native_media_v2:262627:131927:1:1:171230:abc", "MP4 Dublado", true);
  assert.ok(profileScore("hls", null, false, embed) > profileScore("hls", null, false, arquivo));
});

test("native_media_v2 conta como arquivo direto, não como servidor alternativo", () => {
  // O teste antigo era startsWith("native_media:") e o prefixo virou
  // native_media_v2:, o que classificava todo servidor nativo como alternativo.
  assert.equal(ehServidorIncorporado(opcao("native_media_v2:262627:131927:1:1:171230:abc", "MP4 Dublado")), false);
  assert.equal(ehServidorIncorporado(opcao("native_media:262627", "MP4 Dublado")), false);
  assert.equal(ehServidorIncorporado(opcao("152777", "Servidor 152777")), true);
  // O is_file do bootstrap tem precedência sobre o palpite pelo prefixo.
  assert.equal(ehServidorIncorporado(opcao("152777", "Servidor", true)), false);
});

test("IDs do protocolo atual são aceitos na varredura de HTML", () => {
  const html = [
    '<div data-video-id="native_media_v2:262627:131927:1:1:171230:ed30d8ad975b394a3be785ea0cd2ad07"></div>',
    '<div data-video-id="152777"></div>',
    '<div data-video-id="native_media:99"></div>',
  ].join("");

  const ids = findSourceIds(html);
  assert.ok(ids.includes("native_media_v2:262627:131927:1:1:171230:ed30d8ad975b394a3be785ea0cd2ad07"));
  assert.ok(ids.includes("152777"));
  assert.ok(ids.includes("native_media:99"));
});

test("contentid é localizado nas formas conhecidas", () => {
  assert.equal(findContentId('<input name="contentid" value="122952">'), "122952");
  assert.equal(findContentId('{"contentid":122952}'), "122952");
  assert.equal(findContentId('<div data-content-id="122952"></div>'), "122952");
  assert.equal(findContentId("<p>sem nada aqui</p>"), null);
});

test("coordenadas do conteúdo saem do caminho do token", () => {
  assert.deepEqual(contentCoordinates("/serie/dexter-new-blood/1/1"), {
    tipo: "serie", season: "1", episode: "1",
  });
  assert.deepEqual(contentCoordinates("/filme/duna-parte-2"), {
    tipo: "filme", season: null, episode: null,
  });
});

test("servidor incorporado é sondado antes do MP4, e dublado antes de legendado", () => {
  const opcoes = [
    opcao("native_media_v2:a:b:1:1:c:d", "MP4 Legendado", true),
    opcao("native_media_v2:e:f:1:1:g:h", "MP4 Dublado", true),
    opcao("152777", "Servidor 152777", false),
  ].map((o) => Object.assign(o, { orderScore: optionOrderScore(o) }))
    .sort((a, b) => b.orderScore - a.orderScore);

  assert.deepEqual(opcoes.map((o) => o.label), ["Servidor 152777", "MP4 Dublado", "MP4 Legendado"]);
});

test("templates JavaScript e scripts do Cloudflare não viram hops", () => {
  const html = [
    '<iframe src="${url}"></iframe>',
    '<img src="${thumb}">',
    '<script src="/cdn-cgi/challenge-platform/scripts/main.js"></script>',
    '<script src="https://superflixapi.invalid/assets/app.js"></script>',
    '<iframe src="https://warezcdn.invalid/player?cfv=TOKEN_FALSO"></iframe>',
  ].join("");

  const urls = collectChainUrls(html, "https://superflixapi.pro/serie/4057/1/1");
  assert.deepEqual(urls, ["https://warezcdn.invalid/player?cfv=TOKEN_FALSO"]);
});

test("rota assinada do WarezCDN é priorizada sobre a página do player", () => {
  const html = [
    '<a href="https://superflixapi.pro/player/redirect?x=1">a</a>',
    '<a href="https://vizero.invalid/embed">b</a>',
    '<a href="https://warezcdn.invalid/e?cfv=TOKEN_FALSO">c</a>',
  ].join("");

  const urls = collectChainUrls(html, "https://superflixapi.pro/filme/550");
  assert.equal(urls[0], "https://warezcdn.invalid/e?cfv=TOKEN_FALSO");
});

test("page_token é reconhecido pelo payload, não pelo formato", () => {
  const pageToken = fakeToken({ embed_context_host: "vizero.buzz", exp: 1780000000 });
  const outroToken = fakeToken({ algo: "irrelevante" });
  const html = `<script>var cfv="${outroToken}";var page_token="${pageToken}";</script>`;

  assert.equal(findPageToken(html), pageToken);
  assert.equal(decodeTokenPayload(pageToken).embed_context_host, "vizero.buzz");
});

test("expiração do token é normalizada para milissegundos", () => {
  assert.equal(tokenExpiry({ exp: 1780000000 }), 1780000000000);
  assert.equal(tokenExpiry({ exp: 1780000000000 }), 1780000000000);
  assert.equal(tokenExpiry({}), null);
  assert.equal(tokenExpiry(null), null);
});

test("ordem de inspeção começa pelo servidor alternativo", () => {
  const html = [
    '<div data-video-id="native_media:4242">Servidor principal</div>',
    '<div data-video-id="777">Servidor alternativo Dublado</div>',
  ].join("");

  assert.deepEqual(findSourceIds(html), ["777", "native_media:4242"]);
});

test("bootstrap real do provedor vira a lista de servidores", async () => {
  // Corpo capturado de POST /player/bootstrap (HAR de 2026-08-16). Os IDs longos
  // são o formato real; nenhum token ou cookie acompanha esta fixture.
  const RESPOSTA_REAL = JSON.stringify({
    data: {
      options: [
        { ID: 152777, type: 1, name: "Servidor 152777", is_file: false, can_download: false },
        {
          ID: "native_media_v2:262627:131927:1:1:171230:ed30d8ad975b394a3be785ea0cd2ad07",
          type: 1, name: "MP4 Dublado", is_file: true, can_download: false,
        },
        {
          ID: "native_media_v2:262637:131927:1:1:171603:8a3677b5fb998b85fa47bb6d4d1248f6",
          type: 2, name: "MP4 Legendado", is_file: true, can_download: false,
        },
      ],
      flags: { mp4_active: true, native_player_active: true },
    },
  });

  let corpoEnviado = null;
  let urlChamada = null;
  const fetchStub = async (url, init) => {
    urlChamada = url;
    corpoEnviado = new URLSearchParams(init.body);
    return new Response(RESPOSTA_REAL, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const opcoes = await _test.fetchBootstrap(
    fetchStub,
    _test.createCookieJar(),
    { url: "https://superflixapi.pro/serie/dexter-new-blood/1/1", html: "" },
    "TOKEN_FALSO.ASSINATURA_FALSA",
    "122952",
    "/serie/dexter-new-blood/1/1",
    "UA-de-teste",
  );

  assert.equal(urlChamada, "https://superflixapi.pro/player/bootstrap");
  // Campos exatamente como o provedor recebe, incluindo as duas grafias do token.
  assert.equal(corpoEnviado.get("contentid"), "122952");
  assert.equal(corpoEnviado.get("type"), "serie");
  assert.equal(corpoEnviado.get("season"), "1");
  assert.equal(corpoEnviado.get("episode"), "1");
  assert.equal(corpoEnviado.get("page_token"), "TOKEN_FALSO.ASSINATURA_FALSA");
  assert.equal(corpoEnviado.get("pageToken"), "TOKEN_FALSO.ASSINATURA_FALSA");

  assert.deepEqual(opcoes.map((o) => o.label), ["Servidor 152777", "MP4 Dublado", "MP4 Legendado"]);
  // ID numérico e ID em string precisam sobreviver os dois.
  assert.equal(opcoes[0].id, "152777");
  assert.equal(opcoes[1].id, "native_media_v2:262627:131927:1:1:171230:ed30d8ad975b394a3be785ea0cd2ad07");
  assert.equal(opcoes[0].isFile, false);
  assert.equal(opcoes[1].isFile, true);
  // O servidor incorporado precisa ser sondado primeiro.
  assert.ok(opcoes[0].orderScore > opcoes[1].orderScore);
});

test("mídia e legenda em HTTP são promovidas para HTTPS", () => {
  assert.equal(secureTransportUrl("http://cdn.invalid:80/a.mp4"), "https://cdn.invalid/a.mp4");
  assert.equal(secureTransportUrl("https://cdn.invalid/a.mp4"), "https://cdn.invalid/a.mp4");
  assert.equal(secureTransportUrl("data:text/plain,x"), null);

  const html = '<video src="http://cdn.invalid/filme.mp4"></video>';
  assert.equal(findDirectMedia(html, "http://cdn.invalid/"), "https://cdn.invalid/filme.mp4");

  const comLegenda = '<track src="http://cdn.invalid/pt.vtt" label="Português">';
  assert.deepEqual(
    findSubtitleTracks(comLegenda, "http://cdn.invalid/").map((t) => t.file),
    ["https://cdn.invalid/pt.vtt"],
  );
});

function response(body = "", status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function integrationFetch({ firstSourceStatus = 200, firstExternal = false, secondLabel = "MP4 Alternativo" } = {}) {
  const calls = [];
  const token = fakeToken({
    embed_context_host: "contexto.invalid",
    embed_content_path: "/filme/exemplo",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const page = `<input name="contentid" value="4242"><script>var page_token="${token}";</script>`;
  let firstSourceAttempts = 0;

  const fetchImpl = async (raw, init = {}) => {
    const url = String(raw);
    calls.push({ url, method: init.method || "GET", body: init.body || "", headers: init.headers || {} });
    const parsed = new URL(url);
    if (parsed.pathname === "/filme/exemplo") return response(page);
    if (parsed.pathname === "/player/bootstrap") {
      return response(JSON.stringify({ data: { options: [
        { ID: "embed-1", name: "Player Principal Dublado", is_file: false },
        { ID: "native_media_v2:fixture", name: secondLabel, is_file: true },
      ] } }), 200, { "content-type": "application/json" });
    }
    if (parsed.pathname === "/player/source") {
      const form = new URLSearchParams(init.body);
      if (form.get("video_id") === "embed-1") {
        firstSourceAttempts += 1;
        if (firstSourceAttempts === 1 && firstSourceStatus !== 200) return response("", firstSourceStatus);
        return response(JSON.stringify({ data: { video_url: "https://superflixapi.pro/player/redirect/embed" } }));
      }
      return response(JSON.stringify({ data: { video_url: "https://superflixapi.pro/player/redirect/native" } }));
    }
    if (parsed.pathname === "/player/redirect/embed") {
      return response("", 302, {
        location: firstExternal
          ? "https://embedplayer.invalid/video/abcdef0123456789"
          : "https://cdn.invalid/main.m3u8",
      });
    }
    if (parsed.pathname === "/player/redirect/native") {
      return response("", 302, { location: "https://superflixapi.pro/player/native/media/nmp_fixture" });
    }
    if (parsed.pathname.endsWith("/nmp_fixture")) {
      return response('<script>var SOURCES=[{"src":"https://superflixapi.pro/player/native/media-source/nms_fixture"}];</script>');
    }
    if (parsed.pathname.endsWith("/nms_fixture")) {
      return response("", 302, { location: "https://cdn.invalid/movie.mp4?fixture=1" });
    }
    if (parsed.hostname === "cdn.invalid" && parsed.pathname.endsWith(".m3u8")) {
      return response(MEDIA_MANIFEST, 200, { "content-type": "application/vnd.apple.mpegurl" });
    }
    if (parsed.hostname === "cdn.invalid" && parsed.pathname.endsWith(".mp4")) {
      return response("", 206, { "content-type": "video/mp4", "content-range": "bytes 0-0/100" });
    }
    if (parsed.hostname === "embedplayer.invalid") {
      return response("<html><body>fixture do player externo</body></html>");
    }
    throw new Error(`fixture sem rota para ${parsed.pathname}`);
  };
  return { fetchImpl, calls };
}

function concurrentFirePlayerFetch() {
  const calls = [];
  const cookieUpdates = [];
  const token = fakeToken({
    embed_context_host: "contexto.invalid",
    embed_content_path: "/filme/fire",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const page = `<input name="contentid" value="6262"><script>var page_token="${token}";</script>`;
  let releaseSource;
  let markSourceStarted;
  const sourceGate = new Promise((resolve) => { releaseSource = resolve; });
  const sourceStarted = new Promise((resolve) => { markSourceStarted = resolve; });
  let fireCookieUsed = false;

  const fetchImpl = async (raw, init = {}) => {
    const url = String(raw);
    const parsed = new URL(url);
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body || "" });
    if (parsed.pathname === "/filme/fire") return response(page);
    if (parsed.pathname === "/player/bootstrap") {
      return response(JSON.stringify({ data: { options: [
        { ID: "fire-option", name: "Fire Player", is_file: false },
      ] } }), 200, { "content-type": "application/json" });
    }
    if (parsed.pathname === "/player/source") {
      markSourceStarted();
      await sourceGate;
      return response(JSON.stringify({ data: {
        video_url: "https://superflixapi.pro/player/redirect/fire",
      } }));
    }
    if (parsed.pathname === "/player/redirect/fire") {
      return response("", 302, {
        location: "https://embedplayer.invalid/video/abcdef0123456789",
      });
    }
    if (parsed.hostname === "embedplayer.invalid" && parsed.pathname.startsWith("/video/")) {
      return response("<html><body>Fire Player fixture</body></html>", 200, {
        "content-type": "text/html",
        "set-cookie": "fireplayer_player=fixture-session; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    }
    if (parsed.hostname === "embedplayer.invalid" && parsed.pathname === "/player/index.php") {
      const cookie = init.headers?.Cookie || init.headers?.cookie || "";
      fireCookieUsed = cookie.includes("fireplayer_player=fixture-session");
      if (!fireCookieUsed) return response("sessão ausente", 403);
      return response(JSON.stringify({ securedLink: "https://cdn.invalid/fire.mp4" }), 200, {
        "content-type": "application/json",
      });
    }
    if (parsed.hostname === "cdn.invalid" && parsed.pathname === "/fire.mp4") {
      return response("", 206, { "content-type": "video/mp4", "content-range": "bytes 0-0/100" });
    }
    throw new Error(`fixture sem rota para ${parsed.pathname}`);
  };

  const extractEmbedPlayer = async (embedUrl, _referer, _ua, cookieHeader, trace) => {
    const parsed = new URL(embedUrl);
    const id = parsed.pathname.split("/").filter(Boolean).at(-1);
    const apiUrl = `${parsed.origin}/player/index.php?data=${id}&do=getVideo`;
    const result = await fetchImpl(apiUrl, {
      method: "POST",
      headers: { Cookie: cookieHeader },
    });
    trace?.record(apiUrl, result.status, false);
    if (!result.ok) throw new Error(`Fire Player HTTP ${result.status}`);
    return (await result.json()).securedLink;
  };

  return {
    fetchImpl,
    extractEmbedPlayer,
    calls,
    cookieUpdates,
    sourceStarted,
    releaseSource,
    get fireCookieUsed() { return fireCookieUsed; },
  };
}

/**
 * Reproduz o caso real: a API legada do embedplayer (POST /player/index.php?
 * do=getVideo) devolve 403 para esta variante — como no HAR capturado do
 * próprio Obaflix —, mas uma sessão de navegador comum, no mesmo host,
 * continua normalmente e entrega a mídia por outro caminho (challenge JS
 * automático, depois o player carregando o manifesto), como o HAR de
 * referência (youcinehd.lat, via Fire Player) mostrou.
 *
 * Só uma opção de servidor — de propósito: prova que o 403 não encerra a
 * resolução mesmo sem outro candidato para o failover tentar.
 */
function embedPlayerLegacyBlockedFetch() {
  const calls = [];
  const token = fakeToken({
    embed_context_host: "contexto.invalid",
    embed_content_path: "/filme/fire-legado",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const page = `<input name="contentid" value="7373"><script>var page_token="${token}";</script>`;
  let legacyAttempts = 0;
  let fallbackCalls = 0;

  const fetchImpl = async (raw, init = {}) => {
    const url = String(raw);
    const parsed = new URL(url);
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body || "" });
    if (parsed.pathname === "/filme/fire-legado") return response(page);
    if (parsed.pathname === "/player/bootstrap") {
      return response(JSON.stringify({ data: { options: [
        { ID: "fire-legado", name: "Fire Player", is_file: false },
      ] } }), 200, { "content-type": "application/json" });
    }
    if (parsed.pathname === "/player/source") {
      return response(JSON.stringify({ data: {
        video_url: "https://superflixapi.pro/player/redirect/fire-legado",
      } }));
    }
    if (parsed.pathname === "/player/redirect/fire-legado") {
      return response("", 302, { location: "https://embedplayer.invalid/video/7373737373737373" });
    }
    if (parsed.hostname === "embedplayer.invalid" && parsed.pathname.startsWith("/video/")) {
      // GET /video/<id> 200 — igual ao HAR: a página em si sempre carrega.
      return response("<html><body>Fire Player fixture</body></html>", 200, {
        "content-type": "text/html",
      });
    }
    // Nenhuma outra rota nativa (player/index.php, master.txt, m3/...) é
    // servida por este fetchImpl de propósito: se profileSource() tentar
    // revalidar a mídia observada pela rede nativa, a fixture não tem para
    // onde ir e o teste falha alto, em vez de mascarar uma regressão.
    throw new Error(`fixture sem rota para ${parsed.pathname}`);
  };

  // extractEmbedPlayer real (extractors.js) lança Error com .status ao ver
  // 403/419 — reproduzido aqui fielmente, sem tocar na rede.
  const extractEmbedPlayer = async () => {
    legacyAttempts += 1;
    const error = new Error("EmbedPlayer HTTP 403");
    error.status = 403;
    throw error;
  };

  // O observador real roda uma sessão Electron; aqui simula o que ela
  // devolveria depois de ver a página continuar e o player carregar o
  // manifesto — sem nenhuma tentativa de contornar challenge nenhum.
  const observeEmbedFallback = async (embedUrl) => {
    fallbackCalls += 1;
    return {
      stream: "https://cdn-observado.invalid/rum-fixture/master.txt",
      referer: embedUrl,
      tipo: "hls",
      manifestBody: MASTER_MANIFEST,
      subtitles: [],
    };
  };

  return {
    fetchImpl,
    extractEmbedPlayer,
    observeEmbedFallback,
    calls,
    get legacyAttempts() { return legacyAttempts; },
    get fallbackCalls() { return fallbackCalls; },
  };
}

function nativeExpiryFetch({ expirations = 1, expireAt = "nmp" } = {}) {
  const calls = [];
  const token = fakeToken({
    embed_context_host: "contexto.invalid",
    embed_content_path: "/filme/nativo-expirado",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const page = `<input name="contentid" value="5252"><script>var page_token="${token}";</script>`;
  let bootstrapCount = 0;

  const fetchImpl = async (raw, init = {}) => {
    const url = String(raw);
    const parsed = new URL(url);
    calls.push({ url, method: init.method || "GET", body: init.body || "", headers: init.headers || {} });
    if (parsed.pathname === "/filme/nativo-expirado") return response(page);
    if (parsed.pathname === "/player/bootstrap") {
      bootstrapCount += 1;
      return response(JSON.stringify({ data: { options: [
        { ID: `native-option-${bootstrapCount}`, name: "Fonte de Canais", is_file: true },
      ] } }), 200, { "content-type": "application/json" });
    }
    if (parsed.pathname === "/player/source") {
      const generation = String(new URLSearchParams(init.body).get("video_id") || "").split("-").at(-1);
      return response(JSON.stringify({ data: {
        video_url: `https://superflixapi.pro/player/native/media/nmp_expiry_${generation}`,
      } }));
    }
    if (parsed.pathname.includes("/player/native/media/nmp_expiry_")) {
      const generation = Number(parsed.pathname.split("_").at(-1));
      if (expireAt === "nmp" && generation <= expirations) {
        return response("Expired native media option", 200, { "content-type": "text/plain" });
      }
      return response(`<script>var SOURCES=[{"src":"https://superflixapi.pro/player/native/media-source/nms_expiry_${generation}"}];</script>`);
    }
    if (parsed.pathname.includes("/player/native/media-source/nms_expiry_")) {
      const generation = Number(parsed.pathname.split("_").at(-1));
      if (expireAt === "nms" && generation <= expirations) {
        return response(JSON.stringify({ error: "Expired native media option" }), 410, {
          "content-type": "application/json",
        });
      }
      return response("", 302, { location: `https://cdn.invalid/native-${generation}.mp4` });
    }
    if (parsed.hostname === "cdn.invalid" && parsed.pathname.endsWith(".mp4")) {
      return response("", 206, { "content-type": "video/mp4", "content-range": "bytes 0-0/100" });
    }
    throw new Error(`fixture sem rota para ${parsed.pathname}`);
  };

  return {
    fetchImpl,
    calls,
    get bootstrapCount() { return bootstrapCount; },
  };
}

async function prepareNativeExpirySession(fixture, previous = null) {
  return prepareSuperflixSession("https://superflixapi.pro/filme/nativo-expirado", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
    ...(previous?.context?.() || {}),
  });
}

test("prepare/bootstrap mantém is_file e só resolve a opção escolhida", async () => {
  const fixture = integrationFetch();
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/exemplo", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
  });

  assert.deepEqual(session.publicOptions.map(({ label, isFile }) => ({ label, isFile })), [
    { label: "Player Principal Dublado", isFile: false },
    { label: "MP4 Alternativo", isFile: true },
  ]);
  assert.equal(fixture.calls.filter((call) => new URL(call.url).pathname === "/player/source").length, 0);

  const second = session.publicOptions[1];
  const media = await session.resolve(second.key);
  assert.equal(media.tipo, "mp4");
  const sourceCalls = fixture.calls.filter((call) => new URL(call.url).pathname === "/player/source");
  assert.equal(sourceCalls.length, 1);
  assert.equal(new URLSearchParams(sourceCalls[0].body).get("video_id"), "native_media_v2:fixture");
});

test("failover é tardio e só consulta a próxima fonte após falha", async () => {
  const fixture = integrationFetch({ firstSourceStatus: 500 });
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/exemplo", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
  });
  const media = await session.resolveWithFailover(session.publicOptions[0].key);
  assert.equal(media.tipo, "mp4");
  assert.equal(media.effectiveOptionKey, session.publicOptions[1].key);
  assert.equal(media.effectiveOptionLabel, "MP4 Alternativo");
  const ids = fixture.calls
    .filter((call) => new URL(call.url).pathname === "/player/source")
    .map((call) => new URLSearchParams(call.body).get("video_id"));
  assert.deepEqual(ids, ["embed-1", "native_media_v2:fixture"]);
});

test("403 do player externo faz failover sem renovar e informa a fonte efetiva", async () => {
  const fixture = integrationFetch({ firstExternal: true, secondLabel: "Fonte de Canais" });
  let externalAttempts = 0;
  let renewals = 0;
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/exemplo", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
    extractEmbedPlayer: async () => {
      externalAttempts += 1;
      const error = new Error("player externo recusou a fonte");
      error.status = 403;
      throw error;
    },
  });

  const media = await retryAuthorizationOnce(
    () => session.resolveWithFailover(session.publicOptions[0].key),
    async () => { renewals += 1; },
  );

  assert.equal(externalAttempts, 1);
  assert.equal(renewals, 0);
  assert.equal(media.tipo, "mp4");
  assert.equal(media.effectiveOptionKey, session.publicOptions[1].key);
  assert.equal(media.effectiveOptionLabel, "Fonte de Canais");
  assert.equal(media.effectiveOptionIsFile, true);
});

test("duas resoluções concorrentes compartilham uma cadeia Fire Player e o mesmo cookie jar", async () => {
  const fixture = concurrentFirePlayerFetch();
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/fire", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
    extractEmbedPlayer: fixture.extractEmbedPlayer,
    onSetCookie: async (cookie) => { fixture.cookieUpdates.push(cookie.name); },
  });
  const optionKey = session.publicOptions[0].key;
  const trace = createResolutionAttemptTrace(optionKey, "attempt-fixture-opaco");
  const inFlight = new Map();
  let reused = 0;
  const operation = () => session.resolve(optionKey, { trace });

  const firstPromise = shareInFlightResolution(inFlight, optionKey, operation);
  await fixture.sourceStarted;
  const secondPromise = shareInFlightResolution(inFlight, optionKey, operation, () => { reused += 1; });
  fixture.releaseSource();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  trace.finish("ok");

  assert.strictEqual(first, second);
  assert.equal(reused, 1);
  assert.equal(fixture.fireCookieUsed, true);
  assert.deepEqual(fixture.cookieUpdates, ["fireplayer_player"]);
  const routeCounts = fixture.calls.reduce((counts, call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/player/source") counts.source += 1;
    else if (pathname.startsWith("/player/redirect")) counts.redirect += 1;
    else if (pathname.startsWith("/video/")) counts.video += 1;
    else if (pathname === "/player/index.php") counts.index += 1;
    return counts;
  }, { source: 0, redirect: 0, video: 0, index: 0 });
  assert.deepEqual(routeCounts, { source: 1, redirect: 1, video: 1, index: 1 });
  assert.deepEqual(trace.snapshot().counts, routeCounts);
  assert.equal(trace.snapshot().cookieJarUpdated, true);
});

// Regressão do caso real: /video 200 → rota legada 403 → página continua →
// mídia HLS observada → resolução termina com sucesso, mesmo com um único
// candidato (sem outro servidor para o failover tentar).
test("403 do POST legado do embedplayer não encerra a resolução quando a observação do navegador encontra HLS", async () => {
  const fixture = embedPlayerLegacyBlockedFetch();
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/fire-legado", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
    extractEmbedPlayer: fixture.extractEmbedPlayer,
    observeEmbedFallback: fixture.observeEmbedFallback,
  });

  const media = await session.resolve(session.publicOptions[0].key);

  assert.equal(fixture.legacyAttempts, 1, "a API legada continua sendo tentada primeiro, como compatibilidade");
  assert.equal(fixture.fallbackCalls, 1, "a observação só entra em jogo depois do 403");
  assert.equal(media.tipo, "hls");
  assert.equal(media.stream, "https://cdn-observado.invalid/rum-fixture/master.txt");
  assert.equal(media.isMaster, true, "o manifesto observado precisa ser interpretado, não só aceito no nome");
  assert.equal(media.qualities.length, 2);
  assert.equal(media.audioTracks.length, 2);

  // A prova central: nada além do que a fixture programou foi tocado pela
  // rede nativa. Em especial, o manifesto observado NUNCA é refeito por ela —
  // é exatamente o host que o challenge protege, e um refetch nu reproduziria
  // o mesmo bloqueio que motivou a observação em primeiro lugar.
  const hosts = fixture.calls.map((call) => new URL(call.url).hostname);
  assert.ok(!hosts.includes("cdn-observado.invalid"), "o manifesto observado não pode ser buscado de novo pela rede nativa");
});

test("sem observador injetado, o 403 do embedplayer continua um erro normal de candidata", async () => {
  // O flag do fallback é totalmente opcional: quem não o injeta (testes,
  // outras variantes do embedplayer que já funcionam) mantém o comportamento
  // de antes desta mudança — o erro sobe e o failover decide o resto.
  const fixture = embedPlayerLegacyBlockedFetch();
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/fire-legado", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
    extractEmbedPlayer: fixture.extractEmbedPlayer,
    // observeEmbedFallback ausente de propósito.
  });

  await assert.rejects(
    () => session.resolve(session.publicOptions[0].key),
    /EmbedPlayer HTTP 403/,
  );
  assert.equal(fixture.legacyAttempts, 1);
  assert.equal(fixture.fallbackCalls, 0);
});

test("opção nmp expirada refaz bootstrap, remapeia a opção e resolve uma única vez", async () => {
  const fixture = nativeExpiryFetch({ expirations: 1, expireAt: "nmp" });
  let session = await prepareNativeExpirySession(fixture);
  const originalKey = session.publicOptions[0].key;
  const originalIdentity = session.optionIdentity(originalKey);
  let renewals = 0;

  const resolveSelected = async () => {
    const currentKey = session.findOptionKey(originalIdentity);
    assert.ok(currentKey, "a opção original deve ser remapeada após o bootstrap");
    return session.resolve(currentKey);
  };

  const media = await retryNativeOptionOnce(resolveSelected, async () => {
    renewals += 1;
    assert.equal(await session.revalidate(), true);
    const previous = session;
    session = await prepareNativeExpirySession(fixture, previous);
  });

  assert.equal(renewals, 1);
  assert.equal(fixture.bootstrapCount, 2);
  assert.notEqual(media.effectiveOptionKey, originalKey);
  assert.equal(media.effectiveOptionLabel, "Fonte de Canais");
  assert.equal(media.tipo, "mp4");
  const sourceIds = fixture.calls
    .filter((call) => new URL(call.url).pathname === "/player/source")
    .map((call) => new URLSearchParams(call.body).get("video_id"));
  assert.deepEqual(sourceIds, ["native-option-1", "native-option-2"]);
  const nativeRoutes = fixture.calls
    .map((call) => new URL(call.url).pathname)
    .filter((pathname) => pathname.includes("/player/native/media/nmp_expiry_"));
  assert.deepEqual(nativeRoutes, [
    "/player/native/media/nmp_expiry_1",
    "/player/native/media/nmp_expiry_2",
  ]);
});

test("segunda expiração nms encerra a renovação sem loop", async () => {
  const fixture = nativeExpiryFetch({ expirations: 2, expireAt: "nms" });
  let session = await prepareNativeExpirySession(fixture);
  const originalIdentity = session.optionIdentity(session.publicOptions[0].key);
  let renewals = 0;

  const resolveSelected = () => session.resolve(session.findOptionKey(originalIdentity));
  await assert.rejects(
    retryNativeOptionOnce(resolveSelected, async () => {
      renewals += 1;
      const previous = session;
      session = await prepareNativeExpirySession(fixture, previous);
    }),
    isNativeOptionExpiredError,
  );

  assert.equal(renewals, 1);
  assert.equal(fixture.bootstrapCount, 2);
  assert.equal(
    fixture.calls.filter((call) => new URL(call.url).pathname === "/player/source").length,
    2,
  );
});

test("403/419 faz uma única renovação e a segunda recusa não cria loop", async () => {
  let operations = 0;
  let renewals = 0;
  const ok = await retryAuthorizationOnce(async () => {
    operations += 1;
    if (operations === 1) throw new SuperflixAuthorizationError("expirou", { status: 419 });
    return "ok";
  }, async () => { renewals += 1; });
  assert.equal(ok, "ok");
  assert.equal(renewals, 1);

  operations = 0;
  renewals = 0;
  await assert.rejects(
    retryAuthorizationOnce(async () => {
      operations += 1;
      throw new SuperflixAuthorizationError("continua recusado", { status: 403 });
    }, async () => { renewals += 1; }),
    (error) => error?.code === "SUPERFLIX_AUTH_REQUIRED",
  );
  assert.equal(operations, 2);
  assert.equal(renewals, 1);
});

test("sessão expirada pede renovação antes de chamar player/source", async () => {
  const fixture = integrationFetch();
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/exemplo", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
  });
  session.expiresAt = Date.now() - 1;
  await assert.rejects(session.resolve(session.publicOptions[0].key),
    (error) => error?.code === "SUPERFLIX_AUTH_REQUIRED");
  assert.equal(fixture.calls.filter((call) => new URL(call.url).pathname === "/player/source").length, 0);
});

test("403 de player/source é classificado como autorização, não como parser/rede", async () => {
  const fixture = integrationFetch({ firstSourceStatus: 403 });
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/exemplo", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
  });
  await assert.rejects(session.resolve(session.publicOptions[0].key),
    (error) => error?.code === "SUPERFLIX_AUTH_REQUIRED" && error?.status === 403);
});

test("cache é revalidado por GET autenticado com o mesmo UA", async () => {
  const fixture = integrationFetch();
  const session = await prepareSuperflixSession("https://superflixapi.pro/filme/exemplo", {
    fetchImpl: fixture.fetchImpl,
    ua: "UA-legitimo-fixture",
    cookies: [{ name: "sessao", value: "fixture", domain: ".superflixapi.pro", path: "/", secure: true }],
  });
  assert.equal(await session.revalidate(), true);
  const pageCalls = fixture.calls.filter((call) => new URL(call.url).pathname === "/filme/exemplo");
  assert.equal(pageCalls.length, 2);
  assert.equal(pageCalls[1].headers["User-Agent"], "UA-legitimo-fixture");
  assert.equal(pageCalls[1].headers.Cookie, "sessao=fixture");
});

test("rotas nmp/nms só são aceitas quando vieram como URL do servidor", () => {
  assert.equal(isServerProvidedNativeRoute("https://sf.invalid/player/native/media/nmp_fixture"), true);
  assert.equal(isServerProvidedNativeRoute("https://sf.invalid/player/native/media-source/nms_fixture", "nms"), true);
  assert.equal(isServerProvidedNativeRoute("https://sf.invalid/player/source", "nms"), false);
  assert.equal(isServerProvidedNativeRoute("nmp_construido_localmente"), false);
});

test("cookie jar respeita domínio, path, secure, expiry e entrega Set-Cookie ao sink", async () => {
  const jar = createCookieJar();
  const synced = [];
  jar.setCookieSink(async (cookie) => { synced.push(cookie); });
  const headers = new Headers({
    "set-cookie": "sessao=valor-fixture; Domain=.superflixapi.pro; Path=/player; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
  });
  await jar.absorb("https://superflixapi.pro/player/bootstrap", headers);
  assert.equal(jar.header("https://superflixapi.pro/player/source"), "sessao=valor-fixture");
  assert.equal(jar.header("https://superflixapi.pro/filme/exemplo"), "");
  assert.equal(jar.header("http://superflixapi.pro/player/source"), "");
  assert.equal(synced.length, 1);
  assert.deepEqual(
    { domain: synced[0].domain, path: synced[0].path, secure: synced[0].secure, httpOnly: synced[0].httpOnly, sameSite: synced[0].sameSite },
    { domain: "superflixapi.pro", path: "/player", secure: true, httpOnly: true, sameSite: "lax" },
  );
});

test("nome útil seguro é preservado e formato sensível continua genérico", () => {
  assert.equal(publicOptionLabel(opcao("1", "Player Principal Dublado", false), 0), "Player Principal Dublado");
  assert.equal(publicOptionLabel(opcao("2", "Fonte de Canais", true), 1), "Fonte de Canais");
  assert.equal(publicOptionLabel(opcao("2", "https://provider.invalid/?token=fixture", false), 1), "Servidor 2");
});
