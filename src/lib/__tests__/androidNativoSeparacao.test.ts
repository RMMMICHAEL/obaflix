import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { autorizarPorAnuncio } from "../ads/enforcement";
import { plataformaDaRequisicao, ehSinalDeAppNativo } from "../ads/politica";
import { anuncioAndroidNativoAtivo } from "../playbackAuthorization";
import { PLANO_GRATUITO } from "../planos";
import type { Entitlements } from "../entitlements";

const COOKIE = { origem: "cookie", deviceId: null } as const;
const TV = { origem: "bearer", deviceId: "tv1" } as const;
const NATIVO = { userAgent: "ObaflixNative/0.6.3 (Android)", headerCliente: "android-nativo" };

describe("plataforma android_nativo — sinais concordantes", () => {
  test("declaração + header + UA nativo + cookie => android_nativo", () => {
    assert.equal(plataformaDaRequisicao("android_nativo", COOKIE, NATIVO), "android_nativo");
  });
  test("qualquer sinal faltando ou divergente cai em web", () => {
    assert.equal(plataformaDaRequisicao("android_nativo", COOKIE), "web");
    assert.equal(plataformaDaRequisicao("android_nativo", COOKIE, { ...NATIVO, headerCliente: "android" }), "web");
    assert.equal(plataformaDaRequisicao("android_nativo", COOKIE, { ...NATIVO, userAgent: "Mozilla/5.0" }), "web");
    assert.equal(
      plataformaDaRequisicao("android_nativo", COOKIE, { ...NATIVO, userAgent: "ObaflixNative/1 ObaflixApp/1.0.24" }),
      "web",
    );
    assert.equal(ehSinalDeAppNativo(undefined), false);
  });
  test("TV e demais plataformas não mudam", () => {
    assert.equal(plataformaDaRequisicao("android_nativo", TV, NATIVO), "android_tv");
    assert.equal(plataformaDaRequisicao("android", COOKIE, NATIVO), "android");
    assert.equal(plataformaDaRequisicao("electron", COOKIE), "electron");
    assert.equal(plataformaDaRequisicao(undefined, COOKIE), "web");
  });
});

describe("ANUNCIO_ANDROID_NATIVO_ATIVO", () => {
  test('só "true" exato liga', () => {
    assert.equal(anuncioAndroidNativoAtivo({ ANUNCIO_ANDROID_NATIVO_ATIVO: "true" }), true);
    for (const v of [undefined, "", "false", "1", "TRUE", " true"]) {
      assert.equal(anuncioAndroidNativoAtivo({ ANUNCIO_ANDROID_NATIVO_ATIVO: v }), false, String(v));
    }
  });
});

const gratuito: Entitlements = {
  assinatura: { ativa: false, planoId: "gratuito", expiraEm: null },
  direitos: (() => {
    const { id, nome, descricao, ordem, ativo, ehPadrao, ...d } = PLANO_GRATUITO;
    void [id, nome, descricao, ordem, ativo, ehPadrao];
    return d as Entitlements["direitos"];
  })(),
};
const base = { userId: "u_nativo", tipo: "unity" as never, concessao: null };
const off = { ativa: false, promocaoTvAtiva: false, anuncioAndroidAtivo: false, anuncioElectronAtivo: false };
const r = async () => gratuito;

describe("enforcement — flags independentes", () => {
  test("nativo ligado cobra só android_nativo", async () => {
    const o = { ...off, anuncioAndroidNativoAtivo: true, resolver: r };
    const n = await autorizarPorAnuncio({ ...base, plataforma: "android_nativo" }, o);
    assert.equal(n.liberado, false);
    for (const p of ["android", "web", "android_tv", "electron"] as const) {
      assert.deepEqual(await autorizarPorAnuncio({ ...base, plataforma: p }, o), { liberado: true, via: "flag_desligada" }, p);
    }
  });
  test("ANUNCIO_ANDROID_ATIVO (WebView) não atinge o nativo, e o inverso", async () => {
    const w = { ...off, anuncioAndroidAtivo: true, anuncioAndroidNativoAtivo: false, resolver: r };
    assert.deepEqual(await autorizarPorAnuncio({ ...base, plataforma: "android_nativo" }, w), {
      liberado: true,
      via: "flag_desligada",
    });
    assert.equal((await autorizarPorAnuncio({ ...base, plataforma: "android" }, w)).liberado, false);
    const n = { ...off, anuncioAndroidAtivo: false, anuncioAndroidNativoAtivo: true, resolver: r };
    assert.deepEqual(await autorizarPorAnuncio({ ...base, plataforma: "android" }, n), {
      liberado: true,
      via: "flag_desligada",
    });
  });
});
