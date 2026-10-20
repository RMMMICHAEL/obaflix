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

  test("ligado: completo liberado a toda conta, inclusive Cortes; completo nunca concede corte", async () => {
    let tocou = false;
    const semResolver = (async () => { tocou = true; throw new Error("não devia resolver"); }) as never;
    assert.equal(await downloadPermitido("u", "completo", { controleAtivo: true, resolver: semResolver }), true);
    assert.equal(tocou, false);
    assert.equal(await downloadPermitido("u", "lote", { controleAtivo: true, resolver: resolver("nenhum", true) }), false);
    assert.equal(await downloadPermitido("u", "individual", { controleAtivo: true, resolver: resolver("nenhum", true) }), false);
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
    assert.equal((await direitosDoCliente("u", { ativa: true, controleAtivo: true, resolver })).cortesNivel, "nenhum");
    assert.equal(await downloadPermitido("u", "inventado" as never, { controleAtivo: true, resolver }), false);
    const falha = (async () => { throw new Error("indisponível"); }) as never;
    const negado = await direitosDoCliente("u", { controleAtivo: true, resolver: falha });
    assert.equal(negado.cortesNivel, "nenhum");
    assert.equal(negado.downloads, false);
  });
});

for (const nivel of ["nenhum", "individual", "lote", "ia"] as const) {
  for (const operacao of ["completo", "individual", "lote"] as const) {
    test(`servidor: ${nivel}/${operacao}, plano com downloads=false`, async () => {
      const resolver = (async () => ({ direitos: { cortesNivel: nivel, downloads: false } })) as never;
      // Completo é de toda conta, inclusive Cortes; corte segue a escada.
      const esperado = operacao === "completo" ? true : corteAutorizado(nivel, operacao);
      assert.equal(await downloadPermitido("u", operacao, { controleAtivo: true, resolver }), esperado);
      assert.equal(await downloadPermitido("u", "forjado" as never, { controleAtivo: true, resolver }), false);
    });
  }
}


test("controle desligado: plano tradicional baixa o completo com monetização ativa", async () => {
  const { direitosDoCliente } = await import("../playbackAuthorization");
  for (const downloads of [false, true]) {
    let chamadas = 0;
    const resolver = (async () => { chamadas++; return { direitos: { downloads, cortesNivel: "nenhum" } }; }) as never;
    const direitos = await direitosDoCliente("u", { ativa: true, controleAtivo: false, resolver });
    assert.equal(direitos.downloads, true);
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

describe("matriz: completo/trecho/lote por plano, monetização ligada e desligada", async () => {
  const P = await import("../planos");
  const planos = { gratuito: P.PLANO_GRATUITO, basic: P.PLANO_BASIC, plus: P.PLANO_PLUS, premium: P.PLANO_PREMIUM,
    start: P.PLANO_CORTES_START, pro: P.PLANO_CORTES_PRO, ai: P.PLANO_CORTES_AI };
  const esperado: Record<string, [boolean, boolean, boolean]> = {
    gratuito: [true, false, false], basic: [true, false, false], plus: [true, false, false], premium: [true, false, false],
    start: [true, true, false], pro: [true, true, true], ai: [true, true, true],
  };
  for (const ativa of [true, false]) {
    for (const [nome, plano] of Object.entries(planos)) {
      test(`${nome} com monetização ${ativa ? "ligada" : "desligada"}`, async () => {
        const { direitosDoCliente } = await import("../playbackAuthorization");
        const resolver = (async () => ({ direitos: plano })) as never;
        const [completo, individual, lote] = esperado[nome];
        const completoEsperado = completo;
        const op = (o: "completo" | "individual" | "lote") => downloadPermitido("u", o, { controleAtivo: true, resolver });
        assert.equal(await op("completo"), completoEsperado);
        assert.equal(await op("individual"), individual);
        assert.equal(await op("lote"), lote);
        const cliente = await direitosDoCliente("u", { ativa, controleAtivo: true, anuncioAtivo: ativa, resolver });
        assert.equal(cliente.downloads, completoEsperado);
        // Anúncio obrigatório do gratuito preservado (só aparece com anúncio ativo).
        assert.equal(cliente.anuncio, ativa && plano.anunciosObrigatorios === true);
      });
    }
  }
});
