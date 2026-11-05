import { test, describe } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { decidirRota } from "../../config/site-mode";

// As páginas usam JSX clássico: o React precisa estar no escopo global antes de elas carregarem.
(globalThis as { React?: typeof React }).React = React;
const pagina = async (rota: string): Promise<string> => {
  const modulo = await import(`../../app/${rota}/page`);
  return renderToStaticMarkup(modulo.default() as never);
};

/**
 * Páginas jurídicas por produto. As do aplicativo (Filmes e Séries) vivem em /privacidade e /termos, que o app Android e a
 * Google Play abrem sem login; as do Obaflix Cortes foram preservadas em /cortes/privacidade e /cortes/termos.
 */

describe("rotas públicas, sem redirecionar para a home", () => {
  for (const rota of ["/privacidade", "/termos", "/excluir-conta", "/cortes/privacidade", "/cortes/termos"]) {
    for (const ambiente of ["navegador", "android", "desktop"] as const) {
      test(`${rota} segue em ${ambiente}`, () => {
        assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" });
      });
    }
  }
});

describe("política de privacidade do aplicativo", () => {
  test("descreve o que o aplicativo realmente trata e os serviços de anúncio", async () => {
    const texto = await pagina("privacidade");
    for (const termo of ["e-mail", "hash", "Google", "histórico de reprodução", "Unity Ads", "LevelPlay", "AdMob", "UMP", "identificador de publicidade", "contextuais"]) {
      assert.ok(texto.includes(termo), `faltou: ${termo}`);
    }
  });

  test("aponta para a exclusão de conta, o contato e as páginas do outro produto", async () => {
    const texto = await pagina("privacidade");
    assert.ok(texto.includes('href="/excluir-conta"'));
    assert.ok(texto.includes("mailto:obaflixsuporte@gmail.com"));
    assert.ok(texto.includes('href="/cortes/privacidade"'));
  });

  test("não carrega o conteúdo do Obaflix Cortes nem promete o que não sabemos", async () => {
    const texto = await pagina("privacidade");
    for (const termo of ["CPF", "Pix", "Cakto", "Meta Pixel", "Windows"]) {
      assert.ok(!texto.replace("Obaflix Cortes, para Windows", "").includes(termo), `não deveria citar: ${termo}`);
    }
    assert.ok(!/\b\d+ (dias|meses|anos)\b/.test(texto), "não inventa prazo de retenção");
    assert.ok(!/não vendemos/i.test(texto));
  });
});

describe("termos de uso do aplicativo", () => {
  test("cobre conta, anúncios, uso permitido e suporte, e liga à privacidade", async () => {
    const texto = await pagina("termos");
    for (const termo of ["Conta", "Anúncios", "Uso permitido", "obaflixsuporte@gmail.com", 'href="/privacidade"', 'href="/excluir-conta"', 'href="/cortes/termos"']) {
      assert.ok(texto.includes(termo), `faltou: ${termo}`);
    }
  });

  test("não traz as condições de venda do Obaflix Cortes", async () => {
    const texto = await pagina("termos");
    for (const termo of ["Start", "Pix", "FFmpeg", "30 dias"]) assert.ok(!texto.includes(termo), `não deveria citar: ${termo}`);
  });
});

describe("documentos do Obaflix Cortes preservados", () => {
  test("a privacidade mantém os dados de compra e o Pixel da Meta", async () => {
    const texto = await pagina("cortes/privacidade");
    for (const termo of ["CPF", "Cakto", "Meta", "Obaflix Cortes"]) assert.ok(texto.includes(termo), `faltou: ${termo}`);
    assert.ok(texto.includes('href="/cortes"'), "link de volta ao produto");
  });

  test("os termos mantêm planos, Pix e FFmpeg", async () => {
    const texto = await pagina("cortes/termos");
    for (const termo of ["Start", "Pro", "Pix", "FFmpeg", "30 dias"]) assert.ok(texto.includes(termo), `faltou: ${termo}`);
  });
});
