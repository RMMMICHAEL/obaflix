/**
 * Race da seleção de canal: resposta atrasada de A não pode reselecionar A
 * depois que o usuário já escolheu B.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { criarSelecaoMaisRecente } from "../canais/selecaoMaisRecente";

/** Reproduz `abrir()`: espera a autorização e só então efetiva a seleção. */
function simularAbrir(
  guarda: ReturnType<typeof criarSelecaoMaisRecente>,
  canal: string,
  atrasoMs: number,
  efetivadas: string[],
) {
  const token = guarda.iniciar();
  return new Promise<void>((ok) =>
    setTimeout(() => {
      if (guarda.vale(token)) efetivadas.push(canal); // setSelecionado → /play
      ok();
    }, atrasoMs),
  );
}

test("A lento + B rápido: só B é efetivado; A atrasado é descartado", async () => {
  const guarda = criarSelecaoMaisRecente();
  const efetivadas: string[] = [];
  await Promise.all([simularAbrir(guarda, "A", 60, efetivadas), simularAbrir(guarda, "B", 5, efetivadas)]);
  assert.deepEqual(efetivadas, ["B"]);
});

test("A rápido + B lento: A pode aparecer, mas a seleção final é B", async () => {
  const guarda = criarSelecaoMaisRecente();
  const efetivadas: string[] = [];
  const a = simularAbrir(guarda, "A", 5, efetivadas);
  const b = simularAbrir(guarda, "B", 30, efetivadas);
  await Promise.all([a, b]);
  assert.equal(efetivadas.at(-1), "B");
  assert.ok(!efetivadas.includes("A"), "A já não é o mais recente quando responde");
});

test("seleção única continua valendo", async () => {
  const guarda = criarSelecaoMaisRecente();
  const efetivadas: string[] = [];
  await simularAbrir(guarda, "A", 5, efetivadas);
  assert.deepEqual(efetivadas, ["A"]);
});

test("vários cliques rápidos: só o último efetiva", async () => {
  const guarda = criarSelecaoMaisRecente();
  const efetivadas: string[] = [];
  await Promise.all(["A", "B", "C", "D"].map((c, i) => simularAbrir(guarda, c, 40 - i * 10, efetivadas)));
  assert.deepEqual(efetivadas, ["D"]);
});
