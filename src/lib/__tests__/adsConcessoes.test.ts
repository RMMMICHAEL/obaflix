import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  TEMPO_MINIMO_DE_ANUNCIO_MS,
  TTL_CONCESSAO_S,
  abrirDesafio,
  chaveDoEpisodio,
  concessaoValida,
  consumirConcessao,
  consumirDesafio,
  emitirConcessao,
  episodiosDistintosNaJanela,
  registrarEpisodioDistinto,
} from "../ads/concessoes";
import { PLANO_GRATUITO } from "../planos";
import { getRedis } from "../redis";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * Desafio, concessão e contador — contra o Redis de verdade.
 *
 * "De verdade" aqui é o `MemoryStore` de `src/lib/redis.ts`, que é o mesmo
 * cliente que roda fora de produção e implementa `SET NX`, `INCR`, `DEL` e TTL
 * com a mesma semântica. Testar contra um dublê escrito à mão provaria que o
 * dublê concorda comigo, e não que a regra funciona.
 *
 * Cada teste usa um `userId` próprio: o store é um singleton por processo, e
 * chaves compartilhadas fariam um teste enxergar o estado de outro.
 */

function direitosDe(plano: PlanoSemeado): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return direitos as DireitosDoPlano;
}

const GRATUITO = direitosDe(PLANO_GRATUITO);

let sequencia = 0;
const novoUsuario = () => `u_ads_${Date.now()}_${++sequencia}`;

// ── Concessão ────────────────────────────────────────────────────────────────

describe("concessão: uso único, dono e finalidade", () => {
  /** Cenário 3, na camada que realmente consome. */
  test("emitida e consumida uma vez, libera", async () => {
    const userId = novoUsuario();
    const id = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    assert.equal(await concessaoValida(id, userId), true);
    assert.equal(await consumirConcessao(id, userId, "reproducao"), true);
  });

  /** Cenário 4, e o motivo de o `DEL` — não o `GET` — ser quem autoriza. */
  test("a segunda tentativa falha", async () => {
    const userId = novoUsuario();
    const id = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    assert.equal(await consumirConcessao(id, userId, "reproducao"), true);
    assert.equal(await consumirConcessao(id, userId, "reproducao"), false);
    assert.equal(await concessaoValida(id, userId), false);
  });

  /**
   * Duas requisições paralelas com a mesma concessão: exatamente uma passa.
   *
   * É o caso que um `GET` + `DEL` sem conferir o retorno do `DEL` deixaria
   * passar duas vezes — os dois leriam a concessão antes de qualquer apagamento.
   */
  test("sob concorrência, exatamente uma passa", async () => {
    const userId = novoUsuario();
    const id = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    const resultados = await Promise.all([
      consumirConcessao(id, userId, "reproducao"),
      consumirConcessao(id, userId, "reproducao"),
      consumirConcessao(id, userId, "reproducao"),
    ]);

    assert.equal(resultados.filter(Boolean).length, 1, "só uma pode consumir");
  });

  /** Cenário 5 — o TTL é o que faz a concessão expirar sozinha. */
  test("o TTL aprovado é de 30 minutos, e é aplicado", async () => {
    assert.equal(TTL_CONCESSAO_S, 30 * 60);

    const userId = novoUsuario();
    const id = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    const ttl = await getRedis().ttl(`ads:concessao:${id}`);
    assert.ok(ttl > 0 && ttl <= TTL_CONCESSAO_S, `ttl inesperado: ${ttl}`);
  });

  /**
   * Cenário 5, o efeito: uma concessão que não está mais no Redis — expirada ou
   * apagada — não libera nada.
   */
  test("concessão expirada não funciona", async () => {
    const userId = novoUsuario();
    const id = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    // Apagar é como o Redis se comporta quando o TTL vence.
    await getRedis().del(`ads:concessao:${id}`);

    assert.equal(await concessaoValida(id, userId), false);
    assert.equal(await consumirConcessao(id, userId, "reproducao"), false);
  });

  /** Concessão capturada não libera a conta de outro. */
  test("outro usuário não consome a concessão alheia", async () => {
    const dono = novoUsuario();
    const intruso = novoUsuario();
    const id = await emitirConcessao({ userId: dono, finalidade: "reproducao", verificacao: "soft" });

    assert.equal(await concessaoValida(id, intruso), false);
    assert.equal(await consumirConcessao(id, intruso, "reproducao"), false);
  });

  /**
   * Cenário 6. A finalidade existe para que a primeira funcionalidade nova não
   * herde a autorização da anterior sem ninguém decidir isso.
   */
  test("finalidade errada não libera reprodução", async () => {
    const userId = novoUsuario();
    const id = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    assert.equal(
      await consumirConcessao(id, userId, "canais" as unknown as "reproducao"),
      false,
      "uma concessão de reprodução não pode abrir outra coisa",
    );
  });

  test("id inexistente ou nulo não libera", async () => {
    const userId = novoUsuario();
    assert.equal(await concessaoValida(null, userId), false);
    assert.equal(await concessaoValida("inventado", userId), false);
    assert.equal(await consumirConcessao("inventado", userId, "reproducao"), false);
  });
});

// ── Desafio ──────────────────────────────────────────────────────────────────

describe("desafio: emitido pelo servidor, uso único", () => {
  test("abre e consome uma vez", async () => {
    const userId = novoUsuario();
    const id = await abrirDesafio({ userId, tipo: "filme", plataforma: "android" });

    const d = await consumirDesafio(id, userId);
    assert.equal(d?.tipo, "filme");
    assert.equal(d?.plataforma, "android");
    assert.equal(await consumirDesafio(id, userId), null, "segunda vez não vale");
  });

  test("desafio de outra conta não é consumido", async () => {
    const dono = novoUsuario();
    const intruso = novoUsuario();
    const id = await abrirDesafio({ userId: dono, tipo: "filme", plataforma: "electron" });

    assert.equal(await consumirDesafio(id, intruso), null);
  });

  /**
   * O desafio guarda `criadoEm` gravado pelo **servidor**. É contra ele que
   * `/api/ads/complete` mede o tempo mínimo — o cliente não informa duração e
   * não teria como ser acreditado se informasse.
   */
  test("carrega o instante em que o servidor o abriu", async () => {
    const userId = novoUsuario();
    const antes = Date.now();
    const id = await abrirDesafio({ userId, tipo: "serie", plataforma: "android" });

    const d = await consumirDesafio(id, userId);
    assert.ok(d && d.criadoEm >= antes && d.criadoEm <= Date.now());
    assert.ok(TEMPO_MINIMO_DE_ANUNCIO_MS > 0);
  });

  test("forjado não existe", async () => {
    assert.equal(await consumirDesafio("nao-existe", novoUsuario()), null);
  });
});

// ── Contador de episódios distintos ──────────────────────────────────────────

describe("contador: só episódios distintos contam", () => {
  const registrar = (userId: string, temporada: number, episodio: number, direitos = GRATUITO) =>
    registrarEpisodioDistinto({ userId, conteudoId: "serie-x", temporada, episodio, direitos });

  /** Cenários 7, 8 e 9 na camada que conta de verdade. */
  test("três episódios distintos devolvem 1, 2, 3", async () => {
    const userId = novoUsuario();
    assert.equal(await registrar(userId, 1, 1), 1);
    assert.equal(await registrar(userId, 1, 2), 2);
    assert.equal(await registrar(userId, 1, 3), 3);
  });

  /**
   * Cenário 10, e o núcleo da regra: é o `SET NX` que faz reabrir o mesmo
   * episódio devolver o contador **sem somar**.
   */
  test("repetir o mesmo episódio não incrementa", async () => {
    const userId = novoUsuario();
    assert.equal(await registrar(userId, 1, 1), 1);
    assert.equal(await registrar(userId, 1, 1), 1);
    assert.equal(await registrar(userId, 1, 1), 1);
    assert.equal(await episodiosDistintosNaJanela(userId), 1);
  });

  /**
   * Cenário 11: retry por erro do player é o mesmo episódio de novo. Do ponto de
   * vista do contador é indistinguível de um replay — e é justamente por isso
   * que a chave é o episódio, e não o número de tentativas.
   */
  test("retry do mesmo episódio não incrementa, mesmo intercalado", async () => {
    const userId = novoUsuario();
    await registrar(userId, 1, 1);
    await registrar(userId, 1, 2);
    // player falhou no episódio 2 e o cliente tentou de novo
    assert.equal(await registrar(userId, 1, 2), 2);
    // e voltou ao 1
    assert.equal(await registrar(userId, 1, 1), 2);
    assert.equal(await episodiosDistintosNaJanela(userId), 2);
  });

  test("temporadas diferentes com o mesmo número de episódio são distintas", async () => {
    const userId = novoUsuario();
    assert.equal(await registrar(userId, 1, 1), 1);
    assert.equal(await registrar(userId, 2, 1), 2);
  });

  test("séries diferentes contam separadamente, no mesmo contador da conta", async () => {
    const userId = novoUsuario();
    await registrarEpisodioDistinto({ userId, conteudoId: "a", temporada: 1, episodio: 1, direitos: GRATUITO });
    const n = await registrarEpisodioDistinto({ userId, conteudoId: "b", temporada: 1, episodio: 1, direitos: GRATUITO });
    assert.equal(n, 2, "a cota é da conta, não da série");
  });

  test("contas diferentes não compartilham contador", async () => {
    const a = novoUsuario();
    const b = novoUsuario();
    await registrar(a, 1, 1);
    await registrar(a, 1, 2);
    assert.equal(await registrar(b, 1, 1), 1);
  });

  /**
   * Cenário 12. Não dá para esperar 24 h num teste, então ele prova as duas
   * metades verificáveis: a janela **é aplicada** como TTL, e quando ela vence o
   * ciclo **recomeça**. Apagar as chaves é exatamente o que o Redis faz no
   * vencimento.
   */
  test("a janela de 24h é aplicada como TTL do contador", async () => {
    const userId = novoUsuario();
    await registrar(userId, 1, 1);

    const ttl = await getRedis().ttl(`ads:ep:contador:${userId}`);
    assert.ok(ttl > 23 * 3600 && ttl <= 24 * 3600, `ttl fora da janela de 24h: ${ttl}`);
  });

  test("a janela do plano é respeitada quando difere do padrão", async () => {
    const userId = novoUsuario();
    await registrar(userId, 1, 1, { ...GRATUITO, janelaAnuncioHoras: 1 });

    const ttl = await getRedis().ttl(`ads:ep:contador:${userId}`);
    assert.ok(ttl > 0 && ttl <= 3600, `esperava janela de 1h, veio ${ttl}`);
  });

  /**
   * A janela **não** é empurrada para frente a cada episódio. Se fosse, quem
   * assiste continuamente nunca fecharia o ciclo e nunca voltaria a ver anúncio.
   */
  test("episódios seguintes não renovam a janela", async () => {
    const userId = novoUsuario();
    await registrar(userId, 1, 1);
    const primeiro = await getRedis().ttl(`ads:ep:contador:${userId}`);

    await registrar(userId, 1, 2);
    const depois = await getRedis().ttl(`ads:ep:contador:${userId}`);

    assert.ok(depois <= primeiro, "a janela foi renovada, e não deveria");
  });

  test("vencida a janela, o ciclo recomeça do 1", async () => {
    const userId = novoUsuario();
    await registrar(userId, 1, 1);
    await registrar(userId, 1, 2);

    // O que o Redis faz quando o TTL vence.
    const redis = getRedis();
    await redis.del(`ads:ep:contador:${userId}`);
    await redis.del(`ads:ep:visto:${userId}:${chaveDoEpisodio(userId, "serie-x", 1, 1)}`);
    await redis.del(`ads:ep:visto:${userId}:${chaveDoEpisodio(userId, "serie-x", 1, 2)}`);

    assert.equal(await registrar(userId, 1, 1), 1, "janela nova, ciclo novo");
  });

  /**
   * A chave do episódio não carrega o id do conteúdo em claro: quem lê o banco
   * de chaves não fica sabendo o que a conta assiste.
   */
  test("a chave do episódio é um hash, não o id do conteúdo", () => {
    const chave = chaveDoEpisodio("u1", "conteudo-secreto", 1, 1);
    assert.equal(chave.includes("conteudo-secreto"), false);
    assert.equal(chave.includes("u1"), false);
    assert.match(chave, /^[A-Za-z0-9_-]{22}$/);

    // Determinística — é o que faz o mesmo episódio reencontrar a própria chave.
    assert.equal(chave, chaveDoEpisodio("u1", "conteudo-secreto", 1, 1));
    assert.notEqual(chave, chaveDoEpisodio("u2", "conteudo-secreto", 1, 1));
  });
});
