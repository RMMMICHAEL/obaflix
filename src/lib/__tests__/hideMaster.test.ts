// Testes da validação da master do Hide — lado Website. Nenhuma requisição de
// rede real: global.fetch é substituído. Rodar com: npm run test:web
//
// A mesma classificação existe em desktop/electron/__tests__/hide-extractor.test.js
// (Electron) e é espelhada em Kotlin. Ao mudar uma, ajuste as outras — ver CLAUDE.md.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ehHostHide,
  ordemEspelhosHide,
  validarMasterHide,
  HIDE_MANIFEST_INLINE_MAX,
} from "../hideMaster";

const MASTER = "https://cdn-teste.invalid/hls2/01/00000/abc_,l,n,.urlset/master.m3u8?t=fake";
const PAGINA = "https://hidehide.shop/v/abc";

/** Substitui global.fetch por uma resposta fixa, guardando os headers enviados. */
function comCdn(resposta: Response | (() => never)) {
  const original = global.fetch;
  const chamadas: { url: string; headers: Record<string, string> }[] = [];
  global.fetch = (async (url: any, init: any = {}) => {
    chamadas.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    if (typeof resposta === "function") resposta();
    return resposta;
  }) as typeof fetch;
  return { chamadas, restaurar: () => { global.fetch = original; } };
}

const m3u8 = (corpo: string, status = 200) =>
  new Response(corpo, { status, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });

// ── Reconhecimento de host ──────────────────────────────────────────────────

test("reconhece os espelhos do Hide pelo nome exato", () => {
  assert.equal(ehHostHide("hidehide.shop"), true);
  assert.equal(ehHostHide("vidhidehub.com"), true);
  assert.equal(ehHostHide("playhide.shop"), true);
  assert.equal(ehHostHide("cdn.hidehide.shop"), true);
});

test("não aceita host parecido só porque contém 'hide'", () => {
  assert.equal(ehHostHide("hidehide.shop.evil.com"), false);
  assert.equal(ehHostHide("nao-hidehide.shop"), false);
  assert.equal(ehHostHide("hide.com"), false);
});

test("o host recebido vem primeiro na ordem dos espelhos", () => {
  assert.deepEqual(ordemEspelhosHide("vidhidehub.com")[0], "vidhidehub.com");
  assert.deepEqual(ordemEspelhosHide("playhide.shop")[0], "playhide.shop");
  // Host desconhecido cai na ordem padrão, com o espelho vivo na frente.
  assert.deepEqual(ordemEspelhosHide("outro.com")[0], "hidehide.shop");
  assert.equal(ordemEspelhosHide("vidhidehub.com").length, 3);
});

// ── Classificação da master ─────────────────────────────────────────────────

test("404 é arquivo removido", async () => {
  const cdn = comCdn(m3u8("", 404));
  try {
    const v = await validarMasterHide(MASTER, PAGINA);
    assert.equal(v.removido, true);
    assert.equal(v.motivo, "removido");
  } finally { cdn.restaurar(); }
});

test("410 é arquivo removido", async () => {
  const cdn = comCdn(m3u8("", 410));
  try {
    assert.equal((await validarMasterHide(MASTER, PAGINA)).removido, true);
  } finally { cdn.restaurar(); }
});

test("403 NÃO é arquivo removido: pode ser token ou autorização", async () => {
  const cdn = comCdn(m3u8("", 403));
  try {
    const v = await validarMasterHide(MASTER, PAGINA);
    assert.equal(v.removido, false);
    assert.equal(v.motivo, "inconclusivo");
  } finally { cdn.restaurar(); }
});

test("500 não é arquivo removido", async () => {
  const cdn = comCdn(m3u8("", 500));
  try {
    assert.equal((await validarMasterHide(MASTER, PAGINA)).removido, false);
  } finally { cdn.restaurar(); }
});

test("timeout não prova que o arquivo sumiu", async () => {
  const cdn = comCdn(() => { throw new DOMException("timed out", "TimeoutError"); });
  try {
    const v = await validarMasterHide(MASTER, PAGINA);
    assert.equal(v.removido, false);
    assert.equal(v.motivo, "inconclusivo");
  } finally { cdn.restaurar(); }
});

test("erro de rede não prova que o arquivo sumiu", async () => {
  const cdn = comCdn(() => { throw new TypeError("fetch failed"); });
  try {
    assert.equal((await validarMasterHide(MASTER, PAGINA)).removido, false);
  } finally { cdn.restaurar(); }
});

// ── Reaproveitamento do corpo ───────────────────────────────────────────────

test("master pequena volta inline, para o proxy não buscar de novo", async () => {
  const corpo = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nindex-v1-a1.m3u8\n";
  const cdn = comCdn(m3u8(corpo));
  try {
    const v = await validarMasterHide(MASTER, PAGINA);
    assert.equal(v.removido, false);
    assert.equal(v.motivo, "ok");
    assert.equal(v.manifest, corpo);
  } finally { cdn.restaurar(); }
});

test("manifesto grande não vai inline: token na URL tem limite", async () => {
  const corpo = "#EXTM3U\n" + "#EXTINF:5,\nseg.ts\n".repeat(2000);
  assert.ok(corpo.length > HIDE_MANIFEST_INLINE_MAX);
  const cdn = comCdn(m3u8(corpo));
  try {
    const v = await validarMasterHide(MASTER, PAGINA);
    assert.equal(v.removido, false);
    assert.equal(v.manifest, undefined);
  } finally { cdn.restaurar(); }
});

test("corpo 200 que não é m3u8 não vai inline", async () => {
  const cdn = comCdn(new Response("<html>bloqueado</html>", { status: 200 }));
  try {
    assert.equal((await validarMasterHide(MASTER, PAGINA)).manifest, undefined);
  } finally { cdn.restaurar(); }
});

test("a checagem manda Referer e Origin do espelho que respondeu", async () => {
  const cdn = comCdn(m3u8("#EXTM3U\n"));
  try {
    await validarMasterHide(MASTER, PAGINA);
    assert.equal(cdn.chamadas[0].headers.Referer, PAGINA);
    assert.equal(cdn.chamadas[0].headers.Origin, "https://hidehide.shop");
  } finally { cdn.restaurar(); }
});
