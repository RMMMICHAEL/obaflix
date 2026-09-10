import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Trava a regra que separa produção de desenvolvimento em `redis.ts`.
 *
 * O estado distribuído da reprodução — uso único de token, bloqueio por IP,
 * limite de streams simultâneos — só está correto se todas as instâncias
 * serverless enxergarem o MESMO Redis. Caindo para o stub in-memory, cada
 * instância teria o próprio estado e "uso único" deixaria de ser único.
 *
 * `getRedis()` já protege contra isso, e protegia antes deste arquivo existir.
 * O que faltava era impedir que a proteção fosse removida sem que nada
 * quebrasse: até aqui, apagar aquele `throw` passava no CI sem um único teste
 * vermelho. É esse o buraco que este arquivo fecha — ele não muda
 * comportamento nenhum em produção.
 *
 * Os dois casos compartilham UM módulo de propósito. `getRedis()` memoriza o
 * cliente em `_client`, mas o caminho de produção lança ANTES de memorizar, o
 * que deixa o módulo intacto para o caso seguinte. Por isso a ordem importa e
 * o caso de produção vem primeiro.
 */

// `process.env.NODE_ENV` é tipado como união literal pelo Next; escrever nele
// exige a visão crua do ambiente.
const env = process.env as Record<string, string | undefined>;

const original = {
  NODE_ENV: env.NODE_ENV,
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
};

function restaurar(chave: string, valor: string | undefined) {
  if (valor === undefined) delete env[chave];
  else env[chave] = valor;
}

let m: typeof import("../redis");

describe("getRedis: Redis distribuído é obrigatório em produção", () => {
  before(async () => {
    // Precisa estar ausente ANTES do primeiro getRedis(): é a configuração que
    // o teste reproduz — deploy de produção com a variável esquecida.
    delete env.UPSTASH_REDIS_REST_URL;
    delete env.UPSTASH_REDIS_REST_TOKEN;
    m = await import("../redis");
  });

  after(() => {
    restaurar("NODE_ENV", original.NODE_ENV);
    restaurar("UPSTASH_REDIS_REST_URL", original.url);
    restaurar("UPSTASH_REDIS_REST_TOKEN", original.token);
  });

  test("produção sem URL e sem token lança, em vez de cair para memória", () => {
    env.NODE_ENV = "production";
    assert.throws(
      () => m.getRedis(),
      /Redis distribuído obrigatório em produção/,
    );
  });

  test("a falha não é memorizada: a segunda chamada lança igual", () => {
    // Se o cliente quebrado fosse memorizado, a primeira requisição falharia e
    // as seguintes seguiriam com um cliente inválido — pior que falhar sempre.
    env.NODE_ENV = "production";
    assert.throws(
      () => m.getRedis(),
      /Redis distribuído obrigatório em produção/,
    );
  });

  test("fora de produção, o stub in-memory continua permitido", () => {
    env.NODE_ENV = "development";
    const cliente = m.getRedis();
    assert.equal(typeof cliente.set, "function");
    assert.equal(typeof cliente.get, "function");
  });
});
