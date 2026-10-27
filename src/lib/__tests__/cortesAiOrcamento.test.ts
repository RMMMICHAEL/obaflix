import test from "node:test";
import assert from "node:assert/strict";
import { getRedis } from "../redis";
import { custoMaximoAnalise, gastoDoMes, liquidarGasto, reservarGasto } from "../cortesAi";

// Sempre memória: estes testes nunca devem usar credenciais ou serviços externos.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
const redis = getRedis();
const outubro = new Date("2026-10-31T23:59:59Z"), novembro = new Date("2026-11-01T00:00:00Z");

test("reservas simultâneas nunca ultrapassam o teto e liquidações não perdem gastos", async () => {
  const reservas = await Promise.all(Array.from({ length: 100 }, () => reservarGasto(redis, "concorrencia", 100, 1000, outubro)));
  const aceitas = reservas.filter((r) => r !== null);
  assert.equal(aceitas.length, 10);
  assert.equal(await gastoDoMes(redis, "concorrencia", outubro), 1000);
  await Promise.all(aceitas.map((r) => liquidarGasto(redis, r, 25)));
  assert.equal(await gastoDoMes(redis, "concorrencia", outubro), 250);
  assert.ok(await redis.ttl(aceitas[0].chave) > 31 * 24 * 3600);
});

test("liquidação idempotente preserva mês, usuário e gastos anteriores", async () => {
  await redis.set("cortesai:gasto:mes:2026-10", "200");
  const r = await reservarGasto(redis, "mes", 100, 1000, outubro);
  assert.ok(r);
  await liquidarGasto(redis, r, 40);
  await liquidarGasto(redis, r, 40);
  assert.equal(await gastoDoMes(redis, "mes", outubro), 240);
  assert.equal(await gastoDoMes(redis, "mes", novembro), 0);
  assert.equal(await gastoDoMes(redis, "outra-conta", outubro), 0);
  await assert.rejects(liquidarGasto(redis, r, 0));
  assert.equal(await gastoDoMes(redis, "mes", outubro), 240);
});

test("sem reserva, com contador corrompido ou custo acima do reservado não há estorno", async () => {
  const r = await reservarGasto(redis, "falhas", 100, 1000, outubro);
  assert.ok(r);
  await assert.rejects(liquidarGasto(redis, r, 101));
  assert.equal(await gastoDoMes(redis, "falhas", outubro), 100);
  await redis.del(r.reserva);
  await assert.rejects(liquidarGasto(redis, r, 1));
  assert.equal(await gastoDoMes(redis, "falhas", outubro), 100);
  await redis.set("cortesai:gasto:corrompido:2026-10", "inválido");
  await assert.rejects(reservarGasto(redis, "corrompido", 10, 1000, outubro));
  await assert.rejects(gastoDoMes(redis, "corrompido", outubro));
  await assert.rejects(reservarGasto(redis, "negativo", -1, 1000, outubro));
});

test("reserva conservadora acompanha os bytes do pedido, sem mudar limites do Gemini", () => {
  const curta = [{ id: 1, inicio: 0, fim: 10, texto: "Olá" }];
  assert.ok(custoMaximoAnalise(curta, "tema") >= 4096 * 2.5);
  assert.ok(custoMaximoAnalise([{ ...curta[0], texto: "á".repeat(1000) }], "tema") > custoMaximoAnalise(curta, "tema"));
  const expansivel = "ﷺ".repeat(100);
  assert.equal(custoMaximoAnalise([{ ...curta[0], texto: expansivel }], "tema"), custoMaximoAnalise([{ ...curta[0], texto: expansivel.normalize("NFKC") }], "tema"));
});
