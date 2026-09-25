/**
 * Teste de integração do edge de canais.
 *
 * Exercita `tratarCanal` — o handler real do Cloudflare Worker — com um Redis
 * falso e um `fetch` falso. É o oposto de testar a função de HMAC isolada: aqui
 * passam assinatura, nonce, grace, resolução de base, persistência obrigatória
 * e reescrita de manifesto, na mesma ordem em que passam em produção.
 *
 * O que estes testes travam, e que a revisão pegou faltando:
 *
 *   1. **O protocolo de handoff.** Grant A funciona; renovação gera B; B
 *      funciona; A continua valendo durante a grace e morre depois; apagar a
 *      sessão mata os dois no mesmo instante.
 *   2. **Persistência obrigatória de base nova.** Redis falhando ao gravar uma
 *      base descoberta não pode devolver manifesto — ele apontaria para um id
 *      que ninguém resolve.
 *   3. **Concorrência de descoberta.** Duas descobertas simultâneas não podem
 *      fazer um id apontar para a base errada.
 */

process.env.CANAIS_MEDIA_SIGNING_SECRET ||= "segredo-de-canais-para-teste";

import assert from "node:assert/strict";
import test from "node:test";

import {
  criarSessaoDeCanal,
  renovarSessaoDeCanal,
  encerrarSessao,
  lerSessao,
  assinaturaConfere,
  GRACE_HANDOFF_S,
} from "../canais/sessao";
import { chaveDaBase, chaveDaSessao } from "../canais/assinatura";
import {
  tratarCanal,
  __limparCachesDeBase,
  type EnvCanais,
} from "../../../workers/media-proxy/src/canais";

// ── Redis falso, falando o dialeto REST do Upstash ───────────────────────────

/**
 * O Worker fala com o Upstash por HTTP. Em vez de um cliente falso, o teste
 * intercepta o `fetch` — assim o caminho exercitado é o mesmo de produção,
 * incluindo a serialização do comando e o tratamento de `!r.ok`.
 */
class RedisFalso {
  readonly dados = new Map<string, string>();
  /** Quando `true`, todo SET falha. Simula Redis fora do ar na escrita. */
  falharEscrita = false;
  escritas: string[] = [];

  executar(cmd: (string | number)[]): { ok: boolean; result: unknown } {
    const [verbo, chave] = cmd as [string, string];
    if (verbo === "GET") return { ok: true, result: this.dados.get(chave) ?? null };
    if (verbo === "SET") {
      if (this.falharEscrita) return { ok: false, result: null };
      this.escritas.push(chave);
      this.dados.set(chave, String(cmd[2]));
      return { ok: true, result: "OK" };
    }
    if (verbo === "DEL") {
      this.dados.delete(chave);
      return { ok: true, result: 1 };
    }
    return { ok: true, result: null };
  }
}

const REDIS_URL = "https://redis.example.test";
const EDGE = "https://media.example.test";
const CDN = "https://cdn.example.test";
const PLAYER = "https://player.example.test";

const ENV: EnvCanais = {
  ASSINATURA_SECRET: process.env.CANAIS_MEDIA_SIGNING_SECRET!,
  CDN_ALLOWLIST: "cdn.example.test,segmentos.example.test,outro.example.test",
  CANAIS_PLAYER_ALLOWLIST: "player.example.test",
  APP_ORIGIN: "https://app.example.test",
  CANAIS_MEDIA_BASE: EDGE,
  UPSTASH_REDIS_REST_URL: REDIS_URL,
  UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
};

/** Manifesto de live no formato que a Fase A mediu: segmento absoluto, outro host. */
const MANIFESTO_UPSTREAM = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-MEDIA-SEQUENCE:1271",
  "#EXT-X-TARGETDURATION:11",
  "#EXTINF:10.0,",
  "https://segmentos.example.test/assets/a1.css",
  "#EXTINF:10.0,",
  "https://segmentos.example.test/assets/a2.css",
].join("\n");

interface Ambiente {
  redis: RedisFalso;
  /** Cada URL upstream buscada, na ordem. */
  buscas: string[];
  restaurar: () => void;
  /** Corpo que o CDN devolve. Trocável por cenário. */
  corpoDoManifesto: string;
  /**
   * Fila de corpos, consumida em ordem, para cenários em que duas requisições
   * precisam receber manifestos diferentes. Vazia, vale `corpoDoManifesto`.
   */
  filaDeManifestos: string[];
}

function montarAmbiente(): Ambiente {
  const redis = new RedisFalso();
  const buscas: string[] = [];
  const original = globalThis.fetch;
  const amb: Ambiente = {
    redis,
    buscas,
    corpoDoManifesto: MANIFESTO_UPSTREAM,
    filaDeManifestos: [],
    restaurar: () => {
      globalThis.fetch = original;
    },
  };

  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof entrada === "string" ? entrada : entrada.toString();

    if (url === REDIS_URL) {
      const cmd = JSON.parse(String(init?.body)) as (string | number)[];
      const r = redis.executar(cmd);
      return new Response(JSON.stringify({ result: r.result }), { status: r.ok ? 200 : 500 });
    }

    buscas.push(url);

    if (url.startsWith(PLAYER)) return new Response("<html>arm</html>", { status: 200 });

    if (url.startsWith(CDN)) {
      const corpo = amb.filaDeManifestos.shift() ?? amb.corpoDoManifesto;
      return new Response(corpo, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    if (url.startsWith("https://segmentos.example.test")) {
      return new Response("TS", { status: 200, headers: { "Content-Type": "text/css" } });
    }
    return new Response("nao encontrado", { status: 404 });
  }) as typeof fetch;

  return amb;
}

/**
 * `criarSessaoDeCanal` grava no Redis do backend (stub in-memory de
 * `src/lib/redis.ts`); o Worker lê do Redis falso. Esta ponte copia a linha de
 * um para o outro, que é o que o Upstash faria de verdade.
 */
async function publicarSessaoNoEdge(redis: RedisFalso, sessionId: string) {
  const sessao = await lerSessao(sessionId);
  assert.ok(sessao, "a sessão precisa existir no backend");
  redis.dados.set(chaveDaSessao(sessionId), JSON.stringify(sessao));
}

const FONTE = {
  streamUrl: `${CDN}/live/master.m3u8`,
  paginaDoPlayer: `${PLAYER}/c.php?id=x`,
  referer: null,
  userAgent: null,
  expiresAt: null,
};

function urlDoManifesto(sessionId: string, exp: number, sig: string): string {
  return `${EDGE}/canal/${sessionId}/master.m3u8?e=${exp}&k=${sig}`;
}

/** Extrai as URLs de segmento de um manifesto já reescrito. */
function segmentosDe(manifesto: string): string[] {
  return manifesto.split("\n").filter((l) => l.startsWith(`${EDGE}/canal/`));
}

// ── 1. O protocolo de handoff, ponta a ponta ─────────────────────────────────

test("handoff: grant A → renovação → grant B, com grace e revogação", async (t) => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-1", fonte: FONTE });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    let segmentosDeA: string[] = [];

    await t.test("manifesto A funciona e não vaza o upstream", async () => {
      const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
      assert.equal(r.status, 200);
      const corpo = await r.text();
      assert.equal(corpo.includes("segmentos.example.test"), false, "vazou o host do CDN");
      assert.equal(corpo.includes("cdn.example.test"), false);
      segmentosDeA = segmentosDe(corpo);
      assert.equal(segmentosDeA.length, 2);
      // A base foi persistida antes de o manifesto sair.
      assert.ok(amb.redis.escritas.some((k) => k.startsWith("canal:base:")));
    });

    await t.test("segmentos de A funcionam", async () => {
      for (const seg of segmentosDeA) {
        const r = await tratarCanal(new Request(seg), ENV);
        assert.equal(r.status, 200, `segmento de A recusado: ${r.status}`);
      }
    });

    // ── A renovação ────────────────────────────────────────────────────────
    const B = await renovarSessaoDeCanal({
      userId: "dono",
      canalId: "canal-1",
      sessionId: A.sessionId,
    });
    assert.ok(B, "a renovação legítima precisa funcionar");
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    assert.notEqual(B.sig, A.sig, "a concessão nova tem de ter assinatura própria");
    assert.equal(B.sessionId, A.sessionId, "renovar não troca de sessão");

    let segmentosDeB: string[] = [];

    await t.test("manifesto B funciona", async () => {
      const r = await tratarCanal(new Request(urlDoManifesto(B.sessionId, B.exp, B.sig)), ENV);
      assert.equal(r.status, 200);
      const corpo = await r.text();
      assert.equal(corpo.includes("segmentos.example.test"), false);
      segmentosDeB = segmentosDe(corpo);
      assert.equal(segmentosDeB.length, 2);
    });

    await t.test("segmentos de B funcionam", async () => {
      for (const seg of segmentosDeB) {
        assert.equal((await tratarCanal(new Request(seg), ENV)).status, 200);
      }
    });

    await t.test("A continua valendo DURANTE a grace — é o que salva o player", async (t2) => {
      // Este é o teste que a versão anterior não tinha, e o defeito que ele
      // pega: sem grace, girar o nonce mataria o player no mesmo instante.
      //
      // Relógio congelado nesta verificação. O manifesto assina cada segmento
      // com `e = segundo atual + TTL`; comparar com `segmentosDeB`, cunhado
      // subtestes antes, falhava sempre que uma fronteira de segundo caía entre
      // as duas requisições (reproduzido forçando a fronteira: mesmo caminho,
      // `e` +1 e `k` diferente). A comparação continua exata — só passa a ser
      // entre dois manifestos do mesmo instante.
      const instante = Date.now();
      t2.mock.method(Date, "now", () => instante);

      const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
      assert.equal(r.status, 200, "a geração anterior tem de sobreviver à janela");

      for (const seg of segmentosDeA) {
        assert.equal((await tratarCanal(new Request(seg), ENV)).status, 200);
      }

      // E o manifesto antigo já devolve segmentos da geração NOVA, que é o que
      // faz o handoff ser quase invisível: assinados com o nonce de B, iguais
      // aos que o manifesto de B entrega no mesmo instante.
      const doAntigo = segmentosDe(await r.text());
      const rB = await tratarCanal(new Request(urlDoManifesto(B.sessionId, B.exp, B.sig)), ENV);
      const deB = segmentosDe(await rB.text());
      assert.equal(deB.length, 2);
      assert.deepEqual(doAntigo, deB, "durante a grace, A serve segmentos de B");
      assert.deepEqual(
        doAntigo.map((u) => new URL(u).pathname),
        segmentosDeB.map((u) => new URL(u).pathname),
        "mesmos recursos que B já entregava",
      );
    });

    await t.test("A morre DEPOIS da grace", async () => {
      // Empurra o fim da janela para o passado, como o relógio faria.
      const sessao = JSON.parse(amb.redis.dados.get(chaveDaSessao(A.sessionId))!);
      sessao.graceAte = Date.now() - 1;
      amb.redis.dados.set(chaveDaSessao(A.sessionId), JSON.stringify(sessao));

      assert.equal(
        (await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV)).status,
        403,
        "passada a grace, a geração anterior tem de morrer",
      );
      for (const seg of segmentosDeA) {
        assert.equal((await tratarCanal(new Request(seg), ENV)).status, 403);
      }
      // B segue valendo.
      assert.equal(
        (await tratarCanal(new Request(urlDoManifesto(B.sessionId, B.exp, B.sig)), ENV)).status,
        200,
      );
    });

    await t.test("apagar a sessão mata A e B no mesmo instante, sem grace", async () => {
      await encerrarSessao(A.sessionId);
      amb.redis.dados.delete(chaveDaSessao(A.sessionId));

      assert.equal(
        (await tratarCanal(new Request(urlDoManifesto(B.sessionId, B.exp, B.sig)), ENV)).status,
        403,
      );
      for (const seg of [...segmentosDeA, ...segmentosDeB]) {
        assert.equal((await tratarCanal(new Request(seg), ENV)).status, 403);
      }
    });
  } finally {
    amb.restaurar();
  }
});

test("a janela de grace é curta e explícita", () => {
  assert.ok(GRACE_HANDOFF_S >= 30, "curta demais não cobre o handoff");
  assert.ok(GRACE_HANDOFF_S <= 120, "longa demais é janela de replay");
});

// ── 2. Persistência de base é obrigatória ────────────────────────────────────

test("base nova que não persiste no Redis impede servir o manifesto", async () => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-2", fonte: FONTE });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    amb.redis.falharEscrita = true;

    const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);

    // 503, e não 200: o manifesto referenciaria um id que ninguém resolve, e
    // todo segmento dele responderia 403 — falha que parece revogação e não é.
    assert.equal(r.status, 503, "manifesto não pode sair sem a base persistida");
    const corpo = await r.text();
    assert.equal(corpo.includes("segmentos.example.test"), false);
    assert.equal(corpo.includes("#EXTM3U"), false, "não pode vazar o manifesto na falha");

    // E é temporário: restaurado o Redis, a mesma URL passa a servir.
    amb.redis.falharEscrita = false;
    const ok = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
    assert.equal(ok.status, 200);
  } finally {
    amb.restaurar();
  }
});

test("renovação de TTL da sessão continua best-effort", async () => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-3", fonte: FONTE });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    // Primeira passada persiste a base e a deixa no cache do isolate.
    assert.equal(
      (await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV)).status,
      200,
    );

    // Agora o Redis recusa escrita. A base já é conhecida, então a única
    // escrita que restaria é a do TTL — e essa pode falhar sem derrubar nada.
    amb.redis.falharEscrita = true;
    const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
    assert.equal(r.status, 200, "base conhecida não exige escrita crítica");
    assert.equal((await r.text()).includes("#EXTM3U"), true);
  } finally {
    amb.restaurar();
  }
});

// ── 3. Concorrência de descoberta ────────────────────────────────────────────

test("descobertas concorrentes de bases diferentes não trocam os ids", async () => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-4", fonte: FONTE });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    // Dois manifestos servidos ao mesmo tempo, cada um apontando para uma base
    // diferente. Era exatamente aqui que o vetor de índices dentro do documento
    // da sessão fazia last-write-wins: o índice 1 de um podia acabar apontando
    // para a base do outro.
    const manifestoA = ["#EXTM3U", "#EXTINF:4.0,", "https://segmentos.example.test/x/s1.ts"].join("\n");
    const manifestoB = ["#EXTM3U", "#EXTINF:4.0,", "https://outro.example.test/y/s2.ts"].join("\n");

    // A fila garante que a primeira busca receba `manifestoA` e a segunda
    // `manifestoB`, mesmo com as duas invocações intercaladas — é o cruzamento
    // que o índice mutável não sobrevivia.
    amb.filaDeManifestos = [manifestoA, manifestoB];
    const [resp1, resp2] = await Promise.all([
      tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV),
      tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV),
    ]);

    const [c1, c2] = await Promise.all([resp1.text(), resp2.text()]);
    const seg1 = segmentosDe(c1)[0];
    const seg2 = segmentosDe(c2)[0];
    assert.ok(seg1 && seg2);

    // Os ids são diferentes (bases diferentes) e cada um resolve para o SEU
    // host — a asserção que o índice mutável não sustentava.
    //
    // Qual das duas chamadas pega `manifestoA` da fila não é garantido: a ordem
    // das buscas ao CDN depende de como as etapas assíncronas (Redis, HMAC) se
    // intercalam. Com a ordem perturbada, `resp1` recebeu `manifestoB` e a
    // versão posicional falhava sem defeito nenhum no Worker. Então cada
    // segmento é casado com o manifesto que ele de fato veio: pelo upstream que
    // ele busca.
    const id1 = new URL(seg1).pathname.split("/")[4];
    const id2 = new URL(seg2).pathname.split("/")[4];
    assert.notEqual(id1, id2);

    const upstreamDe = async (seg: string) => {
      amb.buscas.length = 0;
      await tratarCanal(new Request(seg), ENV);
      assert.equal(amb.buscas.length, 1, "um segmento, uma busca upstream");
      return amb.buscas[0];
    };
    const pares = [
      { id: id1, upstream: await upstreamDe(seg1) },
      { id: id2, upstream: await upstreamDe(seg2) },
    ];

    // Os dois recursos foram buscados, cada um no seu host...
    assert.deepEqual(
      pares.map((p) => p.upstream).sort(),
      ["https://outro.example.test/y/s2.ts", "https://segmentos.example.test/x/s1.ts"],
    );
    // ...e o id de cada segmento aponta para a base do próprio upstream.
    for (const p of pares) {
      assert.equal(amb.redis.dados.get(chaveDaBase(p.id)), p.upstream.replace(/[^/]+$/, ""));
    }
  } finally {
    amb.restaurar();
  }
});

test("id de base é determinístico: a mesma base grava o mesmo par", async () => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-5", fonte: FONTE });
    const B = await criarSessaoDeCanal({ userId: "outro", canalId: "canal-5", fonte: FONTE });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);
    await publicarSessaoNoEdge(amb.redis, B.sessionId);

    const c1 = await (await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV)).text();
    __limparCachesDeBase(); // força o segundo a recalcular do zero
    const c2 = await (await tratarCanal(new Request(urlDoManifesto(B.sessionId, B.exp, B.sig)), ENV)).text();

    const id1 = new URL(segmentosDe(c1)[0]).pathname.split("/")[4];
    const id2 = new URL(segmentosDe(c2)[0]).pathname.split("/")[4];
    // Sessões diferentes, mesma base: mesmo id. É o que torna a gravação
    // idempotente e a concorrência inofensiva.
    assert.equal(id1, id2);

    // O id não revela o host.
    assert.equal(id1.includes("segmentos"), false);
    assert.equal(id1.includes("example"), false);
  } finally {
    amb.restaurar();
  }
});

// ── Recusas básicas do edge ──────────────────────────────────────────────────

test("o edge recusa assinatura forjada, expirada e de outra sessão", async () => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-6", fonte: FONTE });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    const forjada = urlDoManifesto(A.sessionId, A.exp, "A".repeat(22));
    assert.equal((await tratarCanal(new Request(forjada), ENV)).status, 403);

    const vencida = urlDoManifesto(A.sessionId, Math.floor(Date.now() / 1000) - 10, A.sig);
    assert.equal((await tratarCanal(new Request(vencida), ENV)).status, 403);

    const outraSessao = urlDoManifesto("z".repeat(32), A.exp, A.sig);
    assert.equal((await tratarCanal(new Request(outraSessao), ENV)).status, 403);

    // Método que não é GET/HEAD.
    const post = new Request(urlDoManifesto(A.sessionId, A.exp, A.sig), { method: "POST" });
    assert.equal((await tratarCanal(post, ENV)).status, 403);
  } finally {
    amb.restaurar();
  }
});

test("o edge só arma pela allowlist da página, e não pela de CDN", async () => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const fonteHostil = { ...FONTE, paginaDoPlayer: "https://cdn.example.test/fingindo.php" };
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-7", fonte: fonteHostil });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    amb.buscas.length = 0;
    await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);

    // O CDN está na allowlist de mídia, mas não na de arm. Nenhuma busca pode
    // ter ido para a página falsa — as listas são separadas justamente para
    // isso.
    assert.equal(amb.buscas.includes("https://cdn.example.test/fingindo.php"), false);
  } finally {
    amb.restaurar();
  }
});

// ── N0 → N1 → N2 → N3: só current + previous ────────────────────────────────

test("quatro gerações: só a corrente e a anterior são aceitas", async (t) => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const geracoes = [
      await criarSessaoDeCanal({ userId: "dono", canalId: "canal-n", fonte: FONTE }),
    ];
    await publicarSessaoNoEdge(amb.redis, geracoes[0].sessionId);
    const sid = geracoes[0].sessionId;

    // N1, N2, N3 — três renovações seguidas.
    for (let i = 1; i <= 3; i++) {
      const g = await renovarSessaoDeCanal({ userId: "dono", canalId: "canal-n", sessionId: sid });
      assert.ok(g, `renovação ${i} precisa funcionar`);
      assert.equal(g.geracao, i, "a geração tem de ser monotônica");
      geracoes.push(g);
      await publicarSessaoNoEdge(amb.redis, sid);
    }

    const status = async (g: (typeof geracoes)[number]) =>
      (await tratarCanal(new Request(urlDoManifesto(sid, g.exp, g.sig)), ENV)).status;

    await t.test("N3 (corrente) e N2 (anterior) valem; N1 e N0 não", async () => {
      assert.equal(await status(geracoes[3]), 200, "N3 é a corrente");
      assert.equal(await status(geracoes[2]), 200, "N2 é a anterior, dentro da grace");
      assert.equal(await status(geracoes[1]), 403, "N1 já saiu da janela");
      assert.equal(await status(geracoes[0]), 403, "N0 muito menos");
    });

    await t.test("os segmentos seguem a mesma regra", async () => {
      // Segmentos cunhados agora são da geração corrente; os de uma geração
      // aposentada não passam.
      const corpo = await (
        await tratarCanal(new Request(urlDoManifesto(sid, geracoes[3].exp, geracoes[3].sig)), ENV)
      ).text();
      for (const seg of segmentosDe(corpo)) {
        assert.equal((await tratarCanal(new Request(seg), ENV)).status, 200);
      }
    });

    await t.test("passada a grace, só a corrente sobra", async () => {
      const sessao = JSON.parse(amb.redis.dados.get(chaveDaSessao(sid))!);
      sessao.graceAte = Date.now() - 1;
      amb.redis.dados.set(chaveDaSessao(sid), JSON.stringify(sessao));

      assert.equal(await status(geracoes[3]), 200, "a corrente continua");
      assert.equal(await status(geracoes[2]), 403, "a anterior morre com a grace");
    });

    await t.test("encerrar a sessão invalida TUDO imediatamente", async () => {
      await encerrarSessao(sid);
      amb.redis.dados.delete(chaveDaSessao(sid));

      for (const [i, g] of geracoes.entries()) {
        assert.equal(await status(g), 403, `N${i} sobreviveu à revogação`);
      }
    });
  } finally {
    amb.restaurar();
  }
});

// ── Refresh de upstream: arm (Caso A) e rotação (Caso B) ─────────────────────

const A_UPSTREAM = `${CDN}/live/master.m3u8`;
const B_UPSTREAM = "https://outro.example.test/liveB/master.m3u8"; // outro host, na allowlist de CDN
const FONTE_A = { ...FONTE, streamUrl: A_UPSTREAM };

/**
 * `fetch` scriptável: o teste decide o HTML do player (que também **arma**) e a
 * resposta de cada URL de mídia, e pode variar por número de chamadas.
 */
function montarAmbienteScriptavel(opts: {
  playerHtml: () => string;
  respostaDeMidia: (url: string) => Response;
}) {
  const redis = new RedisFalso();
  const buscas: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof entrada === "string" ? entrada : entrada.toString();
    if (url === REDIS_URL) {
      const cmd = JSON.parse(String(init?.body)) as (string | number)[];
      const r = redis.executar(cmd);
      return new Response(JSON.stringify({ result: r.result }), { status: r.ok ? 200 : 500 });
    }
    buscas.push(url);
    if (url.startsWith(PLAYER)) {
      return new Response(opts.playerHtml(), { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return opts.respostaDeMidia(url);
  }) as typeof fetch;
  return { redis, buscas, restaurar: () => { globalThis.fetch = original; } };
}

const manifest200 = () =>
  new Response(MANIFESTO_UPSTREAM, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
const erroHttp = (s: number) => new Response(null, { status: s });

async function upstreamNaSessao(redis: RedisFalso, sid: string): Promise<string> {
  return JSON.parse(redis.dados.get(chaveDaSessao(sid))!).upstream;
}

test("Caso A: MASTER 403 → arm → 200, sem rotação e sem re-resolver", async () => {
  __limparCachesDeBase();
  let armado = false;
  const amb = montarAmbienteScriptavel({
    // A página do player continua anunciando A (não rotacionou).
    playerHtml: () => { armado = true; return `<html>src="${A_UPSTREAM}"</html>`; },
    respostaDeMidia: (url) => {
      if (url === A_UPSTREAM) return armado ? manifest200() : erroHttp(403);
      if (url.startsWith("https://segmentos.example.test")) return new Response("TS", { status: 200 });
      return erroHttp(404);
    },
  });
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "ca", fonte: FONTE_A });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
    assert.equal(r.status, 200);
    const corpo = await r.text();
    // Continua com A, e o upstream não vazou.
    assert.equal(await upstreamNaSessao(amb.redis, A.sessionId), A_UPSTREAM);
    assert.equal(corpo.includes("cdn.example.test"), false);
    assert.equal(corpo.includes("segmentos.example.test"), false);
    // O arm buscou o player exatamente uma vez (buscarComArm), sem re-resolução.
    assert.equal(amb.buscas.filter((u) => u.startsWith(PLAYER)).length, 1);
  } finally {
    amb.restaurar();
  }
});

test("Caso B: MASTER 403 persistente → player passa a anunciar B → B 200, sessão atualizada", async () => {
  __limparCachesDeBase();
  const amb = montarAmbienteScriptavel({
    playerHtml: () => `<html>file: "${B_UPSTREAM}"</html>`, // agora anuncia B
    respostaDeMidia: (url) => {
      if (url === A_UPSTREAM) return erroHttp(403); // A nunca volta, mesmo armado
      if (url === B_UPSTREAM) return manifest200();
      if (url.startsWith("https://segmentos.example.test")) return new Response("TS", { status: 200 });
      return erroHttp(404);
    },
  });
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "cb", fonte: FONTE_A });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);

    const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
    assert.equal(r.status, 200, "após rotacionar para B, o master serve 200");
    const corpo = await r.text();
    // A sessão passou a apontar para B, e nem A nem B vazaram ao cliente.
    assert.equal(await upstreamNaSessao(amb.redis, A.sessionId), B_UPSTREAM);
    assert.equal(corpo.includes("outro.example.test"), false);
    assert.equal(corpo.includes("cdn.example.test"), false);
    assert.ok(amb.buscas.includes(B_UPSTREAM), "B precisa ter sido buscado");
  } finally {
    amb.restaurar();
  }
});

for (const statusObsoleto of [404, 410]) {
  test(`Caso B via ${statusObsoleto}: MASTER ${statusObsoleto} → re-resolve B → B 200`, async () => {
    __limparCachesDeBase();
    const amb = montarAmbienteScriptavel({
      playerHtml: () => `<html>${B_UPSTREAM}</html>`,
      respostaDeMidia: (url) => {
        if (url === A_UPSTREAM) return erroHttp(statusObsoleto);
        if (url === B_UPSTREAM) return manifest200();
        if (url.startsWith("https://segmentos.example.test")) return new Response("TS", { status: 200 });
        return erroHttp(404);
      },
    });
    try {
      const A = await criarSessaoDeCanal({ userId: "dono", canalId: `cb${statusObsoleto}`, fonte: FONTE_A });
      await publicarSessaoNoEdge(amb.redis, A.sessionId);
      const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
      assert.equal(r.status, 200);
      assert.equal(await upstreamNaSessao(amb.redis, A.sessionId), B_UPSTREAM);
    } finally {
      amb.restaurar();
    }
  });
}

test("re-resolução recusa mídia nova fora da CDN_ALLOWLIST e não a busca", async () => {
  __limparCachesDeBase();
  const FORA = "https://evil.example.net/pirata.m3u8";
  const amb = montarAmbienteScriptavel({
    playerHtml: () => `<html>${FORA}</html>`,
    respostaDeMidia: (url) => {
      if (url === A_UPSTREAM) return erroHttp(404);
      return erroHttp(404);
    },
  });
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "cf", fonte: FONTE_A });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);
    const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
    assert.equal(r.status, 410, "mídia fora da allowlist não vira upstream");
    assert.equal(amb.buscas.includes(FORA), false, "o host fora da allowlist nunca é buscado");
    assert.equal(await upstreamNaSessao(amb.redis, A.sessionId), A_UPSTREAM, "sessão não adota URL recusada");
  } finally {
    amb.restaurar();
  }
});

test("re-resolução recusa SSRF (IP privado), mesmo allowlisted, e http; não os busca", async () => {
  __limparCachesDeBase();
  const PRIVADO = "https://10.0.0.1/interno.m3u8";
  const HTTP = "http://cdn.example.test/claro.m3u8";
  const amb = montarAmbienteScriptavel({
    playerHtml: () => `<html>${PRIVADO} ${HTTP}</html>`, // http nem é extraído; IP privado fora da allowlist
    respostaDeMidia: (url) => {
      if (url === A_UPSTREAM) return erroHttp(404);
      return erroHttp(404);
    },
  });
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "cs", fonte: FONTE_A });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);
    const envComIpConfiguradoErrado = { ...ENV, CDN_ALLOWLIST: `${ENV.CDN_ALLOWLIST},10.0.0.1` };
    const r = await tratarCanal(
      new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)),
      envComIpConfiguradoErrado,
    );
    assert.equal(r.status, 410);
    assert.equal(amb.buscas.includes(PRIVADO), false);
    assert.equal(amb.buscas.includes(HTTP), false);
  } finally {
    amb.restaurar();
  }
});

test("player sem mídia na re-resolução: falha controlada (410), sem crash", async () => {
  __limparCachesDeBase();
  const amb = montarAmbienteScriptavel({
    playerHtml: () => "<html>fora do ar, nenhuma midia</html>",
    respostaDeMidia: (url) => (url === A_UPSTREAM ? erroHttp(410) : erroHttp(404)),
  });
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "cm", fonte: FONTE_A });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);
    const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
    assert.equal(r.status, 410);
  } finally {
    amb.restaurar();
  }
});

test("sem loop: uma re-resolução por falha, mesmo com B também falhando", async () => {
  __limparCachesDeBase();
  const amb = montarAmbienteScriptavel({
    playerHtml: () => `<html>${B_UPSTREAM}</html>`,
    respostaDeMidia: (url) => {
      if (url === A_UPSTREAM) return erroHttp(404);
      if (url === B_UPSTREAM) return erroHttp(404); // rotação não ajudou
      return erroHttp(404);
    },
  });
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "cl", fonte: FONTE_A });
    await publicarSessaoNoEdge(amb.redis, A.sessionId);
    const r = await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV);
    assert.equal(r.status, 410, "esgotada a única tentativa, devolve condição de recarga");
    // Exatamente uma re-resolução: um GET no player, um GET em A, um GET em B.
    assert.equal(amb.buscas.filter((u) => u.startsWith(PLAYER)).length, 1, "no máximo uma re-resolução");
    assert.equal(amb.buscas.filter((u) => u === B_UPSTREAM).length, 1, "B tentado uma única vez");
  } finally {
    amb.restaurar();
  }
});

for (const statusObsoleto of [401, 403, 404, 410]) {
  test(`segmento ${statusObsoleto} NÃO re-resolve: devolve 410 para recarregar o master`, async () => {
    __limparCachesDeBase();
    // Primeiro serve o master (para cunhar segmentos), depois o segmento some.
    let segmentoVivo = true;
    const amb = montarAmbienteScriptavel({
      playerHtml: () => "<html>arm sem re-resolução</html>",
      respostaDeMidia: (url) => {
        if (url === A_UPSTREAM) return manifest200();
        if (url.startsWith("https://segmentos.example.test")) {
          return segmentoVivo ? new Response("TS", { status: 200 }) : erroHttp(statusObsoleto);
        }
        return erroHttp(404);
      },
    });
    try {
      const A = await criarSessaoDeCanal({
        userId: "dono",
        canalId: `cseg${statusObsoleto}`,
        fonte: FONTE_A,
      });
      await publicarSessaoNoEdge(amb.redis, A.sessionId);
      const corpo = await (
        await tratarCanal(new Request(urlDoManifesto(A.sessionId, A.exp, A.sig)), ENV)
      ).text();
      const seg = segmentosDe(corpo)[0];
      assert.ok(seg);

      segmentoVivo = false;
      amb.buscas.length = 0;
      const r = await tratarCanal(new Request(seg), ENV);
      assert.equal(r.status, 410);
      // 401/403 podem fazer o único arm normal, mas nunca a segunda consulta
      // que extrai/troca upstream. 404/410 nem armam.
      const chamadasAoPlayer = amb.buscas.filter((u) => u.startsWith(PLAYER)).length;
      assert.equal(chamadasAoPlayer, statusObsoleto === 401 || statusObsoleto === 403 ? 1 : 0);
    } finally {
      amb.restaurar();
    }
  });
}

test("renovações concorrentes fazem uma só rotação e devolvem a concessão vigente", async () => {
  __limparCachesDeBase();
  const amb = montarAmbiente();
  try {
    const A = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-c", fonte: FONTE });
    const tetoAbsoluto = (await lerSessao(A.sessionId))!.expiraDefinitivamenteEm;

    // Três renovações disparadas juntas contra a MESMA sessão. O lock no
    // servidor precisa fazer uma só rotação; as perdedoras reutilizam N+1.
    const resultados = await Promise.all([
      renovarSessaoDeCanal({ userId: "dono", canalId: "canal-c", sessionId: A.sessionId }),
      renovarSessaoDeCanal({ userId: "dono", canalId: "canal-c", sessionId: A.sessionId }),
      renovarSessaoDeCanal({ userId: "dono", canalId: "canal-c", sessionId: A.sessionId }),
    ]);

    for (const r of resultados) {
      assert.ok(r, "nenhuma renovação legítima pode falhar");
      assert.equal(r.geracao, A.geracao + 1, "todas recebem a única geração renovada");
    }

    const sessao = await lerSessao(A.sessionId);
    assert.ok(sessao);
    assert.equal(sessao.geracao, A.geracao + 1, "a geração final sobe uma vez");
    assert.equal(sessao.expiraDefinitivamenteEm, tetoAbsoluto, "a renovação não move o teto absoluto");
    for (const concessao of resultados) {
      assert.ok(
        assinaturaConfere({
          escopo: "m", sessionId: A.sessionId, nonce: sessao.nonce,
          recurso: "master", exp: concessao!.exp,
        }, concessao!.sig),
        "nenhuma resposta concorrente fica inválida imediatamente",
      );
    }
  } finally {
    amb.restaurar();
  }
});
