import test from "node:test";
import assert from "node:assert/strict";
import { autorizarAddon, type AlvoDeAddon } from "../playerAddons";

const alvo: AlvoDeAddon = { finalidade: "reproducao", conteudoTipo: "filme", imdbId: "tt1254207",
  tmdbId: "123", temporada: null, numeroEp: null };
const permitido = async () => ({ situacao: "permitido", via: "direito" } as const);
const semConsulta = async () => { throw new Error("Não deveria consultar TMDB"); };

test("usa IMDb do catálogo sem nova chamada; séries mantêm coordenadas canônicas", async () => {
  assert.deepEqual(await autorizarAddon(alvo, permitido, semConsulta), { type: "movie", id: "tt1254207" });
  assert.deepEqual(await autorizarAddon({ ...alvo, conteudoTipo: "serie", temporada: 2, numeroEp: 3 }, permitido, semConsulta),
    { type: "series", id: "tt1254207:2:3" });
});
test("resolve TMDB só sob demanda quando IMDb está ausente", async () => {
  let calls = 0;
  const resolved = await autorizarAddon({ ...alvo, imdbId: null }, permitido, async (id, type) => {
    calls++; assert.equal(id, "123"); assert.equal(type, "filme"); return "tt1254207";
  });
  assert.equal(calls, 1); assert.equal(resolved.id, "tt1254207");
});
test("recusa sessão legada, finalidade diferente e direito ausente ou indeterminado", async () => {
  await assert.rejects(autorizarAddon(null, permitido, semConsulta));
  for (const finalidade of ["download", "transmissao"] as const) {
    await assert.rejects(autorizarAddon({ ...alvo, finalidade }, permitido, semConsulta));
  }
  for (const situacao of ["negado", "indeterminado"] as const) {
    await assert.rejects(autorizarAddon(alvo, async () => ({ situacao }), semConsulta));
  }
});
test("não inventa IMDb nem aceita coordenadas malformadas", async () => {
  for (const imdbId of [null, "../admin", "tt1:2:3", "123"]) {
    await assert.rejects(autorizarAddon({ ...alvo, imdbId, tmdbId: null }, permitido, semConsulta));
  }
  for (const numeroEp of [0, -1, 1.5, 1001]) {
    await assert.rejects(autorizarAddon({ ...alvo, conteudoTipo: "serie", temporada: 1, numeroEp }, permitido, semConsulta));
  }
});

test("contexto do addon só pode ser lido pelo dono na sessão Electron de reprodução", async () => {
  const { criarSessaoFontes, alvoAddonDaSessao } = await import("../fontes");
  const { getRedis } = await import("../redis");
  const token = await criarSessaoFontes("owner", "electron", [], alvo);
  assert.deepEqual(await alvoAddonDaSessao(token, "owner"), alvo);
  assert.equal(await alvoAddonDaSessao(token, "other"), null);
  const web = await criarSessaoFontes("owner", "web", [], alvo);
  assert.equal(await alvoAddonDaSessao(web, "owner"), null);
  const download = await criarSessaoFontes("owner", "electron", [], { ...alvo, finalidade: "download" });
  assert.equal(await alvoAddonDaSessao(download, "owner"), null);
  const legacy = await criarSessaoFontes("owner", "electron", []);
  assert.equal(await alvoAddonDaSessao(legacy, "owner"), null);
  await getRedis().del("play:fontes:" + token);
  assert.equal(await alvoAddonDaSessao(token, "owner"), null);
});
