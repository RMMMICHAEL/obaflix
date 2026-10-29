import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/meta-capi/teste/route";

const req = (corpo: unknown) => new NextRequest("https://obaflix.online/api/admin/meta-capi/teste", { method: "POST", headers: { "content-type": "application/json", host: "obaflix.online" }, body: JSON.stringify(corpo) });

test("exige admin: sem autorização nada é enviado", async () => {
  let enviou = false;
  const h = POST.createForTest({ requireAdmin: async () => new Response("no", { status: 401 }) as any, enviar: async () => { enviou = true; return { ok: true, recebidos: 1 }; } });
  assert.equal((await h(req({ testEventCode: "TESTE1" }))).status, 401);
  assert.equal(enviou, false);
});

test("valida o código; envia com ele; não vaza token", async () => {
  const usados: string[] = [];
  const h = POST.createForTest({ requireAdmin: async () => null, enviar: async (c: string) => { usados.push(c); return { ok: true, recebidos: 1 }; } });
  assert.equal((await h(req({}))).status, 400);
  assert.equal((await h(req({ testEventCode: "a b;" }))).status, 400);
  const ok = await h(req({ testEventCode: "TESTE1" }));
  assert.deepEqual([ok.status, await ok.json(), usados], [200, { ok: true, recebidos: 1 }, ["TESTE1"]]);
  const falha = await POST.createForTest({ requireAdmin: async () => null, enviar: async () => ({ ok: false, motivo: "configuracao" }) })(req({ testEventCode: "TESTE1" }));
  assert.equal(falha.status, 503);
});
