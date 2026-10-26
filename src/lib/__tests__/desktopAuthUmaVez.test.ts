import assert from "node:assert/strict";
import test from "node:test";
import { consumirTicketUmaVez, criarTicketDesktopAuth, verificarTicketDesktopAuth } from "../desktopAuth";

const SEGREDO = "s".repeat(40);
const redisFalso = () => {
  const usados = new Set<string>();
  return {
    usados,
    async set(key: string, _v: string, opts: { ex: number; nx: boolean }) {
      assert.ok(opts.nx && opts.ex >= 180);
      if (usados.has(key)) return null;
      usados.add(key);
      return "OK" as const;
    },
  };
};
const ticket = (user = "u1") =>
  criarTicketDesktopAuth({ userId: user, challenge: "c".repeat(43), state: "s".repeat(43), callbackUrl: "/desktop" }, SEGREDO);

test("ticket de uso único: a segunda troca do mesmo ticket é recusada, outro ticket segue valendo", async () => {
  const r = redisFalso();
  const t = ticket();
  assert.equal(await consumirTicketUmaVez(r, t), true);
  assert.equal(await consumirTicketUmaVez(r, t), false); // replay
  assert.equal(await consumirTicketUmaVez(r, ticket("u2")), true);
});

test("sem Redis a troca falha fechada", async () => {
  const quebrado = { async set() { throw new Error("redis fora"); } };
  assert.equal(await consumirTicketUmaVez(quebrado as never, ticket()), false);
});

test("o ticket expira em 180 s, é vinculado à conta e adulterá-lo o invalida", () => {
  const agora = Date.now();
  const t = criarTicketDesktopAuth({ userId: "u1", challenge: "c".repeat(43), state: "s".repeat(43), callbackUrl: "/desktop" }, SEGREDO, agora);
  assert.equal(verificarTicketDesktopAuth(t, SEGREDO, agora + 179_000)?.sub, "u1");
  assert.equal(verificarTicketDesktopAuth(t, SEGREDO, agora + 181_000), null); // expirado
  assert.equal(verificarTicketDesktopAuth(t, "x".repeat(40), agora), null); // outro segredo
  const [corpo, assinatura] = t.split(".");
  const outroCorpo = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(corpo, "base64url").toString()), sub: "u2" })).toString("base64url");
  assert.equal(verificarTicketDesktopAuth(`${outroCorpo}.${assinatura}`, SEGREDO, agora), null); // trocar a conta quebra a assinatura
});
