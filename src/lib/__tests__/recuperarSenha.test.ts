import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";

import { enviarRecuperacaoDeSenha } from "../recuperarSenha";
import { emitirTokenDeAtivacao, consumirTokenDeAtivacao } from "../primeiroAcesso";
import type { MensagemDeEmail } from "../email/enviar";
import { readFileSync } from "node:fs";
import { credencialRevogada, revogarSessoesAposTrocaDeSenha } from "../sessionRevocation";
import { POST as recuperar } from "../../app/api/auth/recuperar/route";
import { POST as redefinir } from "../../app/api/auth/redefinir/route";

const pedir = (url: string, corpo: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" } });
const liberado = async () => ({ allowed: true, remaining: 1 });
const tokenDo = (m: MensagemDeEmail) => /#t=([A-Za-z0-9_-]{43})/.exec(m.texto)?.[1] ?? null;

describe("recuperação de senha", () => {
  test("o e-mail leva o link com token no fragmento e só o hash fica guardado", async () => {
    const enviadas: MensagemDeEmail[] = [];
    const r = await enviarRecuperacaoDeSenha({ userId: "r-1", email: "a@b.co" }, { base: "https://obaflixbr.com", enviar: async (m) => { enviadas.push(m); return { ok: true, simulado: true }; } });
    assert.equal(r.ok, true);
    const token = tokenDo(enviadas[0]);
    assert.ok(token);
    assert.ok(enviadas[0].texto.includes(`https://obaflixbr.com/redefinir-senha#t=${token}`));
    assert.equal(await consumirTokenDeAtivacao(token), "r-1");
  });

  test("base ausente ou insegura: não envia nada", async () => {
    let chamou = false;
    const enviar = async () => { chamou = true; return { ok: true as const, simulado: true }; };
    for (const base of [undefined, "http://obaflixbr.com", "https://u:p@obaflixbr.com", "https://obaflixbr.com/x"]) {
      const r = await enviarRecuperacaoDeSenha({ userId: "r-2", email: "a@b.co" }, { base: base ?? "", enviar });
      assert.equal(r.ok, false);
    }
    assert.equal(chamou, false);
  });

  test("o pedido responde 202 igual com e sem conta e só envia para conta existente", async () => {
    const enviados: string[] = [];
    const h = recuperar.createForTest({
      prisma: { user: { findUnique: async ({ where }: { where: { email: string } }) => (where.email === "existe@b.co" ? { id: "u-9", email: "existe@b.co" } : null) } } as never,
      enviar: async (c) => { enviados.push(c.email); return { ok: true, simulado: true }; },
      limitar: liberado,
    });
    const a = await h(pedir("/api/auth/recuperar", { email: "existe@b.co" }));
    const b = await h(pedir("/api/auth/recuperar", { email: "nao-existe@b.co" }));
    const c = await h(pedir("/api/auth/recuperar", { email: "lixo" }));
    assert.deepEqual([a.status, b.status, c.status], [202, 202, 202]);
    assert.deepEqual(await a.json(), await b.json());
    assert.deepEqual(enviados, ["existe@b.co"]);
  });

  test("limite estourado: 202 e nenhum envio", async () => {
    let enviou = false;
    const h = recuperar.createForTest({
      prisma: { user: { findUnique: async () => ({ id: "u", email: "x@b.co" }) } } as never,
      enviar: async () => { enviou = true; return { ok: true, simulado: true }; },
      limitar: async () => ({ allowed: false, remaining: 0 }),
    });
    assert.equal((await h(pedir("/api/auth/recuperar", { email: "x@b.co" }))).status, 202);
    assert.equal(enviou, false);
  });

  test("redefinir: troca a senha, o link é de uso único e senha fraca não queima o link", async () => {
    const gravado: Array<{ id: string; hash: string }> = [];
    const h = redefinir.createForTest({
      prisma: { user: { updateMany: async ({ where, data }: { where: { id: string }; data: { senhaHash: string } }) => { gravado.push({ id: where.id, hash: data.senhaHash }); return { count: 1 }; } } } as never,
      limitar: liberado,
    });
    const token = await emitirTokenDeAtivacao("u-reset");
    const fraca = await h(pedir("/api/auth/redefinir", { token, senha: "curta" }));
    assert.equal(fraca.status, 400);
    assert.equal(gravado.length, 0);
    const ok = await h(pedir("/api/auth/redefinir", { token, senha: "NovaSenha123" }));
    assert.equal(ok.status, 200);
    assert.equal(gravado[0].id, "u-reset");
    assert.equal(await bcrypt.compare("NovaSenha123", gravado[0].hash), true);
    const reuso = await h(pedir("/api/auth/redefinir", { token, senha: "OutraSenha123" }));
    assert.equal(reuso.status, 400);
    assert.equal(gravado.length, 1);
  });

  test("troca de senha encerra as sessões antigas e deixa entrar de novo na hora", async () => {
    const uid = `reset-sess-${Date.now()}`;
    const antes = Math.floor(Date.now() / 1000) - 5; // sessão aberta antes da troca
    assert.equal(await credencialRevogada(uid, antes), false);
    const h = redefinir.createForTest({ prisma: { user: { updateMany: async () => ({ count: 1 }) } } as never, limitar: liberado });
    const token = await emitirTokenDeAtivacao(uid);
    assert.equal((await h(pedir("/api/auth/redefinir", { token, senha: "NovaSenha123" }))).status, 200);
    assert.equal(await credencialRevogada(uid, antes), true, "sessão antiga continua valendo");
    assert.equal(await credencialRevogada(uid, undefined), true, "token legado sem authTime continua valendo");
    const novoLogin = Math.floor(Date.now() / 1000) + 1; // login com a senha nova, logo depois
    assert.equal(await credencialRevogada(uid, novoLogin), false, "login com a senha nova foi barrado");
    assert.equal(await credencialRevogada(`${uid}-outra`, antes), false, "outra conta não pode ser afetada");
  });

  test("sem confirmar a revogação a senha não muda", async () => {
    let gravou = false;
    const h = redefinir.createForTest({
      prisma: { user: { updateMany: async () => { gravou = true; return { count: 1 }; } } } as never,
      limitar: liberado,
      revogar: async () => { throw new Error("revogacao_nao_persistida"); },
    });
    const token = await emitirTokenDeAtivacao("u-sem-revogar");
    assert.equal((await h(pedir("/api/auth/redefinir", { token, senha: "NovaSenha123" }))).status, 503);
    assert.equal(gravou, false);
  });

  test("o reset administrativo também revoga antes de trocar a senha", async () => {
    const fonte = readFileSync("src/app/api/admin/reset-password/route.ts", "utf8");
    const revoga = fonte.indexOf("revogarSessoesAposTrocaDeSenha(user.id)");
    assert.ok(revoga > 0, "rota admin não chama a revogação");
    assert.ok(revoga < fonte.indexOf("prisma.user.update("), "revogação deve vir antes de gravar a senha");
    // a função em si: revoga só o que já existia
    const uid = `adm-${Date.now()}`;
    await revogarSessoesAposTrocaDeSenha(uid);
    assert.equal(await credencialRevogada(uid, Math.floor(Date.now() / 1000) - 10), true);
    assert.equal(await credencialRevogada(uid, Math.floor(Date.now() / 1000) + 1), false);
  });

  test("redefinir: token inválido, vazio ou com formato errado é recusado sem tocar no banco", async () => {
    let tocou = false;
    const h = redefinir.createForTest({ prisma: { user: { updateMany: async () => { tocou = true; return { count: 1 }; } } } as never, limitar: liberado });
    for (const token of ["", "x", "A".repeat(43), 123, null]) {
      assert.equal((await h(pedir("/api/auth/redefinir", { token, senha: "NovaSenha123" }))).status, 400);
    }
    assert.equal(tocou, false);
  });
});
