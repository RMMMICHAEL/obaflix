"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PRESETS, publicAddress, publicTarget, parseManifest, supports, streamUrl, parseStream,
  createAddonService, registerAddonIpc } = require("../addons");

const rawManifest = { id: "test", name: "Addon de teste", version: "1", types: ["movie", "series"],
  resources: ["stream"] };
const sessao = "a".repeat(22);
const target = { type: "movie", id: "tt1254207" };

test("manifests string e objeto respeitam tipos e prefixos herdados", () => {
  const manifest = parseManifest(rawManifest);
  assert.ok(supports(manifest, "movie", target.id));
  assert.equal(supports(manifest, "anime", target.id), false);
  const object = parseManifest({ ...rawManifest, idPrefixes: ["tt"],
    resources: [{ name: "stream", types: ["series"] }] });
  assert.ok(supports(object, "series", "tt123:1:1"));
  assert.equal(supports(object, "movie", "tt123"), false);
  assert.equal(supports(object, "series", "kitsu:1"), false);
  assert.throws(() => parseManifest({ ...rawManifest, name: null }));
  assert.throws(() => parseManifest({ ...rawManifest, behaviorHints: { configurationRequired: true } }));
});

test("URL de recurso mantém configuração e codifica coordenadas sem permitir outro caminho", () => {
  assert.equal(streamUrl("https://addon.example/config/manifest.json?token=demo", "series", "tt123:2:3"),
    "https://addon.example/config/stream/series/tt123%3A2%3A3.json?token=demo");
  for (const id of ["../admin", "tt1/../../secret", "tt1?x=1"]) assert.throws(() => streamUrl(PRESETS[0].url, "movie", id));
  assert.throws(() => streamUrl(PRESETS[0].url, "other", "tt1"));
});

test("HTTPS e DNS público: bloqueia IPs locais, DNS misto, credenciais e portas", async () => {
  for (const ip of ["0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "198.18.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(publicAddress(ip), false, ip);
  }
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  for (const url of ["http://example.com", "file:///tmp/file", "https://u:p@example.com", "https://example.com:8443"]) {
    await assert.rejects(publicTarget(url));
  }
  await assert.rejects(publicTarget("https://example.com", async () => [
    { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
  ]));
  const result = await publicTarget("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(result.address.address, "8.8.8.8");
});

test("fontes diretas têm prioridade sobre hash; P2P e externas têm orientação", () => {
  assert.equal(parseStream({ url: "https://cdn.example/master.m3u8?q=1", infoHash: "a".repeat(40) }).tipo, "hls");
  assert.equal(parseStream({ url: "https://cdn.example/video.mp4" }).tipo, "mp4");
  assert.match(parseStream({ infoHash: "a".repeat(40) }).reason, /P2P/);
  assert.match(parseStream({ url: "magnet:?xt=urn:btih:abc" }).reason, /P2P/);
  assert.match(parseStream({ externalUrl: "https://example.com" }).reason, /externo/);
  assert.ok(parseStream({ url: "https://cdn.example/video", behaviorHints: {
    proxyHeaders: { request: { Authorization: "secret" } },
  } }).reason);
  assert.equal(parseStream({ url: "https://cdn.example/video", behaviorHints: {
    proxyHeaders: { request: { Referer: "https://origin.example/" } },
  } }).referer, "https://origin.example/");
});

function fixture(overrides = {}) {
  let authorized = 0, fetched = 0, saved = [], time = 1000;
  let allowed = true;
  const service = createAddonService({
    readSettings: () => ["fenixflix"],
    writeSettings: value => { saved = value; },
    authorize: async () => { authorized++; if (!allowed) throw new Error("denied"); return target; },
    fetchJson: async url => { fetched++; return url.includes("manifest.json") ? rawManifest : {
      streams: [{ name: "Teste MP4", url: "https://cdn.example/video.mp4" }, { infoHash: "a".repeat(40) }],
    }; },
    validateMedia: async url => { assert.equal(url, "https://cdn.example/video.mp4"); },
    now: () => time,
    ...overrides,
  });
  return { service, counts: () => ({ authorized, fetched, saved }), deny: () => { allowed = false; },
    expire: () => { time += 61_000; } };
}

test("busca compartilha chamadas em andamento, mantém ordem e não entrega URL antes da seleção", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    f.service({}, { action: "streams", key: "fenixflix", sessao })));
  // Só uma busca de manifest e de fontes mesmo com consumidores simultâneos.
  assert.equal(f.counts().fetched, 2);
  assert.equal(f.counts().authorized, 4);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].sources[0].available, true);
  assert.equal(results[0].sources[1].available, false);
  assert.equal(JSON.stringify(results[0]).includes("cdn.example"), false);
  const resolved = await f.service({}, { action: "resolve", sessao, sourceId: results[0].sources[0].id });
  assert.equal(resolved.stream, "https://cdn.example/video.mp4");
});

test("cache nunca substitui autorização e id opaco não atravessa sessão", async () => {
  const f = fixture();
  const first = await f.service({}, { action: "streams", key: "fenixflix", sessao });
  await assert.rejects(f.service({}, { action: "resolve", sessao: "b".repeat(22), sourceId: first.sources[0].id }));
  f.deny();
  await assert.rejects(f.service({}, { action: "streams", key: "fenixflix", sessao }));
  await assert.rejects(f.service({}, { action: "resolve", sessao, sourceId: first.sources[0].id }));
  assert.equal(f.counts().fetched, 2);
});

test("fonte vencida ou addon desativado não resolve e nunca instala addon desconhecido", async () => {
  const f = fixture();
  const first = await f.service({}, { action: "streams", key: "fenixflix", sessao });
  f.expire();
  await assert.rejects(f.service({}, { action: "resolve", sessao, sourceId: first.sources[0].id }));
  await f.service({}, { action: "disable", key: "fenixflix" });
  assert.deepEqual(f.counts().saved, []);
  await assert.rejects(f.service({}, { action: "streams", key: "fenixflix", sessao }));
  await assert.rejects(f.service({}, { action: "enable", key: "http://127.0.0.1" }));
  await assert.rejects(f.service({}, { action: "resolve", sessao: "invalid", sourceId: "x" }));
});

test("lista vazia difere de erro de provedor e erro não envenena cache", async () => {
  let calls = 0;
  const f = fixture({ fetchJson: async url => {
    if (url.includes("manifest.json")) return rawManifest;
    if (++calls === 1) throw new Error("offline");
    return { streams: [] };
  } });
  await assert.rejects(f.service({}, { action: "streams", key: "fenixflix", sessao }));
  const result = await f.service({}, { action: "streams", key: "fenixflix", sessao });
  assert.deepEqual(result.sources, []);
  assert.equal(calls, 2);
});

test("IPC falso de iframe/outra janela não lê config, consulta rede ou resolve", async () => {
  let callback, called = 0, resolved = 0;
  registerAddonIpc({
    ipcMain: { handle: (channel, cb) => { assert.equal(channel, "desktop-addons"); callback = cb; } },
    isTrusted: event => event.trusted === true,
    service: async () => { called++; return { stream: "https://cdn.example/a.mp4" }; },
    onResolved: async () => { resolved++; },
  });
  assert.deepEqual(await callback({ trusted: false }, { action: "resolve" }), { error: "Acesso negado" });
  assert.equal(called, 0);
  assert.equal(resolved, 0);
  await callback({ trusted: true }, { action: "resolve" });
  assert.equal(called, 1); assert.equal(resolved, 1);
});
