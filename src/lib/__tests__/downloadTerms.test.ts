import { before, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest, type NextFetchEvent } from "next/server";
import TermsPage, { metadata } from "../../app/termos/page";
import { SecaoDownloads } from "../../components/landing/SecaoDownloads";
import { FichaSeoExtra } from "../../components/catalog/FichaSeoExtra";
import { INSTALADORES } from "../../config/downloads";

// Mesmo adaptador do teste bannerDesktop: Next transforma JSX no app; tsx usa
// o runtime clássico por causa de jsx=preserve no tsconfig do projeto.
(globalThis as { React?: typeof React }).React = React;

let decidirRota: typeof import("../../config/site-mode").decidirRota;
let middleware: typeof import("../../middleware").default;
let CatalogAppModal: typeof import("../../components/catalog/CatalogAppModal").CatalogAppModal;
before(async () => {
  process.env.WEB_STREAMING_ENABLED = "false";
  process.env.OBAFLIX_SURFACE = "public";
  process.env.PUBLIC_CUTOVER_ATIVO = "false";
  ({ decidirRota } = await import("../../config/site-mode"));
  ({ default: middleware } = await import("../../middleware"));
  ({ CatalogAppModal } = await import("../../components/catalog/CatalogAppModal"));
});

const event = {} as NextFetchEvent;

test("Termos públicos sem liberar subrotas ou prefixos arbitrários", () => {
  for (const ambiente of ["navegador", "android", "desktop"] as const) {
    for (const rota of ["/termos", "/termos/"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" }, `${ambiente}: ${rota}`);
    }
  }
  for (const rota of ["/termos-falso", "/termosxyz", "/termos/arquivo", "/termos//", "/baixar", "/privacidade"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "landing" }, rota);
  }
});

test("middleware permite Termos sem sessão, inclusive em desktop e mobile", () => {
  for (const ua of ["Mozilla/5.0 (Windows NT 10.0)", "Mozilla/5.0 (Linux; Android 14) Mobile"]) {
    const response = middleware(new NextRequest("https://obaflixbr.com/termos", {
      headers: { "user-agent": ua },
    }), event);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("location"), null);
  }
  const bloqueada = middleware(new NextRequest("https://obaflixbr.com/termos-falso"), event);
  assert.equal(bloqueada.status, 307);
  assert.equal(bloqueada.headers.get("location"), "https://obaflixbr.com/");
});

test("Termos não amplia a superfície administrativa", () => {
  process.env.OBAFLIX_SURFACE = "admin";
  try {
    assert.equal(middleware(new NextRequest("https://admin.example/termos"), event).status, 404);
  } finally {
    process.env.OBAFLIX_SURFACE = "public";
  }
});

test("entradas dos apps, APIs e fechamento do player mantêm a navegação", () => {
  for (const ambiente of ["navegador", "android", "desktop"] as const) {
    assert.deepEqual(decidirRota("/", ambiente), ambiente === "navegador"
      ? { tipo: "segue" }
      : { tipo: "reescreve", para: ambiente === "android" ? "/android" : "/desktop" });
    for (const rota of ["/api/player/proxy", "/api/auth/session", "/login", "/parear", "/filmes", "/series", "/genero/terror--5"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" }, `${ambiente}: ${rota}`);
    }
    for (const rota of ["/assistir/filme/123", "/player"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: ambiente === "navegador" ? "landing" : "segue" });
    }
    for (const [rota, cliente] of [["/android", "android"], ["/desktop", "desktop"]] as const) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: ambiente === cliente ? "segue" : "landing" });
    }
  }
});

test("documento renderiza proposta legível e metadata própria sem indexar rascunho", () => {
  const html = renderToStaticMarkup(React.createElement(TermsPage));
  assert.match(html, /<article aria-labelledby="termos-titulo"/);
  assert.match(html, /<h1[^>]*id="termos-titulo"/);
  assert.match(html, /Termos de Serviço do Obaflix/);
  assert.match(html, /Documento em preparação/);
  assert.match(html, /identificação legal do responsável/);
  assert.match(html, /não foi aprovado juridicamente/);
  assert.match(html, /não oferecem reprodução.*no navegador/);
  assert.match(html, /<time dateTime="2026-10-11"/);
  assert.doesNotMatch(html, /<script|<iframe|<form|mailto:|href="\/privacidade"|href="\/baixar"/);
  assert.equal(metadata.title, "Termos de Serviço");
  assert.ok(typeof metadata.description === "string" && metadata.description.length > 40);
  assert.deepEqual(metadata.alternates, { canonical: "/termos" });
  assert.deepEqual(metadata.robots, { index: false, follow: true });
});

function conferirLinks(html: string) {
  const legal = html.match(/<a href="\/termos"[^>]*>Termos de Serviço<\/a>/g) ?? [];
  assert.equal(legal.length, 1, "um link HTML com nome acessível por fluxo de download");
  assert.doesNotMatch(legal[0], /hidden|aria-hidden|display:\s*none|target=/);
  for (const instalador of Object.values(INSTALADORES)) {
    assert.ok(html.includes(`href="${instalador.url}"`), "destino existente preservado");
  }
}

test("seção compartilhada apresenta Termos e mantém os três instaladores", () => {
  conferirLinks(renderToStaticMarkup(React.createElement(SecaoDownloads, {
    android: INSTALADORES.android,
    androidTv: INSTALADORES.androidTv,
    windows: INSTALADORES.windows,
  })));
});

test("ficha pública apresenta Termos no mesmo fluxo dos downloads", () => {
  conferirLinks(renderToStaticMarkup(React.createElement(FichaSeoExtra, {
    titulo: "Título de teste", tipo: "filme", generos: [],
  })));
});

test("modal apresenta Termos sem trocar destinos ou iniciar downloads", () => {
  const html = renderToStaticMarkup(React.createElement(CatalogAppModal, {
    payload: { titulo: "Título de teste", contexto: "Filme" }, onFechar: () => {},
  }));
  conferirLinks(html);
  assert.match(html, /role="dialog"/);
  assert.match(html, /Agora não/);
  assert.doesNotMatch(html, /<script|target="_blank"/);
});
