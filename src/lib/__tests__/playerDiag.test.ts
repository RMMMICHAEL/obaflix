import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("JW firstFrame não é registrado como reprodução confirmada e coleta frame visível sem URLs", () => {
  const player = readFileSync(join(process.cwd(), "src/components/player/CustomPlayer.tsx"), "utf8");
  const inicio = player.indexOf('player.on("firstFrame"');
  const fim = player.indexOf('player.on("play"', inicio);
  const handler = player.slice(inicio, fim);
  assert.ok(inicio >= 0 && fim > inicio);
  assert.match(handler, /"JW_FIRST_FRAME"/);
  assert.match(handler, /requestVideoFrameCallback/);
  assert.match(handler, /videoWidth/);
  assert.match(handler, /getVideoPlaybackQuality/);
  assert.doesNotMatch(handler, /OK_PLAYBACK|url:\s*directStreamRef/);
});
