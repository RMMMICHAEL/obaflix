import test from "node:test";
import assert from "node:assert/strict";

import {
  corridaComPrazo,
  fetchComPrazo,
  EtapaExpirada,
  ehEtapaExpirada,
  transmitirComCast,
  type FonteParaCast,
  type RespostaDeCast,
} from "../androidCast";
import { AcaoCancelada, AcaoInterrompida } from "../ads/acaoPatrocinada";

// ── corridaComPrazo ──────────────────────────────────────────────────────────
// O trabalho vence o prazo, ou o prazo estoura: nunca os dois, nunca nenhum.

test("corridaComPrazo: trabalho rápido resolve com o valor", async () => {
  const valor = await corridaComPrazo(Promise.resolve("pronto"), 1000, "etapa");
  assert.equal(valor, "pronto");
});

test("corridaComPrazo: trabalho lento estoura em EtapaExpirada", async () => {
  const lento = new Promise<string>((r) => setTimeout(() => r("tarde"), 1000));
  await assert.rejects(
    () => corridaComPrazo(lento, 10, "extracao"),
    (e: unknown) => ehEtapaExpirada(e) && (e as EtapaExpirada).etapa === "extracao",
  );
});

test("corridaComPrazo: chama aoExpirar ao estourar (para abortar o fetch)", async () => {
  let abortou = false;
  const lento = new Promise<void>((r) => setTimeout(r, 1000));
  await assert.rejects(
    () => corridaComPrazo(lento, 10, "fonte-nativa", () => { abortou = true; }),
    ehEtapaExpirada,
  );
  assert.equal(abortou, true);
});

test("corridaComPrazo: erro do trabalho sobe como está, sem virar EtapaExpirada", async () => {
  const falho = Promise.reject(new Error("fonte_falhou"));
  await assert.rejects(
    () => corridaComPrazo(falho, 1000, "etapa"),
    (e: unknown) => e instanceof Error && e.message === "fonte_falhou" && !ehEtapaExpirada(e),
  );
});

test("corridaComPrazo: não chama aoExpirar quando o trabalho ganha", async () => {
  let abortou = false;
  await corridaComPrazo(Promise.resolve(1), 50, "etapa", () => { abortou = true; });
  // Espera passar do prazo para garantir que o timer não dispara depois.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(abortou, false);
});

// ── fetchComPrazo ─────────────────────────────────────────────────────────────
// Aborta a requisição e rejeita EtapaExpirada quando o servidor não responde.

test("fetchComPrazo: estoura e aborta o fetch pendurado", async () => {
  const original = globalThis.fetch;
  let sinalVisto: AbortSignal | undefined;
  // fetch que nunca responde até ser abortado.
  globalThis.fetch = ((_: unknown, init?: RequestInit) => {
    sinalVisto = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("abortado")));
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchComPrazo("/api/x", { method: "POST" }, 10, "fontes"),
      (e: unknown) => ehEtapaExpirada(e) && (e as EtapaExpirada).etapa === "fontes",
    );
    assert.ok(sinalVisto, "passou um AbortSignal ao fetch");
    assert.equal(sinalVisto?.aborted, true, "abortou a requisição pendurada");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchComPrazo: um sinal externo já abortado cancela na hora", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error("abortado"));
      init?.signal?.addEventListener("abort", () => reject(new Error("abortado")));
    })) as typeof fetch;
  try {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() =>
      fetchComPrazo("/api/x", { method: "POST", signal: ac.signal }, 1000, "fontes"),
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ── transmitirComCast ─────────────────────────────────────────────────────────

const FONTE: FonteParaCast = { origem: "nativo", stream: "https://cdn/x.m3u8", tipo: "hls" };
const OK: RespostaDeCast = { ok: true };

/** resolverFonte que entrega `fontes[tentativa]` e conta o "anúncio" da tentativa 0. */
function resolvedorContado(fontes: (FonteParaCast | null)[]) {
  const estado = { chamadas: [] as number[], anuncios: 0 };
  const resolverFonte = async (tentativa: number): Promise<FonteParaCast | null> => {
    estado.chamadas.push(tentativa);
    // O anúncio/liberação vive só na tentativa 0 da MESMA ação (sessão reusada).
    if (tentativa === 0) estado.anuncios += 1;
    return fontes[tentativa] ?? null;
  };
  return { estado, resolverFonte };
}

test("app ausente: precisa_app ANTES de qualquer anúncio ou resolução", async () => {
  const { estado, resolverFonte } = resolvedorContado([FONTE]);
  let castChamado = false;
  const r = await transmitirComCast({
    appInstalado: async () => false,
    resolverFonte,
    requestCast: async () => { castChamado = true; return OK; },
  });
  assert.deepEqual(r, { tipo: "precisa_app" });
  assert.equal(estado.chamadas.length, 0, "não resolveu fonte nenhuma");
  assert.equal(estado.anuncios, 0, "não pediu anúncio");
  assert.equal(castChamado, false, "não tentou transmitir");
});

test("caminho feliz: app instalado, fonte resolve, cast ok", async () => {
  const { resolverFonte } = resolvedorContado([FONTE]);
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte,
    requestCast: async () => OK,
  });
  assert.deepEqual(r, { tipo: "ok" });
});

test("fechar o convite (AcaoCancelada) vira cancelado, sem mensagem", async () => {
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte: async () => { throw new AcaoCancelada(); },
    requestCast: async () => OK,
  });
  assert.deepEqual(r, { tipo: "cancelado" });
});

test("recusa comercial (AcaoInterrompida) vira erro com o motivo próprio", async () => {
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte: async () => { throw new AcaoInterrompida("anuncio_indisponivel"); },
    requestCast: async () => OK,
  });
  assert.deepEqual(r, { tipo: "erro", motivo: "anuncio_indisponivel" });
});

test("fonte 1 falha com tentarOutraFonte: tenta a próxima e SEM segundo anúncio", async () => {
  const { estado, resolverFonte } = resolvedorContado([FONTE, FONTE]);
  let n = 0;
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte,
    requestCast: async () => (n++ === 0 ? { ok: false, tentarOutraFonte: true } : OK),
  });
  assert.deepEqual(r, { tipo: "ok" });
  assert.deepEqual(estado.chamadas, [0, 1], "tentou dois servidores");
  assert.equal(estado.anuncios, 1, "o anúncio aconteceu uma vez só");
});

test("servidor falha (erro genérico/timeout) na tentativa 0: tenta a próxima sem novo anúncio", async () => {
  const estado = { chamadas: [] as number[], anuncios: 0 };
  const resolverFonte = async (tentativa: number): Promise<FonteParaCast | null> => {
    estado.chamadas.push(tentativa);
    if (tentativa === 0) {
      // A sessão já foi aberta (anúncio consumido) e a fonte 0 estourou o prazo.
      estado.anuncios += 1;
      throw new EtapaExpirada("fonte-nativa");
    }
    return tentativa === 1 ? FONTE : null;
  };
  const r = await transmitirComCast({ appInstalado: async () => true, resolverFonte, requestCast: async () => OK });
  assert.deepEqual(r, { tipo: "ok" });
  assert.deepEqual(estado.chamadas, [0, 1]);
  assert.equal(estado.anuncios, 1, "nenhum segundo anúncio ao trocar de servidor");
});

test("cast pendurado (requestCast rejeita/timeout) sem outra fonte: erro, não gira para sempre", async () => {
  const { resolverFonte } = resolvedorContado([FONTE]);
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte,
    requestCast: async () => { throw new EtapaExpirada("cast"); },
  });
  assert.equal(r.tipo, "erro");
});

test("todas as fontes recusam: erro com o último motivo", async () => {
  const { resolverFonte } = resolvedorContado([FONTE, FONTE, FONTE]);
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte,
    requestCast: async () => ({ ok: false, tentarOutraFonte: true, motivo: "falha_ao_abrir" }),
  });
  assert.deepEqual(r, { tipo: "erro", motivo: "falha_ao_abrir", podeInstalar: undefined });
});

test("app sumiu entre a checagem e a entrega: erro carrega podeInstalar", async () => {
  const { resolverFonte } = resolvedorContado([FONTE]);
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte,
    requestCast: async () => ({ ok: false, motivo: "app_ausente", podeInstalar: true }),
  });
  assert.deepEqual(r, { tipo: "erro", motivo: "app_ausente", podeInstalar: true });
});

test("sem fontes candidatas: erro sem motivo, nunca spinner infinito", async () => {
  const r = await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte: async () => null,
    requestCast: async () => OK,
  });
  assert.deepEqual(r, { tipo: "erro", motivo: undefined, podeInstalar: undefined });
});

test("respeita maxTentativas: não passa do teto de servidores", async () => {
  const { estado, resolverFonte } = resolvedorContado([FONTE, FONTE, FONTE, FONTE, FONTE]);
  await transmitirComCast({
    appInstalado: async () => true,
    resolverFonte,
    requestCast: async () => ({ ok: false, tentarOutraFonte: true }),
    maxTentativas: 2,
  });
  assert.deepEqual(estado.chamadas, [0, 1], "parou em duas tentativas");
});
