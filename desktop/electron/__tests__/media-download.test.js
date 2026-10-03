"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const binPath = require.resolve("../ffmpeg-bin");
const originalBin = require.cache[binPath];
const comandos = [];
let falhar = false;
require.cache[binPath] = { id: binPath, filename: binPath, loaded: true, exports: {
  temFfmpeg: () => true,
  suportaOpcao: () => true,
  rodarFfmpeg: async (args) => {
    comandos.push(args);
    if (falhar) throw new Error("https://private.test/movie.mp4?token=SEGREDO ffmpeg stderr");
    await fs.promises.writeFile(args.at(-1), Buffer.alloc(2048));
  },
} };
const { baixarMidia, verificarMidia, _test } = require("../media-download");
if (originalBin) require.cache[binPath] = originalBin;
else delete require.cache[binPath];

test("MP4 direto segue candidato a recorte e FFmpeg não recebe opções HLS", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "obaflix-test-"));
  try {
    const r = await baixarMidia({ stream: "https://private.test/film.mp4?token=x", referer: "https://private.test/embed", tipo: "mp4", titulo: "teste", modo: "trecho", inicioSeg: 60, fimSeg: 70, destinoDir: dir });
    assert.equal(r.viaFfmpeg, true);
    const args = comandos.at(-1);
    assert.ok(!args.includes("-allowed_extensions"));
    assert.ok(!args.includes("-extension_picky"));
    assert.equal(args[args.indexOf("-ss") + 1], "00:01:00.000");
    assert.equal(args[args.indexOf("-to") + 1], "00:01:10.000");
    assert.ok(args.includes("copy"));
    await fs.promises.unlink(r.caminho);
  } finally { await fs.promises.rmdir(dir); }
});
test("HLS preserva opções específicas e capacidade MP4 exige tentativa real de mux/seek", async () => {
  assert.ok(_test.opcoesEntrada("hls").includes("-allowed_extensions"));
  assert.deepEqual(_test.opcoesEntrada("mp4"), []);
  assert.equal(await verificarMidia({ stream: "https://private.test/media", tipo: "mp4", modo: "trecho", posicao: 120 }), true);
  const args = comandos.at(-1);
  assert.equal(args[args.indexOf("-ss") + 1], "00:02:00.000");
  assert.ok(args.at(-1).endsWith("check.mp4"));
  assert.equal(fs.existsSync(args.at(-1)), false, "teste temporário removido");
  falhar = true;
  await assert.rejects(verificarMidia({ stream: "https://private.test/media", tipo: "mp4", modo: "trecho" }));
  assert.equal(fs.existsSync(path.dirname(comandos.at(-1).at(-1))), false);
  falhar = false;
});
test("IPC não transporta erro bruto e UI não confia em erro do EXE anterior", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const trecho = main.slice(main.indexOf('ipcMain.handle("download-media"'), main.indexOf('ipcMain.handle("cancel-download"'));
  assert.ok(!trecho.includes("mensagem.slice"));
  assert.ok(trecho.includes('t.fail(new Error("download_failed"))'));
  assert.ok(trecho.includes('return { error: "Não foi possível concluir o download. Tente novamente." }'));
  const check = main.slice(main.indexOf('ipcMain.handle("check-download-media"'), main.indexOf('ipcMain.handle("download-media"'));
  assert.ok(check.includes("assertPublicHttpsStream(stream)"));
  assert.ok(check.includes("isTrustedIpc(event)"));
  assert.ok(!check.includes("erro.message"));
});
test("handler real mapeia stderr/URL/token/caminho antes do IPC e dos logs", async () => {
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const trecho = main.slice(main.indexOf('ipcMain.handle("download-media"'), main.indexOf('ipcMain.handle("cancel-download"'));
  let handler;
  const logs = [];
  vm.runInNewContext(`let downloadEmAndamento = null; ${trecho}`, {
    ipcMain: { handle: (_nome, h) => { handler = h; } },
    isTrustedIpc: () => true,
    assertPublicHttpsStream: async () => {},
    baixarMidia: async () => { throw new Error('FFmpeg stderr https://private.test/path.mp4?unexpectedQuery=SEGREDO Referer: private.test C:\\media\\file.mp4'); },
    app: { getPath: () => "downloads" },
    log: { info: (...args) => logs.push(args), timer: () => ({ done() {}, fail: e => logs.push(e.message) }) },
    AbortController,
  });
  const result = await handler({}, { stream: "https://private.test/path.mp4?unexpectedQuery=SEGREDO", modo: "trecho" });
  assert.equal(result.error, "Não foi possível concluir o download. Tente novamente.");
  assert.ok(!JSON.stringify([result, logs]).includes("SEGREDO"));
  assert.ok(!JSON.stringify([result, logs]).includes("private.test"));
  assert.deepEqual(logs, ["download_failed"]);
});
