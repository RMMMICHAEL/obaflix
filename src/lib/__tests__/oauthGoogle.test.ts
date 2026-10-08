import test, { before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import GoogleProvider from "next-auth/providers/google";
import { PGlite } from "@electric-sql/pglite";
import bcrypt from "bcryptjs";
import { encode, decode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { prisma } from "../prisma";
import { authOptions } from "../auth";
import { googleLinkAuthOptions } from "../googleLinkAuth";
import { googleAccountMutation, googleAccountState } from "../googleAccount";
import { getUserFromRequest } from "../authSession";
import { validateAuthVersion, decodeVersionedSession } from "../authVersion";
import { completeGoogleLink, findLinkedGoogleUser, saveLinkIntent } from "../oauthGoogleStore";
import { GOOGLE_ISSUER, LINK_COOKIE, hashOpaque, makeLinkIntent, matchesLinkIntent, newOpaque, validatedGoogleIdentity, validAccountMutation } from "../oauthGoogle";

// PostgreSQL in memory only. No DATABASE_URL or remote database is used.
// Match Prisma's UTC convention for PostgreSQL TIMESTAMP (without timezone).
const db = new PGlite({ parsers: { 1114: value => new Date(value + "Z") } });
const secret = newOpaque();
const origin = "https://web.test";
const actor = { userId: "local-a", sid: newOpaque(), authVersion: 0, origin };
const identity = { issuer: GOOGLE_ISSUER, subject: "synthetic-subject" } as const;
const claims = { iss: GOOGLE_ISSUER, sub: identity.subject, email_verified: true };
let passwordHash: string;
const restoreMethods: Array<() => void> = [];
const previousEnv = { url: process.env.NEXTAUTH_URL, secret: process.env.NEXTAUTH_SECRET, id: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };

// Small SQL-backed Prisma test adapter: production transaction functions run
// unchanged, against real PostgreSQL uniqueness/FK/rollback semantics.
function adapter(rawSql: { query: (text: string, args?: any[]) => Promise<any> }) {
  const sql = { query: (text: string, args?: any[]) => rawSql.query(text, args?.map(v => v instanceof Date ? v.toISOString() : v)) };
  function model(table: string) {
    async function select(where: Record<string, any> = {}) {
      const args: any[] = [];
      const clauses: string[] = [];
      for (const [key, value] of Object.entries(where.issuer_subject ? { ...where, ...where.issuer_subject } : where)) {
        if (key === "issuer_subject") continue;
        if (value === null) clauses.push(`"${key}" IS NULL`);
        else if (typeof value === "object" && !(value instanceof Date)) {
          const [op, operand] = Object.entries(value)[0];
          args.push(operand);
          clauses.push(`"${key}" ${op === "not" ? "<>" : ">"} $${args.length}`);
        } else { args.push(value); clauses.push(`"${key}" = $${args.length}`); }
      }
      return (await sql.query(`SELECT * FROM "${table}"${clauses.length ? " WHERE " + clauses.join(" AND ") : ""}`, args)).rows;
    }
    return {
      async findUnique({ where, select: projection }: any) {
        const row = (await select(where))[0] ?? null;
        if (row && projection?.user) row.user = (await sql.query('SELECT * FROM "User" WHERE "id"=$1', [row.userId])).rows[0];
        return row;
      },
      async findFirst({ where }: any) { return (await select(where))[0] ?? null; },
      async count({ where }: any) { return (await select(where)).length; },
      async create({ data }: any) {
        const row = { id: randomUUID(), ...data };
        const keys = Object.keys(row);
        return (await sql.query(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, Object.values(row))).rows[0];
      },
      async updateMany({ where, data }: any) {
        const rows = await select(where);
        for (const row of rows) {
          const values: any[] = [];
          const assignments = Object.entries(data).map(([k, v]: [string, any]) => {
            if (v?.increment) { values.push(v.increment); return `"${k}"="${k}"+$${values.length}`; }
            values.push(v); return `"${k}"=$${values.length}`;
          });
          values.push(row.id);
          await sql.query(`UPDATE "${table}" SET ${assignments.join(",")} WHERE "id"=$${values.length}`, values);
        }
        return { count: rows.length };
      },
      async update(input: any) { await this.updateMany(input); return (await select(input.where))[0]; },
    };
  }
  return {
    user: model("User"), oAuthIdentity: model("OAuthIdentity"), oAuthLinkIntent: model("OAuthLinkIntent"),
    $queryRaw: async (_strings: TemplateStringsArray, id: string) => sql.query('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE', [id]),
  };
}

before(async () => {
  process.env.NEXTAUTH_URL = origin;
  process.env.NEXTAUTH_SECRET = secret;
  process.env.GOOGLE_CLIENT_ID = "synthetic-client";
  process.env.GOOGLE_CLIENT_SECRET = "synthetic-secret";
  passwordHash = await bcrypt.hash("SyntheticPassword1", 4);
  await db.exec('CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "email" TEXT UNIQUE, "nome" TEXT, "avatar" TEXT, "role" TEXT, "senhaHash" TEXT);');
  await db.exec('CREATE TABLE "Assinatura" ("id" TEXT PRIMARY KEY, "userId" TEXT REFERENCES "User"("id") ON DELETE CASCADE, "status" TEXT); CREATE TABLE "WatchHistory" ("id" TEXT PRIMARY KEY, "userId" TEXT REFERENCES "User"("id") ON DELETE CASCADE, "progresso" INTEGER);');
  await db.exec(readFileSync("prisma/migrations/20261008000000_oauth_google_identity/migration.sql", "utf8"));
  const live = adapter(db);
  const transaction = prisma.$transaction;
  (prisma as any).$transaction = (fn: any) => db.transaction(tx => fn(adapter(tx)));
  restoreMethods.push(() => { prisma.$transaction = transaction; });
  for (const name of ["user", "oAuthIdentity", "oAuthLinkIntent"] as const) {
    for (const method of Object.keys(live[name])) {
      const model = prisma[name] as any;
      const original = model[method];
      model[method] = (live[name] as any)[method].bind(live[name]);
      restoreMethods.push(() => { model[method] = original; });
    }
  }
  mock.method(console, "info", () => {});
});

beforeEach(async () => {
  await db.exec('DELETE FROM "User";');
  for (const id of ["local-a", "local-b"]) {
    await db.query('INSERT INTO "User" ("id","email","nome","avatar","role","senhaHash") VALUES ($1,$2,$3,$4,$5,$6)',
      [id, id + "@example.invalid", "Local account", "local-avatar", "user", passwordHash]);
  }
  await db.query('INSERT INTO "Assinatura" VALUES ($1,$2,$3)', ["subscription", actor.userId, "ativa"]);
  await db.query('INSERT INTO "WatchHistory" VALUES ($1,$2,$3)', ["history", actor.userId, 100]);
});
after(async () => {
  mock.restoreAll();
  restoreMethods.forEach(restore => restore());
  for (const [key, value] of Object.entries({ NEXTAUTH_URL: previousEnv.url, NEXTAUTH_SECRET: previousEnv.secret, GOOGLE_CLIENT_ID: previousEnv.id, GOOGLE_CLIENT_SECRET: previousEnv.clientSecret })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await db.close();
});

async function request(body?: object, options: { actor?: typeof actor | null; origin?: string; handle?: string; version?: number } = {}) {
  const active = options.actor === undefined ? actor : options.actor;
  const token = active ? await encode({ secret, token: { id: active.userId, sid: active.sid, authVersion: options.version ?? active.authVersion, role: "user" } }) : null;
  const csrf = "a".repeat(64);
  const cookies = [`__Host-next-auth.csrf-token=${encodeURIComponent(csrf + "|" + hashOpaque(csrf + secret))}`];
  if (token) cookies.push(`__Secure-next-auth.session-token=${token}`);
  if (options.handle) cookies.push(`${LINK_COOKIE}=${options.handle}`);
  return new NextRequest(origin + "/api/account/google", {
    method: body ? "POST" : "GET", headers: { origin: options.origin ?? origin, cookie: cookies.join("; "), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify({ csrfToken: csrf, ...body }) } : {}),
  });
}

test("canonical issuer and verified identity, without dependence on email", () => {
  assert.deepEqual(validatedGoogleIdentity(claims), identity);
  assert.deepEqual(validatedGoogleIdentity({ ...claims, iss: "accounts.google.com", email: "changed@example.invalid" }), identity);
  for (const invalid of [{ ...claims, iss: "https://attacker.invalid" }, { ...claims, sub: "" }, { ...claims, email_verified: false }, { ...claims, email_verified: "true" }]) assert.equal(validatedGoogleIdentity(invalid), null);
});

test("intention binding, expiry, reauthentication, session switch and single use", () => {
  const now = new Date();
  const { intent, handle } = makeLinkIntent(actor, now);
  assert.equal(matchesLinkIntent(intent, actor, handle, now), true);
  for (const bad of [{ ...actor, userId: "local-b" }, { ...actor, sid: newOpaque() }, { ...actor, authVersion: 1 }, { ...actor, origin: "https://other.invalid" }]) assert.equal(matchesLinkIntent(intent, bad, handle, now), false);
  assert.equal(matchesLinkIntent(intent, actor, newOpaque(), now), false);
  assert.equal(matchesLinkIntent(intent, actor, handle, new Date(now.getTime() + 300000)), false);
  assert.equal(matchesLinkIntent({ ...intent, consumedAt: now }, actor, handle, now), false);
  assert.equal(matchesLinkIntent({ ...intent, expiresAt: new Date(now.getTime() + 600000), reauthenticatedAt: new Date(now.getTime() - 300001) }, actor, handle, now), false);
});

test("csrf requires signed cookie and exact origin, including scheme", () => {
  const csrf = "a".repeat(64);
  const valid = { origin, requestOrigin: origin, configuredOrigin: origin, csrfToken: csrf, csrfCookie: csrf + "|" + hashOpaque(csrf + secret), secret };
  assert.equal(validAccountMutation(valid), true);
  for (const override of [{ origin: null }, { origin: "http://web.test" }, { requestOrigin: "https://other.invalid" }, { csrfToken: "" }, { csrfCookie: "invalid" }, { secret: undefined }]) assert.equal(validAccountMutation({ ...valid, ...override }), false);
});

test("version zero compatibility and immediate revocation without accepting malformed versions", async () => {
  assert.equal(await validateAuthVersion({ id: actor.userId }, async () => 0), true);
  assert.equal(await validateAuthVersion({ id: actor.userId }, async () => 1), false);
  for (const value of [null, -1, "0", 1.5, NaN]) assert.equal(await validateAuthVersion({ id: actor.userId, authVersion: value }, async () => 0), false);
  const jwt = await encode({ secret, token: { id: actor.userId } });
  assert.ok(await decodeVersionedSession({ secret, token: jwt }));
  await db.query('UPDATE "User" SET "authVersion"=1 WHERE "id"=$1', [actor.userId]);
  assert.equal(await decodeVersionedSession({ secret, token: jwt }), null);
});

test("migration unique constraints reserve a revoked identity and limit active Google identities", async () => {
  await db.query('INSERT INTO "OAuthIdentity" ("id","userId","issuer","subject") VALUES ($1,$2,$3,$4)', ["link-1", actor.userId, identity.issuer, identity.subject]);
  await assert.rejects(db.query('INSERT INTO "OAuthIdentity" ("id","userId","issuer","subject") VALUES ($1,$2,$3,$4)', ["link-2", actor.userId, identity.issuer, "other-subject"]));
  await db.exec('UPDATE "OAuthIdentity" SET "revokedAt"=CURRENT_TIMESTAMP;');
  await assert.rejects(db.query('INSERT INTO "OAuthIdentity" ("id","userId","issuer","subject") VALUES ($1,$2,$3,$4)', ["link-3", "local-b", identity.issuer, identity.subject]));
  const rows = await db.query<{ authVersion: number }>('SELECT "authVersion" FROM "User"');
  assert.ok(rows.rows.every(row => row.authVersion === 0));
});

test("transaction links once, handles replay/concurrency and preserves local data", async () => {
  const before = (await db.query('SELECT * FROM "User" ORDER BY "id"')).rows;
  const subscriptions = (await db.query('SELECT * FROM "Assinatura"')).rows;
  const history = (await db.query('SELECT * FROM "WatchHistory"')).rows;
  const { intent, handle } = makeLinkIntent(actor);
  await saveLinkIntent(intent);
  const saved = (await db.query<any>('SELECT * FROM "OAuthLinkIntent"')).rows[0];
  assert.deepEqual({ handle: saved.handleHash === hashOpaque(handle), user: saved.userId === actor.userId, binding: saved.sessionBindingHash === hashOpaque(actor.sid), version: saved.authVersion === actor.authVersion, origin: saved.origin === actor.origin, unused: saved.consumedAt === null, notExpired: saved.expiresAt.getTime() > Date.now(), reauthenticated: saved.reauthenticatedAt.getTime() <= Date.now() }, { handle: true, user: true, binding: true, version: true, origin: true, unused: true, notExpired: true, reauthenticated: true });
  const results = await Promise.all([completeGoogleLink(actor, handle, identity), completeGoogleLink(actor, handle, identity)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await completeGoogleLink(actor, handle, identity), false);
  assert.deepEqual((await db.query('SELECT * FROM "User" ORDER BY "id"')).rows, before);
  assert.deepEqual((await db.query('SELECT * FROM "Assinatura"')).rows, subscriptions);
  assert.deepEqual((await db.query('SELECT * FROM "WatchHistory"')).rows, history);
  const linked = await findLinkedGoogleUser(identity);
  assert.equal(linked?.id, actor.userId);
  const repeat = makeLinkIntent(actor);
  await saveLinkIntent(repeat.intent);
  assert.equal(await completeGoogleLink(actor, repeat.handle, identity), true);
});

test("identity cannot transfer users, including after revocation", async () => {
  const first = makeLinkIntent(actor); await saveLinkIntent(first.intent);
  assert.equal(await completeGoogleLink(actor, first.handle, identity), true);
  const other = { ...actor, userId: "local-b" };
  const second = makeLinkIntent(other); await saveLinkIntent(second.intent);
  assert.equal(await completeGoogleLink(other, second.handle, identity), false);
  await db.exec('UPDATE "OAuthIdentity" SET "revokedAt"=CURRENT_TIMESTAMP;');
  assert.equal(await completeGoogleLink(other, second.handle, identity), false);
  assert.equal(await findLinkedGoogleUser(identity), null);
  const again = makeLinkIntent(actor); await saveLinkIntent(again.intent);
  assert.equal(await completeGoogleLink(actor, again.handle, identity), true);
});

test("missing and expired intents or changed session are refused without creating user", async () => {
  assert.equal(await completeGoogleLink(actor, newOpaque(), identity), false);
  const expired = makeLinkIntent(actor, new Date(Date.now() - 301000)); await saveLinkIntent(expired.intent);
  assert.equal(await completeGoogleLink(actor, expired.handle, identity), false);
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent);
  assert.equal(await completeGoogleLink({ ...actor, sid: newOpaque() }, pending.handle, identity), false);
  assert.equal((await db.query('SELECT * FROM "User"')).rows.length, 2);
});

test("only one active Google identity, including two users racing for the same subject", async () => {
  const otherActor = { ...actor, userId: "local-b", sid: newOpaque() };
  const first = makeLinkIntent(actor), second = makeLinkIntent(otherActor);
  await saveLinkIntent(first.intent); await saveLinkIntent(second.intent);
  const results = await Promise.all([completeGoogleLink(actor, first.handle, identity), completeGoogleLink(otherActor, second.handle, identity)]);
  assert.deepEqual(results.sort(), [false, true]);
  const owner = await findLinkedGoogleUser(identity);
  assert.ok(owner);
  const ownerActor = owner.id === actor.userId ? actor : otherActor;
  const attempt = makeLinkIntent(ownerActor); await saveLinkIntent(attempt.intent);
  assert.equal(await completeGoogleLink(ownerActor, attempt.handle, { ...identity, subject: "different-google" }), false);
});

test("Google role gate remains enforced on admin surface", async () => {
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent); await completeGoogleLink(actor, pending.handle, identity);
  const beforeSurface = process.env.OBAFLIX_SURFACE;
  try {
    process.env.OBAFLIX_SURFACE = "admin";
    assert.equal(await authOptions.callbacks!.signIn!({ user: {}, account: { provider: "google" }, profile: claims } as any), false);
    await db.query('UPDATE "User" SET "role"=$1 WHERE "id"=$2', ["admin", actor.userId]);
    assert.equal(await authOptions.callbacks!.signIn!({ user: {}, account: { provider: "google" }, profile: claims } as any), true);
  } finally {
    if (beforeSurface === undefined) delete process.env.OBAFLIX_SURFACE; else process.env.OBAFLIX_SURFACE = beforeSurface;
  }
});

test("password/session/origin/CSRF gate the real mutation handler", async () => {
  assert.equal((await googleAccountMutation(await request({ senha: "SyntheticPassword1" }, { actor: null }), "link")).status, 401);
  assert.equal((await googleAccountMutation(await request({ senha: "wrong" }), "link")).status, 403);
  assert.equal((await googleAccountMutation(await request({ senha: "SyntheticPassword1" }, { origin: "https://other.invalid" }), "link")).status, 403);
  assert.equal((await googleAccountMutation(await request({ senha: "SyntheticPassword1", csrfToken: "" }), "link")).status, 403);
  const good = await googleAccountMutation(await request({ senha: "SyntheticPassword1" }), "link");
  assert.equal(good.status, 200);
  const cookie = good.cookies.get(LINK_COOKIE);
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === "lax" && !cookie.domain && cookie.maxAge === 300);
  const row = (await db.query<{ handleHash: string }>('SELECT * FROM "OAuthLinkIntent"')).rows[0];
  assert.notEqual(row.handleHash, cookie.value);
  assert.equal(row.handleHash, hashOpaque(cookie.value));
});

test("unlink revokes identity, cancels intentions, deletes cookie and rejects old JWT", async () => {
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent);
  assert.equal(await completeGoogleLink(actor, pending.handle, identity), true);
  const otherPending = makeLinkIntent(actor); await saveLinkIntent(otherPending.intent);
  const oldJwt = await encode({ secret, token: { id: actor.userId, authVersion: 0 } });
  const result = await googleAccountMutation(await request({ senha: "SyntheticPassword1" }), "unlink");
  assert.equal(result.status, 200);
  assert.equal(result.cookies.get("__Secure-next-auth.session-token")?.maxAge, 0);
  assert.equal(await findLinkedGoogleUser(identity), null);
  assert.equal(await decodeVersionedSession({ secret, token: oldJwt }), null);
  assert.equal(await completeGoogleLink(actor, otherPending.handle, identity), false);
  const cookieName = authOptions.cookies!.sessionToken!.name;
  const api = new NextRequest(origin + "/api/user/history", { headers: { cookie: `${cookieName}.0=${oldJwt.slice(0, 50)}; ${cookieName}.1=${oldJwt.slice(50)}` } });
  assert.equal(await getUserFromRequest(api), null);
  const provider: any = authOptions.providers.find((p: any) => p.id === "credentials");
  const local = await provider.options.authorize({ email: "local-a@example.invalid", senha: "SyntheticPassword1" }, { headers: {} });
  const token = await authOptions.callbacks!.jwt!({ token: {}, user: local, account: { provider: "credentials" } } as any);
  assert.equal(token.authVersion, 1);
  assert.ok(await decodeVersionedSession({ secret, token: await encode({ secret, token }) }));
  const tvToken = await encode({ secret, token: { id: actor.userId, tv: true, did: "synthetic-device", role: "user" } });
  assert.equal((await getUserFromRequest(new NextRequest(origin + "/api/user/history", { headers: { authorization: `Bearer ${tvToken}` } })))?.deviceId, "synthetic-device");
});

test("unlink requires new password confirmation and refuses CSRF/origin/session bypass", async () => {
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent); await completeGoogleLink(actor, pending.handle, identity);
  for (const req of [
    await request({ senha: "SyntheticPassword1" }, { actor: null }),
    await request({ senha: "wrong" }),
    await request({ senha: "SyntheticPassword1", csrfToken: "" }),
    await request({ senha: "SyntheticPassword1" }, { origin: "https://other.invalid" }),
  ]) assert.notEqual((await googleAccountMutation(req, "unlink")).status, 200);
  assert.ok(await findLinkedGoogleUser(identity));
  assert.equal((await db.query<{ authVersion: number }>('SELECT "authVersion" FROM "User" WHERE "id"=$1', [actor.userId])).rows[0].authVersion, 0);
});

test("Google equality of email never signs in a pre-created local account", async () => {
  const user: any = { email: "local-a@example.invalid" };
  const result = await authOptions.callbacks!.signIn!({ user, account: { provider: "google" }, profile: { ...claims, email: user.email } } as any);
  assert.equal(result, "/login?error=GoogleLinkRequired");
  assert.equal((await db.query('SELECT * FROM "OAuthIdentity"')).rows.length, 0);
});

test("linked signIn and jwt preserve local identity when Google email changes", async () => {
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent);
  await completeGoogleLink(actor, pending.handle, identity);
  const user: any = { id: identity.subject, email: "changed@example.invalid", name: "Google name", image: "Google image" };
  assert.equal(await authOptions.callbacks!.signIn!({ user, account: { provider: "google" }, profile: { ...claims, email: user.email } } as any), true);
  const token = await authOptions.callbacks!.jwt!({ token: {}, user, account: { provider: "google" } } as any);
  assert.equal(token.id, actor.userId); assert.equal(token.sub, actor.userId);
  assert.equal(token.email, "local-a@example.invalid"); assert.equal(token.name, "Local account");
  assert.equal(token.picture, "local-avatar"); assert.equal(token.role, "user"); assert.equal(token.authVersion, 0);
  const tampered = await authOptions.callbacks!.jwt!({ token, trigger: "update", session: { id: "local-b", authVersion: 99, sid: "attacker" } } as any);
  assert.deepEqual(tampered, token);
});

test("credentials still authenticate and mint a private binding/version", async () => {
  const provider: any = authOptions.providers.find((p: any) => p.id === "credentials");
  const user = await provider.options.authorize({ email: "LOCAL-A@example.invalid", senha: "SyntheticPassword1" }, { headers: {} });
  assert.equal(user.id, actor.userId);
  assert.equal(await provider.options.authorize({ email: "local-a@example.invalid", senha: "wrong" }, { headers: {} }), null);
  const token = await authOptions.callbacks!.jwt!({ token: {}, user, account: { provider: "credentials" } } as any);
  assert.match(String(token.sid), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token.authVersion, 0);
});

test("dedicated callback keeps local session; absent/switched session and logout deny linking", async () => {
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent);
  const callback = async (req: NextRequest) => googleLinkAuthOptions(req).callbacks!.signIn!({ user: {}, account: { provider: "google-link" }, profile: claims } as any);
  assert.equal(await callback(await request(undefined, { actor: null, handle: pending.handle })), origin + "/conta/seguranca?google=denied");
  assert.equal(await callback(await request(undefined, { actor: { ...actor, sid: newOpaque() }, handle: pending.handle })), origin + "/conta/seguranca?google=denied");
  const req = await request(undefined, { handle: pending.handle });
  assert.equal(await callback(req), origin + "/conta/seguranca?google=linked");
  const cookie = req.cookies.get("__Secure-next-auth.session-token")!.value;
  assert.equal((await decode({ secret, token: cookie }))?.id, actor.userId);
  const next = makeLinkIntent(actor); await saveLinkIntent(next.intent);
  await googleLinkAuthOptions(req).events!.signOut!({ token: { id: actor.userId, sid: actor.sid } } as any);
  assert.equal(await callback(await request(undefined, { handle: next.handle })), origin + "/conta/seguranca?google=denied");
});

test("state endpoint returns no raw Google identity", async () => {
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent); await completeGoogleLink(actor, pending.handle, identity);
  const result = await googleAccountState(await request());
  assert.deepEqual(await result.json(), { linked: true });
});

test("database errors never place exception details in login redirects or logs", async t => {
  const previous = prisma.oAuthIdentity.findUnique;
  (prisma.oAuthIdentity as any).findUnique = async () => { throw new Error("synthetic-sensitive-material"); };
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  try {
    assert.equal(await authOptions.callbacks!.signIn!({ user: {}, account: { provider: "google" }, profile: claims } as any), "/login?error=GoogleLinkRequired");
    assert.deepEqual(logs, [["AUTH_ERROR"]]);
  } finally { prisma.oAuthIdentity.findUnique = previous; }
});

test("real NextAuth OIDC callback validates state, PKCE and signed ID token before linking, without minting session", async t => {
  const require = createRequire(resolve("package.json"));
  const { init } = require(resolve("node_modules/next-auth/core/init.js"));
  const { default: callback } = require(resolve("node_modules/next-auth/core/routes/callback.js"));
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  require(resolve("node_modules/next-auth/utils/logger.js")).setLogger(authOptions.logger, false);
  const checks = require(resolve("node_modules/next-auth/core/lib/oauth/checks.js"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic-key", use: "sig", alg: "RS256" };
  let discovery = "";
  let challenge = "";
  let wrongAudience = false;
  let tokenRequests = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer: GOOGLE_ISSUER, authorization_endpoint: discovery + "/authorize", token_endpoint: discovery + "/token", jwks_uri: discovery + "/jwks", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] }));
    } else if (req.url === "/jwks") res.end(JSON.stringify({ keys: [jwk] }));
    else if (req.url === "/token") {
      tokenRequests++;
      let body = ""; for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const verifier = params.get("code_verifier") ?? "";
      const { createHash } = require("node:crypto");
      if (createHash("sha256").update(verifier).digest("base64url") !== challenge) {
        res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" })); return;
      }
      const id_token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
        .setIssuer(GOOGLE_ISSUER).setSubject(identity.subject).setAudience(wrongAudience ? "other-client" : "synthetic-client")
        .setIssuedAt().setExpirationTime("5m").sign(privateKey);
      res.end(JSON.stringify({ access_token: "synthetic-access-token", token_type: "Bearer", id_token }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  discovery = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const pending = makeLinkIntent(actor); await saveLinkIntent(pending.intent);
  const req = await request(undefined, { handle: pending.handle });
  const factory = googleLinkAuthOptions(req);
  const link: any = factory.providers.find((p: any) => p.options?.id === "google-link");
  link.options.wellKnown = discovery + "/.well-known/openid-configuration";
  const { options } = await init({ authOptions: { ...factory, secret, useSecureCookies: true }, providerId: "google-link", action: "callback", origin, cookies: {}, isPost: false });
  const responseCookies: any[] = []; const authorization: any = {};
  await checks.state.create(options, responseCookies, authorization);
  await checks.pkce.create(options, responseCookies, authorization);
  challenge = authorization.code_challenge;
  const cookieJar = { ...Object.fromEntries(req.cookies.getAll().map(c => [c.name, c.value])), ...Object.fromEntries(responseCookies.map(c => [c.name, c.value])) };
  const invoke = (cookies: object, state = authorization.state) => callback({ options, query: { code: "synthetic-code", state }, method: "GET", cookies, sessionStore: { value: req.cookies.get("__Secure-next-auth.session-token")!.value } });
  const absentState = { ...cookieJar }; delete absentState[options.cookies.state.name];
  assert.match((await invoke(absentState)).redirect, /error=OAuthCallback/);
  assert.match((await invoke(cookieJar, "incorrect-state")).redirect, /error=OAuthCallback/);
  const absentPkce = { ...cookieJar }; delete absentPkce[options.cookies.pkceCodeVerifier.name];
  assert.match((await invoke(absentPkce)).redirect, /error=OAuthCallback/);
  const badPkce = { ...cookieJar, [options.cookies.pkceCodeVerifier.name]: "invalid-synthetic-cookie" };
  assert.match((await invoke(badPkce)).redirect, /error=OAuthCallback/);
  assert.equal(tokenRequests, 0);
  wrongAudience = true;
  assert.match((await invoke(cookieJar)).redirect, /error=OAuthCallback/);
  assert.equal(await findLinkedGoogleUser(identity), null);
  wrongAudience = false;
  const result = await invoke(cookieJar);
  assert.equal(result.redirect, origin + "/conta/seguranca?google=linked");
  assert.equal(result.cookies.some((c: any) => c.name.startsWith(options.cookies.sessionToken.name)), false);
  assert.equal((await findLinkedGoogleUser(identity))?.id, actor.userId);
  assert.equal((await invoke(cookieJar)).redirect, origin + "/conta/seguranca?google=denied");
  // Normal login uses the same validated OIDC chain and produces the local JWT.
  const google = GoogleProvider({ clientId: "synthetic-client", clientSecret: "synthetic-secret", wellKnown: discovery + "/.well-known/openid-configuration" });
  const { options: loginOptions } = await init({ authOptions: { ...authOptions, providers: [google], secret, useSecureCookies: true }, providerId: "google", action: "callback", origin, cookies: {}, isPost: false });
  const loginCookies: any[] = []; const loginAuthorization: any = {};
  await checks.state.create(loginOptions, loginCookies, loginAuthorization);
  await checks.pkce.create(loginOptions, loginCookies, loginAuthorization);
  challenge = loginAuthorization.code_challenge;
  const login = await callback({ options: loginOptions, query: { code: "synthetic-code", state: loginAuthorization.state }, method: "GET", cookies: Object.fromEntries(loginCookies.map(c => [c.name, c.value])), sessionStore: { value: "", chunk: (value: string) => [{ name: loginOptions.cookies.sessionToken.name, value }] } });
  const issued = login.cookies.find((c: any) => c.name === loginOptions.cookies.sessionToken.name);
  assert.ok(issued);
  const token = await decode({ token: issued.value, secret });
  assert.equal(token?.id, actor.userId); assert.equal(token?.email, "local-a@example.invalid");
  assert.equal(token?.authVersion, 0); assert.equal(token?.name, "Local account");
  assert.ok(logs.length >= 5);
  assert.ok(logs.every(args => args.length === 1 && args[0] === "AUTH_ERROR"));
});
