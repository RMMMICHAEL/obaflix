import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// O tsx compila JSX no modo clássico; o Next usa o automático.
(globalThis as { React?: typeof React }).React = React;

const noop = () => {};
const render = async (p: { podeCompleto: boolean; anuncio: boolean; podeIndividual: boolean; podeLote: boolean }) => {
  const { DownloadModal } = await import("../../components/player/DownloadModal");
  return renderToStaticMarkup(createElement(DownloadModal, {
    titulo: "Batman", onCompleto: noop, onIndividual: noop, onLote: noop, onClose: noop, ...p,
  }));
};

const contar = (html: string, trecho: string) => html.split(trecho).length - 1;

test("gratuito com anúncio: completo com anúncios; trecho e lote bloqueados; conhecer planos", async () => {
  const html = await render({ podeCompleto: true, anuncio: true, podeIndividual: false, podeLote: false });
  assert.ok(html.includes("Continuar com anúncios"));
  assert.equal(contar(html, "Bloqueado"), 2);
  assert.ok(html.includes("Conhecer planos"));
  assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'));
});

test("assinante isento sem cortes: baixa direto, sem prometer anúncio", async () => {
  const html = await render({ podeCompleto: true, anuncio: false, podeIndividual: false, podeLote: false });
  assert.ok(html.includes(">Baixar<"));
  assert.ok(!html.includes("Continuar com anúncios"));
});

test("Cortes Start: trecho liberado, lote bloqueado", async () => {
  const html = await render({ podeCompleto: true, anuncio: false, podeIndividual: true, podeLote: false });
  assert.ok(html.includes("Escolher trecho"));
  assert.ok(!html.includes("Montar lote"));
  assert.equal(contar(html, "Bloqueado"), 1);
});

test("Cortes Pro/AI: tudo liberado, sem CTA de planos e sem prometer IA", async () => {
  const html = await render({ podeCompleto: true, anuncio: false, podeIndividual: true, podeLote: true });
  assert.ok(html.includes("Escolher trecho") && html.includes("Montar lote"));
  assert.ok(!html.includes("Bloqueado") && !html.includes("Conhecer planos"));
  assert.ok(!/IA dispon[ií]vel/i.test(html));
});
