import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import {
  CODIGO_COMPRAS_INDISPONIVEIS_PLAY,
  ehClientePlay,
  ehClientePlayNoNavegador,
  rotaComercialBloqueadaNoPlay,
} from "@/config/play";
import { downloadsHabilitados } from "@/lib/androidMedia";
import { POST as ordersPost } from "../../app/api/billing/orders/route";

/**
 * Estágio 2 — Google Play consumo apenas.
 *
 * O cliente Play (User-Agent `ObaflixPlay/`) não compra, não abre planos/checkout
 * e não baixa. O marcador só RESTRINGE: navegador, APK direto, Electron e TV não
 * o enviam e seguem idênticos. Nada aqui concede acesso por flag do cliente.
 */

// ── ehClientePlay (servidor): só restringe quem envia ObaflixPlay/ ─────────────

test("ehClientePlay reconhece o app da Play e ninguém mais", () => {
  assert.equal(ehClientePlay("Mozilla/5.0 (Linux; Android 13) ObaflixApp/1.0 ObaflixPlay/1.0"), true);
  // APK direto (fora da Play): tem ObaflixApp/, nunca ObaflixPlay/.
  assert.equal(ehClientePlay("Mozilla/5.0 (Linux; Android 13) ObaflixApp/1.0"), false);
  assert.equal(ehClientePlay("Mozilla/5.0 (Windows NT 10.0) Chrome/120"), false);
  assert.equal(ehClientePlay("Mozilla/5.0 ObaflixDesktop/1.0.12"), false);
  assert.equal(ehClientePlay(null), false);
  assert.equal(ehClientePlay(undefined), false);
});

// ── rotaComercialBloqueadaNoPlay: só /planos e /checkout ───────────────────────

test("rotaComercialBloqueadaNoPlay cobre planos e checkout por prefixo, nada além", () => {
  for (const p of ["/planos", "/planos/", "/planos?plano=x", "/checkout", "/checkout?planoId=x"]) {
    assert.equal(rotaComercialBloqueadaNoPlay(p), true, `${p} deveria bloquear`);
  }
  for (const p of ["/conta", "/planos-falso", "/checkouts", "/", "/android", "/filme/abc"]) {
    assert.equal(rotaComercialBloqueadaNoPlay(p), false, `${p} não deveria bloquear`);
  }
});

// ── downloadsHabilitados: capability do Estágio 1 ──────────────────────────────

test("downloadsHabilitados só esconde o download quando a capability é false explícito", () => {
  assert.equal(downloadsHabilitados({ downloads: false }), false); // build Play
  assert.equal(downloadsHabilitados({ downloads: true }), true); // APK direto
  assert.equal(downloadsHabilitados({}), true); // versão antiga sem a flag
  assert.equal(downloadsHabilitados(undefined), true);
  assert.equal(downloadsHabilitados(null), true);
});

// ── ehClientePlayNoNavegador (cliente): flag do shim, ponte, ou UA ─────────────

function definir(nome: string, valor: unknown) {
  Object.defineProperty(globalThis, nome, { value: valor, configurable: true, writable: true });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "navigator");
});

test("ehClientePlayNoNavegador: flag nativa, ponte.isPlayStore ou UA — senão false", () => {
  definir("navigator", { userAgent: "Mozilla/5.0 Chrome/120" });

  definir("window", { __OBAFLIX_PLAY_STORE__: true });
  assert.equal(ehClientePlayNoNavegador(), true);

  definir("window", { obaflixDesktop: { isPlayStore: true } });
  assert.equal(ehClientePlayNoNavegador(), true);

  definir("window", {});
  definir("navigator", { userAgent: "Mozilla/5.0 ObaflixApp/1.0 ObaflixPlay/1.0" });
  assert.equal(ehClientePlayNoNavegador(), true);

  // Navegador comum e APK direto (sem ObaflixPlay/) não são Play.
  definir("window", {});
  definir("navigator", { userAgent: "Mozilla/5.0 Chrome/120" });
  assert.equal(ehClientePlayNoNavegador(), false);
  definir("navigator", { userAgent: "Mozilla/5.0 ObaflixApp/1.0" });
  assert.equal(ehClientePlayNoNavegador(), false);
});

// ── POST /api/billing/orders: recusa o Play, preserva o resto ──────────────────

function pedido(ua: string) {
  return new NextRequest("http://local/api/billing/orders", {
    method: "POST",
    headers: { "user-agent": ua, "content-type": "application/json" },
  });
}

test("POST /api/billing/orders recusa o cliente Play com código estável, sem criar pedido", async () => {
  const res = await ordersPost(pedido("Mozilla/5.0 (Linux; Android 13) ObaflixApp/1.0 ObaflixPlay/1.0"));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.codigo, CODIGO_COMPRAS_INDISPONIVEIS_PLAY);
  assert.equal(body.codigo, "compras_indisponiveis_play");
  // A recusa vem antes da flag, da sessão, do banco e do provedor: o teste roda
  // sem DATABASE_URL e sem mock de prisma, logo nenhum PedidoPagamento/PIX pôde
  // ser criado — se o gate falhasse, a rota tentaria o banco antes do 403.
});

test("POST /api/billing/orders não aplica o gate do Play a navegador/APK direto", async () => {
  // Navegador comum: o gate do Play NÃO dispara. Com a cobrança desligada no
  // ambiente de teste, cai em 503 cobranca_indisponivel — nunca o 403 do Play.
  const res = await ordersPost(pedido("Mozilla/5.0 (Windows NT 10.0) Chrome/120"));
  assert.notEqual(res.status, 403);
  const body = await res.json();
  assert.notEqual(body.codigo, CODIGO_COMPRAS_INDISPONIVEIS_PLAY);

  // APK direto (ObaflixApp/ sem ObaflixPlay/) também não é restringido.
  const resApk = await ordersPost(pedido("Mozilla/5.0 (Linux; Android 13) ObaflixApp/1.0"));
  assert.notEqual(resApk.status, 403);
});

// ── Guardas de fonte: a fiação das superfícies (sem render) ────────────────────

test("middleware bloqueia rota comercial do Play e manda para /conta", () => {
  const src = readFileSync("src/middleware.ts", "utf8");
  assert.match(src, /from\s+"@\/config\/play"/);
  assert.ok(src.includes("ehClientePlay(") && src.includes("rotaComercialBloqueadaNoPlay("),
    "middleware precisa compor os dois helpers do Play");
  const gate = src.indexOf("rotaComercialBloqueadaNoPlay(");
  const destino = src.indexOf('new URL("/conta"', gate);
  assert.ok(destino > gate, "o bloqueio do Play deve redirecionar para /conta");
});

test("/conta troca o CTA de planos por mensagem neutra no Play", () => {
  const pagina = readFileSync("src/app/conta/page.tsx", "utf8");
  assert.match(pagina, /ehClientePlayNoNavegador/);
  assert.match(pagina, /MENSAGEM_ASSINATURA_INDISPONIVEL_PLAY/);
  // O CTA "Ver planos" só existe no ramo !play (else do ternário com a mensagem).
  const msg = pagina.indexOf("MENSAGEM_ASSINATURA_INDISPONIVEL_PLAY");
  const verPlanos = pagina.indexOf("Ver planos");
  assert.ok(msg >= 0 && verPlanos > msg, "Ver planos tem de ficar no ramo não-Play");
});

test("modal de anúncio esconde todo CTA comercial no Play", () => {
  const src = readFileSync("src/components/player/useAnuncio.tsx", "utf8");
  assert.match(src, /const play = ehClientePlayNoNavegador\(\);/);
  // Os dois botões comerciais ("Remover anúncios" e "Ver planos e remover
  // anúncios") ficam cada um dentro de um `{!play && (`.
  assert.ok((src.match(/\{!play && \(/g) ?? []).length >= 2, "os CTAs comerciais precisam do gate !play");
  for (const texto of ["Remover anúncios", "Ver planos e remover anúncios"]) {
    const cta = src.indexOf(texto);
    const gate = src.lastIndexOf("{!play && (", cta);
    assert.ok(gate >= 0 && cta - gate < 400, `"${texto}" precisa estar sob {!play && (`);
  }
});

test("Baixar é escondido no Play e o Cast (Transmitir) continua", () => {
  for (const arquivo of [
    "src/components/android/AndroidMediaActions.tsx",
    "src/components/android/AndroidHeroActions.tsx",
  ]) {
    const src = readFileSync(arquivo, "utf8");
    assert.match(src, /useDownloadHabilitado/, `${arquivo} deve usar useDownloadHabilitado`);
    assert.ok(src.includes("baixarHabilitado && ("), `${arquivo} deve gatear o botão Baixar`);
    const baixar = src.indexOf('rotulo="Baixar"');
    const transmitir = src.indexOf('rotulo="Transmitir"');
    assert.ok(baixar >= 0 && transmitir >= 0, `${arquivo} precisa ter os dois botões`);
    // O gate do Baixar não pode envolver o Cast: entre Baixar e Transmitir não
    // aparece outro `baixarHabilitado`.
    assert.ok(
      !src.slice(baixar, transmitir).includes("baixarHabilitado"),
      `${arquivo}: o Cast (Transmitir) não pode depender de baixarHabilitado`,
    );
  }
});
