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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";

import {
  REVOGACAO_TTL_SEG,
  JANELA_CORRIDA_SEG,
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

/**
 * `maxDuration` real da rota de exclusão, lido do fonte — é o teto da janela em
 * que a conta ainda existe depois de o cutoff ser gravado. Lido (não fixado) para
 * que um bump futuro de `maxDuration` quebre o teste se a janela não acompanhar.
 */
const MAX_DURACAO_PLAUSIVEL = (() => {
  const src = readFileSync(join(process.cwd(), "src/app/api/user/account/route.ts"), "utf8");
  const m = src.match(/export const maxDuration\s*=\s*(\d+)/);
  assert.ok(m, "maxDuration não encontrado na rota de exclusão");
  return Number(m![1]);
})();

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

describe("revogarSessoesDoUsuario: grava o cutoff ADIANTADO e falha alto", () => {
  test("persiste o cutoff = agora + JANELA_CORRIDA_SEG (não o 'agora' cru)", async () => {
    const uid = `rev-${Math.random()}`;
    const t = agora();
    await revogarSessoesDoUsuario(uid, t);
    assert.equal(await getRedis().get(chaveRevogacao(uid)), String(t + JANELA_CORRIDA_SEG));
  });

  test("lança quando o SET não confirma — a rota vira 503, não apaga nada", async () => {
    const redisNull: Pick<ReturnType<typeof getRedis>, "set"> = { set: async () => null };
    await assert.rejects(() => revogarSessoesDoUsuario("u1", agora(), redisNull));
  });

  test("a chave contém só o userId e o valor só o timestamp (sem PII)", () => {
    assert.equal(chaveRevogacao("abc"), "session:revoked:abc");
  });
});

// ── 1b. A corrida: token emitido DURANTE a exclusão ────────────────────────────
//
// Reproduz o blocker: a exclusão grava o cutoff e só depois roda a transação;
// enquanto a conta existe, um login/renovação concorrente emite um JWT com `iat`
// POSTERIOR ao instante do cutoff. Com cutoff cru (= agora) esse token teria
// `iat > cutoff` e sobreviveria — é o que estes testes provam estar fechado pelo
// cutoff adiantado. (Com `JANELA_CORRIDA_SEG = 0` o primeiro teste falharia,
// exatamente o comportamento do HEAD anterior à correção.)

describe("corrida de emissão concorrente durante a exclusão", () => {
  test("JWT emitido DEPOIS do cutoff gravado, mas DENTRO da janela, é revogado após o sucesso", async () => {
    const uid = `race-${Math.random()}`;
    const base = agora(); // instante em que a exclusão grava o cutoff
    await revogarSessoesDoUsuario(uid, base);
    // Token que uma requisição concorrente emitiria durante a transação:
    for (const atraso of [1, 5, MAX_DURACAO_PLAUSIVEL, JANELA_CORRIDA_SEG]) {
      const iatConcorrente = base + atraso;
      assert.equal(
        await credencialRevogada(uid, iatConcorrente),
        true,
        `iat = base + ${atraso}s (dentro da janela) tinha de ser revogado`,
      );
    }
  });

  test("passada a janela, um login novo (exclusão falhou) volta a valer — espera limitada", async () => {
    const uid = `recover-${Math.random()}`;
    const base = agora();
    await revogarSessoesDoUsuario(uid, base);
    // `iat` após o fim da janela: só acontece se a conta ainda existe (exclusão
    // falhou) e o relógio já passou do cutoff. Recuperação sem esperar 31 dias.
    assert.equal(await credencialRevogada(uid, base + JANELA_CORRIDA_SEG + 1), false);
  });

  test("a janela cobre o maxDuration da rota de exclusão (derivada, não arbitrária)", () => {
    assert.ok(JANELA_CORRIDA_SEG >= MAX_DURACAO_PLAUSIVEL, "a janela precisa cobrir toda a transação");
    assert.ok(Number.isFinite(JANELA_CORRIDA_SEG) && JANELA_CORRIDA_SEG > 0);
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

// Ponta a ponta com o cutoff adiantado REAL (revogarSessoesDoUsuario), não um
// cutoff fixado à mão: a exclusão começou há poucos segundos (`base`) e uma
// requisição concorrente emite o token AGORA, com `iat` posterior ao `base`.
describe("getUserFromRequest: token emitido DURANTE a exclusão (corrida)", () => {
  test("login web concorrente (cookie emitido agora, iat > base) é recusado", async () => {
    const uid = `race-web-${Date.now()}`;
    await revogarSessoesDoUsuario(uid, agora() - 5); // cutoff = agora+40, cobre o iat de agora
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    assert.equal(await getUserFromRequest(cookieReq(jwt)), null);
  });

  test("renovação de TV concorrente (Bearer emitido agora, iat > base) é recusada", async () => {
    const uid = `race-tv-${Date.now()}`;
    await revogarSessoesDoUsuario(uid, agora() - 5);
    const jwt = await encode({ token: { id: uid, role: "user", tv: true, did: "dev-1" }, secret: SECRET, maxAge: 900 });
    assert.equal(await getUserFromRequest(bearerReq(jwt)), null);
  });

  test("recuperação: passada a janela (exclusão falhou), o login novo autentica", async () => {
    const uid = `race-recover-${Date.now()}`;
    await revogarSessoesDoUsuario(uid, agora() - (JANELA_CORRIDA_SEG + 10)); // cutoff já no passado
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    const u = await getUserFromRequest(cookieReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "cookie", deviceId: null });
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
