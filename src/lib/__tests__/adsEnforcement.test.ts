import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { autorizarPorAnuncio } from "../ads/enforcement";
import { resolverDirectLink, hostParaLog } from "../ads/directLink";
import { PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * O enforcement no ponto onde a sessão nasce, e as promessas estruturais.
 *
 * A primeira metade exercita `autorizarPorAnuncio` com portas injetadas — sem
 * Redis, sem banco. A segunda lê arquivos: é o que trava promessas que não têm
 * como ser exercitadas em runtime aqui, como "o Direct Link não está no
 * repositório" e "a TV não tem anúncio".
 */

const raiz = process.cwd();

function direitosDe(plano: PlanoSemeado): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return direitos as DireitosDoPlano;
}

function entitlementsDe(plano: PlanoSemeado): Entitlements {
  return {
    assinatura: { ativa: true, planoId: plano.id, expiraEm: null },
    direitos: direitosDe(plano),
  };
}

/** Resolver que conta chamadas — é o que prova os bypasses. */
function resolverFalso(ent: Entitlements | Error) {
  let chamadas = 0;
  return {
    chamadas: () => chamadas,
    resolver: async () => {
      chamadas++;
      if (ent instanceof Error) throw ent;
      return ent;
    },
  };
}

/** Consumidor que registra o que recebeu. */
function consumidorFalso(devolve: boolean) {
  const vistos: { id: string; userId: string }[] = [];
  return {
    vistos,
    consumir: async (id: string, userId: string) => {
      vistos.push({ id, userId });
      return devolve;
    },
  };
}

// ── Bypass ───────────────────────────────────────────────────────────────────

describe("quem não precisa de anúncio não paga por esta camada", () => {
  test("flag desligada libera SEM resolver entitlements", async () => {
    const { resolver, chamadas } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: null },
      { ativa: false, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
    assert.equal(chamadas(), 0, "com a flag off nada pode ser consultado");
    assert.equal(vistos.length, 0);
  });

  /** Cenário 1, na camada que cobra: assinante passa sem tocar no Redis de anúncio. */
  test("assinante é liberado sem consumir concessão", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_PREMIUM));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: null },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: true, via: "sem_anuncios" });
    assert.equal(vistos.length, 0, "nem chegou a olhar concessão");
  });
});

// ── Cobrança ─────────────────────────────────────────────────────────────────

describe("gratuito: a sessão só nasce com concessão", () => {
  /** Cenário 2, e o caso de quem pulou `/authorize` e chamou `/fontes` direto. */
  test("sem concessão, recusa", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: null },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: false, motivo: "sem_concessao" });
    assert.equal(vistos.length, 0);
  });

  /** Cenário 3. */
  test("com concessão válida, libera e consome", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: "c1" },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: true, via: "concessao" });
    assert.deepEqual(vistos, [{ id: "c1", userId: "u1" }]);
  });

  /** Cenários 4, 5 e 6 chegam aqui como a mesma recusa: o consumo falhou. */
  test("concessão recusada pelo consumo não libera", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir } = consumidorFalso(false);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "serie", concessao: "usada-ou-expirada" },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: false, motivo: "concessao_invalida" });
  });

  /** Fail-closed: não saber se a conta precisa de anúncio não vira "não precisa". */
  test("entitlements indisponíveis recusam", async () => {
    const { resolver } = resolverFalso(new Error("Redis fora"));
    const { consumir } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: "c1" },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: false, motivo: "indeterminado" });
  });

  test("falha no consumo recusa, em vez de liberar", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: "c1" },
      {
        ativa: true,
        resolver,
        consumir: async () => {
          throw new Error("Redis fora no meio do consumo");
        },
      },
    );

    assert.deepEqual(r, { liberado: false, motivo: "indeterminado" });
  });
});

// ── Direct Link ──────────────────────────────────────────────────────────────

describe("Direct Link do Electron", () => {
  test("resolve uma URL https válida", () => {
    const r = resolverDirectLink({ ANUNCIO_DIRECT_LINK_URL: "https://exemplo.invalido/x?id=1" });
    assert.equal(r.situacao, "ok");
  });

  /**
   * `shell.openExternal` abre o que receber. Um `http:` exporia o identificador
   * de publisher em claro na rede do usuário; `file:` e `javascript:` seriam
   * pior. A checagem de protocolo fecha os três.
   */
  test("recusa o que não for https", () => {
    for (const url of [
      "http://exemplo.invalido",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "nao-e-url",
      "",
      "   ",
    ]) {
      assert.equal(
        resolverDirectLink({ ANUNCIO_DIRECT_LINK_URL: url }).situacao,
        "indisponivel",
        `${url} não pode ser aceito`,
      );
    }
  });

  test("ausente é indisponível, não erro", () => {
    assert.equal(resolverDirectLink({}).situacao, "indisponivel");
  });

  /** O identificador de publisher vive na querystring — só o host vai ao log. */
  test("o log recebe só o host", () => {
    assert.equal(hostParaLog("https://rede.invalido/abc?publisher=SEGREDO&sub=123"), "rede.invalido");
    assert.equal(hostParaLog("nao-e-url"), "invalido");
  });

  /**
   * Cenário 15. A URL real é configuração de produção e o repositório nunca a
   * vê. Este teste falha se alguém "facilitar" colocando um default no código.
   */
  test("nenhum Direct Link literal no repositório", () => {
    const fontes = [
      "src/lib/ads/directLink.ts",
      "src/lib/ads/concessoes.ts",
      "src/lib/ads/politica.ts",
      "src/lib/ads/enforcement.ts",
      "src/app/api/playback/authorize/route.ts",
      "src/app/api/ads/complete/route.ts",
    ];

    for (const arquivo of fontes) {
      const codigo = readFileSync(join(raiz, arquivo), "utf8")
        .split("\n")
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");

      // Só `exemplo.invalido` e afins podem aparecer, e mesmo isso não deve
      // estar em código de produção — nenhum literal https fora de comentário.
      const literais = codigo.match(/["'`]https:\/\/[^"'`]+["'`]/g) ?? [];
      assert.deepEqual(literais, [], `${arquivo} tem URL literal em código`);
    }
  });

  /** Não pode virar variável de cliente: `NEXT_PUBLIC_` entra no bundle. */
  test("a variável não é NEXT_PUBLIC_", () => {
    const fonte = readFileSync(join(raiz, "src/lib/ads/directLink.ts"), "utf8");
    assert.ok(fonte.includes("ANUNCIO_DIRECT_LINK_URL"));
    assert.equal(/NEXT_PUBLIC_[A-Z_]*DIRECT/.test(fonte), false);

    assert.equal(
      resolverDirectLink({ NEXT_PUBLIC_ANUNCIO_DIRECT_LINK_URL: "https://x.invalido" } as Record<string, string>)
        .situacao,
      "indisponivel",
      "uma variável pública não pode alimentar o Direct Link",
    );
  });
});

// ── Promessas estruturais ────────────────────────────────────────────────────

describe("o que o servidor NÃO aceita como prova", () => {
  const rotaComplete = readFileSync(join(raiz, "src/app/api/ads/complete/route.ts"), "utf8");
  const codigoComplete = rotaComplete
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

  /**
   * Cenário 16, e a regra mais importante desta rota: o `concluido` que o
   * cliente manda é registrado e **não decide**. Quem decide é o desafio (que o
   * servidor emitiu e consome uma vez) e o tempo mínimo (medido no nosso
   * relógio).
   */
  test("a concessão não é emitida por um booleano do cliente", () => {
    // Nenhum `if` sobre `concluido` governando a emissão.
    assert.equal(
      /if\s*\([^)]*\bconcluido\b[^)]*\)/.test(codigoComplete),
      false,
      "o campo do cliente não pode governar a emissão",
    );

    const posDesafio = codigoComplete.indexOf("await consumirDesafio(");
    const posTempo = codigoComplete.indexOf("TEMPO_MINIMO_DE_ANUNCIO_MS");
    const posEmite = codigoComplete.indexOf("await emitirConcessao(");

    assert.ok(posDesafio > -1 && posTempo > -1 && posEmite > -1);
    assert.ok(posDesafio < posEmite, "o desafio precisa ser consumido antes de emitir");
    assert.ok(posTempo < posEmite, "o tempo mínimo precisa ser conferido antes de emitir");
  });

  /**
   * Nenhuma das duas redes desta fase confirma fora de banda. A constante é
   * fixa no servidor de propósito: um campo do corpo que elevasse o nível seria
   * o próprio buraco.
   */
  test("a verificação é sempre soft, e o cliente não a escolhe", () => {
    assert.match(codigoComplete, /NivelDeVerificacao\s*=\s*"soft"/);
    assert.equal(
      /corpo\.\w*verificacao|corpo\.\w*nivel/.test(codigoComplete),
      false,
      "o cliente não pode informar o nível de verificação",
    );
  });

  test("desafio inválido não emite nada", () => {
    const posDesafio = codigoComplete.indexOf("const desafio = await consumirDesafio(");
    const bloco = codigoComplete.slice(posDesafio, posDesafio + 500);
    assert.ok(bloco.includes("if (!desafio)"));
    assert.ok(bloco.includes("403"));
  });
});

describe("Android TV continua sem anúncios", () => {
  /**
   * Cenário 17. A política desta fase é explícita: nenhum SDK, nenhum modal,
   * nenhuma mudança de reprodução na TV. O teste lê o módulo `:tv` inteiro.
   */
  test("o módulo :tv não tem dependência nem código de anúncio", () => {
    const gradle = readFileSync(join(raiz, "android/tv/build.gradle"), "utf8");
    for (const rede of ["unity", "admob", "play-services-ads", "applovin", "ironsource"]) {
      assert.equal(
        gradle.toLowerCase().includes(rede),
        false,
        `:tv não pode depender de ${rede}`,
      );
    }
  });

  test("nenhum arquivo de anúncio no código-fonte da TV", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const encontrados: string[] = [];

    const varrer = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) varrer(caminho);
        else if (/ad(s|gate)|anuncio|unity/i.test(nome)) encontrados.push(caminho);
      }
    };
    varrer(join(raiz, "android/tv/src"));

    assert.deepEqual(encontrados, [], "a TV não deve ter arquivo de anúncio");
  });
});
