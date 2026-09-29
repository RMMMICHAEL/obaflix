import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { GET as bannerGet } from "@/app/api/ads/banner-desktop/route";
import {
  ALTURA_DO_BANNER,
  DOCUMENTO_DO_BANNER,
  POSICOES_DO_BANNER,
  SANDBOX_DO_BANNER,
  TEMPO_SEM_ANUNCIO_MS,
  alturaDoIframe,
  bannerDesktopAtivo,
  criarControleDeFalhas,
  decidirBannerDesktop,
  lerMensagemDoBanner,
  urlDoBanner,
} from "../ads/bannerDesktop";
import { ComBanners } from "@/components/ads/ComBanners";
import { BannerDesktop } from "@/components/ads/BannerDesktop";
import * as React from "react";
import { createElement, isValidElement, type ReactElement } from "react";

// `tsx` compila JSX no runtime clássico (tsconfig: jsx preserve; no app quem
// transforma é o Next). Os componentes chamados aqui precisam de React no escopo.
(globalThis as { React?: typeof React }).React = React;
import { decidirRota } from "../../config/site-mode";
import { PLANO_GRATUITO, PLANO_PREMIUM, type DireitosDoPlano, type PlanoSemeado } from "../planos";
import type { Entitlements } from "../entitlements";

/**
 * Banner Monetag (In-Page Push) do app Windows.
 *
 * Trava três coisas: **quem** recebe (só Electron, só conta sujeita a anúncio,
 * só com a flag), **onde** o script existe (um documento estático isolado, e em
 * nenhum outro arquivo servido) e **como** é isolado (sandbox sem
 * `allow-same-origin`).
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

describe("decidirBannerDesktop", () => {
  const base = { ativo: true, ambiente: "desktop" as const };

  test("gratuito no desktop vê; pago não vê", () => {
    assert.equal(decidirBannerDesktop({ ...base, conta: { tipo: "resolvida", direitos: GRATUITO } }), true);
    assert.equal(decidirBannerDesktop({ ...base, conta: { tipo: "resolvida", direitos: PREMIUM } }), false);
  });

  test("anônimo vê; direito indefinido não vê", () => {
    assert.equal(decidirBannerDesktop({ ...base, conta: { tipo: "anonima" } }), true);
    assert.equal(decidirBannerDesktop({ ...base, conta: { tipo: "indefinida" } }), false);
  });

  test("navegador e Android nunca veem, qualquer que seja a conta", () => {
    for (const ambiente of ["navegador", "android"] as const) {
      for (const conta of [{ tipo: "anonima" as const }, { tipo: "resolvida" as const, direitos: GRATUITO }]) {
        assert.equal(decidirBannerDesktop({ ativo: true, ambiente, conta }), false);
      }
    }
  });

  test("flag desligada desliga tudo", () => {
    assert.equal(decidirBannerDesktop({ ativo: false, ambiente: "desktop", conta: { tipo: "anonima" } }), false);
  });

  test("anunciosObrigatorios ausente não liga banner por coerção", () => {
    const semCampo = { ...GRATUITO } as Partial<DireitosDoPlano>;
    delete semCampo.anunciosObrigatorios;
    assert.equal(
      decidirBannerDesktop({ ...base, conta: { tipo: "resolvida", direitos: semCampo as DireitosDoPlano } }),
      false,
    );
  });

  test("flag só liga com a string exata", () => {
    assert.equal(bannerDesktopAtivo({ ANUNCIO_BANNER_DESKTOP_ATIVO: "true" }), true);
    for (const v of [undefined, "", "1", "TRUE", "yes"]) {
      assert.equal(bannerDesktopAtivo({ ANUNCIO_BANNER_DESKTOP_ATIVO: v }), false);
    }
  });
});

describe("GET /api/ads/banner-desktop", () => {
  const entitlementsDe = (direitos: DireitosDoPlano) => async () =>
    ({ assinatura: { ativa: false, planoId: "x", expiraEm: null }, direitos }) as Entitlements;

  function pedido(ua: string, headers: Record<string, string> = {}) {
    return new Request("https://obaflix.test/api/ads/banner-desktop", {
      headers: { "user-agent": ua, ...headers },
    }) as never;
  }

  const ligado = { ANUNCIO_BANNER_DESKTOP_ATIVO: "true" };

  test("navegador e Android: false sem ler sessão nem entitlements", async () => {
    let consultas = 0;
    const handler = bannerGet.createForTest({
      env: ligado,
      getUserFromRequest: async () => { consultas++; return null; },
      entitlementsDoUsuario: async () => { consultas++; throw new Error("não deveria"); },
    });
    for (const ua of [UA_NAVEGADOR, UA_ANDROID]) {
      const r = await handler(pedido(ua));
      assert.deepEqual(await r.json(), { exibir: false });
    }
    assert.equal(consultas, 0);
  });

  test("desktop gratuito: true; desktop pago: false", async () => {
    const usuario = async () => ({ userId: "u1", role: "user", origem: "cookie" }) as never;
    const gratuito = bannerGet.createForTest({ env: ligado, getUserFromRequest: usuario, entitlementsDoUsuario: entitlementsDe(GRATUITO) });
    const pago = bannerGet.createForTest({ env: ligado, getUserFromRequest: usuario, entitlementsDoUsuario: entitlementsDe(PREMIUM) });
    assert.deepEqual(await (await gratuito(pedido(UA_DESKTOP))).json(), { exibir: true });
    assert.deepEqual(await (await pago(pedido(UA_DESKTOP))).json(), { exibir: false });
  });

  test("header x-obaflix-client=desktop também identifica o app", async () => {
    const handler = bannerGet.createForTest({ env: ligado, getUserFromRequest: async () => null });
    const r = await handler(pedido(UA_NAVEGADOR, { "x-obaflix-client": "desktop" }));
    assert.deepEqual(await r.json(), { exibir: true });
  });

  test("entitlements falhando: sem banner", async () => {
    const handler = bannerGet.createForTest({
      env: ligado,
      getUserFromRequest: async () => ({ userId: "u1", role: "user", origem: "cookie" }) as never,
      entitlementsDoUsuario: async () => { throw new Error("redis fora"); },
    });
    assert.deepEqual(await (await handler(pedido(UA_DESKTOP))).json(), { exibir: false });
  });

  test("flag desligada: false mesmo no desktop", async () => {
    const handler = bannerGet.createForTest({ env: {}, getUserFromRequest: async () => null });
    assert.deepEqual(await (await handler(pedido(UA_DESKTOP))).json(), { exibir: false });
  });

  test("resposta não carrega nada além de `exibir`", async () => {
    const handler = bannerGet.createForTest({ env: ligado, getUserFromRequest: async () => null });
    const corpo = await (await handler(pedido(UA_DESKTOP))).json();
    assert.deepEqual(Object.keys(corpo), ["exibir"]);
  });
});

describe("isolamento do script publicitário", () => {
  test("sandbox sem allow-same-origin, sem navegação do topo, sem download", () => {
    const flags = SANDBOX_DO_BANNER.split(/\s+/);
    assert.deepEqual(flags.sort(), ["allow-popups", "allow-scripts"]);
    for (const proibida of [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-popups-to-escape-sandbox",
      "allow-downloads",
      "allow-forms",
      "allow-modals",
    ]) {
      assert.ok(!flags.includes(proibida), proibida);
    }
  });

  test("componente usa o documento e o sandbox centrais, e só renderiza com isDesktop", () => {
    const fonte = ler("src/components/ads/BannerDesktop.tsx");
    assert.match(fonte, /sandbox=\{SANDBOX_DO_BANNER\}/);
    assert.match(fonte, /src=\{urlDoBanner\(posicao\)\}/);
    assert.match(fonte, /isDesktop === true/);
    // Mensagem do documento isolado: só deste iframe e só de origem opaca.
    assert.match(fonte, /e\.source !== alvo/);
    assert.match(fonte, /e\.origin !== "null"/);
    // Tela cheia do documento e da janela nativa desmontam o slot.
    assert.match(fonte, /fullscreenchange/);
    assert.match(fonte, /if \(!elegivel \|\| telaCheia\) return null;/);
    assert.ok(!fonte.includes("nap5k"), "o script não pode ser carregado no documento do app");
  });

  test("o documento é estático, sem querystring, sob /desktop/", () => {
    assert.equal(DOCUMENTO_DO_BANNER, "/desktop/banner.html");
    assert.ok(!DOCUMENTO_DO_BANNER.includes("?"));
  });

  test("documento do banner: detector + uma tag, só a zona 11917353, nenhum outro formato", () => {
    const html = ler("public/desktop/banner.html");
    // Dois <script> inline: o detector do Obaflix e o snippet da Monetag.
    assert.equal((html.match(/<script/g) || []).length, 2);
    assert.ok(!/<script[^>]+src=/.test(html), "nenhum script externo além do que o snippet injeta");
    assert.equal((html.match(/https?:\/\//g) || []).length, 1);
    assert.match(html, /s\.src='https:\/\/nap5k\.com\/tag\.min\.js'/);
    assert.match(html, /s\.dataset\.zone=window\.__obaflixZona/);
    // Tabela de zonas: exatamente as posições do app, todas na zona existente.
    const tabela = /var ZONAS = \{([^}]*)\}/.exec(html);
    assert.ok(tabela, "tabela ZONAS");
    const pares = [...tabela![1].matchAll(/(\w+): '(\d+)'/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(pares.map((p) => p[0]).sort(), [...POSICOES_DO_BANNER].sort());
    assert.ok(pares.every((p) => p[1] === "11917353"), "nenhuma zona inventada");
    assert.ok(!/serviceWorker|sw\.js|Notification|multitag|vignette|popunder|onclick/i.test(html));
    // O aviso ao app vai só para a própria origem, nunca "*".
    assert.match(html, /parent\.postMessage\(msg, destino\)/);
    assert.ok(!/postMessage\([^)]*['"]\*['"]/.test(html));
  });

  test("nenhum outro arquivo servido referencia a tag ou a zona", () => {
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const nome of readdirSync(join(raiz, dir))) {
        const rel = join(dir, nome);
        if (nome === "__tests__" || nome === "node_modules") continue;
        if (statSync(join(raiz, rel)).isDirectory()) { varrer(rel); continue; }
        if (!/\.(tsx?|jsx?|mjs|html|css)$/.test(nome)) continue;
        const txt = readFileSync(join(raiz, rel), "utf8");
        if (txt.includes("nap5k") || txt.includes("11917353")) achados.push(rel);
      }
    };
    for (const d of ["src", "public", "android", "desktop/electron"]) {
      try { varrer(d); } catch { /* diretório opcional */ }
    }
    assert.deepEqual(achados, [join("public", "desktop", "banner.html")]);
  });

  test("layout global, login e planos/checkout não montam o banner", () => {
    for (const p of [
      "src/app/layout.tsx",
      "src/app/login/page.tsx",
      "src/app/planos/page.tsx",
      "src/app/checkout/page.tsx",
    ]) {
      assert.ok(!/BannerDesktop|ComBanners/.test(ler(p)), p);
    }
  });

  test("player: posição player, clicável só com o overlay visível", () => {
    const player = ler("src/components/player/CustomPlayer.tsx");
    assert.match(player, /<BannerDesktop posicao="player" interativo=\{showOverlay\} \/>/);
    assert.equal((player.match(/<BannerDesktop/g) || []).length, 1);
  });

  test("headers globais dos quais o isolamento depende", () => {
    // COOP: uma janela que o anúncio abrir numa URL do app perde o vínculo
    // `opener` (medido no Electron 43) e o anúncio não consegue navegá-la.
    // XFO SAMEORIGIN: DENY quebraria o iframe; ausente, qualquer site nos emolduraria.
    // CSP frame-src 'none' fora de /assistir: no navegador comum o iframe nem carrega.
    const conf = ler("next.config.mjs");
    assert.match(conf, /key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups"/);
    assert.match(conf, /key: "X-Frame-Options", value: "SAMEORIGIN"/);
    assert.match(conf, /source: "\/\(\(\?!assistir\)\.\*\)", headers: \[\.\.\.baseHeaders, csp\("'none'"\)\]/);
  });

  test("middleware só entrega o documento ao Electron", () => {
    assert.deepEqual(decidirRota(DOCUMENTO_DO_BANNER, "desktop"), { tipo: "segue" });
    assert.deepEqual(decidirRota(DOCUMENTO_DO_BANNER, "navegador"), { tipo: "landing" });
    assert.deepEqual(decidirRota(DOCUMENTO_DO_BANNER, "android"), { tipo: "landing" });
  });
});

describe("placements", () => {
  test("url por posição usa hash (não vai ao servidor, não fragmenta cache)", () => {
    for (const p of POSICOES_DO_BANNER) {
      assert.equal(urlDoBanner(p), `/desktop/banner.html#${p}`);
      assert.equal(decidirRota(urlDoBanner(p).split("#")[0], "desktop").tipo, "segue");
    }
  });

  test("altura: nunca abaixo da inicial, nunca acima da máxima", () => {
    for (const p of POSICOES_DO_BANNER) {
      const { inicial, maxima } = ALTURA_DO_BANNER[p];
      assert.equal(alturaDoIframe(p, 0), inicial);
      assert.equal(alturaDoIframe(p, inicial + 10.2), inicial + 11);
      assert.equal(alturaDoIframe(p, 99999), maxima);
      assert.equal(alturaDoIframe(p, Number.NaN), inicial);
    }
  });

  test("fallback sem anúncio é de 10 s", () => {
    assert.equal(TEMPO_SEM_ANUNCIO_MS, 10_000);
  });

  test("mensagem do documento isolado: formato fechado", () => {
    assert.deepEqual(lerMensagemDoBanner({ obaflixBanner: 1, estado: "anuncio", altura: 96 }), { estado: "anuncio", altura: 96 });
    assert.deepEqual(lerMensagemDoBanner({ obaflixBanner: 1, estado: "vazio" }), { estado: "vazio" });
    for (const ruim of [
      null, "anuncio", 1, {}, { estado: "anuncio", altura: 1 },
      { obaflixBanner: 2, estado: "anuncio", altura: 1 },
      { obaflixBanner: 1, estado: "anuncio" },
      { obaflixBanner: 1, estado: "anuncio", altura: -1 },
      { obaflixBanner: 1, estado: "anuncio", altura: Infinity },
      { obaflixBanner: 1, estado: "navegar", url: "https://x" },
    ]) {
      assert.equal(lerMensagemDoBanner(ruim), null, JSON.stringify(ruim));
    }
  });

  test("recuo: 3 falhas seguidas pausam novos slots por 120 s; anúncio zera", () => {
    const c = criarControleDeFalhas();
    assert.equal(c.podeTentar(0), true);
    c.registrarFalha(0); c.registrarFalha(0);
    assert.equal(c.podeTentar(1), true);
    c.registrarFalha(1000);
    assert.equal(c.podeTentar(1000), false);
    assert.equal(c.podeTentar(120_999), false);
    assert.equal(c.podeTentar(121_000), true);
    c.registrarFalha(200_000); c.registrarFalha(200_000); c.registrarSucesso(); c.registrarFalha(200_000);
    assert.equal(c.podeTentar(200_000), true);
  });

  test("ComBanners: um banner feed depois de cada fileira; fileira ausente não gera banner", () => {
    const fileira = (k: string) => createElement("section", { key: k, id: k });
    const saida = ComBanners({
      children: [fileira("a"), false, null, fileira("b"), undefined, fileira("c")],
    }) as ReactElement<{ children: ReactElement<{ children: ReactElement[] }>[] }>;
    const blocos = saida.props.children;
    assert.equal(blocos.length, 3);
    for (const bloco of blocos) {
      const [row, banner] = bloco.props.children;
      assert.ok(isValidElement(row));
      assert.equal((banner as ReactElement).type, BannerDesktop);
      assert.equal(((banner as ReactElement).props as { posicao: string }).posicao, "feed");
    }
  });

  test("listagens intercalam; detalhes têm posição detalhe", () => {
    for (const p of [
      "src/components/home/HomeStreaming.tsx",
      "src/app/filmes/page.tsx",
      "src/app/series/page.tsx",
      "src/app/animes/page.tsx",
      "src/app/desenhos/page.tsx",
    ]) {
      const f = ler(p);
      assert.ok(f.includes("<ComBanners>"), p);
      assert.equal((f.match(/<ComBanners>/g) || []).length, (f.match(/<\/ComBanners>/g) || []).length, p);
      // Nada que possa renderizar vazio no cliente dentro da intercalação.
      for (const bloco of f.split("<ComBanners>").slice(1).map((b) => b.split("</ComBanners>")[0])) {
        assert.ok(!bloco.includes("<ContinuarAssistindo"), `${p}: ContinuarAssistindo dentro de ComBanners`);
        assert.ok(!bloco.includes("<PersonalizedRows"), `${p}: PersonalizedRows dentro de ComBanners`);
        assert.ok(!/^\s*<LazyRow><EpisodioRecenteRow/m.test(bloco), `${p}: EpisodioRecenteRow sem condição`);
      }
    }
    for (const p of ["src/app/filme/[id]/page.tsx", "src/app/serie/[id]/page.tsx"]) {
      const f = ler(p);
      assert.match(f, /<BannerDesktop posicao="detalhe" \/>/, p);
      assert.ok(f.indexOf('<BannerDesktop posicao="detalhe"') > f.indexOf("<MediaHero"), `${p}: abaixo do hero`);
    }
  });
});
