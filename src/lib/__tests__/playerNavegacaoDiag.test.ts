import test from "node:test";
import assert from "node:assert/strict";
import { registrarErroNavegacao, observarFaseNavegacao } from "../playerNavegacaoDiag";

test("diagnóstico conserva NotFoundError/removeChild e frames, sem URL, token ou path", () => {
  const mensagens: string[] = [];
  const original = console.error;
  console.error = texto => mensagens.push(texto);
  try {
    registrarErroNavegacao("episode:boundary", {
      name: "NotFoundError", message: "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node. https://private.example/media.mp4?token=SECRET _vercel_share=SHARE referer=https://private.example",
      stack: "NotFoundError\n    at commitDeletionEffects (https://preview.example/_next/static/chunks/abc-123.js:1:456)\n    at remove (https://private.example/jwplayer.js?token=SECRET:1:7)\n    at file:///C:/private/media.mp4?token=SECRET",
    });
  } finally { console.error = original; }
  const evento = JSON.parse(mensagens[0].slice("[diag/nav] ".length));
  assert.equal(evento.name, "NotFoundError");
  assert.match(evento.message, /removeChild/);
  assert.match(evento.stack, /commitDeletionEffects.*abc-123.js:1:456/);
  assert.doesNotMatch(mensagens[0], /SECRET|SHARE|private|preview|media\.mp4|https?:|file:|_vercel_share/);
});

test("observação de fase não mascara exceção síncrona nem rejeição real", async () => {
  const original = console.error;
  const info = console.info;
  console.error = console.info = () => {};
  try {
    const erro = new DOMException("Falha DOM", "NotFoundError");
    assert.throws(() => observarFaseNavegacao("cleanup-jw", () => { throw erro; }), e => e === erro);
    await assert.rejects(observarFaseNavegacao("cleanup-jw", () => Promise.reject(erro)), e => e === erro);
  } finally { console.error = original; console.info = info; }
});
