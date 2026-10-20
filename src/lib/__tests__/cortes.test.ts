import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { corteAutorizado, type CortesNivel, type ModoCorte } from "../planos";
import { downloadPermitido, cortesControleAtivo } from "../playbackAuthorization";

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

describe("downloadPermitido: controle desligado preserva; ligado aplica o direito", () => {
  const resolver = (nivel: CortesNivel, downloads = false) => (async () => ({
    assinatura: { ativa: true, planoId: "x", expiraEm: null },
    direitos: { cortesNivel: nivel, downloads },
  })) as unknown as typeof import("../entitlements").entitlementsDoUsuario;

  test("desligado: libera sem sequer resolver o direito (planos de hoje seguem baixando/cortando)", async () => {
    let tocou = false;
    const portas = { controleAtivo: false, resolver: (async () => { tocou = true; throw new Error("não devia resolver"); }) as never };
    assert.equal(await downloadPermitido("u", "lote", portas), true);
    assert.equal(await downloadPermitido("u", "completo", portas), true);
    assert.equal(tocou, false);
  });

  test("ligado: lote exige nível lote; individual basta individual; nenhum nega", async () => {
    assert.equal(await downloadPermitido("u", "lote", { controleAtivo: true, resolver: resolver("individual") }), false);
    assert.equal(await downloadPermitido("u", "lote", { controleAtivo: true, resolver: resolver("lote") }), true);
    assert.equal(await downloadPermitido("u", "individual", { controleAtivo: true, resolver: resolver("individual") }), true);
    assert.equal(await downloadPermitido("u", "individual", { controleAtivo: true, resolver: resolver("nenhum") }), false);
  });

  test("ligado: completo segue a regra de sempre — gratuito/assinante baixa; cortes não liberam por omissão", async () => {
    // Monetização desligada: completo liberado para qualquer conta (o anúncio vem depois, no fluxo existente).
    assert.equal(await downloadPermitido("u", "completo", { controleAtivo: true, ativa: false, resolver: resolver("nenhum", false) }), true);
    // Monetização ligada: completo volta a exigir `downloads` do plano.
    assert.equal(await downloadPermitido("u", "completo", { controleAtivo: true, ativa: true, resolver: resolver("lote", false) }), false);
    assert.equal(await downloadPermitido("u", "completo", { controleAtivo: true, ativa: true, resolver: resolver("nenhum", true) }), true);
    // Ter download completo nunca concede corte.
    assert.equal(await downloadPermitido("u", "lote", { controleAtivo: true, ativa: false, resolver: resolver("nenhum", true) }), false);
    assert.equal(await downloadPermitido("u", "individual", { controleAtivo: true, ativa: false, resolver: resolver("nenhum", true) }), false);
  });

  test("ligado: erro ao resolver nega (nunca concede por coerção)", async () => {
    const r = await downloadPermitido("u", "individual", {
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

test("interface: cada nível e usuários tradicionais recebem os gates correspondentes", () => {
  const player = readFileSync("src/components/player/CustomPlayer.tsx", "utf8");
  const expressao = (nome: string) => {
    const linha = player.split("\n").find((l) => l.trimStart().startsWith(`const ${nome} = `));
    assert.ok(linha);
    return linha.trim().slice(`const ${nome} = `.length, -1);
  };
  for (const [nivelCortes, individual, lote] of [
    ["nenhum", false, false], ["individual", true, false],
    ["lote", true, true], ["ia", true, true], ["forjado", false, false],
  ] as const) {
    for (const podeBaixarPeloPlano of [false, true]) {
      const contexto = { nivelCortes, podeBaixarPeloPlano, controleCortes: true };
      assert.equal(runInNewContext(expressao("podeCortar"), contexto), individual);
      assert.equal(runInNewContext(expressao("podeLote"), contexto), lote);
      contexto.controleCortes = false;
      assert.equal(runInNewContext(expressao("podeCortar"), contexto), podeBaixarPeloPlano);
      assert.equal(runInNewContext(expressao("podeLote"), contexto), podeBaixarPeloPlano);
    }
  }
});


describe("direitos do Electron na resposta existente", () => {
  for (const nivel of ["nenhum", "individual", "lote", "ia"] as const) {
    test(`projeta ${nivel} uma vez, independente da monetização`, async () => {
      const { direitosDoCliente } = await import("../playbackAuthorization");
      let chamadas = 0;
      const resolver = (async () => { chamadas++; return { direitos: { downloads: false, cortesNivel: nivel } }; }) as never;
      assert.deepEqual(await direitosDoCliente("u", { ativa: false, controleAtivo: true, anuncioAtivo: false, resolver }), {
        downloads: true, cortesNivel: nivel, cortesControleAtivo: true, anuncio: false,
      });
      assert.equal(chamadas, 1);
    });
  }
  test("flag desligada preserva direitos tradicionais e não consulta sem monetização", async () => {
    const { direitosDoCliente } = await import("../playbackAuthorization");
    const resolver = (async () => { throw new Error("não consultar"); }) as never;
    assert.deepEqual(await direitosDoCliente("u", { ativa: false, controleAtivo: false, anuncioAtivo: false, resolver }), {
      downloads: true, cortesNivel: "nenhum", cortesControleAtivo: false, anuncio: false,
    });
  });
  test("ausência de direitos e falha negam; operação falsificada não concede", async () => {
    const { direitosDoCliente } = await import("../playbackAuthorization");
    const resolver = (async () => ({ direitos: {} })) as never;
    assert.equal((await direitosDoCliente("u", { ativa: true, controleAtivo: true, resolver })).downloads, false);
    assert.equal(await downloadPermitido("u", "inventado" as never, { controleAtivo: true, resolver }), false);
    const falha = (async () => { throw new Error("indisponível"); }) as never;
    assert.equal((await direitosDoCliente("u", { controleAtivo: true, resolver: falha })).cortesNivel, "nenhum");
  });
});

for (const nivel of ["nenhum", "individual", "lote", "ia"] as const) {
  for (const operacao of ["completo", "individual", "lote"] as const) {
    test(`servidor: ${nivel}/${operacao}, plano sem download completo e monetização ligada`, async () => {
      const resolver = (async () => ({ direitos: { cortesNivel: nivel, downloads: false } })) as never;
      const esperado = operacao !== "completo" && corteAutorizado(nivel, operacao);
      assert.equal(await downloadPermitido("u", operacao, { controleAtivo: true, ativa: true, resolver }), esperado);
      assert.equal(await downloadPermitido("u", "forjado" as never, { controleAtivo: true, resolver }), false);
    });
  }
}


test("controle desligado mantém downloads do plano tradicional com monetização ativa", async () => {
  const { direitosDoCliente } = await import("../playbackAuthorization");
  for (const downloads of [false, true]) {
    let chamadas = 0;
    const resolver = (async () => { chamadas++; return { direitos: { downloads, cortesNivel: "nenhum" } }; }) as never;
    const direitos = await direitosDoCliente("u", { ativa: true, controleAtivo: false, resolver });
    assert.equal(direitos.downloads, downloads);
    assert.equal(direitos.cortesControleAtivo, false);
    assert.equal(chamadas, 1);
  }
});

test("anúncio: gratuito com anúncio ativo recebe o aviso; assinante isento não", async () => {
  const { direitosDoCliente } = await import("../playbackAuthorization");
  const de = (anunciosObrigatorios: boolean) => (async () => ({ direitos: { downloads: true, cortesNivel: "nenhum", anunciosObrigatorios } })) as never;
  assert.equal((await direitosDoCliente("u", { ativa: false, controleAtivo: true, anuncioAtivo: true, resolver: de(true) })).anuncio, true);
  assert.equal((await direitosDoCliente("u", { ativa: false, controleAtivo: true, anuncioAtivo: true, resolver: de(false) })).anuncio, false);
  assert.equal((await direitosDoCliente("u", { ativa: false, controleAtivo: true, anuncioAtivo: false, resolver: de(true) })).anuncio, false);
});
