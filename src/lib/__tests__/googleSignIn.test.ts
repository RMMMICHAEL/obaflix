import assert from "node:assert/strict";
import test from "node:test";
import { resolverContaGoogle, type PerfilGoogle, type RepoUsuarios, type UsuarioGoogle } from "../googleSignIn";

/** Banco em memória com a MESMA unicidade do real (e-mail e googleSub) e pausas que deixam pedidos se intercalarem. */
function bancoFalso(inicial: UsuarioGoogle[] = []) {
  const usuarios = new Map<string, UsuarioGoogle>(inicial.map((u) => [u.id, { ...u }]));
  let seq = 0;
  const pausa = () => new Promise((r) => setTimeout(r, 2));
  const repo: RepoUsuarios = {
    async porGoogleSub(sub) { await pausa(); return [...usuarios.values()].find((u) => u.googleSub === sub) ?? null; },
    async porEmail(email) { await pausa(); return [...usuarios.values()].find((u) => u.email === email) ?? null; },
    async criar(d) {
      await pausa();
      const dup = [...usuarios.values()].some((u) => u.email === d.email || (u.googleSub !== null && u.googleSub === d.googleSub));
      if (dup) throw Object.assign(new Error("unique"), { code: "P2002" });
      const u: UsuarioGoogle = { id: `u${++seq}`, email: d.email, nome: d.nome, avatar: d.avatar, role: "user", googleSub: d.googleSub };
      usuarios.set(u.id, u);
      return { ...u };
    },
    async vincularSub(id, sub) {
      await pausa();
      const u = usuarios.get(id);
      if (!u || u.googleSub !== null) return false;
      if ([...usuarios.values()].some((x) => x.googleSub === sub)) throw Object.assign(new Error("unique"), { code: "P2002" });
      u.googleSub = sub;
      return true;
    },
  };
  return { repo, usuarios };
}

const perfil = (extra: Partial<PerfilGoogle> = {}): PerfilGoogle => ({
  sub: "1234567890123456789", email: "Pessoa@Gmail.com", emailVerificado: true, nome: "Pessoa", foto: "https://lh3.example/p.jpg",
  dominioGerenciado: false, ...extra,
});
const antiga = (extra: Partial<UsuarioGoogle> = {}): UsuarioGoogle => ({
  id: "antiga", email: "pessoa@gmail.com", nome: "Pessoa", avatar: null, role: "user", googleSub: null, ...extra,
});

test("conta nova: cria sem senha, papel user, e-mail normalizado, e entrar de novo não duplica", async () => {
  const { repo, usuarios } = bancoFalso();
  const r = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(r.ok && r.acao === "criada");
  assert.equal(usuarios.size, 1);
  const u = [...usuarios.values()][0];
  assert.deepEqual([u.email, u.role, u.googleSub], ["pessoa@gmail.com", "user", "1234567890123456789"]);
  const deNovo = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(deNovo.ok && deNovo.acao === "entrou" && deNovo.usuario.id === u.id);
  assert.equal(usuarios.size, 1);
});

test("conta existente: vincula o sub mantendo o mesmo userId; depois entra pelo sub, mesmo com e-mail novo no Google", async () => {
  const { repo, usuarios } = bancoFalso([antiga()]);
  const r = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(r.ok && r.acao === "vinculada" && r.usuario.id === "antiga");
  assert.equal(usuarios.size, 1);
  const trocouEmail = await resolverContaGoogle(repo, perfil({ email: "outro@gmail.com" }), "public");
  assert.ok(trocouEmail.ok && trocouEmail.acao === "entrou" && trocouEmail.usuario.id === "antiga"); // o sub manda, não o e-mail
  assert.equal(usuarios.size, 1);
});

test("e-mail não verificado, sem e-mail e sub inválido nunca entram nem criam conta", async () => {
  const { repo, usuarios } = bancoFalso([antiga()]);
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ emailVerificado: false }), "public"), { ok: false, motivo: "email_nao_verificado" });
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ email: "  " }), "public"), { ok: false, motivo: "sem_email" });
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ sub: "x" }), "public"), { ok: false, motivo: "sem_identidade_google" });
  assert.equal(usuarios.size, 1);
  assert.equal(usuarios.get("antiga")!.googleSub, null);
});

test("domínio gerenciado (Workspace) nunca assume conta existente, mas pode abrir conta nova", async () => {
  const { repo, usuarios } = bancoFalso([antiga({ email: "pessoa@empresa.com.br" })]);
  const negado = await resolverContaGoogle(repo, perfil({ email: "pessoa@empresa.com.br", dominioGerenciado: true }), "public");
  assert.deepEqual(negado, { ok: false, motivo: "titularidade_nao_confiavel" });
  assert.equal(usuarios.get("antiga")!.googleSub, null);
  const nova = await resolverContaGoogle(repo, perfil({ email: "novo@empresa.com.br", dominioGerenciado: true, sub: "99999999999999999" }), "public");
  assert.ok(nova.ok && nova.acao === "criada");
});

test("conta já ligada a outro Google: conflito, sem duplicata e sem trocar o dono", async () => {
  const { repo, usuarios } = bancoFalso([antiga({ googleSub: "aaaaaaaaaaaaaaaaa" })]);
  const r = await resolverContaGoogle(repo, perfil(), "public");
  assert.deepEqual(r, { ok: false, motivo: "conflito_de_conta" });
  assert.equal(usuarios.size, 1);
  assert.equal(usuarios.get("antiga")!.googleSub, "aaaaaaaaaaaaaaaaa");
});

test("pedidos simultâneos do mesmo Google criam UMA conta só", async () => {
  const { repo, usuarios } = bancoFalso();
  const rs = await Promise.all([1, 2, 3, 4].map(() => resolverContaGoogle(repo, perfil(), "public")));
  assert.ok(rs.every((r) => r.ok));
  assert.equal(usuarios.size, 1);
  const ids = new Set(rs.map((r) => (r.ok ? r.usuario.id : "")));
  assert.equal(ids.size, 1);
  assert.equal(rs.filter((r) => r.ok && r.acao === "criada").length, 1);
});

test("dois Googles diferentes disputando a mesma conta antiga: só um vincula", async () => {
  const { repo, usuarios } = bancoFalso([antiga()]);
  const [a, b] = await Promise.all([
    resolverContaGoogle(repo, perfil({ sub: "sub-A-1234567890" }), "public"),
    resolverContaGoogle(repo, perfil({ sub: "sub-B-1234567890" }), "public"),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(usuarios.size, 1);
  assert.ok(["sub-A-1234567890", "sub-B-1234567890"].includes(usuarios.get("antiga")!.googleSub!));
});

test("superfície admin: ninguém novo entra e só admin existente passa", async () => {
  const { repo, usuarios } = bancoFalso([antiga({ id: "adm", email: "adm@x.com", role: "admin" }), antiga({ id: "comum", email: "comum@x.com" })]);
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ email: "novo@x.com" }), "admin"), { ok: false, motivo: "papel_nao_autorizado" });
  assert.equal(usuarios.size, 2);
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ email: "comum@x.com", sub: "sub-comum-123456" }), "admin"), { ok: false, motivo: "papel_nao_autorizado" });
  assert.ok((await resolverContaGoogle(repo, perfil({ email: "adm@x.com", sub: "sub-admin-123456" }), "admin")).ok);
});

test("conta excluída: entrar de novo com o Google abre uma conta NOVA, com outro id, sem ressuscitar a apagada", async () => {
  const { repo, usuarios } = bancoFalso();
  const primeira = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(primeira.ok);
  if (!primeira.ok) return;
  usuarios.delete(primeira.usuario.id); // exclusão de conta
  const depois = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(depois.ok && depois.acao === "criada" && depois.usuario.id !== primeira.usuario.id);
  assert.equal(usuarios.size, 1);
});

test("nome e foto vindos do Google são limitados e só https", async () => {
  const { repo } = bancoFalso();
  const r = await resolverContaGoogle(repo, perfil({ nome: "N".repeat(200), foto: "http://inseguro.example/f.jpg" }), "public");
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.usuario.nome!.length, 80); assert.equal(r.usuario.avatar, null); }
});
