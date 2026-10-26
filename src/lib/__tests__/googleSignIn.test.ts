import assert from "node:assert/strict";
import test from "node:test";
import { decidirLoginGoogle } from "../googleSignIn";

const base = { email: "a@b.c", emailVerificadoPeloGoogle: true, localRole: "user" as string | null, superficie: "public" as const };

test("login Google só passa com e-mail verificado e conta Obaflix existente", () => {
  assert.deepEqual(decidirLoginGoogle(base), { ok: true });
});

test("cada recusa tem um motivo próprio, na ordem das checagens", () => {
  assert.deepEqual(decidirLoginGoogle({ ...base, email: "" }), { ok: false, motivo: "sem_email" });
  assert.deepEqual(decidirLoginGoogle({ ...base, emailVerificadoPeloGoogle: false }), { ok: false, motivo: "email_nao_verificado" });
  assert.deepEqual(decidirLoginGoogle({ ...base, localRole: null }), { ok: false, motivo: "sem_conta_obaflix" });
  assert.deepEqual(decidirLoginGoogle({ ...base, superficie: "admin" }), { ok: false, motivo: "papel_nao_autorizado" });
  assert.deepEqual(decidirLoginGoogle({ ...base, superficie: "admin", localRole: "admin" }), { ok: true });
});

test("e-mail não verificado nunca vira acesso, mesmo com conta existente", () => {
  assert.equal(decidirLoginGoogle({ ...base, emailVerificadoPeloGoogle: false, localRole: "admin" }).ok, false);
});
