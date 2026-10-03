import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encontrarMidiaCompativel, controlarMidia } from "../prepararDownload";

test("preparação testa atual e percorre fontes em ordem após resolução/fonte incompatível", async () => {
  const visitadas: string[] = [];
  const midia = await encontrarMidiaCompativel("atual", ["falha", "iframe", "mp4", "posterior"], {
    ativa: () => true,
    verificar: async m => { visitadas.push(`verificar:${m}`); return m === "mp4"; },
    resolver: async f => { visitadas.push(`resolver:${f}`); if (f === "falha") throw new Error("https://private.test/?token=x"); return f === "iframe" ? null : f; },
  });
  assert.equal(midia, "mp4");
  assert.deepEqual(visitadas, ["verificar:atual", "resolver:falha", "resolver:iframe", "resolver:mp4", "verificar:mp4"]);
});
test("fonte atual válida não troca; falta de fonte retorna só null", async () => {
  assert.equal(await encontrarMidiaCompativel("atual", ["outra"], {
    ativa: () => true, verificar: async () => true, resolver: async () => { throw new Error("não deve resolver"); },
  }), "atual");
  assert.equal(await encontrarMidiaCompativel(null, ["uma", "duas"], {
    ativa: () => true, verificar: async () => false, resolver: async f => f,
  }), null);
});
test("resposta tardia após navegação/conta/sessão/troca não publica mídia", async () => {
  let ativa = true;
  let resolver!: (m: string) => void;
  const busca = encontrarMidiaCompativel<string, string>(null, ["uma", "duas"], {
    ativa: () => ativa, verificar: async () => true,
    resolver: () => new Promise<string>(r => { resolver = r; }),
  });
  await new Promise(r => setImmediate(r));
  ativa = false;
  resolver("midia");
  assert.equal(await busca, null);
});
test("pause/play cancelado durante navegação não causa rejeição não tratada", async () => {
  controlarMidia(() => { throw new DOMException("player removido", "AbortError"); });
  controlarMidia(() => Promise.reject(new DOMException("play interrompido", "AbortError")));
  await new Promise(r => setImmediate(r));
});
test("editor/fallback não autoriza reprodução ou download e mantém posição na mesma sessão", () => {
  const player = readFileSync("src/components/player/CustomPlayer.tsx", "utf8");
  const preparo = player.slice(player.indexOf("const prepararDownload ="), player.indexOf("desktopBridge?.onDownloadProgress"));
  assert.ok(!preparo.includes("await liberarAcao"));
  assert.ok(!preparo.includes("await abrirSessao"));
  assert.ok(preparo.includes("retomarEmRef.current = progressoRef.current"));
  assert.ok(preparo.includes("instancia === instanciaPlaybackRef.current"));
  assert.ok(preparo.includes("sessao === sessaoFontesRef.current"));
  assert.ok(preparo.includes("checkDownloadMedia"));
  assert.ok(player.includes('if (!await prepararDownload("trecho")'));
  assert.ok(player.includes('modo === "completo" && !await prepararDownload(modo)'));
  assert.ok(!player.includes('erro: r?.error'));
  assert.ok(player.includes('Preparando editor…'));
});
