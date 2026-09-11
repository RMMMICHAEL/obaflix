import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TELAS_SEM_ENFORCEMENT,
  direitosDoCliente,
  limiteDeTelas,
} from "../playbackAuthorization";
import { PLANO_BASIC, PLANO_GRATUITO, PLANO_PREMIUM, inversoesDeDireito } from "../planos";
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

  test("o gratuito continua com cinco, mesmo com a flag ligada", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));

    const r = await limiteDeTelas("u1", { ativa: true, resolver });

    assert.equal(r.situacao === "definido" && r.limite, 5);
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

describe("inversoesDeDireito: o gratuito não pode valer mais que um plano pago", () => {
  /**
   * O estado de hoje, e a razão do bloqueador: o gratuito entrega 5 telas,
   * download e 4K; o Basic pago entrega 2, sem download, em HD.
   */
  test("a matriz atual TEM inversão, e ela é detectada", () => {
    const inv = inversoesDeDireito(PLANO_GRATUITO);
    assert.ok(inv.length > 0, "a inversão de hoje precisa ser detectada");

    const doBasic = inv.filter((i) => i.planoPago === "basic").map((i) => i.campo).sort();
    assert.deepEqual(doBasic, ["downloads", "resolucaoMax", "telasMax"]);
  });

  test("premium só é superado em telas — o resto já é coerente", () => {
    const doPremium = inversoesDeDireito(PLANO_GRATUITO)
      .filter((i) => i.planoPago === "premium")
      .map((i) => i.campo);
    assert.deepEqual(doPremium, ["telasMax"]);
  });

  /** A trava precisa se levantar sozinha quando o gratuito for ajustado. */
  test("um gratuito restringido zera as inversões", () => {
    const restringido: PlanoSemeado = {
      ...PLANO_GRATUITO,
      telasMax: 1,
      downloads: false,
      resolucaoMax: "hd",
      canaisNivel: "nenhum",
      tvNivel: "limitado",
    };

    assert.deepEqual(inversoesDeDireito(restringido), []);
  });

  test("compara pela escala, não pela string", () => {
    const comQuatroK: PlanoSemeado = { ...PLANO_GRATUITO, telasMax: 1, downloads: false };
    const inv = inversoesDeDireito(comQuatroK, [{ ...PLANO_BASIC, resolucaoMax: "sd" }]);
    assert.deepEqual(inv.map((i) => i.campo), ["resolucaoMax"]);
  });

  /** `anunciosObrigatorios` é o campo invertido: `false` entrega mais. */
  test("anúncio obrigatório num plano pago conta como inversão", () => {
    const pago: PlanoSemeado = {
      ...PLANO_BASIC,
      telasMax: 5,
      downloads: true,
      resolucaoMax: "4k",
      anunciosObrigatorios: true,
    };

    const inv = inversoesDeDireito(PLANO_GRATUITO, [pago]);
    assert.deepEqual(inv.map((i) => i.campo), ["anunciosObrigatorios"]);
  });

  test("o seed recusa --apply enquanto houver inversão", () => {
    const script = readFileSync(join(raiz, "scripts/seed-planos.ts"), "utf8");
    // Sem comentário de linha NEM de bloco: o cabeçalho do script cita `--force`
    // exatamente para dizer que ele não existe, e leria como se existisse.
    const codigo = script
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

    assert.ok(codigo.includes("inversoesDeDireito(PLANO_GRATUITO)"));
    assert.match(codigo, /if \(aplicar\)[\s\S]{0,200}RECUSADO/);
    // Sem escotilha de fuga, pelo mesmo motivo de não existir `--force`.
    assert.equal(/--ignorar|--forcar|--force/.test(codigo), false);
  });
});
