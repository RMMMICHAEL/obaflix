import test from "node:test";
import assert from "node:assert/strict";
import { buscarLegenda, configLegendasAutomaticas, duracaoCompativel, identificarConteudo, ordenarCandidatas, type Obter } from "../legendasAutomaticas";
import { lerLegenda } from "../cortesAi";
import { safeGet } from "../ssrf";

/** Legenda automática: tudo com respostas simuladas — nenhuma rede, nenhum download real. */

const BASE = "https://opensubtitlesv3-pro.dexter21767.com/eyJjb25maWciOjF9";
const srt = (fimSeg: number, n = 6) => Array.from({ length: n }, (_, i) => {
  const ini = Math.round((fimSeg - 10) * i / (n - 1)), fim = i === n - 1 ? fimSeg : ini + 3;
  const t = (s: number) => new Date(s * 1000).toISOString().slice(11, 19) + ",000";
  return `${i + 1}\n${t(ini)} --> ${t(fim)}\nFala ${i + 1}\n`;
}).join("\n");

test("desligada por padrão; só a base HTTPS dos hosts permitidos liga", () => {
  assert.equal(configLegendasAutomaticas({}).ativo, false);
  assert.equal(configLegendasAutomaticas({ CORTES_AI_LEGENDAS_ADDON: BASE }).ativo, false, "sem a flag");
  assert.deepEqual(configLegendasAutomaticas({ CORTES_AI_LEGENDAS_AUTOMATICAS: "1", CORTES_AI_LEGENDAS_ADDON: `${BASE}/manifest.json` }), { ativo: true, base: BASE });
  for (const ruim of ["http://opensubtitlesv3-pro.dexter21767.com/x", "https://evil.example/x", "https://u:p@opensubtitles.stremio.homes/x", `${BASE}?a=1`, "lixo"]) {
    assert.equal(configLegendasAutomaticas({ CORTES_AI_LEGENDAS_AUTOMATICAS: "1", CORTES_AI_LEGENDAS_ADDON: ruim }).ativo, false, ruim);
  }
});

test("escolha: português antes de inglês; fonte confiável e não traduzida por IA primeiro", () => {
  const lista = [
    { sub_id: 1, lang_code: "en", from_trusted: true, url: "u1" },
    { sub_id: 2, lang_code: "pt-br", from_trusted: false, url: "u2" },
    { sub_id: 3, lang_code: "pt-br", from_trusted: true, ai_translated: true, url: "u3" },
    { sub_id: 4, lang_code: "pt-br", from_trusted: true, url: "u4" },
    { sub_id: 5, lang_code: "es", from_trusted: true, url: "u5" },
    { sub_id: 6, lang_code: "pt-br", from_trusted: true },
  ];
  assert.deepEqual(ordenarCandidatas(lista).map((c) => c.sub_id), [4, 3, 2, 1]);
});

test("duração compatível: última fala dentro do vídeo e perto do fim (números do Breaking Bad T1E3)", () => {
  const dur = 2903.26;
  assert.equal(duracaoCompativel(lerLegenda(srt(2855)), dur), true, "47 s de créditos");
  assert.equal(duracaoCompativel(lerLegenda(srt(2840)), dur), true, "63 s de créditos");
  assert.equal(duracaoCompativel(lerLegenda(srt(3100)), dur), false, "passa do vídeo");
  assert.equal(duracaoCompativel(lerLegenda(srt(1500)), dur), false, "outra versão, muito mais curta");
  assert.equal(duracaoCompativel(lerLegenda(srt(1500)), undefined), true, "sem duração não filtra");
});

const banco = (o: { filme?: object | null; serie?: object | null; episodio?: object | null }) => ({
  filme: { findUnique: async () => o.filme ?? null },
  serie: { findUnique: async () => o.serie ?? null },
  episodio: { findFirst: async () => o.episodio ?? null },
}) as never;

test("conteúdo vem do catálogo: série sem IMDb usa o TMDB; episódio precisa existir", async () => {
  const ids = async (tipo: string, tmdb: string | number) => (tipo === "serie" && String(tmdb) === "1396" ? { imdb_id: "tt0903747" } : null);
  const bb = banco({ serie: { tmdbId: "1396", imdbId: null }, episodio: { id: "teste-1396-s1e3" } });
  assert.deepEqual(await identificarConteudo("teste-1396", 1, 3, { db: bb, ids: ids as never }), { tipo: "serie", imdb: "tt0903747", temporada: 1, episodio: 3 });
  assert.equal(await identificarConteudo("teste-1396", 1, 99, { db: banco({ serie: { tmdbId: "1396", imdbId: null } }), ids: ids as never }), null, "episódio inexistente");
  assert.equal(await identificarConteudo("teste-1396", "x", 3, { db: bb, ids: ids as never }), null, "temporada inválida");
  assert.equal(await identificarConteudo("nao-existe", 1, 3, { db: banco({}), ids: ids as never }), null);
  assert.equal(await identificarConteudo("teste-1396", 1, 3, { db: bb, ids: (async () => ({ imdb_id: "../x" })) as never }), null, "IMDb malformado");
  assert.deepEqual(await identificarConteudo("16638", undefined, undefined, { db: banco({ filme: { tmdbId: "603", imdbId: "tt0133093", duracao: 136 } }), ids: ids as never }),
    { tipo: "filme", imdb: "tt0133093", duracaoSeg: 8160 });
});

test("busca: URL do episódio, pula a legenda incompatível, até 3 downloads", async () => {
  const pedidos: string[] = [];
  const lista = { subtitles: [
    { sub_id: 10, lang_code: "pt-br", from_trusted: true, url: "https://opensubtitles.stremio.homes/a.srt" },
    { sub_id: 11, lang_code: "pt-br", from_trusted: true, url: "https://opensubtitles.stremio.homes/b.srt" },
    { sub_id: 12, lang_code: "pt-br", from_trusted: false, url: "https://opensubtitles.stremio.homes/c.srt" },
    { sub_id: 13, lang_code: "pt-br", from_trusted: false, url: "https://opensubtitles.stremio.homes/d.srt" },
  ] };
  const textos: Record<string, string> = { "a.srt": srt(1500), "b.srt": srt(2855), "c.srt": srt(2850), "d.srt": srt(2850) };
  const obter: Obter = async (url) => { pedidos.push(url); return url.endsWith(".json") ? JSON.stringify(lista) : textos[url.split("/").pop()!]; };
  const r = await buscarLegenda({ tipo: "serie", imdb: "tt0903747", temporada: 1, episodio: 3 }, BASE, 2903.26, obter);
  assert.equal(pedidos[0], `${BASE}/subtitles/series/tt0903747:1:3.json`);
  assert.equal(r?.subId, "11", "a primeira (outra versão) foi descartada pela duração");
  assert.equal(r?.downloads, 2);
  assert.match(r!.impressao, /^[0-9a-f]{64}$/);

  pedidos.length = 0;
  const nenhuma = await buscarLegenda({ tipo: "serie", imdb: "tt0903747", temporada: 1, episodio: 3 }, BASE, 9000, obter);
  assert.equal(nenhuma, null);
  assert.equal(pedidos.length, 1 + 3, "lista + no máximo 3 downloads");
});

test("safeGet recusa saltar para fora da lista permitida, mesmo num redirecionamento", async () => {
  const real = globalThis.fetch;
  let chamadas = 0;
  globalThis.fetch = (async () => { chamadas++; return new Response(null, { status: 302, headers: { location: "https://8.8.8.8/fora" } }); }) as typeof fetch;
  try {
    const permitido = (u: URL) => u.hostname === "1.1.1.1";
    await assert.rejects(safeGet("https://8.8.4.4/inicio", {}, 4, permitido), /fora da lista/);
    assert.equal(chamadas, 0, "nem chega a pedir");
    await assert.rejects(safeGet("https://1.1.1.1/inicio", {}, 4, permitido), /fora da lista/);
    assert.equal(chamadas, 1, "segue só até o salto proibido");
  } finally { globalThis.fetch = real; }
});
