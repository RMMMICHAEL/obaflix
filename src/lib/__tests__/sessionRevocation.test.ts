// Revogação imediata de sessão — o fecho do gap do JWT stateless.
// Rodar com: npm run test:web
//
// Três camadas:
//   1. a regra pura (`credencialRevogada`, `revogarSessoesDoUsuario`), ancorada na
//      claim imutável `authTime`, inclusive os caminhos fail-closed;
//   2. a integração REAL pelos pontos compartilhados — `getUserFromRequest`
//      (cookie e Bearer de TV), o callback `session` de `auth.ts` e
//      `/api/playback/authorize`;
//   3. o rolling do NextAuth: um GET real em `/api/auth/session` RE-ENCODA o
//      cookie (reescrevendo `iat`), e provamos que a claim `authTime` sobrevive
//      intacta e que um cookie revogado NÃO se "lava" por atravessar o endpoint.

// getToken/NextAuth leem segredo e URL do ambiente; encode recebe o mesmo
// segredo. Definidos antes de qualquer import que resolva sessão. A URL http
// mantém `useSecureCookies=false` (cookie `next-auth.session-token`).
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret-at-least-32-chars-long-xxxxxx";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encode, decode } from "next-auth/jwt";
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
import { renovarSessao, type BancoDeSessaoTv } from "../tvPairing";
import { createRequire } from "node:module";

// `next-auth/core` não está no mapa de `exports` do pacote; carrega-se o arquivo
// CJS por caminho absoluto (fora da resolução de `exports`). É o MESMO núcleo que
// `/api/auth/session` executa — inclui o re-encode de rolling.
const { AuthHandler } = createRequire(import.meta.url)(
  join(process.cwd(), "node_modules/next-auth/core/index.js"),
) as { AuthHandler: (p: any) => Promise<any> };

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

/** Cookie de sessão com claim `authTime` — como o login real passa a emitir. */
const encodeCookie = (id: string, authTime: number, role = "user") =>
  encode({ token: { id, role, authTime }, secret: SECRET, maxAge: SESSION_MAX_AGE });

/**
 * Passa o cookie pela rota REAL de sessão do NextAuth, via `AuthHandler` (o mesmo
 * núcleo que `/api/auth/session` executa — `core/routes/session.ts`), e devolve o
 * cookie `next-auth.session-token` RE-EMITIDO mais o corpo. É aqui que o NextAuth
 * decodifica, roda `callbacks.jwt`/`callbacks.session` e re-encoda o token
 * (reescrevendo `iat` via `jose.setIssuedAt()`). Usa-se `AuthHandler` em vez do
 * handler do App Router porque este lê cookies de `next/headers`, indisponível
 * fora do escopo de request do Next; `AuthHandler` recebe os cookies direto.
 */
async function rolarSessao(jwt: string): Promise<{
  cookieNovo: string | null;
  cookieObj: { name: string; value: string; options?: any } | null;
  body: any;
}> {
  const internal: any = await AuthHandler({
    req: {
      action: "session",
      method: "GET",
      cookies: { "next-auth.session-token": jwt },
      headers: { host: "localhost:3000" },
    } as any,
    // `secret` é injetado aqui como o wrapper de rota do NextAuth faz antes de
    // chamar o AuthHandler (`options.secret ??= process.env.NEXTAUTH_SECRET`).
    options: { ...authOptions, secret: SECRET },
  });
  let cookieObj: { name: string; value: string; options?: any } | null = null;
  for (const c of (internal.cookies ?? []) as Array<{ name: string; value: string; options?: any }>) {
    if (c.name === "next-auth.session-token") cookieObj = c;
  }
  // `cookieNovo` só é um token USÁVEL se tiver valor não vazio. Um cookie de
  // limpeza (`sessionStore.clean()`) vem com value "" e expiração no passado.
  const cookieNovo = cookieObj && cookieObj.value ? cookieObj.value : null;
  const body = typeof internal.body === "string"
    ? (() => { try { return JSON.parse(internal.body); } catch { return {}; } })()
    : internal.body;
  return { cookieNovo, cookieObj, body };
}

const claims = (jwt: string) => decode({ token: jwt, secret: SECRET }) as Promise<Record<string, any> | null>;

// ── 1. A regra pura ────────────────────────────────────────────────────────────

describe("credencialRevogada: authTime contra o cutoff", () => {
  const redisFake = (valor: string | null): Pick<ReturnType<typeof getRedis>, "get"> => ({
    get: async () => valor,
  });

  test("sem marcador → válida (comportamento legítimo preservado)", async () => {
    assert.equal(await credencialRevogada("u1", agora(), redisFake(null)), false);
  });

  test("marcador presente + authTime <= cutoff → revogada", async () => {
    const cutoff = agora();
    assert.equal(await credencialRevogada("u1", cutoff, redisFake(String(cutoff))), true);
    assert.equal(await credencialRevogada("u1", cutoff - 1, redisFake(String(cutoff))), true);
  });

  test("marcador presente + authTime > cutoff → válida (login novo após falha de exclusão)", async () => {
    const cutoff = agora();
    assert.equal(await credencialRevogada("u1", cutoff + 5, redisFake(String(cutoff))), false);
  });

  test("marcador presente + authTime ausente/inválido → fail-closed", async () => {
    const cutoff = String(agora());
    for (const authTime of [undefined, null, NaN, Infinity, "123", {}]) {
      assert.equal(await credencialRevogada("u1", authTime, redisFake(cutoff)), true, `authTime=${String(authTime)}`);
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
    // authTime que uma requisição concorrente carimbaria durante a transação:
    for (const atraso of [1, 5, MAX_DURACAO_PLAUSIVEL, JANELA_CORRIDA_SEG]) {
      const authTimeConcorrente = base + atraso;
      assert.equal(
        await credencialRevogada(uid, authTimeConcorrente),
        true,
        `authTime = base + ${atraso}s (dentro da janela) tinha de ser revogado`,
      );
    }
  });

  test("passada a janela, um login novo (exclusão falhou) volta a valer — espera limitada", async () => {
    const uid = `recover-${Math.random()}`;
    const base = agora();
    await revogarSessoesDoUsuario(uid, base);
    // authTime após o fim da janela: só acontece se a conta ainda existe (exclusão
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
  test("cookie antigo com authTime <= cutoff é recusado após a exclusão", async () => {
    const uid = `ck-old-${Date.now()}`;
    const jwt = await encodeCookie(uid, agora() - 100); // authTime anterior ao cutoff
    await marcar(uid, agora() + 3600);
    assert.equal(await getUserFromRequest(cookieReq(jwt)), null);
  });

  test("sem marcador, o cookie legítimo continua autenticando", async () => {
    const uid = `ck-ok-${Date.now()}`;
    const jwt = await encodeCookie(uid, agora());
    const u = await getUserFromRequest(cookieReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "cookie", deviceId: null });
  });

  test("login novo (authTime > cutoff) volta a valer após uma exclusão que falhou", async () => {
    const uid = `ck-relogin-${Date.now()}`;
    await marcar(uid, agora() - 10); // cutoff no passado; exclusão falhou e a janela passou
    const jwt = await encodeCookie(uid, agora()); // login novo → authTime atual > cutoff
    const u = await getUserFromRequest(cookieReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "cookie", deviceId: null });
  });
});

describe("getUserFromRequest: Bearer de TV", () => {
  const tvJwt = (id: string, authTime: number) =>
    encode({ token: { id, role: "user", tv: true, did: "dev-1", authTime }, secret: SECRET, maxAge: 900 });

  test("Bearer de TV antigo (authTime <= cutoff) é recusado após a exclusão", async () => {
    const uid = `tv-old-${Date.now()}`;
    const jwt = await tvJwt(uid, agora() - 100);
    await marcar(uid, agora() + 3600);
    assert.equal(await getUserFromRequest(bearerReq(jwt)), null);
  });

  test("sem marcador, o Bearer de TV legítimo devolve o aparelho de origem", async () => {
    const uid = `tv-ok-${Date.now()}`;
    const jwt = await tvJwt(uid, agora());
    const u = await getUserFromRequest(bearerReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "bearer", deviceId: "dev-1" });
  });
});

// Ponta a ponta com o cutoff adiantado REAL (revogarSessoesDoUsuario), não um
// cutoff fixado à mão: a exclusão começou há poucos segundos (`base`) e uma
// requisição concorrente emite o token AGORA, com `iat` posterior ao `base`.
describe("getUserFromRequest: token emitido DURANTE a exclusão (corrida)", () => {
  test("login web concorrente (cookie com authTime=agora > base) é recusado", async () => {
    const uid = `race-web-${Date.now()}`;
    await revogarSessoesDoUsuario(uid, agora() - 5); // cutoff = agora+40, cobre authTime de agora
    const jwt = await encodeCookie(uid, agora());
    assert.equal(await getUserFromRequest(cookieReq(jwt)), null);
  });

  test("renovação de TV concorrente (Bearer com authTime=agora > base) é recusada", async () => {
    const uid = `race-tv-${Date.now()}`;
    await revogarSessoesDoUsuario(uid, agora() - 5);
    const jwt = await encode({ token: { id: uid, role: "user", tv: true, did: "dev-1", authTime: agora() }, secret: SECRET, maxAge: 900 });
    assert.equal(await getUserFromRequest(bearerReq(jwt)), null);
  });

  test("recuperação: passada a janela (exclusão falhou), o login novo autentica", async () => {
    const uid = `race-recover-${Date.now()}`;
    await revogarSessoesDoUsuario(uid, agora() - (JANELA_CORRIDA_SEG + 10)); // cutoff já no passado
    const jwt = await encodeCookie(uid, agora());
    const u = await getUserFromRequest(cookieReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "cookie", deviceId: null });
  });
});

describe("callback session: revogação LANÇA (core limpa e não re-encoda)", () => {
  const sessionBase = () => ({ user: { id: "x", role: "user", name: "N" } });

  test("conta revogada → o callback rejeita com SessaoRevogadaError", async () => {
    const uid = `ss-old-${Date.now()}`;
    await marcar(uid, agora() + 3600);
    await assert.rejects(
      async () => {
        await authOptions.callbacks!.session!({
          session: sessionBase(),
          token: { id: uid, role: "user", authTime: agora() - 100 },
        } as any);
      },
      /sessao_revogada/,
      "a sessão revogada precisa lançar para o core limpar o cookie e não re-encodar",
    );
  });

  test("sem marcador, o user permanece (não lança)", async () => {
    const uid = `ss-ok-${Date.now()}`;
    const out = await authOptions.callbacks!.session!({
      session: sessionBase(),
      token: { id: uid, role: "user", authTime: agora() },
    } as any);
    assert.equal((out as any).user.id, uid);
  });
});

// ── 3. Rolling do NextAuth: laundering do iat fechado ──────────────────────────
//
// `GET /api/auth/session` (jwt strategy) decodifica o cookie, roda os callbacks e
// RE-ENCODA o token via `jose.setIssuedAt()` — reescrevendo `iat`/`exp`/`jti` para
// agora — devolvendo o cookie novo no `Set-Cookie`. Se a revogação dependesse de
// `iat`, um cookie revogado se "lavaria" só por passar por aqui. A âncora é
// `authTime` (claim nossa, não tocada pelo encoder).

describe("NextAuth rolling: /api/auth/session e a sessão revogada", () => {
  test("sessão LEGÍTIMA (sem marcador) ainda rola, preservando authTime", async () => {
    const uid = `roll-ok-${Date.now()}`;
    const authTime = agora() - 100;
    const jwt = await encodeCookie(uid, authTime);
    const original = await claims(jwt);
    const { cookieNovo, body } = await rolarSessao(jwt);
    assert.equal(body?.user?.id, uid, "sessão legítima traz o user");
    assert.ok(cookieNovo, "o rolling reemite o cookie de uma sessão válida");
    assert.notEqual(cookieNovo, jwt, "o token foi re-encodado (string nova)");
    const novo = await claims(cookieNovo!);
    assert.equal(novo!.authTime, authTime, "authTime imutável através do re-encode");
    assert.notEqual(novo!.jti, original!.jti, "jti reescrito — prova do re-encode");
  });

  test("sessão REVOGADA não é re-encodada: sem user e cookie LIMPO (expirado)", async () => {
    const uid = `roll-rev-${Date.now()}`;
    const jwt = await encodeCookie(uid, agora() - 100);
    await marcar(uid, agora() + 3600); // conta excluída
    const { cookieNovo, cookieObj, body } = await rolarSessao(jwt);
    assert.equal(body?.user, undefined, "sessão revogada nunca traz user");
    assert.ok(!cookieNovo, "sessão revogada NÃO pode ser re-encodada num token usável");
    // E o cookie de sessão é expirado/limpo no Set-Cookie:
    assert.ok(cookieObj, "o core precisa emitir o cookie de limpeza");
    const exp = cookieObj!.options?.expires ? new Date(cookieObj!.options.expires).getTime() : 0;
    assert.ok(exp <= Date.now(), "o cookie revogado sai expirado (clean), não renovado");
  });

  test("múltiplos rollings nunca mantêm a sessão revogada viva", async () => {
    const uid = `roll-n-${Date.now()}`;
    const jwt = await encodeCookie(uid, agora() - 100);
    await marcar(uid, agora() + 3600);
    for (let i = 0; i < 3; i++) {
      const { cookieNovo } = await rolarSessao(jwt); // sempre o MESMO cookie velho: nunca há renovado
      assert.ok(!cookieNovo, `rolling ${i} não pode re-encodar a sessão revogada`);
    }
  });

  // RESURRECTION: o bug era o rolling renovar o `exp` de um cookie revogado, que
  // sobreviveria além do TTL de 31 dias do marcador; quando o marcador expirasse,
  // `credencialRevogada` veria "sem marcador" e o cookie renovado reautenticaria.
  // Prova sem esperar 31 dias: coleta todo cookie RENOVADO que o rolling produzir
  // e, após remover o marcador (expiração simulada), exige que não exista nenhum.
  test("resurrection fechada: nenhum cookie renovado sobrevive para reautenticar após o marcador expirar", async () => {
    const uid = `resurrect-${Date.now()}`;
    const original = await encodeCookie(uid, agora() - 100);
    await marcar(uid, agora() + 3600);
    const renovados: string[] = [];
    let atual = original;
    for (let i = 0; i < 4; i++) {
      const { cookieNovo } = await rolarSessao(atual);
      if (cookieNovo) { renovados.push(cookieNovo); atual = cookieNovo; }
    }
    // No HEAD anterior, o rolling re-encodava → `renovados` teria tokens válidos
    // que, após o marcador sumir, reautenticariam (resurrection). Agora: vazio.
    assert.equal(renovados.length, 0, "o rolling não pode produzir cookie renovado para sessão revogada");
    await getRedis().del(chaveRevogacao(uid)); // marcador "expira" (31 dias)
    for (const r of renovados) {
      assert.equal(await getUserFromRequest(cookieReq(r)), null, "nenhum cookie renovado reautentica pós-marcador");
    }
  });

  test("getServerSession (via AuthHandler) de sessão revogada → sem user, cookie limpo", async () => {
    const uid = `ss-rev-${Date.now()}`;
    const jwt = await encodeCookie(uid, agora() - 100);
    await marcar(uid, agora() + 3600);
    const { cookieNovo, cookieObj, body } = await rolarSessao(jwt);
    assert.equal(body?.user, undefined, "não autenticado: sem user");
    assert.ok(!cookieNovo, "não re-encoda");
    assert.ok(cookieObj, "cookie de limpeza presente");
  });
});

// ── 4. Token legado (anterior a este deploy, sem a claim authTime) ─────────────

describe("compatibilidade: token legado sem authTime", () => {
  test("SEM marcador continua funcionando (não expulsamos todo mundo no deploy)", async () => {
    const uid = `leg-ok-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    const u = await getUserFromRequest(cookieReq(jwt));
    assert.deepEqual(u, { userId: uid, role: "user", origem: "cookie", deviceId: null });
  });

  test("COM marcador (conta pediu exclusão) é recusado fail-closed", async () => {
    const uid = `leg-no-${Date.now()}`;
    const jwt = await encode({ token: { id: uid, role: "user" }, secret: SECRET, maxAge: SESSION_MAX_AGE });
    await marcar(uid, agora() + 3600);
    assert.equal(await getUserFromRequest(cookieReq(jwt)), null);
  });
});

// ── 5. TV: a claim na emissão + refresh pós-falha / pós-sucesso ────────────────

/** Banco falso que faz `renovarSessao` emitir uma sessão nova, sem Postgres. */
function bancoComRefresh(userId: string): BancoDeSessaoTv {
  return {
    tvRefreshToken: {
      findUnique: async () => ({
        id: "rt-1",
        familia: "fam-1",
        usadoEm: null,
        revogadoEm: null,
        expiraEm: new Date(Date.now() + 60 * 24 * 3600 * 1000),
        device: { id: "dev-1", userId, fingerprint: "a".repeat(64), modelo: "TV", revogadoEm: null },
      }),
      update: async () => ({}),
      create: async () => ({}),
    },
    tvDevice: {
      upsert: async () => ({ id: "dev-1", user: { role: "user" } }),
    },
  } as unknown as BancoDeSessaoTv;
}

/** Banco falso de conta já excluída: o refresh não existe mais. */
const bancoSemRefresh: BancoDeSessaoTv = {
  tvRefreshToken: { findUnique: async () => null },
} as unknown as BancoDeSessaoTv;

describe("TV: emissão e renovação com authTime", () => {
  const argsRenov = { fingerprint: "a".repeat(64), rede: "10.0.0", userAgent: "tv" };

  test("o access token emitido carrega a claim authTime", async () => {
    const r = await renovarSessao({ refreshToken: "x", ...argsRenov }, bancoComRefresh("u-tv-claim"));
    assert.ok(r.ok);
    const c = await claims(r.ok ? r.sessao.accessToken : "");
    assert.equal(typeof c!.authTime, "number", "authTime presente no Bearer de TV");
    assert.equal(c!.tv, true);
  });

  test("refresh após exclusão que FALHOU, passada a janela, volta a autenticar", async () => {
    const uid = "u-tv-recover";
    await marcar(uid, agora() - 10); // cutoff no passado (janela já passou)
    const r = await renovarSessao({ refreshToken: "x", ...argsRenov }, bancoComRefresh(uid));
    assert.ok(r.ok);
    const u = await getUserFromRequest(bearerReq(r.ok ? r.sessao.accessToken : ""));
    assert.equal(u?.userId, uid, "authTime novo > cutoff → autentica");
  });

  test("após exclusão BEM-SUCEDIDA o refresh não existe — renovação falha", async () => {
    const r = await renovarSessao({ refreshToken: "x", ...argsRenov }, bancoSemRefresh);
    assert.equal(r.ok, false);
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
