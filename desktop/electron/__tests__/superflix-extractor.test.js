"use strict";

// Testes de parser do extrator SuperFlix. Usam apenas fixtures inventadas: nenhum
// token, cookie ou assinatura real aparece aqui, e nenhuma requisição de rede é
// feita. Rodar com: npm run test:extractors
//
// A lógica coberta aqui é espelhada em Kotlin (SuperflixExtractor.kt e
// HlsManifest.kt); ao mudar uma das implementações, ajuste a outra e este arquivo.

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../superflix-extractor");
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
