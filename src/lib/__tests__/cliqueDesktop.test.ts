import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GET as cliqueGet } from "@/app/api/ads/click-desktop/route";
import {
  FREQUENCIA_PADRAO,
  SELETOR_SEM_CLIQUE,
  cliqueDesktopAtivo,
  cliqueElegivel,
  criarContadorDeCliques,
  decidirCliqueDesktop,
  frequenciaDoCliqueDesktop,
  lerRespostaDoClique,
  rotaAceitaClique,
} from "../ads/cliqueDesktop";
import { PLANO_GRATUITO, PLANO_PREMIUM, type DireitosDoPlano, type PlanoSemeado } from "../planos";
import type { Entitlements } from "../entitlements";

/**
 * Anúncio por clique do app Windows (Direct Link aberto pelo processo
 * principal). Trava: quem recebe (desktop, gratuito/anônimo, flag própria),
 * frequência configurável com fallback, que cliques contam, e que o renderer
 * nunca conhece nem escolhe a URL.
 */

const raiz = process.cwd();
const ler = (p: string) => readFileSync(join(raiz, p), "utf8");

function direitosDe(plano: PlanoSemeado): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return direitos as DireitosDoPlano;
}
const GRATUITO = direitosDe(PLANO_GRATUITO);
const PREMIUM = direitosDe(PLANO_PREMIUM);

const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile ObaflixApp/1.0";
const UA_NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36";
const LIGADO = { ANUNCIO_CLICK_DESKTOP_ATIVO: "true" };
const DIRECT_LINK = "omg10.com";

function pedido(ua: string, headers: Record<string, string> = {}) {
  return new Request("https://obaflix.test/api/ads/click-desktop", { headers: { "user-agent": ua, ...headers } }) as never;
}
const usuario = async () => ({ userId: "u1", role: "user", origem: "cookie" }) as never;
const entitlementsDe = (direitos: DireitosDoPlano) => async () =>
  ({ assinatura: { ativa: false, planoId: "x", expiraEm: null }, direitos }) as Entitlements;

describe("GET /api/ads/click-desktop", () => {
  test("gratuito habilitado recebe elegibilidade e frequência padrão", async () => {
    const h = cliqueGet.createForTest({ env: LIGADO, getUserFromRequest: usuario, entitlementsDoUsuario: entitlementsDe(GRATUITO) });
    assert.deepEqual(await (await h(pedido(UA_DESKTOP))).json(), { exibir: true, intervaloCliques: 3, cooldownSeg: 120 });
  });

  test("anônimo habilitado recebe", async () => {
    const h = cliqueGet.createForTest({ env: LIGADO, getUserFromRequest: async () => null });
    assert.equal((await (await h(pedido(UA_DESKTOP))).json()).exibir, true);
  });

  test("pago não recebe", async () => {
    const h = cliqueGet.createForTest({ env: LIGADO, getUserFromRequest: usuario, entitlementsDoUsuario: entitlementsDe(PREMIUM) });
    assert.deepEqual(await (await h(pedido(UA_DESKTOP))).json(), { exibir: false });
  });

  test("entitlements falhando: não recebe", async () => {
    const h = cliqueGet.createForTest({
      env: LIGADO, getUserFromRequest: usuario, entitlementsDoUsuario: async () => { throw new Error("redis fora"); },
    });
    assert.deepEqual(await (await h(pedido(UA_DESKTOP))).json(), { exibir: false });
  });

  test("flag desligada (ou só a do banner ligada): ninguém recebe", async () => {
    for (const env of [{}, { ANUNCIO_CLICK_DESKTOP_ATIVO: "1" }, { ANUNCIO_CLICK_DESKTOP_ATIVO: "TRUE" }, { ANUNCIO_BANNER_DESKTOP_ATIVO: "true" }]) {
      const h = cliqueGet.createForTest({ env, getUserFromRequest: async () => null });
      assert.deepEqual(await (await h(pedido(UA_DESKTOP))).json(), { exibir: false }, JSON.stringify(env));
    }
  });

  test("navegador e Android: false sem ler sessão nem entitlements", async () => {
    let consultas = 0;
    const h = cliqueGet.createForTest({
      env: LIGADO,
      getUserFromRequest: async () => { consultas++; return null; },
      entitlementsDoUsuario: async () => { consultas++; throw new Error("não deveria"); },
    });
    for (const ua of [UA_NAVEGADOR, UA_ANDROID]) {
      assert.deepEqual(await (await h(pedido(ua))).json(), { exibir: false }, ua);
    }
    assert.equal(consultas, 0);
  });

  test("frequência vem do servidor; resposta nunca carrega o Direct Link", async () => {
    const env = { ...LIGADO, ANUNCIO_CLICK_DESKTOP_INTERVALO_CLIQUES: "5", ANUNCIO_CLICK_DESKTOP_COOLDOWN_SEG: "300" };
    const h = cliqueGet.createForTest({ env, getUserFromRequest: async () => null });
    const r = await h(pedido(UA_DESKTOP));
    const texto = await r.text();
    assert.deepEqual(JSON.parse(texto), { exibir: true, intervaloCliques: 5, cooldownSeg: 300 });
    assert.ok(!texto.includes(DIRECT_LINK) && !/https?:/.test(texto));
    assert.equal(r.headers.get("cache-control"), "private, max-age=120");
  });
});

describe("decisão e configuração", () => {
  test("mesma regra do banner, com flag própria", () => {
    const base = { ativo: true, ambiente: "desktop" as const };
    assert.equal(decidirCliqueDesktop({ ...base, conta: { tipo: "resolvida", direitos: GRATUITO } }), true);
    assert.equal(decidirCliqueDesktop({ ...base, conta: { tipo: "anonima" } }), true);
    assert.equal(decidirCliqueDesktop({ ...base, conta: { tipo: "resolvida", direitos: PREMIUM } }), false);
    assert.equal(decidirCliqueDesktop({ ...base, conta: { tipo: "indefinida" } }), false);
    for (const ambiente of ["navegador", "android"] as const) {
      assert.equal(decidirCliqueDesktop({ ativo: true, ambiente, conta: { tipo: "anonima" } }), false);
    }
    assert.equal(decidirCliqueDesktop({ ativo: false, ambiente: "desktop", conta: { tipo: "anonima" } }), false);
    assert.equal(cliqueDesktopAtivo({ ANUNCIO_CLICK_DESKTOP_ATIVO: "true" }), true);
    for (const v of [undefined, "", "1", "TRUE", "yes", " true"]) assert.equal(cliqueDesktopAtivo({ ANUNCIO_CLICK_DESKTOP_ATIVO: v }), false);
  });

  test("valores inválidos usam os padrões (3 cliques, 120 s)", () => {
    assert.deepEqual(FREQUENCIA_PADRAO, { intervaloCliques: 3, cooldownSeg: 120 });
    assert.deepEqual(frequenciaDoCliqueDesktop({}), FREQUENCIA_PADRAO);
    for (const [i, c] of [["0", "0"], ["-1", "-5"], ["abc", "1e3"], ["2.5", "60.5"], ["101", "86401"], ["", " "], ["3x", "10"]]) {
      assert.deepEqual(
        frequenciaDoCliqueDesktop({ ANUNCIO_CLICK_DESKTOP_INTERVALO_CLIQUES: i, ANUNCIO_CLICK_DESKTOP_COOLDOWN_SEG: c }),
        FREQUENCIA_PADRAO, `${i}/${c}`,
      );
    }
    assert.deepEqual(
      frequenciaDoCliqueDesktop({ ANUNCIO_CLICK_DESKTOP_INTERVALO_CLIQUES: "1", ANUNCIO_CLICK_DESKTOP_COOLDOWN_SEG: "30" }),
      { intervaloCliques: 1, cooldownSeg: 30 },
    );
  });

  test("cliente só aceita resposta no formato fechado", () => {
    assert.deepEqual(lerRespostaDoClique({ exibir: true, intervaloCliques: 3, cooldownSeg: 120 }), { intervaloCliques: 3, cooldownSeg: 120 });
    for (const ruim of [
      null, {}, { exibir: false }, { exibir: "true", intervaloCliques: 3, cooldownSeg: 120 },
      { exibir: true }, { exibir: true, intervaloCliques: 0, cooldownSeg: 120 },
      { exibir: true, intervaloCliques: 3, cooldownSeg: 5 }, { exibir: true, intervaloCliques: 3.5, cooldownSeg: 120 },
    ]) {
      assert.equal(lerRespostaDoClique(ruim), null, JSON.stringify(ruim));
    }
  });
});

describe("contador", () => {
  test("intervalo 3: 1º e 2º não abrem, 3º abre; cooldown impede a próxima; depois recomeça", () => {
    const c = criarContadorDeCliques({ intervaloCliques: 3, cooldownSeg: 120 });
    assert.equal(c.registrar(1_000), "contar");
    assert.equal(c.registrar(2_000), "contar");
    assert.equal(c.registrar(3_000), "abrir");
    c.confirmarAbertura(3_000);
    for (const t of [4_000, 5_000, 6_000, 122_999]) assert.equal(c.registrar(t), "cooldown");
    assert.equal(c.registrar(123_000), "contar");
    assert.equal(c.registrar(124_000), "contar");
    assert.equal(c.registrar(125_000), "abrir");
  });

  test("abertura recusada pelo processo principal: o próximo clique elegível tenta de novo", () => {
    const c = criarContadorDeCliques({ intervaloCliques: 3, cooldownSeg: 120 });
    c.registrar(1); c.registrar(2);
    assert.equal(c.registrar(3), "abrir");
    // sem confirmarAbertura (main negou): continua na vez
    assert.equal(c.registrar(4), "abrir");
  });
});

describe("que cliques contam", () => {
  const ORIGEM = "https://obaflix.vercel.app";
  // Elemento mínimo: `closest` casa por "tipo" declarado no teste.
  const el = (casa: (sel: string) => unknown = () => null) => ({ closest: casa });
  const clique = (over: Partial<Parameters<typeof cliqueElegivel>[0]> = {}) =>
    cliqueElegivel({ confiavel: true, botao: 0, alvo: el(), pathname: "/", telaCheia: false, origemDoApp: ORIGEM, ...over });

  test("clique real comum no catálogo conta", () => {
    assert.equal(clique(), true);
    for (const p of ["/", "/filmes", "/series", "/filme/123", "/serie/9", "/buscar", "/desktop"]) assert.equal(clique({ pathname: p }), true, p);
  });

  test("clique sintético, botão não principal e tela cheia não contam", () => {
    assert.equal(clique({ confiavel: false }), false);
    assert.equal(clique({ botao: 1 }), false);
    assert.equal(clique({ botao: 2 }), false);
    assert.equal(clique({ telaCheia: true }), false);
    assert.equal(clique({ alvo: null }), false);
  });

  test("rotas de player, conta, pagamento e login não contam", () => {
    for (const p of ["/assistir/filme/1", "/assistir/serie/1/1/1", "/player", "/canais", "/planos", "/checkout/x", "/conta", "/login", "/cadastro", "/desktop-auth", "/parear", "/admin"]) {
      assert.equal(rotaAceitaClique(p), false, p);
      assert.equal(clique({ pathname: p }), false, p);
    }
  });

  test("controles sensíveis e alvos marcados não contam", () => {
    const itens = SELETOR_SEM_CLIQUE.split(", ");
    for (const esperado of [
      "input", "textarea", "select", "[contenteditable]:not([contenteditable='false'])", "video",
      "[role='slider']", "[role='progressbar']", "[role='dialog']", "[aria-modal='true']",
      "[aria-label*='fechar' i]", "[aria-label*='volume' i]", "[aria-label*='tela cheia' i]", "[aria-label*='fullscreen' i]",
      "[data-no-click-ad]", "[data-banner-posicao]",
    ]) {
      assert.ok(itens.includes(esperado), esperado);
    }
    // Qualquer ancestral sensível derruba o clique.
    assert.equal(clique({ alvo: el((sel) => (sel === SELETOR_SEM_CLIQUE ? {} : null)) }), false);
  });

  test("links que saem do app não contam (o clique original precisa do gesto)", () => {
    const link = (attrs: Record<string, string>) =>
      el((sel) => (sel === "a[href]" ? { getAttribute: (n: string) => (n in attrs ? attrs[n] : null) } : null));
    assert.equal(clique({ alvo: link({ href: "/filme/1" }) }), true, "link interno conta");
    assert.equal(clique({ alvo: link({ href: `${ORIGEM}/serie/2` }) }), true);
    const saem: Record<string, string>[] = [
      { href: "https://www.imdb.com/title/tt1" },
      { href: "/filme/1", target: "_blank" },
      { href: "/arquivo", download: "" },
      { href: "mailto:x@y.z" },
      { href: "javascript:void(0)" },
      { href: "http://[::1" },
    ];
    for (const attrs of saem) {
      assert.equal(clique({ alvo: link(attrs) }), false, JSON.stringify(attrs));
    }
  });
});

describe("renderer: passivo, sem URL, só no app Windows", () => {
  const fonte = ler("src/components/ads/CliqueDesktop.tsx");
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  test("listener passivo: o clique original do Obaflix segue intacto", () => {
    assert.match(codigo, /document\.addEventListener\("click", aoClicar, \{ capture: true, passive: true \}\)/);
    assert.ok(!/preventDefault|stopPropagation|stopImmediatePropagation/.test(codigo));
    assert.ok(!/dispatchEvent|\.click\(\)|new MouseEvent|createEvent/.test(codigo), "nenhum clique sintético");
    assert.ok(!/createElement|appendChild|<div|<iframe/.test(codigo), "nenhum overlay");
    assert.match(codigo, /return null;/);
  });

  test("ponte sem parâmetro; URL do anúncio nunca no cliente", () => {
    assert.match(codigo, /ponte\.openClickAd!\(\)/);
    assert.ok(!/openClickAd!?\([^)]/.test(codigo));
    for (const p of ["src/components/ads/CliqueDesktop.tsx", "src/lib/ads/cliqueDesktop.ts", "src/app/api/ads/click-desktop/route.ts"]) {
      const txt = ler(p);
      assert.ok(!txt.includes(DIRECT_LINK) && !txt.includes("11767843"), p);
      assert.ok(!/al5sm|11923183|tag\.min\.js/.test(txt), `${p}: nada da zona OnClick`);
    }
  });

  test("web normal e Android não ativam: sem ponte do app Windows, sem fetch e sem listener", () => {
    assert.match(codigo, /if \(ponte\?\.isDesktop !== true \|\| ponte\.platform === "android"\) return null;/);
    assert.match(codigo, /typeof ponte\.openClickAd === "function"/);
    const efeito = codigo.slice(codigo.indexOf("useEffect("));
    assert.ok(efeito.indexOf("if (!ponte) return;") < efeito.indexOf("fetch("), "porta antes do fetch");
    assert.ok(efeito.indexOf("if (!ponte) return;") < efeito.indexOf("addEventListener"), "porta antes do listener");
    assert.match(codigo, /confiavel: e\.isTrusted/);
  });

  test("montado uma vez no layout do app (não no admin)", () => {
    const layout = ler("src/app/layout.tsx");
    assert.equal((layout.match(/<CliqueDesktop \/>/g) || []).length, 1);
    assert.ok(layout.indexOf("<CliqueDesktop />") > layout.indexOf("<AppModeProvider>"));
  });

  test("In-Page Push intacto: zona 11921288 no banner do ads-site", () => {
    const banner = ler("ads-site/public/banner.html");
    assert.match(banner, /feed: '11921288'/);
    assert.match(banner, /detalhe: '11921288'/);
    assert.match(banner, /player: '11921288'/);
    assert.ok(!/al5sm|11923183/.test(banner));
  });
});
