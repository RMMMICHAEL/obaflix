import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FINALIDADES,
  TEMPO_MINIMO_DE_ANUNCIO_MS,
  TTL_CONCESSAO_S,
  TTL_PASSE_S,
  abrirDesafio,
  chaveDoAlvo,
  chaveDoEpisodio,
  concessaoValida,
  consumirConcessao,
  consumirDesafio,
  emitirConcessao,
  emitirPasse,
  episodiosDistintosNaJanela,
  estaPago,
  marcarPago,
  normalizarFinalidade,
  registrarEpisodioDistinto,
} from "../ads/concessoes";
import { PLANO_GRATUITO } from "../planos";
import { getRedis } from "../redis";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

test("marca persistente do Electron sobrevive sem TTL e é ligada ao alvo", async () => {
  const userId = `electron-persistente-${Date.now()}-${Math.random()}`;
  const alvo = { tipo: "canal" as const, conteudoId: "canal-canonico", temporada: null, episodio: null };
  await marcarPago({ userId, finalidade: "reproducao", alvo, persistente: true });
  assert.equal(await estaPago({ userId, finalidade: "reproducao", alvo }), true);
  assert.equal(await estaPago({
    userId,
    finalidade: "reproducao",
    alvo: { ...alvo, conteudoId: "outro-canal" },
  }), false);
});

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

// ── Finalidade, alvo, passe e marca de pago ──────────────────────────────────

const ALVO_FILME = { tipo: "filme" as const, conteudoId: "f1", temporada: null, episodio: null };
const alvoEp = (temporada: number, episodio: number) => ({
  tipo: "serie" as const,
  conteudoId: "s1",
  temporada,
  episodio,
});

describe("finalidade e alvo: cada concessão abre uma coisa só", () => {
  test("as três finalidades existem e são fechadas", () => {
    assert.deepEqual([...FINALIDADES], ["reproducao", "download", "transmissao"]);
    assert.equal(normalizarFinalidade(undefined), "reproducao", "cliente antigo pede reprodução");
    assert.equal(normalizarFinalidade("download"), "download");
    assert.equal(normalizarFinalidade("canais"), null, "valor desconhecido não vira reprodução");
  });

  test("reprodução, download e transmissão não se autorizam entre si", async () => {
    for (const emitida of FINALIDADES) {
      for (const pedida of FINALIDADES) {
        const userId = novoUsuario();
        const id = await emitirConcessao({ userId, finalidade: emitida, verificacao: "soft", alvo: ALVO_FILME });
        assert.equal(
          await consumirConcessao(id, userId, pedida, ALVO_FILME),
          emitida === pedida,
          `${emitida} → ${pedida}`,
        );
      }
    }
  });

  test("concessão presa a um alvo não abre outro conteúdo, e a tentativa não a queima", async () => {
    const userId = novoUsuario();
    const id = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft", alvo: alvoEp(1, 3) });

    assert.equal(await consumirConcessao(id, userId, "reproducao", alvoEp(1, 4)), false);
    assert.equal(await consumirConcessao(id, userId, "reproducao", null), false, "sem alvo não abre concessão com alvo");
    assert.equal(await consumirConcessao(id, userId, "reproducao", alvoEp(1, 3)), true);
  });

  test("filme ignora temporada e episódio ao comparar o alvo", () => {
    assert.equal(chaveDoAlvo({ tipo: "filme", conteudoId: "f1", temporada: 2, episodio: 9 }), chaveDoAlvo(ALVO_FILME));
    assert.notEqual(chaveDoAlvo(alvoEp(1, 1)), chaveDoAlvo(alvoEp(1, 2)));
  });

  test("o desafio carrega finalidade e alvo; o antigo vira reprodução sem alvo", async () => {
    const userId = novoUsuario();
    const id = await abrirDesafio({
      userId, tipo: "serie", plataforma: "android", finalidade: "download", alvo: alvoEp(2, 5),
    });
    const d = await consumirDesafio(id, userId);
    assert.equal(d?.finalidade, "download");
    assert.deepEqual(d?.alvo, alvoEp(2, 5));

    const antigo = await abrirDesafio({ userId, tipo: "filme", plataforma: "android" });
    const a = await consumirDesafio(antigo, userId);
    assert.equal(a?.finalidade, "reproducao");
    assert.equal(a?.alvo, null);
  });
});

describe("passe de cota: prova server-side do que a política deixou passar", () => {
  test("é de uso único", async () => {
    const userId = novoUsuario();
    const passe = await emitirPasse({ userId, finalidade: "reproducao", alvo: alvoEp(1, 1) });
    assert.equal(await consumirConcessao(passe, userId, "reproducao", alvoEp(1, 1)), true);
    assert.equal(await consumirConcessao(passe, userId, "reproducao", alvoEp(1, 1)), false);
  });

  test("vale pouco: TTL curto, menor que o da concessão de anúncio", async () => {
    const userId = novoUsuario();
    const passe = await emitirPasse({ userId, finalidade: "reproducao", alvo: alvoEp(1, 1) });
    const ttl = await getRedis().ttl(`ads:concessao:${passe}`);
    assert.ok(ttl > 0 && ttl <= TTL_PASSE_S, `ttl ${ttl}`);
    assert.ok(TTL_PASSE_S < TTL_CONCESSAO_S);
  });

  test("não serve a outra conta, outra finalidade nem outro episódio — e nada disso o queima", async () => {
    const userId = novoUsuario();
    const passe = await emitirPasse({ userId, finalidade: "reproducao", alvo: alvoEp(1, 1) });
    assert.equal(await consumirConcessao(passe, novoUsuario(), "reproducao", alvoEp(1, 1)), false);
    assert.equal(await consumirConcessao(passe, userId, "download", alvoEp(1, 1)), false);
    assert.equal(await consumirConcessao(passe, userId, "reproducao", alvoEp(1, 3)), false);
    assert.equal(await consumirConcessao(passe, userId, "reproducao", alvoEp(1, 1)), true);
  });
});

describe("marca de pago: reabrir não pede um segundo anúncio", () => {
  test("presa a conta, finalidade e alvo", async () => {
    const userId = novoUsuario();
    const alvo = { tipo: "filme" as const, conteudoId: "f9", temporada: null, episodio: null };

    assert.equal(await estaPago({ userId, finalidade: "reproducao", alvo }), false);
    await marcarPago({ userId, finalidade: "reproducao", alvo });

    assert.equal(await estaPago({ userId, finalidade: "reproducao", alvo }), true);
    assert.equal(await estaPago({ userId, finalidade: "download", alvo }), false);
    assert.equal(await estaPago({ userId: novoUsuario(), finalidade: "reproducao", alvo }), false);
    assert.equal(await estaPago({ userId, finalidade: "reproducao", alvo: { ...alvo, conteudoId: "f10" } }), false);
  });
});
