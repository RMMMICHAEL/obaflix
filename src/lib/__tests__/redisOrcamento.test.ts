import test from "node:test";
import assert from "node:assert/strict";

const calls: { script: string; keys: string[]; args: number[] }[] = [];
let result = 1, unavailable = false;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url, init) => {
  assert.equal(new URL(String(url)).hostname, "redis.invalid");
  const body = JSON.parse(String(init?.body));
  const pipeline = Array.isArray(body[0]);
  for (const command of pipeline ? body : [body]) {
    assert.equal(String(command[0]).toLowerCase(), "eval", "nenhum GET/SET separado");
    const count = Number(command[2]);
    calls.push({ script: command[1], keys: command.slice(3, 3 + count), args: command.slice(3 + count).map(Number) });
  }
  if (unavailable) throw new Error("Redis simulado indisponível");
  return new Response(JSON.stringify(pipeline ? body.map(() => ({ result })) : { result }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
test.after(() => { globalThis.fetch = fetchOriginal; });
process.env.UPSTASH_REDIS_REST_URL = "https://redis.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "token-falso";

test("adaptador Upstash reserva e liquida cada orçamento em um único EVAL", async () => {
  const { getRedis } = await import("../redis");
  const redis = getRedis();
  assert.equal(await redis.reserveBudget("mes", "reserva", 100, 1000, 3600), true);
  assert.equal(await redis.settleBudget("mes", "reserva", 25, 3600), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].keys, ["mes", "reserva"]);
  assert.deepEqual(calls[0].args, [100, 1000, 3600]);
  assert.deepEqual(calls[1].args, [25, 3600]);
  assert.match(calls[0].script, /Duplicate reservation/);
  assert.match(calls[1].script, /settled:/);
  result = 0;
  assert.equal(await redis.reserveBudget("mes", "outra", 100, 1000, 3600), false);
  assert.equal(await redis.settleBudget("mes", "ausente", 25, 3600), false);
  unavailable = true;
  await assert.rejects(redis.reserveBudget("mes", "falha", 100, 1000, 3600));
  await assert.rejects(redis.settleBudget("mes", "falha", 25, 3600));
  await assert.rejects(redis.reserveBudget("mes", "inválida", -1, 1000, 3600));
  await assert.rejects(redis.settleBudget("mes", "inválida", 25, 0));
});
