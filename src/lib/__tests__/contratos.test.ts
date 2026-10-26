import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const lê = (p: string) => readFileSync(p, "utf8");

test("contrato Google: googleSub único, migration aditiva e patch do NextAuth no build", () => {
  assert.match(lê("prisma/schema.prisma"), /googleSub\s+String\?\s+@unique/);
  const sql = lê("prisma/migrations/20261026120000_user_google_sub/migration.sql");
  assert.doesNotMatch(sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join(" "), /\b(DROP|DELETE|UPDATE|TRUNCATE)\b/i);
  const pkg = JSON.parse(lê("package.json")).scripts;
  assert.match(pkg.postinstall, /patch-next-auth-origin/);
  assert.match(pkg.build, /patch-next-auth-origin/);
});

test("contrato handoff: troca do ticket é de uso único e depois do PKCE", () => {
  const rota = lê("src/app/api/desktop-auth/exchange/route.ts");
  assert.ok(rota.includes("consumirTicketUmaVez"));
  assert.ok(rota.indexOf("verificarPkce(") < rota.indexOf("consumirTicketUmaVez("));
});

test("contrato Google: nenhuma busca por e-mail vincula sozinha conta com senha", () => {
  const g = lê("src/lib/googleSignIn.ts");
  assert.ok(g.includes("vincular_exige_senha") && g.includes("titularidade_nao_confiavel"));
});

test("contrato hosts oficiais", () => {
  const h = lê("src/lib/authHost.ts");
  for (const d of ["obaflix.vercel.app", "obaflixbr.com", "obaflix.online"]) assert.ok(h.includes(d), d);
});

test("contrato migrations: todas as migrations Google/aditivas recentes usam IF NOT EXISTS", () => {
  const dir = "prisma/migrations/20261026120000_user_google_sub";
  assert.ok(readdirSync(dir).includes("migration.sql"));
  assert.match(lê(`${dir}/migration.sql`), /IF NOT EXISTS/);
});

test("contrato Google nativo: rota valida o ID token no servidor e usa o mesmo resolvedor", () => {
  const rota = lê("src/app/api/desktop-auth/google-native/route.ts");
  assert.ok(rota.includes("verificarIdTokenGoogle") && rota.includes("resolverContaGoogle"));
  assert.ok(rota.includes("vinculoAutorizadoPara: null")); // sem vínculo por e-mail a conta com senha
  assert.ok(rota.indexOf("verificarIdTokenGoogle(") < rota.indexOf("criarTicketDesktopAuth("));
  const v = lê("src/lib/googleIdToken.ts");
  for (const c of ["RS256", "audiencias", "nonce", "exp"]) assert.ok(v.includes(c), c);
});
