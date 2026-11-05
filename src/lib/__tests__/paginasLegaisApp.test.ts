import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { decidirRota } from "../../config/site-mode";

/**
 * /privacidade e /termos reúnem o Obaflix — Filmes e Séries e o Obaflix Cortes na mesma página. O texto do Cortes não pode
 * perder nada: cada trecho dele que existia na base (base 8381dca, antes desta alteração) tem de continuar na página.
 */
(globalThis as { React?: typeof React }).React = React;
const pagina = async (rota: string): Promise<string> => {
  const modulo = await import(`../../app/${rota}/page`);
  return renderToStaticMarkup(modulo.default() as never);
};
const jsxOriginal = (rota: string): string => execFileSync("git", ["show", `8381dca:src/app/${rota}/page.tsx`], { encoding: "utf8" });

/** Frases corridas do JSX original (dentro de <p>), sem marcação, para conferir na página renderizada. */
function frasesDoOriginal(rota: string): string[] {
  const codigo = jsxOriginal(rota);
  const paragrafos = [...codigo.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  return paragrafos
    .map((p) => p.replace(/<a [^>]*>([\s\S]*?)<\/a>/g, "$1").replace(/<[^>]+>/g, "").trim())
    .filter((p) => p.length > 20)
    .map((p) => p.split(/(?<=[.!?])\s+/)[0]);
}
const normaliza = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("rotas públicas pelo domínio oficial, sem ir para a home", () => {
  for (const rota of ["/privacidade", "/termos", "/excluir-conta"]) {
    for (const ambiente of ["navegador", "android", "desktop"] as const) {
      test(`${rota} segue em ${ambiente}`, () => assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" }));
    }
  }
});

for (const rota of ["privacidade", "termos"]) {
  describe(`/${rota}`, () => {
    test("preserva cada trecho do texto publicado do Obaflix Cortes", async () => {
      const texto = normaliza(await pagina(rota));
      const frases = frasesDoOriginal(rota);
      assert.ok(frases.length >= 4, "o original deveria ter vários parágrafos");
      for (const frase of frases) assert.ok(texto.includes(normaliza(frase)), `perdeu: ${frase.slice(0, 70)}`);
    });

    test("identifica o Obaflix — Filmes e Séries e mantém a seção do Cortes", async () => {
      const texto = await pagina(rota);
      assert.ok(texto.includes("Obaflix — Filmes e Séries"));
      assert.ok(texto.includes(">Obaflix Cortes<"), "seção do Cortes");
    });

    test("não afirma licenças ou autorizações nem inventa prazos", async () => {
      const texto = await pagina(rota);
      assert.ok(!/(somos|é) (licenciad|autorizad)|detemos|direitos sobre os conte[úu]dos/i.test(texto));
      assert.ok(!/\b\d+ (dias|meses|anos)\b/.test(texto.replace("30 dias", "").replace("7 dias", "")), "prazo inventado");
      assert.ok(!/não vendemos/i.test(texto));
    });
  });
}

describe("conteúdo novo do Filmes e Séries", () => {
  test("privacidade: conta, Google, uso, anúncios e SDKs, exclusão", async () => {
    const texto = await pagina("privacidade");
    for (const termo of ["código irreversível", "Google", "histórico de reprodução", "Unity Ads", "LevelPlay", "AdQuality", "AdMob", "UMP", "identificador de publicidade", "contextuais", 'href="/excluir-conta"', "mailto:obaflixsuporte@gmail.com"]) {
      assert.ok(texto.includes(termo), `faltou: ${termo}`);
    }
  });

  test("termos: conta, anúncios, planos na Play, uso permitido e liga à privacidade", async () => {
    const texto = await pagina("termos");
    for (const termo of ["criada com e-mail e senha ou com o Google", "fechar ou abandonar o anúncio não libera o conteúdo", "não oferece compra de planos", 'href="/privacidade"', 'href="/excluir-conta"']) {
      assert.ok(texto.includes(termo), `faltou: ${termo}`);
    }
  });
});
