import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INTENT_PREFETCH_DELAY_MS,
  shouldPrefetchOnIntent,
} from "../intent-prefetch";

/**
 * Fase Velocidade 1B — prefetch por intenção nos cards das prateleiras.
 * Substitui o prefetch indiscriminado por viewport do <Link> por um disparo
 * ~180ms após hover/foco, com dedupe e respeito a conexões limitadas.
 */

const ler = (p: string) => readFileSync(p, "utf8");

test("a janela de intenção fica entre 150ms e 200ms", () => {
  assert.ok(INTENT_PREFETCH_DELAY_MS >= 150 && INTENT_PREFETCH_DELAY_MS <= 200);
});

test("shouldPrefetchOnIntent: sem info de conexão, segue (desktop comum)", () => {
  assert.equal(shouldPrefetchOnIntent(undefined), true);
  assert.equal(shouldPrefetchOnIntent(null), true);
  assert.equal(shouldPrefetchOnIntent({ effectiveType: "4g" }), true);
});

test("shouldPrefetchOnIntent: respeita saveData e conexões 2g", () => {
  assert.equal(shouldPrefetchOnIntent({ saveData: true }), false);
  assert.equal(shouldPrefetchOnIntent({ effectiveType: "2g" }), false);
  assert.equal(shouldPrefetchOnIntent({ effectiveType: "slow-2g" }), false);
  // saveData vence mesmo com effectiveType bom.
  assert.equal(shouldPrefetchOnIntent({ saveData: true, effectiveType: "4g" }), false);
});

test("o hook deduplica por destino em escopo de módulo (um prefetch por href)", () => {
  const src = ler("src/components/ui/useIntentPrefetch.ts");
  assert.match(src, /new Set<string>\(\)/);
  assert.match(src, /jaPreparados\.has\(href\)/);
  assert.match(src, /jaPreparados\.add\(href\)/);
});

test("o hook dispara por timer, cancela em leave/blur e aquece a imagem sem bloquear", () => {
  const src = ler("src/components/ui/useIntentPrefetch.ts");
  assert.match(src, /setTimeout\(/);
  assert.match(src, /INTENT_PREFETCH_DELAY_MS/);
  assert.match(src, /clearTimeout\(timer\.current\)/);
  assert.match(src, /router\.prefetch\(href\)/);
  // Image.decode() com erro engolido → nunca trava a navegação.
  assert.match(src, /\.decode\?\.\(\)\.catch\(\(\) => \{\}\)/);
  // Hover + foco como gatilho; leave + blur como cancelamento.
  assert.match(src, /onMouseEnter: iniciar/);
  assert.match(src, /onFocus: iniciar/);
  assert.match(src, /onMouseLeave: cancelar/);
  assert.match(src, /onBlur: cancelar/);
  // Respeito a conexão limitada antes de agendar.
  assert.match(src, /shouldPrefetchOnIntent\(readConnection\(\)\)/);
});

test("toque (mobile) prepara o destino imediatamente, sem reativar prefetch por viewport", () => {
  const src = ler("src/components/ui/useIntentPrefetch.ts");
  // Toque dispara a preparação imediata (não a janela de 180ms de hover).
  assert.match(src, /onTouchStart: disparar/);
  // disparar() respeita dedupe e saveData/2g — não é um prefetch cego.
  const disparar = src.slice(src.indexOf("const disparar"));
  assert.match(disparar, /jaPreparados\.has\(href\)/);
  assert.match(disparar, /shouldPrefetchOnIntent\(readConnection\(\)\)/);
  assert.match(disparar, /router\.prefetch\(href\)/);
  // Nada de voltar ao prefetch por viewport do Link.
  const card = ler("src/components/ui/LandscapeCard.tsx");
  assert.doesNotMatch(card, /prefetch=\{true\}/);
  assert.match(card, /prefetch=\{false\}/);
});

test("LandscapeCard desliga o prefetch por viewport e usa o prefetch por intenção", () => {
  const card = ler("src/components/ui/LandscapeCard.tsx");
  // Nada de prefetch indiscriminado do catálogo: o <Link> vem com prefetch={false}.
  assert.match(card, /<Link href=\{href\} title=\{titulo\} prefetch=\{false\}>/);
  // Intenção fiada no wrapper, com a imagem relevante (backdrop em w1280).
  assert.match(card, /useIntentPrefetch\(href, background \? imgUrl\(background, "w1280"\) : null\)/);
  assert.match(card, /\{\.\.\.intentHandlers\}/);
});
