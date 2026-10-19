import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

test("JW Electron usa mount imperativo dedicado e só confirma reprodução após frame apresentado", () => {
  const player = readFileSync(join(process.cwd(), "src/components/player/CustomPlayer.tsx"), "utf8");
  const inicio = player.indexOf('player.on("firstFrame"');
  const fim = player.indexOf('player.on("play"', inicio);
  const handler = player.slice(inicio, fim);
  assert.ok(inicio >= 0 && fim > inicio);
  assert.match(player, /jwMountRef = useRef<HTMLDivElement \| null>/);
  assert.match(player, /mountDoEfeito = document\.createElement\("div"\)/);
  assert.match(player, /host\.appendChild\(mountDoEfeito\)/);
  assert.match(player, /jw\(container!\.id\)\.setup/);
  assert.match(player, /if \(mountDestaInstancia\) mount!\.remove\(\)/);
  assert.doesNotMatch(player, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(player, /setup:clear-dom/);
  assert.match(handler, /"JW_FIRST_FRAME"/);
  assert.match(handler, /requestVideoFrameCallback/);
  assert.match(handler, /mount_connected=/);
  assert.match(handler, /host_contains_mount=/);
  assert.match(handler, /video_element=/);
  assert.match(handler, /videoWidth/);
  assert.match(handler, /getVideoPlaybackQuality/);
  const compositor = handler.slice(handler.indexOf("const confirmarFrameVisivel"));
  assert.ok(compositor.indexOf("compositor_frame=presented") < compositor.indexOf("initialLoadRef.current = false"));
  assert.doesNotMatch(handler, /OK_PLAYBACK|url:\s*directStreamRef/);
});

test("primeiro frame consulta o container substituído pelo JW e preserva mount original para cleanup", () => {
  const fonte = readFileSync(join(process.cwd(), "src/components/player/CustomPlayer.tsx"), "utf8");
  const linha = fonte.split("\n").find(l => l.includes('const mount = ambiente === "electron"'));
  assert.ok(linha);
  const expressao = linha.trim().slice("const mount = ".length, -1);
  const original = { isConnected: false };
  const atual = { isConnected: true, video: { videoWidth: 640 } };
  const contexto = { ambiente: "electron", player: { getContainer: () => atual }, mountDoEfeito: original, container: original };
  assert.equal(runInNewContext(expressao, contexto), atual);
  assert.equal(contexto.mountDoEfeito, original);
  assert.equal(runInNewContext(expressao, { ...contexto, ambiente: "web" }), original);
  assert.equal(runInNewContext(expressao, { ...contexto, player: {} }), original);
});
