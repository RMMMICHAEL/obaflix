import assert from "node:assert/strict";
import test from "node:test";
import { resolverContaGoogle, type PerfilGoogle, type RepoUsuarios, type UsuarioGoogle } from "../googleSignIn";

/** Banco em memória com a MESMA unicidade do real (e-mail e googleSub) e pausas que deixam pedidos se intercalarem. */
function bancoFalso(inicial: UsuarioGoogle[] = []) {
  const usuarios = new Map<string, UsuarioGoogle>(inicial.map((u) => [u.id, { ...u }]));
  let seq = 0;
  const pausa = () => new Promise((r) => setTimeout(r, 2));
  const repo: RepoUsuarios = {
    async porGoogleSub(sub) { await pausa(); const u = [...usuarios.values()].find((x) => x.googleSub === sub); return u ? { ...u } : null; },
    async porEmail(email) { await pausa(); const u = [...usuarios.values()].find((x) => x.email === email); return u ? { ...u } : null; },
    async porId(id) { await pausa(); const u = usuarios.get(id); return u ? { ...u } : null; },
    async criar(d) {
      await pausa();
      const dup = [...usuarios.values()].some((u) => u.email === d.email || (u.googleSub !== null && u.googleSub === d.googleSub));
      if (dup) throw Object.assign(new Error("unique"), { code: "P2002" });
      const u: UsuarioGoogle = { id: `u${++seq}`, email: d.email, nome: d.nome, avatar: d.avatar, role: "user", googleSub: d.googleSub, temSenha: false };
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
/** Conta criada por /cadastro: tem senha. */
const comSenha = (extra: Partial<UsuarioGoogle> = {}): UsuarioGoogle => ({
  id: "antiga", email: "pessoa@gmail.com", nome: "Pessoa", avatar: null, role: "user", googleSub: null, temSenha: true, ...extra,
});
/** Conta sem senha (aberta pelo Google): ninguém a controla por senha. */
const semSenha = (extra: Partial<UsuarioGoogle> = {}): UsuarioGoogle => comSenha({ temSenha: false, ...extra });

test("conta nova: cria sem senha, papel user, e-mail normalizado, e entrar de novo não duplica", async () => {
  const { repo, usuarios } = bancoFalso();
  const r = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(r.ok && r.acao === "criada");
  assert.equal(usuarios.size, 1);
  const u = [...usuarios.values()][0];
  assert.deepEqual([u.email, u.role, u.googleSub, u.temSenha], ["pessoa@gmail.com", "user", "1234567890123456789", false]);
  const deNovo = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(deNovo.ok && deNovo.acao === "entrou" && deNovo.usuario.id === u.id);
  assert.equal(usuarios.size, 1);
});

test("PRÉ-SEQUESTRO: conta com senha e e-mail igual NÃO é vinculada sozinha; nada muda", async () => {
  const { repo, usuarios } = bancoFalso([comSenha()]);
  const r = await resolverContaGoogle(repo, perfil(), "public");
  assert.deepEqual(r, { ok: false, motivo: "vincular_exige_senha" });
  assert.equal(usuarios.size, 1);
  assert.equal(usuarios.get("antiga")!.googleSub, null);
});

test("vínculo AUTORIZADO pelo dono (senha confirmada): mantém o userId e vincula, mesmo com outro e-mail no Google", async () => {
  const { repo, usuarios } = bancoFalso([comSenha()]);
  const r = await resolverContaGoogle(repo, perfil({ email: "outro@gmail.com" }), "public", { vinculoAutorizadoPara: "antiga" });
  assert.ok(r.ok && r.acao === "vinculada" && r.usuario.id === "antiga" && r.usuario.temSenha);
  assert.equal(usuarios.size, 1);
  assert.equal(usuarios.get("antiga")!.googleSub, "1234567890123456789");
  // depois disso o Google entra sozinho, pelo sub
  const depois = await resolverContaGoogle(repo, perfil({ email: "qualquer@gmail.com" }), "public");
  assert.ok(depois.ok && depois.acao === "entrou" && depois.usuario.id === "antiga");
});

test("vínculo indevido: autorização de OUTRA conta, Google já de outra conta, ou conta inexistente", async () => {
  const { repo, usuarios } = bancoFalso([comSenha(), comSenha({ id: "b", email: "b@x.com", googleSub: "bbbbbbbbbbbbbbbbb" })]);
  // este Google já pertence à conta b; a autorização é para a conta antiga
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ sub: "bbbbbbbbbbbbbbbbb" }), "public", { vinculoAutorizadoPara: "antiga" }), { ok: false, motivo: "conflito_de_conta" });
  // a conta alvo já tem outro Google
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ sub: "ccccccccccccccccc" }), "public", { vinculoAutorizadoPara: "b" }), { ok: false, motivo: "conflito_de_conta" });
  // conta alvo não existe (apagada)
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ sub: "ddddddddddddddddd" }), "public", { vinculoAutorizadoPara: "fantasma" }), { ok: false, motivo: "conflito_de_conta" });
  assert.equal(usuarios.size, 2);
  assert.equal(usuarios.get("antiga")!.googleSub, null);
});

test("conta SEM senha (aberta pelo Google antes): vincula pelo e-mail verificado, mantendo o id", async () => {
  const { repo, usuarios } = bancoFalso([semSenha()]);
  const r = await resolverContaGoogle(repo, perfil(), "public");
  assert.ok(r.ok && r.acao === "vinculada" && r.usuario.id === "antiga");
  assert.equal(usuarios.size, 1);
});

test("e-mail não verificado, sem e-mail e sub inválido nunca entram nem criam conta, nem com autorização", async () => {
  const { repo, usuarios } = bancoFalso([comSenha()]);
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ emailVerificado: false }), "public"), { ok: false, motivo: "email_nao_verificado" });
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ emailVerificado: false }), "public", { vinculoAutorizadoPara: "antiga" }), { ok: false, motivo: "email_nao_verificado" });
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ email: "  " }), "public"), { ok: false, motivo: "sem_email" });
  assert.deepEqual(await resolverContaGoogle(repo, perfil({ sub: "x" }), "public"), { ok: false, motivo: "sem_identidade_google" });
  assert.equal(usuarios.size, 1);
  assert.equal(usuarios.get("antiga")!.googleSub, null);
});

test("domínio gerenciado (Workspace) nunca assume conta sem senha, mas pode abrir conta nova", async () => {
  const { repo, usuarios } = bancoFalso([semSenha({ email: "pessoa@empresa.com.br" })]);
  const negado = await resolverContaGoogle(repo, perfil({ email: "pessoa@empresa.com.br", dominioGerenciado: true }), "public");
  assert.deepEqual(negado, { ok: false, motivo: "titularidade_nao_confiavel" });
  assert.equal(usuarios.get("antiga")!.googleSub, null);
  const nova = await resolverContaGoogle(repo, perfil({ email: "novo@empresa.com.br", dominioGerenciado: true, sub: "99999999999999999" }), "public");
  assert.ok(nova.ok && nova.acao === "criada");
});

test("conta já ligada a outro Google: conflito, sem duplicata e sem trocar o dono", async () => {
  const { repo, usuarios } = bancoFalso([comSenha({ googleSub: "aaaaaaaaaaaaaaaaa" })]);
  assert.deepEqual(await resolverContaGoogle(repo, perfil(), "public"), { ok: false, motivo: "conflito_de_conta" });
  assert.equal(usuarios.size, 1);
  assert.equal(usuarios.get("antiga")!.googleSub, "aaaaaaaaaaaaaaaaa");
});

test("pedidos simultâneos do mesmo Google criam UMA conta só", async () => {
  const { repo, usuarios } = bancoFalso();
  const rs = await Promise.all([1, 2, 3, 4].map(() => resolverContaGoogle(repo, perfil(), "public")));
  assert.ok(rs.every((r) => r.ok));
  assert.equal(usuarios.size, 1);
  assert.equal(new Set(rs.map((r) => (r.ok ? r.usuario.id : ""))).size, 1);
  assert.equal(rs.filter((r) => r.ok && r.acao === "criada").length, 1);
});

test("dois Googles autorizados disputando a mesma conta: só um vincula", async () => {
  const { repo, usuarios } = bancoFalso([comSenha()]);
  const [a, b] = await Promise.all([
    resolverContaGoogle(repo, perfil({ sub: "sub-A-1234567890" }), "public", { vinculoAutorizadoPara: "antiga" }),
    resolverContaGoogle(repo, perfil({ sub: "sub-B-1234567890" }), "public", { vinculoAutorizadoPara: "antiga" }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(usuarios.size, 1);
  assert.ok(["sub-A-1234567890", "sub-B-1234567890"].includes(usuarios.get("antiga")!.googleSub!));
});

test("superfície admin: ninguém novo entra e só admin existente passa", async () => {
  const { repo, usuarios } = bancoFalso([
    semSenha({ id: "adm", email: "adm@x.com", role: "admin" }),
    semSenha({ id: "comum", email: "comum@x.com" }),
  ]);
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
