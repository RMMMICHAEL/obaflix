import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { corteAutorizado, type CortesNivel, type ModoCorte } from "../planos";
import { cortePermitido, cortesControleAtivo } from "../playbackAuthorization";

describe("corteAutorizado: escada nenhum<individual<lote<ia, default-deny", () => {
  const casos: [CortesNivel, ModoCorte, boolean][] = [
    ["nenhum", "individual", false], ["nenhum", "lote", false],
    ["individual", "individual", true], ["individual", "lote", false],
    ["lote", "individual", true], ["lote", "lote", true],
    ["ia", "individual", true], ["ia", "lote", true],
  ];
  for (const [nivel, modo, esperado] of casos) {
    test(`${nivel} x ${modo} = ${esperado}`, () => assert.equal(corteAutorizado(nivel, modo), esperado));
  }
  test("nível fora do domínio nega (nunca concede por coerção)", () => {
    assert.equal(corteAutorizado("premium" as unknown as CortesNivel, "individual"), false);
  });
});

describe("cortePermitido: controle desligado preserva; ligado aplica o direito", () => {
  const resolver = (nivel: CortesNivel) => (async () => ({
    assinatura: { ativa: true, planoId: "x", expiraEm: null },
    direitos: { cortesNivel: nivel },
  })) as unknown as typeof import("../entitlements").entitlementsDoUsuario;

  test("desligado: libera sem sequer resolver o direito (planos de hoje seguem cortando)", async () => {
    let tocou = false;
    const r = await cortePermitido("u", "lote", {
      controleAtivo: false,
      resolver: (async () => { tocou = true; throw new Error("não devia resolver"); }) as never,
    });
    assert.equal(r, true);
    assert.equal(tocou, false);
  });

  test("ligado: lote exige nível lote", async () => {
    assert.equal(await cortePermitido("u", "lote", { controleAtivo: true, resolver: resolver("individual") }), false);
    assert.equal(await cortePermitido("u", "lote", { controleAtivo: true, resolver: resolver("lote") }), true);
  });

  test("ligado: individual basta nível individual, nenhum nega", async () => {
    assert.equal(await cortePermitido("u", "individual", { controleAtivo: true, resolver: resolver("individual") }), true);
    assert.equal(await cortePermitido("u", "individual", { controleAtivo: true, resolver: resolver("nenhum") }), false);
  });

  test("ligado: erro ao resolver nega (nunca concede por coerção)", async () => {
    const r = await cortePermitido("u", "individual", {
      controleAtivo: true,
      resolver: (async () => { throw new Error("redis down"); }) as never,
    });
    assert.equal(r, false);
  });
});

test("cortesControleAtivo: só a string exata 'true' liga, independente de MONETIZACAO", () => {
  assert.equal(cortesControleAtivo({ CORTES_CONTROLE_ATIVO: "true" }), true);
  assert.equal(cortesControleAtivo({ CORTES_CONTROLE_ATIVO: "1" }), false);
  assert.equal(cortesControleAtivo({}), false);
});
