import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ANDROID_NAV_ITEMS, ROTA_BUSCA, mostrarBuscaNaTopbar } from "@/components/layout/androidNav";
import { paraHero, paraTrilha } from "@/lib/androidHome";

/**
 * A barra tem seis abas numa linha só, e este teste foi atualizado de propósito
 * junto com ela: a ordem é decisão de produto, e o teste existe para uma mudança
 * nela ser sempre deliberada — nunca um efeito colateral.
 *
 * "Buscar" saiu da barra porque a busca já vive na topbar.
 */
test("a barra Android contém as seis seções na ordem final", () => {
  assert.deepEqual(ANDROID_NAV_ITEMS.map((item) => item.label), [
    "Início", "Séries", "Filmes", "Canais", "Animes", "Kids",
  ]);
});

test("a barra Android não tem Buscar; a busca continua na topbar", () => {
  assert.ok(
    !ANDROID_NAV_ITEMS.some((item) => item.href === ROTA_BUSCA || item.label === "Buscar"),
    "Buscar voltou para a barra inferior",
  );
  assert.equal(mostrarBuscaNaTopbar("/android"), true);
});

test("a barra Android fica numa linha só, com colunas iguais", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const inicio = css.indexOf(".android-bottom-nav {");
  const bloco = css.slice(inicio, css.indexOf("}", inicio));
  assert.match(bloco, /grid-auto-flow:\s*column/);
  assert.match(bloco, /grid-auto-columns:\s*minmax\(0,\s*1fr\)/);
  assert.ok(!/grid-template-columns/.test(bloco), "colunas fixas empurram abas para uma segunda linha");
});

test("a aba Animes usa a shuriken local; as demais mantêm seus ícones", () => {
  const icones = Object.fromEntries(ANDROID_NAV_ITEMS.map((item) => [item.label, item.icone]));
  assert.deepEqual(icones, {
    Início: "home", Séries: "tv", Filmes: "film", Canais: "radio", Animes: "shuriken", Kids: "smile",
  });
  const fonte = readFileSync("src/components/layout/ShurikenIcon.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(fonte.includes("createLucideIcon"), "a shuriken precisa seguir o traço dos ícones lucide");
  assert.ok(!/https?:\/\/|\.(png|jpe?g|webp|gif)\b/i.test(fonte), "o ícone não pode depender de imagem externa");
});

test("a home preserva logo de cards e todos os destaques com background", () => {
  const item = paraTrilha({ id: "1", titulo: "Teste", logo: "/logo.png", background: "/bg.jpg" }, "filme");
  assert.equal(item.logo, "/logo.png");
  assert.deepEqual(paraHero([
    { id: "1", titulo: "Primeiro", background: "/1.jpg" },
    { id: "2", titulo: "Segundo", background: "/2.jpg" },
  ]).map((hero) => hero.id), ["1", "2"]);
});
