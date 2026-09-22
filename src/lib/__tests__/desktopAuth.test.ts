import test from "node:test";
import assert from "node:assert/strict";
import {
  callbackDesktopSeguro,
  criarTicketDesktopAuth,
  desafioPkce,
  verificarPkce,
  verificarTicketDesktopAuth,
} from "@/lib/desktopAuth";

const SECRET = "s".repeat(48);
const VERIFIER = "V".repeat(43);
const CHALLENGE = desafioPkce(VERIFIER)!;
const STATE = "S".repeat(43);

test("ticket desktop e assinado, curto e preso ao callback", () => {
  const ticket = criarTicketDesktopAuth(
    { userId: "user_123", challenge: CHALLENGE, state: STATE, callbackUrl: "/checkout?planoId=plus" },
    SECRET,
    1_000_000,
  );
  const payload = verificarTicketDesktopAuth(ticket, SECRET, 1_001_000);
  assert.equal(payload?.sub, "user_123");
  assert.equal(payload?.ch, CHALLENGE);
  assert.equal(payload?.st, STATE);
  assert.equal(payload?.cb, "/checkout?planoId=plus");
});

test("ticket adulterado ou expirado e rejeitado", () => {
  const ticket = criarTicketDesktopAuth(
    { userId: "user_123", challenge: CHALLENGE, state: STATE, callbackUrl: "/desktop" },
    SECRET,
    1_000_000,
  );
  assert.equal(verificarTicketDesktopAuth(ticket + "x", SECRET, 1_001_000), null);
  assert.equal(verificarTicketDesktopAuth(ticket, SECRET, 1_000_000 + 181_000), null);
});

test("PKCE exige o verifier que originou o challenge", () => {
  assert.equal(verificarPkce(VERIFIER, CHALLENGE), true);
  assert.equal(verificarPkce("W".repeat(43), CHALLENGE), false);
});

test("callback do handoff nunca vira redirect externo", () => {
  assert.equal(callbackDesktopSeguro("/planos"), "/planos");
  assert.equal(callbackDesktopSeguro("//evil.example"), "/desktop");
  assert.equal(callbackDesktopSeguro("/\\evil.example"), "/desktop");
  assert.equal(callbackDesktopSeguro("https://evil.example"), "/desktop");
});
