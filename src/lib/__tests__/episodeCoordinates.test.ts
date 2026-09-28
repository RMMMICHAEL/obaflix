import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Coordenadas alternativas de episódio por provedor.
 *
 * O catálogo é a identidade (T2E1 continua T2E1 para histórico, progresso e
 * próximo episódio); só a coordenada enviada ao provedor muda. Estes testes
 * travam: ordem das tentativas, cálculo contínuo seguro, regras por
 * tmdbId + provedor, teto sem duplicata, Redis como otimização e a
 * preservação da identidade canônica.
 */

// ── Redis falso (antes de qualquer módulo pedir o cliente) ──────────────────
const kv = new Map<string, string>();
let redisFora = false;
let desserializa = false;
const escritas: string[] = [];
const clienteFalso = {
  async set(key: string, value: string | number) {
    if (redisFora) throw new Error("redis fora");
    escritas.push(key);
    kv.set(key, String(value));
    return "OK" as const;
  },
  async get(key: string) {
    if (redisFora) throw new Error("redis fora");
    const v = kv.get(key);
    if (v === undefined) return null;
    if (desserializa) { try { return JSON.parse(v); } catch { return v; } }
    return v;
  },
  async del(key: string) {
    if (redisFora) throw new Error("redis fora");
    escritas.push(`del:${key}`);
    return kv.delete(key) ? 1 : 0;
  },
  async incr() { return 1; },
  async expire() { return 1; },
  async ttl() { return -1; },
  async zadd() { return 1; },
  async zrem() { return 1; },
  async zremrangebyscore() { return 0; },
  async zcard() { return 0; },
};
(globalThis as any).obaflixMemoryStore = clienteFalso;

let c: typeof import("../episodeCoordinates");
let f: typeof import("../fontes");
let cache: typeof import("../episodeCoordinateCache");
let t: typeof import("../tentativasCoordenada");
let regrasReais: typeof import("../episodeCoordinateRules");

const logOriginal = console.log;

before(async () => {
  console.log = () => {};
  c = await import("../episodeCoordinates");
  f = await import("../fontes");
  cache = await import("../episodeCoordinateCache");
  t = await import("../tentativasCoordenada");
  regrasReais = await import("../episodeCoordinateRules");
});
after(() => { console.log = logOriginal; });
beforeEach(() => { kv.clear(); redisFora = false; desserializa = false; escritas.length = 0; });

// ── Catálogos de exemplo ─────────────────────────────────────────────────────
const linhas = (porTemporada: Record<number, number[]>) =>
  Object.entries(porTemporada).flatMap(([s, eps]) => eps.map((e) => ({ temporada: Number(s), numeroEp: e })));
const faixa = (de: number, ate: number) => Array.from({ length: ate - de + 1 }, (_, i) => de + i);

/** T1 = 26 episódios, T2 = 12 — o exemplo do enunciado. */
const CATALOGO_26 = linhas({ 1: faixa(1, 26), 2: faixa(1, 12) });

/** Catálogo real do HxH (série 21040, tmdb 46298), medido em 28/09/2026. */
const CATALOGO_HXH = linhas({
  1: faixa(1, 26),
  2: [...faixa(1, 12), ...faixa(27, 38)],
  3: [...faixa(1, 20), ...faixa(39, 58)],
  4: [...faixa(1, 17), ...faixa(59, 75)],
  5: [...faixa(1, 61), ...faixa(76, 136)],
  6: [...faixa(1, 12), ...faixa(137, 148)],
});

const REGRA_T1E64 = {
  tipo: "faixa" as const, tmdbId: "999", provider: "superflix",
  temporada: 2, de: 1, paraTemporada: 1, paraEpisodio: 64,
};

const SUPERFLIX_T2E1 = "https://superflixapi.beer/serie/999/2/1";

type FonteSemId = Omit<import("../fontes").FonteReal, "id" | "ordem">;

function fonteSuperflix(estrutura: ReturnType<typeof c.estruturaDoCatalogo>, regras: any[], s = 2, e = 1, aprendidas = {}) {
  const base: FonteSemId = {
    embedUrl: `https://superflixapi.beer/serie/999/${s}/${e}`, provider: "superflix", servidor: "SuperFlix",
    idioma: null, tokenized: false, nativo: true, iframeDireto: false, iframeDesafio: true,
    iframeInvalido: false, semExtrator: false, disponivel: true,
  };
  return f.anexarCoordenadas([base], {
    tmdbId: "999", temporada: s, numeroEp: e, estrutura, regras, aprendidas,
  })[0];
}

/** Provedor simulado: só "reproduz" nas coordenadas listadas. Conta chamadas. */
function provedor(funcionam: string[]) {
  const chamadas: string[] = [];
  return {
    chamadas,
    tentar: async (url: string) => {
      const [, , s, e] = new URL(url).pathname.split("/").filter(Boolean);
      const coord = `T${s}E${e}`;
      chamadas.push(coord);
      return funcionam.includes(coord) ? { tipo: "hls", stream: `m3u8:${coord}` } : { tipo: "iframe", stream: url };
    },
    sucesso: (r: { tipo: string }) => r.tipo !== "iframe",
  };
}

const aprenderNulo = async () => {};

// ── 1. Episódio normal ───────────────────────────────────────────────────────
describe("1. canônica funciona", () => {
  test("só T2E1 é chamado", async () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [REGRA_T1E64]);
    const p = provedor(["T2E1"]);
    const r = await t.executarTentativas({ fonte, tentar: p.tentar, sucesso: p.sucesso, aprender: aprenderNulo });
    assert.deepEqual(p.chamadas, ["T2E1"]);
    assert.equal(r.estrategia, "canonical");
    assert.equal(r.url, SUPERFLIX_T2E1);
  });

  test("sem alternativa nenhuma, a fonte fica idêntica à de antes", () => {
    const fonte = fonteSuperflix(null, [], 1, 5);
    assert.equal(fonte.coordenadas, undefined);
    assert.equal(f.totalTentativas(fonte), 1);
    assert.equal(f.urlDaTentativa(fonte, 0), fonte.embedUrl);
    assert.equal(f.urlDaTentativa(fonte, 1), null);
  });
});

// ── 2. Fallback contínuo ─────────────────────────────────────────────────────
describe("2. contínua", () => {
  test("T2E1 falha, T1E27 reproduz, e a fonte continua sendo T2E1", async () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), []);
    const p = provedor(["T1E27"]);
    const r = await t.executarTentativas({ fonte, tentar: p.tentar, sucesso: p.sucesso, aprender: aprenderNulo });
    assert.deepEqual(p.chamadas, ["T2E1", "T1E27"]);
    assert.equal(r.estrategia, "continuous");
    assert.equal((r.resultado as any).stream, "m3u8:T1E27");
    assert.equal(fonte.embedUrl, SUPERFLIX_T2E1, "identidade da fonte não muda");
  });

  test("absoluto soma as temporadas anteriores: T2E2 → 28, T2E10 → 36", () => {
    const est = c.estruturaDoCatalogo(linhas({ 1: faixa(1, 26), 2: faixa(1, 10) }), 2);
    assert.equal(c.episodioAbsoluto(est, 2, 1), 27);
    assert.equal(c.episodioAbsoluto(est, 2, 2), 28);
    assert.equal(c.episodioAbsoluto(est, 2, 10), 36);
  });
});

// ── 3. Alias ─────────────────────────────────────────────────────────────────
describe("3. alias", () => {
  test("T2E1 e T1E27 falham, T1E64 reproduz", async () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [REGRA_T1E64]);
    const p = provedor(["T1E64"]);
    const r = await t.executarTentativas({ fonte, tentar: p.tentar, sucesso: p.sucesso, aprender: aprenderNulo });
    assert.deepEqual(p.chamadas, ["T2E1", "T1E27", "T1E64"]);
    assert.equal(r.estrategia, "alias");
  });

  test("regra de outro provedor ou outro tmdbId não se aplica", () => {
    const lista = c.resolveEpisodeCoordinates({
      tmdbId: "999", provider: "webcine", season: 2, episode: 1, estrutura: null, regras: [REGRA_T1E64],
    });
    assert.deepEqual(lista.map(c.rotuloCoordenada), ["T2E1"]);
    const outra = c.resolveEpisodeCoordinates({
      tmdbId: "1000", provider: "superflix", season: 2, episode: 1, estrutura: null, regras: [REGRA_T1E64],
    });
    assert.deepEqual(outra.map(c.rotuloCoordenada), ["T2E1"]);
  });
});

// ── 4. Progressão ────────────────────────────────────────────────────────────
describe("4. progressão da faixa", () => {
  for (const [e, esperado] of [[1, "T1E64"], [2, "T1E65"], [3, "T1E66"]] as const) {
    test(`T2E${e} → ${esperado}`, () => {
      const lista = c.resolveEpisodeCoordinates({
        tmdbId: "999", provider: "superflix", season: 2, episode: e, estrutura: null, regras: [REGRA_T1E64],
      });
      assert.equal(c.rotuloCoordenada(lista.find((x) => x.strategy === "alias")!), esperado);
    });
  }

  test("`ate` limita a faixa", () => {
    const regra = { ...REGRA_T1E64, ate: 2 };
    const lista = c.resolveEpisodeCoordinates({
      tmdbId: "999", provider: "superflix", season: 2, episode: 3, estrutura: null, regras: [regra],
    });
    assert.equal(lista.some((x) => x.strategy === "alias"), false);
  });
});

// ── 5. Todas falham ──────────────────────────────────────────────────────────
describe("5. todas falham", () => {
  test("devolve a falha da última — o failover segue para o próximo servidor", async () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [REGRA_T1E64]);
    const p = provedor([]);
    const r = await t.executarTentativas({ fonte, tentar: p.tentar, sucesso: p.sucesso, aprender: aprenderNulo });
    assert.deepEqual(p.chamadas, ["T2E1", "T1E27", "T1E64"]);
    assert.equal((r.resultado as any).tipo, "iframe", "mesmo resultado de falha de sempre");
  });

  test("se a última lançou, o erro sobe como numa tentativa única", async () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), []);
    let n = 0;
    await assert.rejects(
      t.executarTentativas({
        fonte, sucesso: () => true, aprender: aprenderNulo,
        tentar: async () => { n++; throw new Error(`falha ${n}`); },
      }),
      /falha 2/,
    );
    assert.equal(n, 2);
  });

  test("prazo esgotado interrompe as tentativas seguintes", async () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [REGRA_T1E64]);
    const p = provedor([]);
    await t.executarTentativas({
      fonte, tentar: p.tentar, sucesso: p.sucesso, aprender: aprenderNulo, cancelado: () => true,
    });
    assert.deepEqual(p.chamadas, ["T2E1"]);
  });
});

// ── 6. Sem dados para a contínua ─────────────────────────────────────────────
describe("6. estrutura insuficiente", () => {
  const casos: Array<[string, ReturnType<typeof linhas>]> = [
    ["temporada anterior ausente", linhas({ 2: faixa(1, 12) })],
    ["lacuna na temporada anterior", linhas({ 1: [...faixa(1, 10), ...faixa(12, 26)], 2: faixa(1, 12) })],
    ["bloco extra que não é o absoluto", linhas({ 1: faixa(1, 26), 2: [...faixa(1, 12), ...faixa(40, 51)] })],
    ["bloco absoluto de tamanho diferente", linhas({ 1: faixa(1, 26), 2: [...faixa(1, 12), ...faixa(27, 36)] })],
  ];
  for (const [nome, cat] of casos) {
    test(`${nome}: não inventa coordenada e não lança`, () => {
      const est = c.estruturaDoCatalogo(cat, 2);
      assert.equal(est, null);
      const lista = c.resolveEpisodeCoordinates({
        tmdbId: "999", provider: "superflix", season: 2, episode: 1, estrutura: est, regras: [],
      });
      assert.deepEqual(lista.map((x) => x.strategy), ["canonical"]);
    });
  }

  test("sem estrutura, regra de divisão não produz nada", () => {
    const lista = c.resolveEpisodeCoordinates({
      tmdbId: "46298", provider: "watchplayer", season: 2, episode: 1, estrutura: null,
      regras: regrasReais.REGRAS_COORDENADA,
    });
    assert.deepEqual(lista.map(c.rotuloCoordenada), ["T2E1"]);
  });

  test("provedor sem coordenada (hide, filmes) nunca recebe alternativa", () => {
    const lista = c.resolveEpisodeCoordinates({
      tmdbId: "999", provider: "hide", season: 2, episode: 1,
      estrutura: c.estruturaDoCatalogo(CATALOGO_26, 2), regras: [{ ...REGRA_T1E64, provider: "hide" }],
    });
    assert.deepEqual(lista.map((x) => x.strategy), ["canonical"]);
  });
});

// ── 7. Duplicatas e teto ─────────────────────────────────────────────────────
describe("7. sem duplicata, com teto", () => {
  test("contínua == alias vira uma chamada só", async () => {
    const regra = { ...REGRA_T1E64, paraEpisodio: 27 };
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [regra]);
    assert.deepEqual(fonte.coordenadas!.tentativas.map(c.rotuloCoordenada), ["T2E1", "T1E27"]);
    const p = provedor([]);
    await t.executarTentativas({ fonte, tentar: p.tentar, sucesso: p.sucesso, aprender: aprenderNulo });
    assert.deepEqual(p.chamadas, ["T2E1", "T1E27"]);
  });

  test("na temporada 1 a contínua é a própria canônica", () => {
    const lista = c.resolveEpisodeCoordinates({
      tmdbId: "999", provider: "superflix", season: 1, episode: 5,
      estrutura: c.estruturaDoCatalogo(CATALOGO_26, 1), regras: [],
    });
    assert.deepEqual(lista.map(c.rotuloCoordenada), ["T1E5"]);
  });

  test("nunca passa do teto e nunca corta a canônica", () => {
    const regras = [2, 3, 4, 5, 6].map((s) => ({ ...REGRA_T1E64, paraTemporada: s, antesDoCanonico: true }));
    const lista = c.resolveEpisodeCoordinates({
      tmdbId: "999", provider: "superflix", season: 2, episode: 1,
      estrutura: c.estruturaDoCatalogo(CATALOGO_26, 2), regras,
    });
    assert.equal(lista.length, c.MAX_TENTATIVAS_COORDENADA);
    assert.ok(lista.some((x) => x.strategy === "canonical"));
    assert.equal(new Set(lista.map(c.rotuloCoordenada)).size, lista.length);
  });

  test("URLs iguais não são repetidas mesmo se a lista vier suja", async () => {
    const fonte = {
      ...fonteSuperflix(null, []),
      coordenadas: {
        tmdbId: "999",
        tentativas: [
          { season: 2, episode: 1, strategy: "canonical" as const },
          { season: 2, episode: 1, strategy: "alias" as const },
        ],
      },
    };
    const p = provedor([]);
    await t.executarTentativas({ fonte, tentar: p.tentar, sucesso: p.sucesso, aprender: aprenderNulo });
    assert.deepEqual(p.chamadas, ["T2E1"]);
  });
});

// ── 8. Redis ─────────────────────────────────────────────────────────────────
describe("8. aprendizado no Redis", () => {
  for (const modo of [false, true]) {
    test(`hit válido reordena, canônica continua na lista (desserializa=${modo})`, async () => {
      desserializa = modo;
      kv.set("epcoord:v1:999", JSON.stringify({ superflix: "continuous" }));
      const aprendidas = await cache.lerAprendidas("999");
      assert.deepEqual(aprendidas, { superflix: "continuous" });
      const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [REGRA_T1E64], 2, 1, aprendidas);
      assert.deepEqual(fonte.coordenadas!.tentativas.map(c.rotuloCoordenada), ["T1E27", "T2E1", "T1E64"]);
    });
  }

  test("miss: ordem padrão, sem erro", async () => {
    assert.deepEqual(await cache.lerAprendidas("999"), {});
  });

  test("valor inválido ou corrompido vira miss", async () => {
    kv.set("epcoord:v1:999", "{nao-json");
    assert.deepEqual(await cache.lerAprendidas("999"), {});
    kv.set("epcoord:v1:999", JSON.stringify({ superflix: "rm -rf", webcine: 3, playerflix: "alias" }));
    assert.deepEqual(await cache.lerAprendidas("999"), { playerflix: "alias" });
    kv.set("epcoord:v1:999", JSON.stringify(["continuous"]));
    assert.deepEqual(await cache.lerAprendidas("999"), {});
  });

  test("expirado (chave sumiu) é miss", async () => {
    kv.set("epcoord:v1:999", JSON.stringify({ superflix: "alias" }));
    kv.delete("epcoord:v1:999");
    assert.deepEqual(await cache.lerAprendidas("999"), {});
  });

  test("Redis fora do ar: leitura e escrita não lançam, e a reprodução segue", async () => {
    redisFora = true;
    assert.deepEqual(await cache.lerAprendidas("999"), {});
    await cache.aprenderEstrategia("999", "superflix", "continuous");
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [], 2, 1, await cache.lerAprendidas("999"));
    const p = provedor(["T1E27"]);
    const r = await t.executarTentativas({ fonte, tentar: p.tentar, sucesso: p.sucesso });
    assert.equal(r.estrategia, "continuous");
  });

  test("aprende só quando a primeira falhou; sucesso de primeira não escreve", async () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), []);
    const ok = provedor(["T2E1"]);
    await t.executarTentativas({ fonte, tentar: ok.tentar, sucesso: ok.sucesso });
    assert.deepEqual(escritas, []);

    const cont = provedor(["T1E27"]);
    await t.executarTentativas({ fonte, tentar: cont.tentar, sucesso: cont.sucesso });
    assert.deepEqual(JSON.parse(kv.get("epcoord:v1:999")!), { superflix: "continuous" });

    // Aprendida parou de funcionar: cai na canônica e a dica é apagada.
    const aprendida = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [], 2, 1, { superflix: "continuous" });
    const volta = provedor(["T2E1"]);
    const r = await t.executarTentativas({ fonte: aprendida, tentar: volta.tentar, sucesso: volta.sucesso });
    assert.deepEqual(volta.chamadas, ["T1E27", "T2E1"]);
    assert.equal(r.estrategia, "canonical");
    assert.equal(kv.has("epcoord:v1:999"), false);
  });

  test("tmdbId inválido não toca o Redis", async () => {
    await cache.aprenderEstrategia("../x", "superflix", "alias");
    assert.deepEqual(await cache.lerAprendidas("abc"), {});
    assert.deepEqual(escritas, []);
  });
});

// ── 9. Identidade canônica ───────────────────────────────────────────────────
describe("9. identidade canônica preservada", () => {
  test("a fonte, a sessão e as projeções continuam em T2E1", () => {
    const fonte = fonteSuperflix(c.estruturaDoCatalogo(CATALOGO_26, 2), [REGRA_T1E64]);
    assert.equal(fonte.embedUrl, SUPERFLIX_T2E1, "play token e sessão seguem amarrados à canônica");
    assert.equal(f.urlDaTentativa(fonte, 2), "https://superflixapi.beer/serie/999/1/64");
    const [numerada] = f.numerar([fonte]);
    const publica = f.projetarPublica(numerada) as unknown as Record<string, unknown>;
    const admin = f.projetarAdmin(numerada) as unknown as Record<string, unknown>;
    assert.equal("coordenadas" in publica, false, "coordenada alternativa nunca vai ao cliente");
    assert.equal(admin.embedUrl, SUPERFLIX_T2E1);
    assert.equal(JSON.stringify(publica).includes("64"), false);
  });

  test("histórico, progresso e próximo episódio usam só as props canônicas", async () => {
    const player = await readFile("src/components/player/CustomPlayer.tsx", "utf8");
    const salvar = player.slice(player.indexOf("const saveProgress = useCallback"), player.indexOf("const saveProgress = useCallback") + 600);
    assert.match(salvar, /conteudoId, conteudoTipo, episodioId, temporada, numeroEp/);
    const inicio = player.indexOf("const tentarCoordenadasNativas");
    const bloco = player.slice(inicio, player.indexOf("}, [resolverUrlNativa]);", inicio));
    assert.ok(bloco.length > 0);
    assert.doesNotMatch(bloco, /temporada|numeroEp|episodioId|nextUrl|setProgress/);
  });

  test("nenhuma rota do fluxo escreve no catálogo", async () => {
    for (const arquivo of [
      "src/app/api/player/fontes/route.ts",
      "src/app/api/player/extract/route.ts",
      "src/app/api/player/fonte-nativa/route.ts",
      "src/lib/tentativasCoordenada.ts",
      "src/lib/episodeCoordinateCache.ts",
    ]) {
      const src = await readFile(arquivo, "utf8");
      assert.doesNotMatch(src, /episodio\.(update|create|upsert|delete)|watchHistory\.(update|create|upsert)/, arquivo);
    }
  });
});

// ── Caso real: Hunter x Hunter (tmdb 46298) ──────────────────────────────────
describe("HxH: catálogo por arco com numeração dupla", () => {
  const est = () => c.estruturaDoCatalogo(CATALOGO_HXH, 6);

  test("a linha relativa e a absoluta dão o mesmo absoluto", () => {
    const e = est();
    assert.ok(e);
    assert.equal(c.episodioAbsoluto(e, 2, 1), 27);
    assert.equal(c.episodioAbsoluto(e, 2, 27), 27);
    assert.equal(c.episodioAbsoluto(e, 5, 1), 76);
    assert.equal(c.episodioAbsoluto(e, 6, 12), 148);
    assert.equal(c.episodioAbsoluto(e, 2, 13), null, "número que não pertence a bloco nenhum");
  });

  const casos: Array<[string, number, number, string]> = [
    ["watchplayer", 2, 1, "T1E27"],
    ["watchplayer", 4, 5, "T2E1"],
    ["watchplayer", 5, 1, "T2E14"],
    ["watchplayer", 6, 1, "T3E1"],
    ["playerflix", 5, 1, "T2E76"],
    ["playerflix", 6, 12, "T3E148"],
    ["playerflix", 2, 27, "T1E27"],
  ];
  for (const [provider, s, e, esperado] of casos) {
    test(`${provider}: T${s}E${e} tenta ${esperado} antes da canônica`, () => {
      const lista = c.resolveEpisodeCoordinates({
        tmdbId: "46298", provider, season: s, episode: e, estrutura: est(), regras: regrasReais.REGRAS_COORDENADA,
      });
      assert.equal(c.rotuloCoordenada(lista[0]), esperado);
      assert.ok(lista.some((x) => x.strategy === "canonical"));
      assert.ok(lista.length <= c.MAX_TENTATIVAS_COORDENADA);
    });
  }

  test("webcine e superflix sem regra medida: canônica primeiro, contínua depois", () => {
    for (const provider of ["webcine", "superflix"]) {
      const lista = c.resolveEpisodeCoordinates({
        tmdbId: "46298", provider, season: 2, episode: 1, estrutura: est(), regras: regrasReais.REGRAS_COORDENADA,
      });
      assert.deepEqual(lista.map(c.rotuloCoordenada), ["T2E1", "T1E27"]);
    }
  });

  test("temporada 1 do HxH não muda nada", () => {
    const lista = c.resolveEpisodeCoordinates({
      tmdbId: "46298", provider: "watchplayer", season: 1, episode: 26,
      estrutura: c.estruturaDoCatalogo(CATALOGO_HXH, 1), regras: regrasReais.REGRAS_COORDENADA,
    });
    assert.deepEqual(lista.map(c.rotuloCoordenada), ["T1E26"]);
  });
});

// ── URL por provedor ─────────────────────────────────────────────────────────
describe("URL da coordenada", () => {
  const coord = { season: 1, episode: 27, strategy: "continuous" as const };
  test("cada formato de montarFontes", () => {
    assert.equal(
      c.urlComCoordenada("webcine", "https://webcinevs2.com/?id=1&type=tv&season=2&episode=1&q=X", coord),
      "https://webcinevs2.com/?id=1&type=tv&season=1&episode=27&q=X",
    );
    assert.equal(
      c.urlComCoordenada("playerflix", "https://playerflix.ink/inc/Ajax.php?id=1&type=tv&season=2&episode=1", coord),
      "https://playerflix.ink/inc/Ajax.php?id=1&type=tv&season=1&episode=27",
    );
    assert.equal(c.urlComCoordenada("superflix", "https://superflixapi.beer/serie/1/2/1", coord), "https://superflixapi.beer/serie/1/1/27");
    assert.equal(c.urlComCoordenada("watchplayer", "https://v1.watchplay.shop/tvshow/1/2/1", coord), "https://v1.watchplay.shop/tvshow/1/1/27");
  });

  test("formato inesperado não vira URL inventada", () => {
    assert.equal(c.urlComCoordenada("superflix", "https://superflixapi.beer/filme/1", coord), null);
    assert.equal(c.urlComCoordenada("webcine", "https://webcinevs2.com/?id=1&type=movie", coord), null);
    assert.equal(c.urlComCoordenada("hide", "https://hidehide.shop/v/abc", coord), null);
  });

  test("filme nunca ganha coordenadas", () => {
    const [filme] = f.anexarCoordenadas<FonteSemId>([{
      embedUrl: "https://superflixapi.beer/filme/999", provider: "superflix", servidor: "SuperFlix",
      idioma: null, tokenized: false, nativo: true, iframeDireto: false, iframeDesafio: true,
      iframeInvalido: false, semExtrator: false, disponivel: true,
    }], { tmdbId: "999", temporada: 2, numeroEp: 1, estrutura: null, regras: [REGRA_T1E64], aprendidas: {} });
    assert.equal(filme.coordenadas, undefined);
  });
});
