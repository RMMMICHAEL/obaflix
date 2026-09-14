import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.NEXTAUTH_SECRET ??= "segredo-de-teste-da-sessao-da-tv-com-32-bytes-ou-mais";

import { renovarSessao, type BancoDeSessaoTv } from "../tvPairing";

/**
 * Rotação do refresh da TV, exercitada sem banco.
 *
 * O cenário que motivou este arquivo: o servidor gira o refresh, grava, e a
 * resposta se perde no caminho (timeout depois do commit). A TV continua com o
 * token antigo — já usado. A proteção contra reuso **tem** de continuar valendo
 * nesse caso, mesmo com o fingerprint certo: o fingerprint é hash de
 * identificadores do aparelho, não prova de posse.
 */

interface LinhaToken {
  id: string; tokenHash: string; deviceId: string; familia: string;
  criadoEm: Date; expiraEm: Date; usadoEm: Date | null; revogadoEm: Date | null;
}
interface LinhaDevice {
  id: string; userId: string; nome: string; modelo: string | null; fingerprint: string;
  revogadoEm: Date | null;
}

const FINGERPRINT = "a".repeat(64);
const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

function bancoEmMemoria() {
  const tokens: LinhaToken[] = [];
  const devices: LinhaDevice[] = [
    { id: "dev-1", userId: "user-1", nome: "Obaflix TV", modelo: "TV", fingerprint: FINGERPRINT, revogadoEm: null },
  ];
  let n = 0;

  const banco = {
    tvDevice: {
      upsert: async ({ where }: any) => {
        const d = devices.find(
          (x) => x.userId === where.userId_fingerprint.userId && x.fingerprint === where.userId_fingerprint.fingerprint,
        )!;
        d.revogadoEm = null;
        return { id: d.id, user: { role: "user" } };
      },
    },
    tvRefreshToken: {
      findUnique: async ({ where }: any) => {
        const t = tokens.find((x) => x.tokenHash === where.tokenHash);
        return t ? { ...t, device: devices.find((d) => d.id === t.deviceId)! } : null;
      },
      update: async ({ where, data }: any) => Object.assign(tokens.find((x) => x.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const alvo = tokens.filter((x) => x.familia === where.familia && x.revogadoEm === null);
        alvo.forEach((x) => Object.assign(x, data));
        return { count: alvo.length };
      },
      create: async ({ data }: any) => {
        const linha: LinhaToken = { id: `tok-${++n}`, criadoEm: new Date(), usadoEm: null, revogadoEm: null, ...data };
        tokens.push(linha);
        return linha;
      },
    },
  } as unknown as BancoDeSessaoTv;

  /** Um refresh válido emitido no pareamento. */
  function semear(token: string) {
    tokens.push({
      id: `tok-${++n}`, tokenHash: hash(token), deviceId: "dev-1", familia: "fam-1",
      criadoEm: new Date(), expiraEm: new Date(Date.now() + 86_400_000), usadoEm: null, revogadoEm: null,
    });
  }

  return { banco, tokens, devices, semear };
}

const args = (refreshToken: string, fingerprint = FINGERPRINT) =>
  ({ refreshToken, fingerprint, rede: "10.0.0.0/24", userAgent: "ObaflixTV/teste" });

describe("renovarSessao — rotação, reuso e perda de resposta", () => {
  let amb: ReturnType<typeof bancoEmMemoria>;
  beforeEach(() => {
    amb = bancoEmMemoria();
    amb.semear("refresh-original");
  });

  test("access vencido com refresh válido: rotação entrega um par novo e consome o antigo", async () => {
    const r = await renovarSessao(args("refresh-original"), amb.banco);
    assert.ok(r.ok);
    assert.notEqual(r.sessao.refreshToken, "refresh-original");
    assert.ok(r.sessao.accessToken.length > 0);
    assert.ok(amb.tokens.find((t) => t.tokenHash === hash("refresh-original"))!.usadoEm);

    const seguinte = await renovarSessao(args(r.sessao.refreshToken), amb.banco);
    assert.ok(seguinte.ok, "o sucessor renova normalmente");
  });

  test("resposta perdida após a rotação: reapresentar o antigo é reuso, mesmo com o fingerprint certo", async () => {
    const perdida = await renovarSessao(args("refresh-original"), amb.banco);
    assert.ok(perdida.ok, "o servidor girou e gravou");
    // A TV nunca recebeu `perdida.sessao`: continua com o token antigo.

    const reapresentado = await renovarSessao(args("refresh-original"), amb.banco);
    assert.deepEqual(reapresentado, { ok: false, motivo: "reuso" });

    // A família inteira caiu, inclusive o sucessor que se perdeu no caminho:
    // quem o tivesse interceptado também não consegue usá-lo.
    assert.ok(amb.tokens.every((t) => t.revogadoEm !== null));
    const sucessor = await renovarSessao(args(perdida.sessao.refreshToken), amb.banco);
    assert.equal(sucessor.ok, false);
  });

  test("reuso não vira aceito por insistência nem por janela de tempo", async () => {
    const r = await renovarSessao(args("refresh-original"), amb.banco);
    assert.ok(r.ok);
    for (let i = 0; i < 3; i++) {
      const outra = await renovarSessao(args("refresh-original"), amb.banco);
      assert.equal(outra.ok, false);
    }
  });

  test("aparelho revogado: recusa definitiva", async () => {
    amb.devices[0].revogadoEm = new Date();
    assert.deepEqual(await renovarSessao(args("refresh-original"), amb.banco), { ok: false, motivo: "revogado" });
  });

  test("fingerprint de outro aparelho: recusado sem consumir o token", async () => {
    const r = await renovarSessao(args("refresh-original", "b".repeat(64)), amb.banco);
    assert.deepEqual(r, { ok: false, motivo: "invalido" });
    assert.equal(amb.tokens[0].usadoEm, null, "o dono ainda pode renovar");
    assert.ok((await renovarSessao(args("refresh-original"), amb.banco)).ok);
  });

  test("refresh desconhecido e expirado são recusados", async () => {
    assert.deepEqual(await renovarSessao(args("nunca-emitido"), amb.banco), { ok: false, motivo: "invalido" });
    amb.tokens[0].expiraEm = new Date(Date.now() - 1);
    assert.deepEqual(await renovarSessao(args("refresh-original"), amb.banco), { ok: false, motivo: "expirado" });
  });
});
