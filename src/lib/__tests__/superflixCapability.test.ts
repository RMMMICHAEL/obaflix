import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { suportaDesafioInterativo } from "../superflixCapability";

/**
 * A fonte de desafio interativo aparece para quem consegue conduzir o desafio,
 * e só.
 *
 * O gap que estes testes fecham: `montarFontes` já exigia
 * `desafioInterativo: true` em ambiente `android`, mas nenhum dos dois caminhos
 * web mandava o campo — então o aplicativo móvel, que sabe conduzir o desafio,
 * nunca recebia a fonte. A TV mandava, por `ApiObaflix`, e por isso era o único
 * Android que a via.
 *
 * Os dois lados são cobertos separadamente de propósito: a decisão do cliente
 * (`suportaDesafioInterativo`) e o efeito dela na montagem (`montarFontes`).
 * O que amarra os dois é o campo `desafioInterativo` do POST, e é por isso que
 * a montagem é exercitada com os mesmos valores que a decisão produz.
 */

/** Ponte completa do aplicativo móvel, como o shim de MainActivity a injeta. */
function ponteDoAplicativo(extra: Record<string, unknown> = {}) {
  return {
    platform: "android",
    isAndroid: true,
    suportaSuperflix: true,
    extractStream: () => {},
    prepareSuperflix: () => {},
    resolveSuperflix: () => {},
    setKeepScreenOn: () => {},
    ...extra,
  };
}

/** Ponte do Electron, como o preload a expõe: sem `platform`, sem a capacidade. */
function ponteDoElectron() {
  return {
    isDesktop: true,
    extractStream: () => {},
    prepareSuperflix: () => {},
    resolveSuperflix: () => {},
    toggleFullscreen: () => {},
  };
}

describe("capacidade de desafio interativo no cliente", () => {
  test("aplicativo movel com a capacidade declarada: true", () => {
    assert.equal(suportaDesafioInterativo(ponteDoAplicativo()), true);
  });

  test("aplicativo movel sem a capacidade: false", () => {
    // WebView abaixo da 118: a ponte existe, os metodos existem, e o nativo diz
    // que nao consegue esconder o X-Requested-With.
    assert.equal(
      suportaDesafioInterativo(ponteDoAplicativo({ suportaSuperflix: false })),
      false,
    );
  });

  test("aplicativo antigo, que nao declara o campo: false", () => {
    // Site novo com APK velho. Continua sem a fonte, que e o comportamento de
    // hoje — nao regride e nao passa a oferecer o que nao funciona.
    const ponte = ponteDoAplicativo();
    delete (ponte as Record<string, unknown>).suportaSuperflix;
    assert.equal(suportaDesafioInterativo(ponte), false);
  });

  test("capacidade declarada mas sem os metodos do fluxo: false", () => {
    const ponte = ponteDoAplicativo();
    delete (ponte as Record<string, unknown>).resolveSuperflix;
    assert.equal(suportaDesafioInterativo(ponte), false);
  });

  test("valor que nao e booleano nao vale por verdadeiro", () => {
    for (const valor of ["true", 1, {}, [], "sim"]) {
      assert.equal(
        suportaDesafioInterativo(ponteDoAplicativo({ suportaSuperflix: valor })),
        false,
        `suportaSuperflix=${JSON.stringify(valor)} deveria recusar`,
      );
    }
  });

  test("navegador Android comum, sem ponte: false", () => {
    // O caso que o enunciado proibe hardcodear: e Android, e nao tem ponte.
    assert.equal(suportaDesafioInterativo(undefined), false);
    assert.equal(suportaDesafioInterativo(null), false);
    assert.equal(suportaDesafioInterativo({}), false);
  });

  test("shim precoce, antes do shim completo: false", () => {
    // registrarShimPrecoceDeAtualizacao injeta so isto; o pedido que saisse
    // nesse instante pede a lista sem a fonte, como hoje.
    assert.equal(
      suportaDesafioInterativo({
        platform: "android",
        isAndroid: true,
        __obaflixEarly: true,
        onUpdateReady: () => {},
        installUpdate: () => {},
      }),
      false,
    );
  });

  test("Electron: false pela ponte, e a fonte chega por outro caminho", () => {
    // O preload nao define `platform`. Nao e regressao: em `montarFontes` o
    // Electron passa por `!ehAndroid`, exercitado no bloco seguinte.
    assert.equal(suportaDesafioInterativo(ponteDoElectron()), false);
  });
});

describe("montagem de fontes por ambiente", () => {
  let m: typeof import("../fontes");

  before(async () => {
    // fontes.ts pede o cliente do Redis no primeiro uso; a montagem nao toca
    // nele, mas o stub evita que o import tenha efeito de rede.
    (globalThis as Record<string, unknown>).obaflixMemoryStore = {
      async get() { return null; },
      async set() { return "OK" as const; },
      async expire() { return 1; },
      async ttl() { return -2; },
    };
    m = await import("../fontes");
  });

  const ENTRADA = {
    tmdbId: "1234",
    titulo: "Exemplo",
    conteudoTipo: "filme" as const,
    urlDub: null,
    urlLeg: null,
  };

  const temSuperflix = (fontes: { iframeDesafio?: boolean; provider: string }[]) =>
    fontes.some((f) => f.provider === "superflix");

  test("android movel COM capacidade inclui a fonte", () => {
    const fontes = m.montarFontes({
      ...ENTRADA, ambiente: "android", desafioInterativo: true,
    });
    assert.equal(temSuperflix(fontes), true);
  });

  test("android movel SEM capacidade continua filtrando", () => {
    const fontes = m.montarFontes({
      ...ENTRADA, ambiente: "android", desafioInterativo: false,
    });
    assert.equal(temSuperflix(fontes), false);
  });

  test("android sem o campo continua filtrando", () => {
    const fontes = m.montarFontes({ ...ENTRADA, ambiente: "android" });
    assert.equal(temSuperflix(fontes), false);
  });

  test("TV nao muda: e o mesmo android com capacidade", () => {
    // A TV manda a flag por ApiObaflix.desafioInterativoSuportado, e este
    // commit nao toca nesse caminho. O que prova que ela nao mudou e a fonte
    // continuar entrando exatamente nas mesmas condicoes.
    const fontes = m.montarFontes({
      ...ENTRADA, ambiente: "android", desafioInterativo: true,
    });
    assert.equal(temSuperflix(fontes), true);
  });

  test("Electron nao muda: entra sem a flag, e a flag nao altera nada", () => {
    const sem = m.montarFontes({ ...ENTRADA, ambiente: "electron" });
    const comFalse = m.montarFontes({
      ...ENTRADA, ambiente: "electron", desafioInterativo: false,
    });
    assert.equal(temSuperflix(sem), true);
    assert.equal(temSuperflix(comFalse), true);
    assert.deepEqual(
      sem.map((f) => f.provider),
      comFalse.map((f) => f.provider),
    );
  });

  test("web comum nao muda em nenhuma das duas formas", () => {
    const sem = m.montarFontes({ ...ENTRADA, ambiente: "web" });
    const comTrue = m.montarFontes({
      ...ENTRADA, ambiente: "web", desafioInterativo: true,
    });
    assert.equal(temSuperflix(sem), false);
    assert.equal(temSuperflix(comTrue), false);
    assert.deepEqual(
      sem.map((f) => f.provider),
      comTrue.map((f) => f.provider),
    );
  });

  test("a fonte entra marcada como desafio de iframe", () => {
    // Sem esta marca o player nao sabe que precisa do overlay, e a fonte
    // apareceria na lista como se fosse extraivel direto.
    const superflix = m.montarFontes({
      ...ENTRADA, ambiente: "android", desafioInterativo: true,
    }).find((f) => f.provider === "superflix");
    assert.ok(superflix, "a fonte deveria existir");
    assert.equal(superflix.iframeDesafio, true);
  });
});
