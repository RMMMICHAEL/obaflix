import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  procurarFonteDeDownload,
  MAX_TENTATIVAS_DE_DOWNLOAD,
  MAX_TENTATIVAS_ALTERNATIVAS_DOWNLOAD,
  type Expansao,
  type EventoDeProcura,
} from "../androidMedia";

/**
 * Finding 1: a procura de download terminava em `fim` antes do teto porque só
 * via a lista base. A correção torna a procura em DUAS fases com orçamentos
 * próprios — base (6) e alternativas (6) — em vez de um índice linear combinado.
 * Uma base ruim com muitas fontes não pode consumir as posições das alternativas.
 */

type Cand = { id: string; k: "mp4" | "hls" | "fail" };
type Resolvida = { stream?: string; tipo?: string | null; servidor?: string; via?: string };
type Resp = { ok: boolean; motivo?: string; tentarOutraFonte?: boolean };

const mp4 = (id: string): Cand => ({ id, k: "mp4" });
const hls = (id: string): Cand => ({ id, k: "hls" });
const fail = (id: string): Cand => ({ id, k: "fail" });

function resolve(c: Cand): Resolvida {
  if (c.k === "mp4") return { stream: `https://cdn/${c.id}.mp4`, tipo: "mp4", servidor: c.id, via: "aparelho" };
  return { stream: `https://cdn/${c.id}.m3u8`, tipo: "hls", servidor: c.id, via: "aparelho" };
}

/** Procura de verdade ligada a uma sessão que cresce uma vez na expansão. */
async function procurar(
  base: Cand[],
  alternativas: Cand[],
  opts: { semExpandir?: boolean; expandirLanca?: boolean } = {},
) {
  let candidatas = [...base];
  let expandiu = 0;
  const resolvidos: number[] = [];
  const sondadas: string[] = [];
  const eventos: EventoDeProcura[] = [];

  const res = await procurarFonteDeDownload<Resolvida, Resp>({
    resolverFonte: async (indice) => {
      resolvidos.push(indice);
      const c = candidatas[indice];
      if (!c) return null;
      if (c.k === "fail") throw new Error("fonte_falhou");
      return resolve(c);
    },
    expandir: opts.semExpandir
      ? undefined
      : async (): Promise<Expansao | null> => {
          expandiu++;
          if (opts.expandirLanca) throw new Error("expansao_quebrou");
          if (alternativas.length === 0) return null;
          const inicio = candidatas.length;
          candidatas = candidatas.concat(alternativas);
          return { inicio, quantidade: alternativas.length };
        },
    sondar: async (f) => {
      sondadas.push(String(f.stream));
      return { ok: true };
    },
    registrar: (e) => eventos.push(e),
  });

  return { res, sondadas, eventos, resolvidos, expandiu };
}

describe("procura de download em duas fases (Finding 1)", () => {
  test("1. base 3 HLS + 1 falha; alternativas 2 HLS + MP4 → alcança e sonda o MP4", async () => {
    const { res, sondadas, eventos, expandiu } = await procurar(
      [hls("h1"), hls("h2"), hls("h3"), fail("f1")],
      [hls("a1"), hls("a2"), mp4("aMP4")],
    );
    assert.equal(res.ok, true);
    assert.deepEqual(sondadas, ["https://cdn/aMP4.mp4"]);
    assert.equal(expandiu, 1);
    assert.equal(eventos.at(-1)?.resultado, "aceita");
    // HLS foram pulados (tanto da base quanto das alternativas), nunca sondados.
    assert.equal(eventos.filter((e) => e.resultado === "pulada_hls").length, 5);
  });

  test("2. base 8 ruins → só 6 da base; expande sem chegar ao fim; alternativa 0 MP4", async () => {
    const base = Array.from({ length: 8 }, (_, i) => hls(`b${i}`));
    const { res, sondadas, resolvidos, expandiu } = await procurar(base, [mp4("aMP4")]);
    assert.equal(res.ok, true);
    assert.deepEqual(sondadas, ["https://cdn/aMP4.mp4"]);
    assert.equal(expandiu, 1);
    // Só as 6 primeiras da base foram resolvidas; as posições 6 e 7 não.
    assert.deepEqual(resolvidos.filter((i) => i < 8).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
    assert.ok(!resolvidos.includes(6) && !resolvidos.includes(7), "não foi só aumentar para 12");
    // A alternativa foi resolvida no índice absoluto após a base inteira (8).
    assert.ok(resolvidos.includes(8));
  });

  test("3. MP4 válido dentro das 6 primeiras da base → sucesso e NÃO expande", async () => {
    const { res, sondadas, expandiu } = await procurar([hls("h1"), hls("h2"), mp4("bMP4")], [mp4("aMP4")]);
    assert.equal(res.ok, true);
    assert.deepEqual(sondadas, ["https://cdn/bMP4.mp4"]);
    assert.equal(expandiu, 0);
  });

  test("4. base esgota com 2 fontes → expande imediatamente após a segunda", async () => {
    const { res, resolvidos, expandiu } = await procurar([hls("h1"), hls("h2")], [mp4("aMP4")]);
    assert.equal(res.ok, true);
    assert.equal(expandiu, 1);
    // 0,1 base; 2 = tentativa que acha a base esgotada; 2 também é a alternativa.
    assert.deepEqual(resolvidos, [0, 1, 2, 2]);
  });

  test("5. alternativas com 8 ruins → no máximo 6 resolvidas, busca termina limitada", async () => {
    const alt = Array.from({ length: 8 }, (_, i) => hls(`a${i}`));
    const { res, eventos, expandiu } = await procurar([fail("b0")], alt);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.motivo, "download_indisponivel");
    assert.equal(expandiu, 1);
    // A base não tem HLS (só a falha); logo todo pulada_hls é das alternativas, e
    // o orçamento da fase 2 as limita a 6, mesmo havendo 8.
    assert.equal(eventos.filter((e) => e.resultado === "pulada_hls").length, MAX_TENTATIVAS_ALTERNATIVAS_DOWNLOAD);
  });

  test("6. HLS continua contando como tentativa de resolução (foi resolvido)", async () => {
    const { resolvidos } = await procurar([hls("h1"), hls("h2"), hls("h3")], []);
    // As três HLS foram efetivamente resolvidas (custaram /fonte-nativa+extração).
    assert.ok([0, 1, 2].every((i) => resolvidos.includes(i)));
  });

  test("10. expansão nula ou que lança mantém o resultado da base, sem crash", async () => {
    const semAlt = await procurar([hls("h1"), hls("h2")], []);
    assert.equal(semAlt.res.ok, false);
    assert.equal(semAlt.res.ok === false && semAlt.res.motivo, "download_indisponivel");

    const lancou = await procurar([hls("h1")], [mp4("aMP4")], { expandirLanca: true });
    assert.equal(lancou.res.ok, false); // expandir lançou → fail-open para a base
    assert.equal(lancou.expandiu, 1);
  });

  test("sem `expandir` o comportamento é fase única (compatível com o anterior)", async () => {
    const base = Array.from({ length: 10 }, (_, i) => hls(`h${i}`));
    const { resolvidos } = await procurar(base, [], { semExpandir: true });
    // Só a fase base, limitada ao teto de 6.
    assert.equal(resolvidos.length, MAX_TENTATIVAS_DE_DOWNLOAD);
  });
});

describe("expansão: mesma sessão, uma vez, sem anúncio/concessão (7, 8, 9)", () => {
  const raiz = process.cwd();
  const hook = readFileSync(join(raiz, "src/components/android/useFonteParaMidia.ts"), "utf8");
  const rota = readFileSync(join(raiz, "src/app/api/player/fontes/route.ts"), "utf8");
  const acoes = readFileSync(join(raiz, "src/components/android/AndroidMediaActions.tsx"), "utf8");

  test("expandirAlternativas usa a MESMA sessão, uma vez, sem anúncio/concessão", () => {
    const ini = hook.indexOf("const expandirAlternativas");
    const fim = hook.indexOf("const resolverFonte", ini);
    const trecho = hook.slice(ini, fim > ini ? fim : undefined);
    assert.ok(ini > -1 && fim > ini);
    assert.ok(trecho.includes('"/api/player/fontes"'));
    assert.ok(trecho.includes("alternativas: true"));
    assert.ok(trecho.includes("sessao: atual.sessao"), "reusa a sessão existente");
    assert.ok(trecho.includes("atual.expandida"), "uma expansão por sessão");
    assert.ok(!trecho.includes("abrirSessao"), "não abre sessão nova");
    // Sem lógica de anúncio/concessão na fase 2 (o `finalidade` do parâmetro é só
    // a chave da sessão, não enforcement — por isso não entra nesta checagem).
    assert.ok(!/\bliberar\b|concessao/.test(trecho), "sem anúncio/concessão na fase 2");
  });

  test("resolverFonte não reseta mais a sessão por índice 0 (evita 2º anúncio)", () => {
    assert.ok(!/=== 0\)\s*sessoesRef\.current/.test(hook), "reset por índice 0 foi removido");
    assert.ok(hook.includes("const reiniciarAcao"), "o reset virou ação explícita");
    assert.ok(/sessoesRef\.current\[finalidade\] = undefined/.test(hook));
  });

  test("o ramo alternativas do servidor não consome concessão nem mostra anúncio", () => {
    const ini = rota.indexOf("corpo.alternativas === true");
    const fim = rota.indexOf("// ── Primeira fase", ini);
    const trecho = rota.slice(ini, fim > ini ? fim : undefined);
    assert.ok(ini > -1);
    assert.ok(trecho.includes("diagnosticarSessao(sessao, userId)"));
    assert.ok(trecho.includes("acrescentarFontes"));
    assert.ok(!trecho.includes("autorizarPorAnuncio"));
  });

  test("o download expande a sessão; a transmissão não", () => {
    assert.ok(acoes.includes('expandirAlternativas("download")'));
    assert.ok(acoes.includes('reiniciarAcao?.("download")'));
    assert.ok(acoes.includes('reiniciarAcao?.("transmissao")'));
    // transmitirComCast não recebe expandir: a fase alternativas é só do download.
    const ini = acoes.indexOf("transmitirComCast({");
    const fim = acoes.indexOf("});", ini);
    assert.ok(!acoes.slice(ini, fim).includes("expandir"));
  });
});
