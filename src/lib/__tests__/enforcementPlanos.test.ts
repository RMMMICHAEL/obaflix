import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TELAS_SEM_ENFORCEMENT,
  direitosDoCliente,
  limiteDeTelas,
} from "../playbackAuthorization";
import {
  PLANO_BASIC,
  PLANO_GRATUITO,
  PLANO_PREMIUM,
  inversoesDeDireito,
  planoDaLinhaCrua,
} from "../planos";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * O enforcement de `telasMax` e `downloads`.
 *
 * Os dois entram pelo mesmo desenho de `autorizarCatalogo`, e os testes cobrem o
 * que esse desenho promete:
 *
 *   - **flag desligada não custa nada** — o resolver não é chamado, e o
 *     comportamento é idêntico ao de antes desta mudança;
 *   - **falha do resolver nega** — fail-closed, com a diferença de que negar
 *     telas derruba a reprodução e negar download só tira um botão;
 *   - **o valor sai do plano**, nunca de constante nem do cliente.
 */

const raiz = process.cwd();

/** Um `Entitlements` a partir dos direitos de um plano semeado. */
function entitlementsDe(plano: PlanoSemeado): Entitlements {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return {
    assinatura: { ativa: true, planoId: plano.id, expiraEm: null },
    direitos: direitos as DireitosDoPlano,
  };
}

/** Um resolver que conta chamadas — é o que prova o bypass da flag. */
function resolverFalso(ent: Entitlements | Error) {
  let chamadas = 0;
  const resolver = async () => {
    chamadas++;
    if (ent instanceof Error) throw ent;
    return ent;
  };
  return { resolver, chamadas: () => chamadas };
}

// ── telasMax ─────────────────────────────────────────────────────────────────

describe("limiteDeTelas", () => {
  /**
   * O requisito que impede esta camada de custar alguma coisa enquanto está
   * desligada: nenhuma consulta, nenhum Redis, nenhum modo de falha novo no
   * caminho de reprodução de todo mundo.
   */
  test("flag desligada devolve o limite de hoje SEM chamar o resolver", async () => {
    const { resolver, chamadas } = resolverFalso(entitlementsDe(PLANO_BASIC));

    const r = await limiteDeTelas("u1", { ativa: false, resolver });

    assert.deepEqual(r, { situacao: "definido", limite: TELAS_SEM_ENFORCEMENT, via: "flag_desligada" });
    assert.equal(chamadas(), 0, "com a flag off, os entitlements não podem ser consultados");
  });

  test("o limite sem enforcement é o MAX_CONCURRENT real de playTokens.ts", () => {
    const fonte = readFileSync(join(raiz, "src/lib/playTokens.ts"), "utf8");
    const achado = fonte.match(/const\s+MAX_CONCURRENT\s*=\s*(\d+)/);
    assert.ok(achado, "MAX_CONCURRENT sumiu de playTokens.ts");
    assert.equal(TELAS_SEM_ENFORCEMENT, Number(achado[1]));
  });

  test("flag ligada devolve o telasMax do plano", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_BASIC));

    const r = await limiteDeTelas("u1", { ativa: true, resolver });

    assert.equal(r.situacao, "definido");
    assert.equal(r.situacao === "definido" && r.limite, 2);
    assert.equal(r.situacao === "definido" && r.via, "direito");
  });

  /**
   * O efeito mais visível da matriz aprovada: com a flag ligada, quem não assina
   * cai de 5 para 1 stream simultâneo. Com a flag desligada continua em 5 (teste
   * acima) — é a diferença entre a decisão estar gravada e estar valendo.
   */
  test("o gratuito aprovado dá UMA tela quando a flag liga", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));

    const r = await limiteDeTelas("u1", { ativa: true, resolver });

    assert.equal(r.situacao === "definido" && r.limite, 1);
    assert.notEqual(
      r.situacao === "definido" && r.limite,
      TELAS_SEM_ENFORCEMENT,
      "ligar a flag precisa mudar o limite — senão o enforcement não existe",
    );
  });

  /** Fail-closed: não saber quantas telas a conta tem não pode virar "cinco". */
  test("resolver que falha vira indeterminado, e não o limite antigo", async () => {
    const { resolver } = resolverFalso(new Error("Redis fora"));

    const r = await limiteDeTelas("u1", { ativa: true, resolver });

    assert.deepEqual(r, { situacao: "indeterminado" });
  });

  /**
   * O CHECK do banco recusa `telasMax < 1`. Chegar aqui com zero significa que
   * alguma coisa passou por fora dele — e liberar cinco por causa disso seria
   * escolher o lado errado do erro.
   */
  test("limite fora do domínio vira indeterminado, nunca permissivo", async () => {
    for (const telasMax of [0, -1, 1.5, NaN]) {
      const ent = entitlementsDe(PLANO_BASIC);
      const { resolver } = resolverFalso({ ...ent, direitos: { ...ent.direitos, telasMax } });

      const r = await limiteDeTelas("u1", { ativa: true, resolver });

      assert.deepEqual(r, { situacao: "indeterminado" }, `telasMax=${telasMax}`);
    }
  });
});

describe("playTokens aplica o limite recebido", () => {
  const fonte = readFileSync(join(raiz, "src/lib/playTokens.ts"), "utf8");
  const codigo = fonte
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

  /**
   * A regressão que este teste existe para pegar: alguém "simplificar" o
   * parâmetro de volta para a constante, e o limite por plano virar decoração.
   */
  test("a contagem compara com o parâmetro, não com a constante", () => {
    assert.match(codigo, /if \(before >= limite\)/);
    assert.equal(
      /if \(before >= MAX_CONCURRENT\)/.test(codigo),
      false,
      "a comparação voltou a usar a constante — o plano deixou de decidir",
    );
  });

  test("createStreamToken repassa o limite para registerStream", () => {
    assert.match(codigo, /registerStream\(userId, th, expiresAt, limiteDeTelas\)/);
  });
});

describe("a rota /extract resolve o limite antes de reservar o slot", () => {
  const rota = readFileSync(join(raiz, "src/app/api/player/extract/route.ts"), "utf8");
  const codigo = rota
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  test("chama limiteDeTelas e passa o valor", () => {
    assert.ok(codigo.includes("await limiteDeTelas(userId)"));
    assert.ok(codigo.includes("telas.limite"));
  });

  test("indeterminado vira 503, e não 429 nem stream liberado", () => {
    const i = codigo.indexOf('telas.situacao === "indeterminado"');
    assert.notEqual(i, -1);
    const bloco = codigo.slice(i, i + 400);
    assert.ok(bloco.includes("503"));
    assert.ok(bloco.includes("entitlements_indisponiveis"));
  });

  test("a resolução acontece antes de createStreamToken", () => {
    assert.ok(
      codigo.indexOf("await limiteDeTelas(userId)") < codigo.indexOf("await createStreamToken("),
    );
  });
});

// ── downloads ────────────────────────────────────────────────────────────────

describe("direitosDoCliente", () => {
  test("flag desligada libera download SEM chamar o resolver", async () => {
    const { resolver, chamadas } = resolverFalso(entitlementsDe(PLANO_BASIC));

    const r = await direitosDoCliente("u1", { ativa: false, resolver });

    assert.deepEqual(r, { downloads: true });
    assert.equal(chamadas(), 0);
  });

  test("basic não baixa; premium baixa", async () => {
    const basic = await direitosDoCliente("u1", {
      ativa: true,
      resolver: resolverFalso(entitlementsDe(PLANO_BASIC)).resolver,
    });
    const premium = await direitosDoCliente("u1", {
      ativa: true,
      resolver: resolverFalso(entitlementsDe(PLANO_PREMIUM)).resolver,
    });

    assert.deepEqual(basic, { downloads: false });
    assert.deepEqual(premium, { downloads: true });
  });

  /** Negar download custa um botão, não a reprodução — fail-closed é barato. */
  test("resolver que falha nega o download", async () => {
    const { resolver } = resolverFalso(new Error("banco fora"));

    assert.deepEqual(await direitosDoCliente("u1", { ativa: true, resolver }), { downloads: false });
  });

  /** Um direito `undefined` — cache de formato antigo — não vira permissão. */
  test("downloads ausente não vira true por coerção", async () => {
    const ent = entitlementsDe(PLANO_PREMIUM);
    const { resolver } = resolverFalso({
      ...ent,
      direitos: { ...ent.direitos, downloads: undefined as unknown as boolean },
    });

    assert.deepEqual(await direitosDoCliente("u1", { ativa: true, resolver }), { downloads: false });
  });

  /**
   * Só `downloads` sai para o cliente. Um objeto de direitos completo na
   * resposta seria um mapa do que vale a pena atacar, e todo o resto é decidido
   * no servidor de qualquer forma.
   */
  test("nada além de downloads atravessa", async () => {
    const r = await direitosDoCliente("u1", {
      ativa: true,
      resolver: resolverFalso(entitlementsDe(PLANO_PREMIUM)).resolver,
    });
    assert.deepEqual(Object.keys(r), ["downloads"]);
  });
});

describe("a rota /fontes devolve o direito, e o player obedece", () => {
  test("/fontes inclui direitos na resposta de sessão nova", () => {
    const rota = readFileSync(join(raiz, "src/app/api/player/fontes/route.ts"), "utf8");
    const codigo = rota.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

    assert.ok(codigo.includes("await direitosDoCliente(userId)"));
    assert.match(codigo, /fontes: projetar\(fontes\), direitos/);
  });

  test("o player exige o direito para oferecer e para executar o download", () => {
    const player = readFileSync(join(raiz, "src/components/player/CustomPlayer.tsx"), "utf8");
    const codigo = player.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

    // Vem do servidor, com comparação estrita.
    assert.match(codigo, /setPodeBaixarPeloPlano\(data\?\.direitos\?\.downloads === true\)/);
    // Gate da UI.
    assert.match(codigo, /const podeBaixar = podeBaixarPeloPlano &&/);
    // Gate da ação, para UI desatualizada não disparar o download.
    assert.match(codigo, /if \(!podeBaixarPeloPlano\) return;/);
  });

  /**
   * Nasce `false`: enquanto a sessão não abriu não há direito confirmado, e
   * mostrar o botão antes disso seria oferecer e depois tirar.
   */
  test("o estado nasce negando", () => {
    const player = readFileSync(join(raiz, "src/components/player/CustomPlayer.tsx"), "utf8");
    assert.match(player, /useState\(false\);\s*\n\s*const directStreamRef/);
  });
});

// ── Bloqueador comercial ─────────────────────────────────────────────────────

// ── Bloqueador comercial ─────────────────────────────────────────────────────

/**
 * O `gratuito` **como a linha de produção está hoje**, antes do ajuste
 * aprovado: 5 telas, download liberado, 4K, TV integral, sem anúncio.
 *
 * Fica escrito aqui, e não lido de `PLANO_GRATUITO`, porque a constante já foi
 * atualizada para os valores aprovados. Os dois estados coexistem de verdade —
 * o código diz um, o banco diz outro, e só o script de ajuste reconcilia. É
 * exatamente essa distância que a trava precisa enxergar.
 */
const GRATUITO_NO_BANCO = {
  ...PLANO_GRATUITO,
  anunciosObrigatorios: false,
  downloads: true,
  telasMax: 5,
  resolucaoMax: "4k" as const,
  tvNivel: "completo" as const,
};

describe("inversoesDeDireito: o gratuito não pode valer mais que um plano pago", () => {
  /**
   * O estado que motivou a trava: a linha em produção supera o Basic pago em
   * três direitos, o Plus em dois e o Premium em um.
   */
  test("o gratuito de produção TEM inversão, e ela é detectada", () => {
    const inv = inversoesDeDireito(GRATUITO_NO_BANCO);
    assert.ok(inv.length > 0, "a inversão da linha atual precisa ser detectada");

    const doBasic = inv.filter((i) => i.planoPago === "basic").map((i) => i.campo).sort();
    assert.deepEqual(doBasic, ["downloads", "resolucaoMax", "telasMax"]);
  });

  test("premium só é superado em telas — o resto já era coerente", () => {
    const doPremium = inversoesDeDireito(GRATUITO_NO_BANCO)
      .filter((i) => i.planoPago === "premium")
      .map((i) => i.campo);
    assert.deepEqual(doPremium, ["telasMax"]);
  });

  /**
   * O outro lado da trava, e a razão de ela se levantar sozinha: os valores
   * aprovados zeram as inversões. Quando a linha do banco receber estes valores,
   * `seed:planos:apply` passa a ser permitido sem que ninguém edite a trava.
   */
  test("os valores APROVADOS zeram as inversões", () => {
    assert.deepEqual(inversoesDeDireito(PLANO_GRATUITO), []);
  });

  test("compara pela escala, não pela string", () => {
    const base = { ...PLANO_GRATUITO, resolucaoMax: "4k" as const };
    const inv = inversoesDeDireito(base, [{ ...PLANO_BASIC, resolucaoMax: "sd" }]);
    assert.deepEqual(inv.map((i) => i.campo), ["resolucaoMax"]);
  });

  /** `anunciosObrigatorios` é o campo invertido: `false` entrega mais. */
  test("anúncio obrigatório num plano pago conta como inversão", () => {
    const pago: PlanoSemeado = { ...PLANO_BASIC, anunciosObrigatorios: true };
    const padraoSemAnuncio = { ...PLANO_GRATUITO, anunciosObrigatorios: false };

    const inv = inversoesDeDireito(padraoSemAnuncio, [pago]);
    assert.deepEqual(inv.map((i) => i.campo), ["anunciosObrigatorios"]);
  });

  /**
   * O gratuito aprovado exige anúncio e o Basic não — essa direção está certa e
   * **não** é inversão. O teste existe porque é fácil errar o sinal do campo.
   */
  test("gratuito com anúncio e pago sem anúncio NÃO é inversão", () => {
    const inv = inversoesDeDireito(PLANO_GRATUITO).filter(
      (i) => i.campo === "anunciosObrigatorios",
    );
    assert.deepEqual(inv, []);
  });
});

describe("planoDaLinhaCrua: a trava lê o banco, não a constante", () => {
  /**
   * A armadilha que este par de funções existe para evitar: editar a constante
   * num commit e a trava se levantar, enquanto a linha de produção continua
   * invertida. Verde falso no único ponto em que o verde importa.
   */
  test("uma linha crua vira o formato comparável", () => {
    const lido = planoDaLinhaCrua({ ...GRATUITO_NO_BANCO, criadoEm: new Date() });
    assert.ok(lido);
    assert.equal(lido?.telasMax, 5);
    assert.equal(lido?.downloads, true);
  });

  test("a linha crua de produção ainda acusa inversão, mesmo com a constante já ajustada", () => {
    const lido = planoDaLinhaCrua(GRATUITO_NO_BANCO);
    assert.ok(lido);
    assert.ok(
      inversoesDeDireito(lido!).length > 0,
      "a trava precisa continuar fechada enquanto o banco não for ajustado",
    );
    // E a constante, no mesmo instante, já está limpa. As duas coisas convivem.
    assert.deepEqual(inversoesDeDireito(PLANO_GRATUITO), []);
  });

  const invalidas: [string, Record<string, unknown> | null][] = [
    ["null", null],
    ["sem id", { ...GRATUITO_NO_BANCO, id: undefined }],
    ["telasMax não inteiro", { ...GRATUITO_NO_BANCO, telasMax: 2.5 }],
    ["telasMax string", { ...GRATUITO_NO_BANCO, telasMax: "5" }],
    ["downloads ausente", { ...GRATUITO_NO_BANCO, downloads: undefined }],
    ["canaisNivel fora do domínio", { ...GRATUITO_NO_BANCO, canaisNivel: "ouro" }],
    ["resolucaoMax fora do domínio", { ...GRATUITO_NO_BANCO, resolucaoMax: "8k" }],
    ["tvNivel fora do domínio", { ...GRATUITO_NO_BANCO, tvNivel: "parcial" }],
  ];

  for (const [nome, linha] of invalidas) {
    /**
     * Devolver `null` importa: quem chama não pode concluir "sem inversão" a
     * partir de uma linha que não conseguiu ler. Não conseguir ler o plano
     * padrão é motivo para parar, não para liberar.
     */
    test(`recusa: ${nome}`, () => {
      assert.equal(planoDaLinhaCrua(linha), null);
    });
  }

  test("episodiosPorAnuncio nulo é válido; texto não é", () => {
    assert.ok(planoDaLinhaCrua({ ...GRATUITO_NO_BANCO, episodiosPorAnuncio: null }));
    assert.equal(planoDaLinhaCrua({ ...GRATUITO_NO_BANCO, episodiosPorAnuncio: "3" }), null);
  });
});

describe("o seed e o script de ajuste, como código", () => {
  const semComentarios = (arquivo: string) =>
    readFileSync(join(raiz, arquivo), "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

  const seed = semComentarios("scripts/seed-planos.ts");
  const ajuste = semComentarios("scripts/ajustar-plano-gratuito.ts");

  test("o seed compara a LINHA DO BANCO, não a constante", () => {
    assert.ok(seed.includes("planoDaLinhaCrua(linhaPadrao)"));
    assert.ok(seed.includes("inversoesDeDireito(padraoReal)"));
    assert.equal(
      seed.includes("inversoesDeDireito(PLANO_GRATUITO)"),
      false,
      "comparar a constante deixaria a trava se levantar antes de o banco mudar",
    );
  });

  test("o seed recusa --apply enquanto houver inversão", () => {
    assert.match(seed, /if \(aplicar\)[\s\S]{0,200}RECUSADO/);
    assert.equal(/--ignorar|--forcar|--force/.test(seed), false);
  });

  test("linha ilegível para o seed, em vez de liberar", () => {
    assert.ok(seed.includes("if (!padraoReal)"));
    assert.match(seed, /PARADA[\s\S]{0,600}exitCode = 1/);
  });

  /**
   * O seed nunca sobrescreve — é o que o torna seguro de rodar. Então a
   * sobrescrita mora num script com nome próprio, e é lá que o `update` existe.
   */
  test("o seed não atualiza plano; o script de ajuste atualiza só o gratuito", () => {
    assert.equal(/plano\.update|plano\.upsert/.test(seed), false);

    const updates = ajuste.match(/prisma\.\w+\.(update|upsert|create|delete)\w*/g) ?? [];
    assert.deepEqual(updates, ["prisma.plano.update"], "uma escrita, e só em Plano");
    assert.ok(ajuste.includes('where: { id: PLANO_GRATUITO.id }'));
  });

  test("o ajuste exige --apply e recusa se sobrar inversão", () => {
    assert.ok(ajuste.includes('process.argv.includes("--apply")'));
    assert.match(ajuste, /RECUSADO/);
    assert.ok(ajuste.includes("inversoesDeDireito({ id: PLANO_GRATUITO.id, ...DIREITOS })"));
  });

  /** Não toca em ehPadrao: mudar isso poderia deixar o sistema sem plano padrão. */
  test("o ajuste não mexe em ehPadrao, ativo, Assinatura nem Canal", () => {
    for (const proibido of ["ehPadrao:", "ativo:", "assinatura.update", "assinatura.create", "canal."]) {
      assert.equal(ajuste.includes(proibido), false, `${proibido} não pertence ao ajuste`);
    }
  });
});
