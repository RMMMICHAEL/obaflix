// Rate limit por usuário na fase 1 de /api/player/fontes.
// Rodar com: npm run test:web
//
// Dois níveis, mesma divisão que authSession.test.ts / ranking.test.ts já usam:
//
//  1. comportamento do primitivo `checkRateLimit` — que gateia login, cadastro,
//     player, like, watchlist e progresso (pentest SEC-07) e não tinha teste;
//  2. guarda de fiação: a rota chama `checkRateLimit` com chave por usuário,
//     DENTRO da fase 1 (depois do ramo de alternativas, antes de
//     `criarSessaoFontes`) e devolve 429. Sem NextAuth nem rede — a rota inteira
//     não é testável aqui pelo mesmo motivo documentado em authSession.test.ts.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Fake do Redis: precisa estar no globalThis ANTES de requestSecurity pedir o
//    cliente (mesmo padrão de fontes.test.ts). `incr`/`expire` são reais aqui,
//    ao contrário do stub de fontes.test.ts, que não os exercita.
function fakeRedis() {
  const kv = new Map<string, { value: string; expiresAt?: number }>();
  const calls = { incr: 0, expire: 0 };
  return {
    kv,
    calls,
    async incr(key: string) {
      calls.incr++;
      const atual = Number(kv.get(key)?.value ?? "0");
      const proximo = atual + 1;
      kv.set(key, { value: String(proximo), expiresAt: kv.get(key)?.expiresAt });
      return proximo;
    },
    async expire(key: string, seconds: number) {
      calls.expire++;
      const e = kv.get(key);
      if (!e) return 0;
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async get(key: string) {
      return kv.get(key)?.value ?? null;
    },
    async set() {
      return "OK" as const;
    },
    async del(key: string) {
      return kv.delete(key) ? 1 : 0;
    },
    async ttl() {
      return -1;
    },
    async zadd() {
      return 1;
    },
    async zrem() {
      return 1;
    },
    async zremrangebyscore() {
      return 0;
    },
    async zcard() {
      return 0;
    },
  };
}

const redisFalso = fakeRedis();
(globalThis as unknown as { obaflixMemoryStore?: unknown }).obaflixMemoryStore = redisFalso;

// ── 1. Comportamento do primitivo ────────────────────────────────────────────

describe("checkRateLimit", () => {
  let checkRateLimit: typeof import("../requestSecurity").checkRateLimit;

  before(async () => {
    checkRateLimit = (await import("../requestSecurity")).checkRateLimit;
  });

  test("libera exatamente `limit` chamadas e bloqueia a seguinte", async () => {
    redisFalso.kv.clear();
    const chave = `t1:${Math.random()}`;

    for (let i = 1; i <= 3; i++) {
      const r = await checkRateLimit(chave, 3, 60);
      assert.equal(r.allowed, true, `chamada ${i} dentro do limite deveria liberar`);
    }
    const quarta = await checkRateLimit(chave, 3, 60);
    assert.equal(quarta.allowed, false, "a 4ª chamada acima do limite deve bloquear");
    assert.equal(quarta.remaining, 0);
  });

  test("TTL é definido só na primeira chamada da janela", async () => {
    redisFalso.kv.clear();
    redisFalso.calls.expire = 0;
    const chave = `t2:${Math.random()}`;

    await checkRateLimit(chave, 5, 60);
    await checkRateLimit(chave, 5, 60);
    await checkRateLimit(chave, 5, 60);

    assert.equal(
      redisFalso.calls.expire,
      1,
      "expire só deve ser chamado quando a chave nasce — senão a janela nunca fecha",
    );
  });
});

// ── 2. Guarda de fiação da rota ──────────────────────────────────────────────

const ROTA_FONTES = "src/app/api/player/fontes/route.ts";
const ROTA_FONTE_NATIVA = "src/app/api/player/fonte-nativa/route.ts";

test("/api/player/fontes importa e usa checkRateLimit com chave por usuário", () => {
  const src = readFileSync(ROTA_FONTES, "utf8");

  assert.ok(
    /import\s*\{[^}]*\bcheckRateLimit\b[^}]*\}\s*from\s*["']@\/lib\/requestSecurity["']/.test(src),
    "a rota não importa checkRateLimit de @/lib/requestSecurity",
  );
  assert.ok(
    src.includes("checkRateLimit(`fontes:${userId}`"),
    "o rate limit precisa ter chave por usuário (`fontes:${userId}`)",
  );
});

test("/api/player/fontes: o rate limit está na fase 1 e devolve 429", () => {
  const src = readFileSync(ROTA_FONTES, "utf8");

  const iAlternativas = src.indexOf("corpo.alternativas === true");
  const iRateLimit = src.indexOf("checkRateLimit(`fontes:");
  const iCriarSessao = src.indexOf("await criarSessaoFontes(userId");

  assert.ok(iAlternativas > -1, "âncora do ramo de alternativas (fase 2) sumiu");
  assert.ok(iCriarSessao > -1, "âncora de criarSessaoFontes sumiu");
  assert.ok(
    iRateLimit > iAlternativas,
    "o rate limit ficou ANTES do ramo de alternativas — passaria a gatear a fase 2 também",
  );
  assert.ok(
    iRateLimit < iCriarSessao,
    "o rate limit ficou DEPOIS de abrir a sessão — não protege o fan-out caro",
  );

  const guarda = src.slice(iRateLimit, iCriarSessao);
  assert.ok(/!limite\.allowed/.test(guarda), "não há checagem de !limite.allowed");
  assert.ok(/status:\s*429/.test(guarda), "o bloqueio precisa responder 429");
});

test("/api/player/fonte-nativa mantém o próprio rate limit (regressão)", () => {
  const src = readFileSync(ROTA_FONTE_NATIVA, "utf8");
  assert.ok(
    src.includes("checkRateLimit(`fonte-nativa:${userId}`"),
    "o rate limit irmão de /fonte-nativa não pode ser removido junto",
  );
});
