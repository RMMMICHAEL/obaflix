// Revogação imediata de sessão — o fecho do gap do JWT stateless.
// Rodar com: npm run test:web
//
// Duas camadas:
//   1. a regra pura (`credencialRevogada`, `revogarSessoesDoUsuario`), inclusive
//      os caminhos fail-closed, com um Redis injetado;
//   2. a integração REAL pelos dois pontos compartilhados — `getUserFromRequest`
//      (cookie e Bearer de TV) e o callback `session` de `auth.ts` — e a prova de
//      que `/api/playback/authorize` com monetização OFF deixa de devolver
//      PERMITIDO para uma credencial revogada.

// getToken lê o segredo do ambiente; encode recebe o mesmo. Definido antes de
// qualquer import que resolva sessão.
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret-at-least-32-chars-long-xxxxxx";

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";

import {
  REVOGACAO_TTL_SEG,
  chaveRevogacao,
  credencialRevogada,
  revogarSessoesDoUsuario,
} from "../sessionRevocation";
import { getRedis } from "../redis";
import { getUserFromRequest } from "../authSession";
import { SESSION_MAX_AGE, authOptions } from "../auth";
import { POST as authorizePost } from "../../app/api/playback/authorize/route";

const SECRET = process.env.NEXTAUTH_SECRET!;
const agora = () => Math.floor(Date.now() / 1000);

/** Marca a conta como revogada com um cutoff explícito, direto no Redis de teste. */
async function marcar(userId: string, cutoff: number) {
  await getRedis().set(chaveRevogacao(userId), String(cutoff), { ex: REVOGACAO_TTL_SEG });
}

const cookieReq = (jwt: string) =>
  new NextRequest("http://local/api/x", { headers: { cookie: `next-auth.session-token=${jwt}` } });
const bearerReq = (jwt: string) =>
  new NextRequest("http://local/api/x", { headers: { authorization: `Bearer ${jwt}` } });

// ── 1. A regra pura ────────────────────────────────────────────────────────────

describe("credencialRevogada: iat contra o cutoff", () => {
  const redisFake = (valor: string | null): Pick<ReturnType<typeof getRedis>, "get"> => ({
    get: async () => valor,
  });

  test("sem marcador → válida (comportamento legítimo preservado)", async () => {
    assert.equal(await credencialRevogada("u1", agora(), redisFake(null)), false);
  });

  test("marcador presente + iat <= cutoff → revogada", async () => {
    const cutoff = agora();
    assert.equal(await credencialRevogada("u1", cutoff, redisFake(String(cutoff))), true);
    assert.equal(await credencialRevogada("u1", cutoff - 1, redisFake(String(cutoff))), true);
  });

  test("marcador presente + iat > cutoff → válida (login novo após falha de exclusão)", async () => {
    const cutoff = agora();
    assert.equal(await credencialRevogada("u1", cutoff + 5, redisFake(String(cutoff))), false);
  });

  test("marcador presente + iat ausente/ inválido → fail-closed", async () => {
    const cutoff = String(agora());
    for (const iat of [undefined, null, NaN, Infinity, "123", {}]) {
      assert.equal(await credencialRevogada("u1", iat, redisFake(cutoff)), true, `iat=${String(iat)}`);
    }
  });

  test("marcador corrompido (não numérico) → fail-closed", async () => {
    assert.equal(await credencialRevogada("u1", agora(), redisFake("lixo")), true);
  });

  test("erro de Redis nunca autoriza → fail-closed", async () => {
    const redisQuebra: Pick<ReturnType<typeof getRedis>, "get"> = {
      get: async () => {
        throw new Error("rede caiu");
      },
    };
    assert.equal(await credencialRevogada("u1", agora(), redisQuebra), true);
  });
});

describe("revogarSessoesDoUsuario: grava o cutoff e falha alto", () => {
  test("persiste o cutoff recuperável pela mesma chave", async () => {
    const uid = `rev-${Math.random()}`;
    const t = agora();
    await revogarSessoesDoUsuario(uid, t);
    assert.equal(await getRedis().get(chaveRevogacao(uid)), String(t));
  });

  test("lança quando o SET não confirma — a rota vira 503, não apaga nada", async () => {
    const redisNull: Pick<ReturnType<typeof getRedis>, "set"> = { set: async () => null };
    await assert.rejects(() => revogarSessoesDoUsuario("u1", agora(), redisNull));
  });

  test("a chave contém só o userId e o valor só o timestamp (sem PII)", () => {
    assert.equal(chaveRevogacao("abc"), "session:revoked:abc");
  });
});

describe("TTL do marcador é finito e cobre o token mais longevo", () => {
  test("REVOGACAO_TTL_SEG >= SESSION_MAX_AGE (30 dias) e é finito", () => {
    assert.ok(Number.isFinite(REVOGACAO_TTL_SEG));
    assert.ok(REVOGACAO_TTL_SEG >= SESSION_MAX_AGE, "precisa sobreviver ao cookie de 30 dias");
    // Margem de exatamente 1 dia sobre o teto do cookie.
    assert.equal(REVOGACAO_TTL_SEG, SESSION_MAX_AGE + 24 * 60 * 60);
  });
});

// ── 2. Integração pelos pontos compartilhados ──────────────────────────────────

describe("getUserFromRequest: cookie (site/Electron/móvel)", () => {
  test("cookie antigo com iat <= cutoff é recusado após a exclusão", async () => {
    const uid = `ck-old-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    await marcar(uid, agora() + 3600); // cutoff no futuro: garante iat <= cutoff
    assert.equal(await getUserFromRequest(cookieReq(jwt)), null);
  });

  test("sem marcador, o cookie legítimo continua autenticando", async () => {
    const uid = `ck-ok-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    const u = await getUserFromRequest(cookieReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "cookie", deviceId: null });
  });

  test("token NOVO (iat > cutoff) volta a valer após uma transação de exclusão que falhou", async () => {
    const uid = `ck-relogin-${Date.now()}`;
    await marcar(uid, agora() - 10); // cutoff gravado há 10s; a transação falhou depois
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    const u = await getUserFromRequest(cookieReq(jwt)); // login novo → iat atual > cutoff
    assert.deepEqual(u, { userId: uid, role: "user", origem: "cookie", deviceId: null });
  });
});

describe("getUserFromRequest: Bearer de TV", () => {
  test("Bearer de TV antigo (iat <= cutoff) é recusado após a exclusão", async () => {
    const uid = `tv-old-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user", tv: true, did: "dev-1" }, secret: SECRET, maxAge: 900 });
    await marcar(uid, agora() + 3600);
    assert.equal(await getUserFromRequest(bearerReq(jwt)), null);
  });

  test("sem marcador, o Bearer de TV legítimo devolve o aparelho de origem", async () => {
    const uid = `tv-ok-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user", tv: true, did: "dev-1" }, secret: SECRET, maxAge: 900 });
    const u = await getUserFromRequest(bearerReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "bearer", deviceId: "dev-1" });
  });
});

describe("callback session (getServerSession): revogação remove o user", () => {
  const sessionBase = () => ({ user: { id: "x", role: "user", name: "N" } });

  test("conta revogada perde o user — consumidores veem não autenticado", async () => {
    const uid = `ss-old-${Date.now()}`;
    await marcar(uid, agora() + 3600);
    const out = await authOptions.callbacks!.session!({
      session: sessionBase(),
      token: { id: uid, role: "user", iat: agora() },
    } as any);
    assert.equal((out as any).user, undefined);
  });

  test("sem marcador, o user permanece", async () => {
    const uid = `ss-ok-${Date.now()}`;
    const out = await authOptions.callbacks!.session!({
      session: sessionBase(),
      token: { id: uid, role: "user", iat: agora() },
    } as any);
    assert.equal((out as any).user.id, uid);
  });
});

describe("/api/playback/authorize: monetização OFF não libera credencial revogada", () => {
  const handler = authorizePost.createForTest({
    // getUserFromRequest NÃO é injetado: usa o real, com a revogação aplicada.
    monetizacaoAtiva: () => false,
    promocaoTvAtiva: () => false,
    anuncioAndroidAtivo: () => false,
    anuncioElectronAtivo: () => false,
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
  });

  const corpo = (jwt: string) =>
    new NextRequest("http://local/api/playback/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `next-auth.session-token=${jwt}` },
      body: JSON.stringify({ conteudoId: "filme-123", conteudoTipo: "filme" }),
    });

  test("cookie revogado → 401, nunca PERMITIDO (o blocker reportado, fechado)", async () => {
    const uid = `pb-old-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    await marcar(uid, agora() + 3600);
    const res = await handler(corpo(jwt));
    const json = (await res.json()) as { decisao?: string };
    assert.equal(res.status, 401);
    assert.notEqual(json.decisao, "PERMITIDO");
  });

  test("controle: cookie legítimo segue recebendo PERMITIDO com a flag off", async () => {
    const uid = `pb-ok-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    const res = await handler(corpo(jwt));
    const json = (await res.json()) as { decisao?: string };
    assert.equal(res.status, 200);
    assert.equal(json.decisao, "PERMITIDO");
  });
});
