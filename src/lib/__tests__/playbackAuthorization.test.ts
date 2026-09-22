import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  autorizarCatalogo,
  direitoDeCatalogo,
  monetizacaoAtiva,
  negativaDeCatalogo,
  type ConteudoAutorizavel,
} from "../playbackAuthorization";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano } from "../planos";

/**
 * A decisão comercial de acesso ao catálogo, sem banco, sem Redis e sem
 * `NextRequest`.
 *
 * A regra é pura e o resolver entra por injeção, então tudo que importa é
 * exercitável aqui — inclusive o que **não** deve acontecer, que nesta fase é a
 * parte mais importante: com a flag desligada, a camada nova não pode sequer
 * ser consultada.
 */

function direitos(over: Partial<DireitosDoPlano> = {}): DireitosDoPlano {
  return {
    anunciosObrigatorios: false,
    episodiosPorAnuncio: null,
    janelaAnuncioHoras: 24,
    filmes: true,
    series: true,
    canaisNivel: "nenhum",
    downloads: true,
    telasMax: 5,
    perfisMax: 1,
    resolucaoMax: "4k",
    tvNivel: "completo",
    servidorVip: false,
    ...over,
  };
}

function entitlements(over: Partial<DireitosDoPlano> = {}): Entitlements {
  return {
    assinatura: { ativa: false, planoId: "gratuito", expiraEm: null },
    direitos: direitos(over),
  };
}

/** Um resolver que conta chamadas — é como se prova que ele NÃO foi chamado. */
function resolverFalso(resultado: Entitlements) {
  const registro = { chamadas: 0, usuarios: [] as string[] };
  const resolver = async (userId: string): Promise<Entitlements> => {
    registro.chamadas++;
    registro.usuarios.push(userId);
    return resultado;
  };
  return { resolver, registro };
}

const resolverQueExplode = async (): Promise<Entitlements> => {
  throw new Error("o resolver não deveria ter sido chamado");
};

// ── A flag ───────────────────────────────────────────────────────────────────

describe("MONETIZACAO_ATIVA: só a string exata liga", () => {
  test('"true" liga', () => {
    assert.equal(monetizacaoAtiva({ MONETIZACAO_ATIVA: "true" }), true);
  });

  for (const valor of ["false", "0", "1", "TRUE", "True", "yes", "sim", " true", "true "]) {
    test(`"${valor}" NÃO liga`, () => {
      assert.equal(monetizacaoAtiva({ MONETIZACAO_ATIVA: valor }), false);
    });
  }

  test("string vazia não liga", () => {
    assert.equal(monetizacaoAtiva({ MONETIZACAO_ATIVA: "" }), false);
  });

  test("variável ausente não liga — é o default", () => {
    assert.equal(monetizacaoAtiva({}), false);
  });

  /**
   * O erro que a comparação estrita evita.
   *
   * Com `Boolean(process.env.MONETIZACAO_ATIVA)`, escrever
   * `MONETIZACAO_ATIVA=false` para desligar LIGARIA o enforcement, porque
   * `Boolean("false")` é `true`. Este teste existe para deixar registrado que a
   * diferença é intencional, e não para testar o JavaScript.
   */
  test('"false" ligaria sob Boolean(), e é por isso que não usamos Boolean()', () => {
    assert.equal(Boolean("false"), true);
    assert.equal(monetizacaoAtiva({ MONETIZACAO_ATIVA: "false" }), false);
  });
});

// ── Bypass ───────────────────────────────────────────────────────────────────

describe("flag desligada é bypass real, não decisão ignorada", () => {
  for (const tipo of ["filme", "serie"] as const) {
    test(`${tipo} é permitido sem consultar entitlements`, async () => {
      const { resolver, registro } = resolverFalso(entitlements({ filmes: false, series: false }));

      const r = await autorizarCatalogo("u1", tipo, { ativa: false, resolver });

      assert.deepEqual(r, { situacao: "permitido", via: "flag_desligada" });
      assert.equal(registro.chamadas, 0, "o resolver não podia ter sido chamado");
    });
  }

  test("um resolver que lança não derruba nada com a flag desligada", async () => {
    // Se a camada resolvesse e ignorasse o resultado, este teste explodiria —
    // que é justamente a diferença entre bypass e decisão descartada.
    const r = await autorizarCatalogo("u1", "filme", {
      ativa: false,
      resolver: resolverQueExplode,
    });

    assert.equal(r.situacao, "permitido");
  });

  test("mesmo negando os dois direitos, a flag desligada libera", async () => {
    const { resolver } = resolverFalso(entitlements({ filmes: false, series: false }));
    for (const tipo of ["filme", "serie"] as const) {
      const r = await autorizarCatalogo("u1", tipo, { ativa: false, resolver });
      assert.equal(r.situacao, "permitido");
    }
  });
});

// ── Direitos ─────────────────────────────────────────────────────────────────

describe("flag ligada: o direito explícito decide", () => {
  test("filmes=true permite filme", async () => {
    const { resolver, registro } = resolverFalso(entitlements({ filmes: true }));
    const r = await autorizarCatalogo("u1", "filme", { ativa: true, resolver });

    assert.deepEqual(r, { situacao: "permitido", via: "direito" });
    assert.equal(registro.chamadas, 1);
    assert.deepEqual(registro.usuarios, ["u1"]);
  });

  test("filmes=false nega filme", async () => {
    const { resolver } = resolverFalso(entitlements({ filmes: false }));
    const r = await autorizarCatalogo("u1", "filme", { ativa: true, resolver });
    assert.deepEqual(r, { situacao: "negado" });
  });

  test("series=true permite série", async () => {
    const { resolver } = resolverFalso(entitlements({ series: true }));
    const r = await autorizarCatalogo("u1", "serie", { ativa: true, resolver });
    assert.deepEqual(r, { situacao: "permitido", via: "direito" });
  });

  test("series=false nega série", async () => {
    const { resolver } = resolverFalso(entitlements({ series: false }));
    const r = await autorizarCatalogo("u1", "serie", { ativa: true, resolver });
    assert.deepEqual(r, { situacao: "negado" });
  });

  test("direito de filme não concede série", async () => {
    const { resolver } = resolverFalso(entitlements({ filmes: true, series: false }));

    assert.equal((await autorizarCatalogo("u1", "filme", { ativa: true, resolver })).situacao, "permitido");
    assert.equal((await autorizarCatalogo("u1", "serie", { ativa: true, resolver })).situacao, "negado");
  });

  test("direito de série não concede filme", async () => {
    const { resolver } = resolverFalso(entitlements({ filmes: false, series: true }));

    assert.equal((await autorizarCatalogo("u1", "serie", { ativa: true, resolver })).situacao, "permitido");
    assert.equal((await autorizarCatalogo("u1", "filme", { ativa: true, resolver })).situacao, "negado");
  });
});

describe("o que NÃO participa da decisão", () => {
  test("anunciosObrigatorios não muda nada nesta fase", async () => {
    for (const anunciosObrigatorios of [true, false]) {
      const { resolver } = resolverFalso(entitlements({ anunciosObrigatorios, filmes: true }));
      const r = await autorizarCatalogo("u1", "filme", { ativa: true, resolver });
      assert.equal(r.situacao, "permitido", "anúncio não é assunto da Fase 3");
    }
  });

  test("episodiosPorAnuncio e janelaAnuncioHoras também não", async () => {
    const { resolver } = resolverFalso(
      entitlements({ episodiosPorAnuncio: 3, janelaAnuncioHoras: 1, series: true }),
    );
    const r = await autorizarCatalogo("u1", "serie", { ativa: true, resolver });
    assert.equal(r.situacao, "permitido");
  });

  test("downloads, telasMax, resolucaoMax, tvNivel e canaisNivel não bloqueiam", async () => {
    const { resolver } = resolverFalso(
      entitlements({
        filmes: true,
        series: true,
        downloads: false,
        telasMax: 1,
        perfisMax: 1,
        resolucaoMax: "sd",
        tvNivel: "nenhum",
        canaisNivel: "nenhum",
      }),
    );

    assert.equal((await autorizarCatalogo("u1", "filme", { ativa: true, resolver })).situacao, "permitido");
    assert.equal((await autorizarCatalogo("u1", "serie", { ativa: true, resolver })).situacao, "permitido");
  });

  test("assinatura.ativa não autoriza por si — quem decide é o direito", async () => {
    // Assinante ativo, mas o plano dele não inclui séries.
    const comAssinatura: Entitlements = {
      assinatura: { ativa: true, planoId: "basico", expiraEm: new Date("2030-01-01") },
      direitos: direitos({ series: false }),
    };
    const { resolver } = resolverFalso(comAssinatura);

    assert.equal((await autorizarCatalogo("u1", "serie", { ativa: true, resolver })).situacao, "negado");
  });

  test("plano de id sugestivo não concede nada por si", async () => {
    const premiumSemDireito: Entitlements = {
      assinatura: { ativa: true, planoId: "premium", expiraEm: new Date("2030-01-01") },
      direitos: direitos({ filmes: false, series: false }),
    };
    const { resolver } = resolverFalso(premiumSemDireito);

    assert.equal((await autorizarCatalogo("u1", "filme", { ativa: true, resolver })).situacao, "negado");
    assert.equal((await autorizarCatalogo("u1", "serie", { ativa: true, resolver })).situacao, "negado");
  });
});

describe("direitoDeCatalogo: comparação estrita", () => {
  test("mapeia cada tipo ao seu direito", () => {
    assert.equal(direitoDeCatalogo(direitos({ filmes: true, series: false }), "filme"), true);
    assert.equal(direitoDeCatalogo(direitos({ filmes: true, series: false }), "serie"), false);
  });

  test("direito ausente não vira permissão por coerção", () => {
    // Coluna nova, cache de formato antigo, projeção incompleta: qualquer coisa
    // que chegue diferente de `true` nega, em vez de ser coagida.
    const semCampo = { ...direitos() } as Partial<DireitosDoPlano>;
    delete semCampo.filmes;
    assert.equal(
      direitoDeCatalogo(semCampo as DireitosDoPlano, "filme"),
      false,
    );
  });
});

// ── Falhas ───────────────────────────────────────────────────────────────────

describe("falha ao resolver nega, e é distinguível de direito negado", () => {
  class EntitlementsIndefinidosFalso extends Error {
    readonly motivo = "assinaturas_ambiguas";
  }

  test("EntitlementsIndefinidos vira indeterminado, não permitido", async () => {
    const r = await autorizarCatalogo("u1", "filme", {
      ativa: true,
      resolver: async () => {
        throw new EntitlementsIndefinidosFalso("duas válidas");
      },
    });

    assert.deepEqual(r, { situacao: "indeterminado" });
  });

  test("erro inesperado também vira indeterminado", async () => {
    const r = await autorizarCatalogo("u1", "serie", {
      ativa: true,
      resolver: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    assert.deepEqual(r, { situacao: "indeterminado" });
  });

  test("nenhuma falha resulta em permitido — fail-closed", async () => {
    const falhas = [
      () => {
        throw new Error("banco fora");
      },
      () => {
        throw new EntitlementsIndefinidosFalso("sem plano padrão");
      },
      () => {
        throw "string solta";
      },
    ];

    for (const falhar of falhas) {
      for (const tipo of ["filme", "serie"] as ConteudoAutorizavel[]) {
        const r = await autorizarCatalogo("u1", tipo, {
          ativa: true,
          resolver: async () => falhar() as never,
        });
        assert.notEqual(r.situacao, "permitido");
      }
    }
  });

  test("direito negado e falha de resolução são situações diferentes", async () => {
    const { resolver } = resolverFalso(entitlements({ filmes: false }));
    const negado = await autorizarCatalogo("u1", "filme", { ativa: true, resolver });
    const indeterminado = await autorizarCatalogo("u1", "filme", {
      ativa: true,
      resolver: async () => {
        throw new Error("qualquer coisa");
      },
    });

    assert.notDeepEqual(negado, indeterminado);
    assert.equal(negado.situacao, "negado");
    assert.equal(indeterminado.situacao, "indeterminado");
  });

  test("o erro original não vaza no resultado", async () => {
    const r = await autorizarCatalogo("u1", "filme", {
      ativa: true,
      resolver: async () => {
        throw new Error("assinatura ckz9 aponta para plano inexistente");
      },
    });

    assert.deepEqual(Object.keys(r), ["situacao"]);
    assert.equal(JSON.stringify(r).includes("ckz9"), false);
  });
});

// ── Resposta HTTP ────────────────────────────────────────────────────────────

describe("negativaDeCatalogo: o que sai para o cliente", () => {
  test("permitido não gera negativa", () => {
    assert.equal(negativaDeCatalogo({ situacao: "permitido", via: "direito" }), null);
    assert.equal(negativaDeCatalogo({ situacao: "permitido", via: "flag_desligada" }), null);
  });

  test("direito negado é 403", () => {
    const n = negativaDeCatalogo({ situacao: "negado" })!;
    assert.equal(n.status, 403);
    assert.equal(n.corpo.codigo, "conteudo_indisponivel_no_plano");
    assert.equal(n.evento, "playback_negado");
  });

  test("falha de resolução é 503, não 403", () => {
    const n = negativaDeCatalogo({ situacao: "indeterminado" })!;
    assert.equal(n.status, 503);
    assert.equal(n.corpo.codigo, "entitlements_indisponiveis");
    assert.equal(n.evento, "entitlements_indisponiveis");
  });

  test("nunca 401 — o usuário já está autenticado", () => {
    for (const r of [{ situacao: "negado" }, { situacao: "indeterminado" }] as const) {
      assert.notEqual(negativaDeCatalogo(r)!.status, 401);
    }
  });

  test("o corpo é curto e não carrega detalhe interno", () => {
    for (const r of [{ situacao: "negado" }, { situacao: "indeterminado" }] as const) {
      const n = negativaDeCatalogo(r)!;
      assert.deepEqual(Object.keys(n.corpo).sort(), ["codigo", "error"]);
      const texto = JSON.stringify(n.corpo).toLowerCase();
      for (const proibido of ["assinatura", "plano_da", "ambigua", "stack", "prisma", "redis"]) {
        assert.equal(texto.includes(proibido), false, `"${proibido}" não pode sair na resposta`);
      }
    }
  });

  test("os dois eventos de auditoria são distintos", () => {
    assert.notEqual(
      negativaDeCatalogo({ situacao: "negado" })!.evento,
      negativaDeCatalogo({ situacao: "indeterminado" })!.evento,
    );
  });
});

// ── A rota ───────────────────────────────────────────────────────────────────

/**
 * Onde o enforcement está dentro de `/api/player/fontes`.
 *
 * O ideal seria chamar o handler com um `NextRequest` e substituir suas
 * dependências. Não dá sem custo desproporcional: o handler exige um JWT válido
 * em `getUserFromRequest`, toca Prisma e Redis logo na entrada, e a substituição
 * de módulos no runner do Node ainda depende de
 * `--experimental-test-module-mocks`, que ligaria uma flag experimental para a
 * suíte inteira do projeto.
 *
 * A fronteira que dava para extrair foi extraída — `autorizarCatalogo` e
 * `negativaDeCatalogo` são testadas acima, sem `NextRequest`. O que sobra é uma
 * propriedade de **ordem** dentro da rota, e é isso que os testes abaixo
 * verificam, lendo o arquivo.
 *
 * Sejamos exatos sobre o alcance: eles provam que a chamada de autorização
 * aparece no fonte antes das operações caras, e que o caminho de alternativas
 * não passou a decidir por `conteudoTipo`. Não provam execução. Se alguém
 * envolver a autorização num `if` que nunca é verdadeiro, isto continua
 * passando — mas mover a chamada para depois de `criarSessaoFontes`, que é a
 * regressão real e provável, quebra.
 */
describe("posição do enforcement em /api/player/fontes", () => {
  const rota = readFileSync(
    join(process.cwd(), "src/app/api/player/fontes/route.ts"),
    "utf8",
  );

  /**
   * Só código, sem comentários de linha inteira.
   *
   * Necessário porque os comentários desta rota descrevem a própria regra e
   * citam `direitos.filmes`, `MONETIZACAO_ATIVA` e `autorizarCatalogo`. Sem
   * removê-los, as verificações abaixo estariam lendo prosa em vez de código —
   * e acusariam a documentação como se fosse implementação.
   */
  const codigo = rota
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("//"))
    .join("\n");

  const posicaoDe = (trecho: string, fonte = codigo) => {
    const i = fonte.indexOf(trecho);
    assert.notEqual(i, -1, `"${trecho}" não foi encontrado na rota`);
    return i;
  };

  test("a autorização acontece antes de qualquer trabalho caro", () => {
    const autorizacao = posicaoDe("autorizarCatalogo(userId, conteudoTipo)");

    // Só o que pertence à criação de sessão. `buscarAlternativasPlayerflix`
    // fica de fora de propósito: ela é do caminho de alternativas, que por
    // decisão desta fase não passa pela autorização.
    for (const caro of ["buscarWarez2(", "montarFontes({", "criarSessaoFontes("]) {
      // A definição de cada função está no topo do arquivo; a chamada dentro da
      // criação de sessão é a ÚLTIMA ocorrência.
      assert.ok(
        codigo.lastIndexOf(caro) > autorizacao,
        `${caro} deveria vir depois da autorização — usuário negado não pode custar isso`,
      );
    }
  });

  test("negar acontece antes de criar a sessão de fontes", () => {
    const negativa = posicaoDe("negativaDeCatalogo(");
    const criacao = posicaoDe("const sessao = await criarSessaoFontes(");
    assert.ok(negativa < criacao);
  });

  test("a autorização acontece depois da autenticação", () => {
    const auth = posicaoDe("await getUserFromRequest(req)");
    const autorizacao = posicaoDe("autorizarCatalogo(userId, conteudoTipo)");
    assert.ok(auth < autorizacao, "não se autoriza quem ainda não se autenticou");
  });

  test("o caminho de alternativas não chama a autorização", () => {
    // Reautorizar ali usaria `corpo.conteudoTipo`, que vem do cliente — e daria
    // aparência de trava a uma checagem que o próprio cliente controla.
    const inicioAlternativas = posicaoDe("corpo.alternativas === true");
    const autorizacao = posicaoDe("autorizarCatalogo(userId, conteudoTipo)");
    assert.ok(
      autorizacao > inicioAlternativas,
      "a autorização deve ficar fora do bloco de alternativas",
    );

    // O bloco termina onde começa a criação de sessão nova.
    const fimDoBloco = posicaoDe("Primeira fase", rota);
    const blocoAlternativas = codigo.slice(
      inicioAlternativas,
      Math.min(fimDoBloco, autorizacao),
    );
    assert.equal(
      blocoAlternativas.includes("autorizarCatalogo"),
      false,
      "o bloco de alternativas não pode decidir por tipo declarado pelo cliente",
    );
  });

  test("série sem temporada/episódio é recusada antes da decisão comercial", () => {
    const validacao = posicaoDe('conteudoTipo === "serie" && (temporada === null');
    const autorizacao = posicaoDe("autorizarCatalogo(userId, conteudoTipo)");
    assert.ok(validacao < autorizacao);
  });

  test("a rota não decide nada por conta própria", () => {
    // Se um `if (ent.direitos.filmes)` aparecer aqui, a regra passou a viver em
    // dois lugares — e o segundo é o que ninguém testa.
    for (const proibido of [
      "direitos.filmes",
      "direitos.series",
      "MONETIZACAO_ATIVA",
      "entitlementsDoUsuario",
    ]) {
      assert.equal(
        codigo.includes(proibido),
        false,
        `${proibido} não deve aparecer no código da rota — a decisão vive em playbackAuthorization`,
      );
    }
  });
});
