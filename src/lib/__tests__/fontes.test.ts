import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Regressão de 26/08/2026: reprodução parou com /fontes 410 e vários token 404.
 *
 * Causa: o cliente do Upstash desserializa a resposta, então `get` devolvia o
 * objeto onde a sessão de fontes esperava a string gravada. `JSON.parse` de
 * "[object Object]" lançava, `lerSessao` devolvia null e toda resolução falhava.
 *
 * O stub in-memory usado em desenvolvimento devolve string, então nenhum teste
 * local reproduzia produção. Estes testes rodam a mesma camada contra os DOIS
 * comportamentos de `get`, que é o que faltava.
 *
 * O `getRedis()` memoriza o cliente no primeiro uso, então aqui existe UM
 * cliente com o modo alternável, em vez de um por caso.
 */

type Entrada = { valor: string; expiraEm?: number };

const kv = new Map<string, Entrada>();
const chamadas = { get: 0, set: 0, expire: 0, ttl: 0 };
/** true reproduz o Upstash (JSON.parse na leitura); false, o stub de dev. */
let desserializa = false;

function limpar(modo: boolean) {
  kv.clear();
  chamadas.get = chamadas.set = chamadas.expire = chamadas.ttl = 0;
  desserializa = modo;
}

const clienteFalso = {
  async set(key: string, value: string | number, opts?: { ex?: number; nx?: boolean }) {
    chamadas.set++;
    if (opts?.nx && kv.has(key)) return null;
    kv.set(key, { valor: String(value), expiraEm: opts?.ex ? Date.now() + opts.ex * 1000 : undefined });
    return "OK" as const;
  },
  async get(key: string) {
    chamadas.get++;
    const e = kv.get(key);
    if (!e) return null;
    if (e.expiraEm && e.expiraEm < Date.now()) { kv.delete(key); return null; }
    // É exatamente aqui que produção divergia de desenvolvimento.
    if (desserializa) { try { return JSON.parse(e.valor); } catch { return e.valor; } }
    return e.valor;
  },
  async del(key: string) { return kv.delete(key) ? 1 : 0; },
  async incr() { return 1; },
  async expire(key: string, seconds: number) {
    chamadas.expire++;
    const e = kv.get(key);
    if (!e) return 0;
    e.expiraEm = Date.now() + seconds * 1000;
    return 1;
  },
  async ttl(key: string) {
    chamadas.ttl++;
    const e = kv.get(key);
    if (!e) return -2;
    return e.expiraEm ? Math.ceil((e.expiraEm - Date.now()) / 1000) : -1;
  },
  async zadd() { return 1; },
  async zrem() { return 1; },
  async zremrangebyscore() { return 0; },
  async zcard() { return 0; },
};

// Precisa estar no globalThis ANTES de fontes.ts pedir o cliente.
(globalThis as any).obaflixMemoryStore = clienteFalso;

const FONTES_BASE = [
  { embedUrl: "https://exemplo-a.test/e/1", provider: "alfa", servidor: "Alfa", idioma: null,
    tokenized: false, nativo: true, iframeDireto: false, iframeDesafio: false,
    iframeInvalido: false, semExtrator: false, disponivel: true },
  { embedUrl: "https://exemplo-b.test/e/2", provider: "beta", servidor: "Beta", idioma: "dub" as const,
    tokenized: false, nativo: false, iframeDireto: false, iframeDesafio: false,
    iframeInvalido: false, semExtrator: false, disponivel: true },
];

const logOriginal = console.log;
let m: typeof import("../fontes");

describe("sessao de fontes", () => {
  before(async () => {
    console.log = () => {};
    m = await import("../fontes");
  });
  after(() => { console.log = logOriginal; });

  for (const modo of [false, true]) {
    const rotulo = modo ? "cliente que desserializa (Upstash)" : "cliente que devolve string (dev)";

    test(`${rotulo}: cria, resolve e continua resolvendo`, async () => {
      limpar(modo);
      const fontes = m.numerar(FONTES_BASE);
      const sessao = await m.criarSessaoFontes("user-1", "web", fontes);
      assert.match(sessao, /^[A-Za-z0-9_-]{16,}$/);

      const r1 = await m.resolverFonte(sessao, "user-1", fontes[0].id);
      assert.equal(r1.motivo, undefined, "nao deve haver motivo de falha");
      assert.ok(r1.fonte, "a fonte deve resolver");
      assert.equal(r1.fonte!.embedUrl, FONTES_BASE[0].embedUrl);

      // NAO e de uso unico: o mesmo id resolve quantas vezes for preciso. Troca
      // manual, retry, failover e renovacao de token dependem disso.
      for (let i = 0; i < 4; i++) {
        const rn = await m.resolverFonte(sessao, "user-1", fontes[0].id);
        assert.ok(rn.fonte, `resolucao repetida ${i + 2} deve funcionar`);
      }

      const r2 = await m.resolverFonte(sessao, "user-1", fontes[1].id);
      assert.ok(r2.fonte);
      assert.equal(r2.fonte!.embedUrl, FONTES_BASE[1].embedUrl);
    });

    test(`${rotulo}: TTL desliza a cada leitura`, async () => {
      limpar(modo);
      const fontes = m.numerar(FONTES_BASE);
      const sessao = await m.criarSessaoFontes("user-1", "web", fontes);
      const antes = chamadas.expire;

      await m.resolverFonte(sessao, "user-1", fontes[0].id);
      assert.ok(
        chamadas.expire > antes,
        "cada leitura precisa renovar a expiracao — a sessao nao pode morrer com o usuario na tela",
      );
    });
  }

  test("motivo da falha e especifico, para a rota poder explicar o 410", async () => {
    limpar(true);
    const fontes = m.numerar(FONTES_BASE);
    const sessao = await m.criarSessaoFontes("user-1", "web", fontes);

    const outroDono = await m.resolverFonte(sessao, "user-2", fontes[0].id);
    assert.equal(outroDono.fonte, null);
    assert.equal(outroDono.motivo, "dono_diferente");

    const inexistente = await m.resolverFonte("x".repeat(22), "user-1", fontes[0].id);
    assert.equal(inexistente.motivo, "ausente");

    const malformada = await m.resolverFonte("curta", "user-1", fontes[0].id);
    assert.equal(malformada.motivo, "formato_invalido");

    // Id desconhecido numa sessao viva NAO e falha de sessao: sem motivo, para
    // o cliente seguir para a proxima fonte em vez de reabrir tudo.
    const idErrado = await m.resolverFonte(sessao, "user-1", "nao-existe");
    assert.equal(idErrado.fonte, null);
    assert.equal(idErrado.motivo, undefined);
  });

  test("crescimento da lista preserva os ids ja entregues", async () => {
    limpar(true);
    const fontes = m.numerar(FONTES_BASE);
    const sessao = await m.criarSessaoFontes("user-1", "web", fontes);

    const crescida = await m.acrescentarFontes(sessao, "user-1", [{
      embedUrl: "https://exemplo-c.test/e/3", provider: "gama", servidor: "Gama", idioma: null,
      tokenized: false, nativo: false, iframeDireto: false, iframeDesafio: false,
      iframeInvalido: false, semExtrator: false, disponivel: true,
    }]);
    assert.ok(crescida);
    assert.equal(crescida!.length, 3);
    assert.equal(crescida![0].id, fontes[0].id, "o id ja entregue ao cliente nao pode mudar");
    assert.equal(crescida![0].ordem, 1, "a numeracao ja exibida nao pode mudar");
    assert.equal(crescida![2].ordem, 3);

    const r = await m.resolverFonte(sessao, "user-1", fontes[0].id);
    assert.ok(r.fonte, "ids antigos continuam resolvendo depois do crescimento");
  });

  test("projecao publica nao carrega nada que identifique o provedor", async () => {
    const fontes = m.numerar(FONTES_BASE);
    const publica = m.projetarPublica(fontes[0]);
    const chaves = Object.keys(publica);
    for (const proibida of ["provider", "servidor", "host", "embedUrl", "videoId"]) {
      assert.ok(!chaves.includes(proibida), `projecao publica nao pode expor ${proibida}`);
    }
    assert.equal(publica.rotulo, "Servidor 1");
    assert.ok(!JSON.stringify(publica).includes("exemplo-a.test"));
  });
});
