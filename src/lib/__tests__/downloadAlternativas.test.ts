import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  procurarFonteDeDownload,
  MAX_TENTATIVAS_DE_DOWNLOAD,
  MAX_TENTATIVAS_ALTERNATIVAS_DOWNLOAD,
  type Expansao,
} from "../androidMedia";

/**
 * Procura de download: preferência MP4 → HLS, sobre as duas fases do PR #66
 * (até 6 base + 6 alternativas). O MP4 é sondado na hora; o HLS resolvido é
 * guardado e só sondado depois, sem ser re-resolvido/reextraído.
 */

type Cand = { id: string; tipo: "mp4" | "hls" | "fail"; hlsAceita?: boolean };
type Resolvida = { stream?: string; tipo?: string | null; servidor?: string; via?: string; id: string };
type Resp = { ok: boolean; motivo?: string; tentarOutraFonte?: boolean; sondagemId?: string; qualidades?: unknown[] };

const mp4 = (id: string): Cand => ({ id, tipo: "mp4" });
const hls = (id: string, hlsAceita = false): Cand => ({ id, tipo: "hls", hlsAceita });
const fail = (id: string): Cand => ({ id, tipo: "fail" });

function resolve(c: Cand): Resolvida {
  const ext = c.tipo === "mp4" ? "mp4" : "m3u8";
  return { stream: `https://cdn/${c.id}.${ext}`, tipo: c.tipo === "mp4" ? "mp4" : "hls", servidor: c.id, via: "aparelho", id: c.id };
}

async function procurar(base: Cand[], alternativas: Cand[]) {
  const porId = new Map<string, Cand>([...base, ...alternativas].map((c) => [c.id, c]));
  let candidatas = [...base];
  let expandiu = 0;
  const resolvidos: number[] = [];
  const sondados: string[] = [];

  const res = await procurarFonteDeDownload<Resolvida, Resp>({
    resolverFonte: async (indice) => {
      resolvidos.push(indice);
      const c = candidatas[indice];
      if (!c) return null;
      if (c.tipo === "fail") throw new Error("fonte_falhou");
      return resolve(c);
    },
    expandir: async (): Promise<Expansao | null> => {
      expandiu++;
      if (alternativas.length === 0) return null;
      const inicio = candidatas.length;
      candidatas = candidatas.concat(alternativas);
      return { inicio, quantidade: alternativas.length };
    },
    sondar: async (f) => {
      sondados.push(String(f.stream));
      const c = porId.get(f.id)!;
      if (c.tipo === "mp4") return { ok: true, sondagemId: "mp4", qualidades: [{}] };
      // HLS: inspectDownloadSource aceita o compatível; o incompatível pede outra fonte.
      return c.hlsAceita ? { ok: true, sondagemId: "hls", qualidades: [{}] } : { ok: false, motivo: "fonte_incompativel", tentarOutraFonte: true };
    },
  });

  return { res, sondados, resolvidos, expandiu };
}

describe("procura de download: MP4 preferencial, HLS fallback", () => {
  test("1. MP4 na base vence; o HLS guardado não é sondado", async () => {
    const { res, sondados } = await procurar([hls("h1"), mp4("m1")], []);
    assert.equal(res.ok, true);
    assert.deepEqual(sondados, ["https://cdn/m1.mp4"]); // só o MP4
  });

  test("2. MP4 nas alternativas vence; HLS base guardado, não sondado", async () => {
    const { res, sondados, expandiu } = await procurar([hls("h1")], [mp4("m1")]);
    assert.equal(res.ok, true);
    assert.equal(expandiu, 1);
    assert.deepEqual(sondados, ["https://cdn/m1.mp4"]);
  });

  test("3. só HLS: depois de procurar MP4, o primeiro HLS é sondado", async () => {
    const { res, sondados, resolvidos } = await procurar([hls("h1", true), hls("h2", true)], []);
    assert.equal(res.ok, true);
    assert.equal(res.ok === true && res.resposta.sondagemId, "hls"); // 5. HLS aceito abre modal
    assert.deepEqual(sondados, ["https://cdn/h1.m3u8"]); // primeiro HLS
    // 6. HLS não re-resolvido: cada índice resolvido uma vez (0,1 e o 2 que achou o fim).
    assert.deepEqual(resolvidos, [0, 1, 2]);
  });

  test("4. primeiro HLS incompatível (tentarOutraFonte) → próximo HLS", async () => {
    const { res, sondados } = await procurar([hls("h1", false), hls("h2", true)], []);
    assert.equal(res.ok, true);
    assert.deepEqual(sondados, ["https://cdn/h1.m3u8", "https://cdn/h2.m3u8"]);
  });

  test("7. orçamento 6 base + 6 alternativas: no máximo 12 fontes resolvidas", async () => {
    const base = Array.from({ length: 8 }, (_, i) => hls(`b${i}`, false));
    const alt = Array.from({ length: 8 }, (_, i) => hls(`a${i}`, false));
    const { res, resolvidos, expandiu } = await procurar(base, alt);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.motivo, "download_indisponivel");
    assert.equal(expandiu, 1);
    assert.equal(resolvidos.length, MAX_TENTATIVAS_DE_DOWNLOAD + MAX_TENTATIVAS_ALTERNATIVAS_DOWNLOAD);
  });

  test("MP4 recusado não impede o HLS de ser tentado depois", async () => {
    // MP4 que o Android recusa sem pedir outra fonte encerraria tudo; mas um MP4
    // que recusa com tentarOutraFonte deixa a procura seguir e cair no HLS.
    const base = [{ id: "m1", tipo: "mp4" as const }, hls("h1", true)];
    const porId = new Map(base.map((c) => [c.id, c]));
    const res = await procurarFonteDeDownload<Resolvida, Resp>({
      resolverFonte: async (i) => (base[i] ? resolve(base[i]) : null),
      sondar: async (f) => {
        const c = porId.get(f.id)!;
        if (c.tipo === "mp4") return { ok: false, motivo: "expirada", tentarOutraFonte: true };
        return { ok: true, sondagemId: "hls" };
      },
    });
    assert.equal(res.ok, true);
  });
});

describe("sessão/concessão/anúncio e re-resolução", () => {
  const raiz = process.cwd();
  const lib = readFileSync(join(raiz, "src/lib/androidMedia.ts"), "utf8");
  const hook = readFileSync(join(raiz, "src/components/android/useFonteParaMidia.ts"), "utf8");
  const acoes = readFileSync(join(raiz, "src/components/android/AndroidMediaActions.tsx"), "utf8");

  test("6/8. o fallback HLS sonda a fonte guardada, sem re-resolver", () => {
    const ini = lib.indexOf("const tentarHls");
    const fim = lib.indexOf("const base = await fase(0", ini);
    const trecho = lib.slice(ini, fim);
    assert.ok(ini > -1 && fim > ini);
    assert.ok(trecho.includes("sondar(fonte)"), "sonda a fonte guardada");
    assert.ok(!trecho.includes("resolverFonte"), "não re-resolve no fallback");
  });

  test("9/10. sessão e ação únicas: reiniciarAcao + uma expansão por sessão", () => {
    assert.ok(hook.includes("const reiniciarAcao"));
    assert.ok(hook.includes("atual.expandida")); // expande uma vez só
    assert.ok(!/=== 0\)\s*sessoesRef\.current/.test(hook)); // sem reset frágil por índice 0
  });

  test("11. nenhuma escolha manual de servidor: resolverFonte é automático", () => {
    assert.ok(acoes.includes('resolverFonte(tentativa, "download", liberar)'));
    assert.ok(!/escolherServidor|selecionarServidor|listaDeServidores/i.test(acoes));
  });
});
