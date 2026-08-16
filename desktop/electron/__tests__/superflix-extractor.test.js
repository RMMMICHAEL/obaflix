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
  decodeTokenPayload,
  secureTransportUrl,
  profileScore,
  tokenExpiry,
} = _test;

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

  const notaMaster = profileScore("hls", master, true, "123");
  const notaSimples = profileScore("hls", simples, false, "123");
  const notaMp4 = profileScore("mp4", null, false, "native_media:9");

  assert.ok(notaMaster > notaSimples, `${notaMaster} > ${notaSimples}`);
  assert.ok(notaSimples > notaMp4, `${notaSimples} > ${notaMp4}`);
  // Um MP4 com legenda ainda perde para um master completo — o master traz
  // qualidades e áudio, que não dá para reconstruir a partir de um MP4.
  assert.ok(notaMaster > profileScore("mp4", null, true, "123"));
});

test("empate entre fontes iguais favorece o servidor alternativo", () => {
  assert.ok(profileScore("hls", null, false, "123") > profileScore("hls", null, false, "native_media:123"));
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
