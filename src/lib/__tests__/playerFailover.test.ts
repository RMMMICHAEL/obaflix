// Testes dos critérios de recuperação e failover. Lógica pura, sem rede.
// Rodar com: npm run test:web
//
// Vale para Website, Electron e Android: os três rodam este mesmo módulo.

import test from "node:test";
import assert from "node:assert/strict";

import {
  classificarFalha,
  decidirAcao,
  backoffMs,
  sourceIdDe,
  LIMITES,
  type EstadoRecuperacao,
} from "../playerFailover";

const falha = (extra: Partial<Parameters<typeof classificarFalha>[0]> = {}) =>
  classificarFalha({ epochErro: 1, epochAtual: 1, ...extra });

const estado = (extra: Partial<EstadoRecuperacao> = {}): EstadoRecuperacao => ({
  retries: 0,
  extracoesNaJanela: 0,
  failoversAposFirstFrame: 0,
  failoversAntesFirstFrame: 0,
  houveFirstFrame: false,
  temProximaFonte: true,
  escolhaManual: false,
  podeReextrair: true,
  ...extra,
});

// ── Classificação ───────────────────────────────────────────────────────────

test("404 e 410 são fatais; nada mais é", () => {
  assert.equal(falha({ http: 404 }).veredito, "FATAL");
  assert.equal(falha({ http: 410 }).veredito, "FATAL");
  assert.equal(falha({ http: 500 }).veredito, "TRANSITORIO");
  assert.equal(falha({ http: 502 }).veredito, "TRANSITORIO");
  assert.equal(falha({ http: 503 }).veredito, "TRANSITORIO");
});

test("502 do Hide não é tratado como arquivo removido", () => {
  // Foi o caso real medido: CDN rotativo do Hide devolvendo 502 consistente.
  const r = falha({ http: 502 });
  assert.equal(r.veredito, "TRANSITORIO");
  assert.notEqual(r.veredito, "FATAL");
});

test("403 é token, não arquivo removido", () => {
  assert.equal(falha({ http: 403 }).veredito, "TOKEN");
  assert.equal(falha({ http: 401 }).veredito, "TOKEN");
});

test("timeout, rede e TLS são transitórios", () => {
  assert.equal(falha({ mensagem: "timed out" }).veredito, "TRANSITORIO");
  assert.equal(falha({ mensagem: "handshake failed" }).veredito, "TRANSITORIO");
  assert.equal(falha({ mensagem: "certificate error" }).veredito, "TRANSITORIO");
  assert.equal(falha({ mensagem: "network error" }).veredito, "TRANSITORIO");
});

test("canceled e ERR_ABORTED isolados são ignorados", () => {
  assert.equal(falha({ mensagem: "canceled" }).veredito, "IGNORAR");
  assert.equal(falha({ mensagem: "net::ERR_ABORTED" }).veredito, "IGNORAR");
  assert.equal(falha({ mensagem: "The operation was aborted" }).veredito, "IGNORAR");
});

test("cancelamento COM status HTTP não é ignorado", () => {
  // Um 404 continua fatal mesmo que a mensagem fale em abort.
  assert.equal(falha({ http: 404, mensagem: "aborted" }).veredito, "FATAL");
});

test("erro de epoch antiga é ignorado, seja qual for o status", () => {
  const antiga = classificarFalha({ http: 404, epochErro: 1, epochAtual: 2 });
  assert.equal(antiga.veredito, "IGNORAR");
  assert.match(antiga.motivo, /epoch-antiga/);
});

test("mensagem do extrator de arquivo removido é fatal", () => {
  assert.equal(falha({ mensagem: "PlayHide não tem mais este arquivo" }).veredito, "FATAL");
  assert.equal(falha({ mensagem: "hide: fonte-morta" }).veredito, "FATAL");
});

// ── Decisão ─────────────────────────────────────────────────────────────────

test("FATAL troca de fonte na hora, sem gastar retry", () => {
  const d = decidirAcao("FATAL", estado());
  assert.equal(d.acao, "failover");
});

test("TRANSITORIO retenta antes de trocar", () => {
  assert.equal(decidirAcao("TRANSITORIO", estado({ retries: 0 })).acao, "retry");
  assert.equal(decidirAcao("TRANSITORIO", estado({ retries: 2 })).acao, "retry");
  assert.equal(
    decidirAcao("TRANSITORIO", estado({ retries: LIMITES.RETRIES_POR_FONTE })).acao,
    "failover",
  );
});

test("TRANSITORIO nunca reextrai: não conserta 5xx e gasta slot na Vercel", () => {
  for (let r = 0; r <= LIMITES.RETRIES_POR_FONTE + 1; r++) {
    assert.notEqual(decidirAcao("TRANSITORIO", estado({ retries: r })).acao, "reextrair");
  }
});

test("TOKEN reextrai dentro do orçamento e troca depois", () => {
  assert.equal(decidirAcao("TOKEN", estado()).acao, "reextrair");
  assert.equal(
    decidirAcao("TOKEN", estado({ extracoesNaJanela: LIMITES.EXTRACOES_POR_JANELA })).acao,
    "failover",
  );
});

test("TOKEN sem meio de reextrair vai direto para failover", () => {
  assert.equal(decidirAcao("TOKEN", estado({ podeReextrair: false })).acao, "failover");
});

// ── Escolha manual ──────────────────────────────────────────────────────────

test("escolha manual não é sobrescrita por falha transitória", () => {
  const d = decidirAcao("TRANSITORIO", estado({
    escolhaManual: true,
    retries: LIMITES.RETRIES_POR_FONTE,
  }));
  assert.equal(d.acao, "erro");
  assert.notEqual(d.acao, "failover");
});

test("escolha manual É sobrescrita por falha fatal", () => {
  assert.equal(decidirAcao("FATAL", estado({ escolhaManual: true })).acao, "failover");
});

test("escolha manual ainda retenta dentro do orçamento", () => {
  assert.equal(decidirAcao("TRANSITORIO", estado({ escolhaManual: true, retries: 1 })).acao, "retry");
});

// ── Tetos ───────────────────────────────────────────────────────────────────

test("depois do primeiro frame o teto de failover é bem menor", () => {
  // Cada troca após firstFrame descarta buffer já baixado — é banda paga.
  const quaseNoTeto = estado({
    houveFirstFrame: true,
    failoversAposFirstFrame: LIMITES.FAILOVERS_APOS_FIRSTFRAME - 1,
  });
  assert.equal(decidirAcao("FATAL", quaseNoTeto).acao, "failover");

  const noTeto = estado({
    houveFirstFrame: true,
    failoversAposFirstFrame: LIMITES.FAILOVERS_APOS_FIRSTFRAME,
  });
  assert.equal(decidirAcao("FATAL", noTeto).acao, "erro");
});

test("antes do primeiro frame o teto é mais folgado: falhar cedo é barato", () => {
  assert.ok(LIMITES.FAILOVERS_ANTES_FIRSTFRAME > LIMITES.FAILOVERS_APOS_FIRSTFRAME);
  const d = decidirAcao("FATAL", estado({
    failoversAntesFirstFrame: LIMITES.FAILOVERS_APOS_FIRSTFRAME + 1,
  }));
  assert.equal(d.acao, "failover");
});

test("sem fonte seguinte, vira erro em vez de failover", () => {
  assert.equal(decidirAcao("FATAL", estado({ temProximaFonte: false })).acao, "erro");
});

// ── Auxiliares ──────────────────────────────────────────────────────────────

test("backoff cresce e satura no último degrau", () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 4000);
  assert.equal(backoffMs(2), 10000);
  assert.equal(backoffMs(99), 10000);
});

test("sourceId é estável e distingue fontes", () => {
  const a = sourceIdDe("https://v1.watchplay.shop/tvshow/1405/1/1");
  assert.equal(a, sourceIdDe("https://v1.watchplay.shop/tvshow/1405/1/1"));
  assert.notEqual(a, sourceIdDe("https://v1.watchplay.shop/tvshow/1405/1/2"));
  assert.match(a, /^[0-9a-f]{8}$/);
});
