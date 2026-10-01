import assert from "node:assert/strict";
import test from "node:test";

import {
  VERSAO_MINIMA_DESKTOP,
  compararVersoesSemver,
  desktopPrecisaAtualizar,
} from "../desktop/versaoMinima";

test("versão mínima final do desktop é 1.0.12", () => {
  assert.equal(VERSAO_MINIMA_DESKTOP, "1.0.12");
});

test("1.0.10 e 1.0.11 são bloqueadas", () => {
  assert.equal(desktopPrecisaAtualizar("1.0.10"), true);
  assert.equal(desktopPrecisaAtualizar("1.0.11"), true);
});

test("1.0.12 final não é bloqueada", () => {
  assert.equal(desktopPrecisaAtualizar("1.0.12"), false);
});

test("versões posteriores não são bloqueadas", () => {
  assert.equal(desktopPrecisaAtualizar("1.0.13"), false);
  assert.equal(desktopPrecisaAtualizar("1.1.0"), false);
  assert.equal(desktopPrecisaAtualizar("2.0.0"), false);
});

test("homologação prerelease 1.0.12 fica abaixo da 1.0.12 final", () => {
  assert.equal(desktopPrecisaAtualizar("1.0.12-homolog.4"), true);
});

test("comparação respeita prerelease SemVer", () => {
  assert.equal(
    compararVersoesSemver("1.0.12-homolog.4", "1.0.12"),
    -1,
  );

  assert.equal(
    compararVersoesSemver("1.0.12", "1.0.12-homolog.4"),
    1,
  );
});

test("prefixo v e build metadata são aceitos", () => {
  assert.equal(
    compararVersoesSemver("v1.0.12+build.7", "1.0.12"),
    0,
  );
});

test("versão inválida não bloqueia outras superfícies", () => {
  assert.equal(desktopPrecisaAtualizar(""), false);
  assert.equal(desktopPrecisaAtualizar("browser"), false);
  assert.equal(desktopPrecisaAtualizar("1.0"), false);
});