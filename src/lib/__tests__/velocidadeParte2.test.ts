import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extrairPessoasSerie } from "@/lib/tmdbPessoas";

/**
 * Fase Velocidade 1A.2 — secundário (elenco/recs) sai da geração ISR para
 * endpoints públicos + fetch no cliente. Helper de pessoas testado de verdade;
 * endpoints e clientes travados por asserção de fonte.
 */
const ler = (p: string) => readFileSync(p, "utf8");
const semBloco = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const creditosEndpoint = () => ler("src/app/api/series/[id]/creditos/route.ts");
const recsEndpoint = () => ler("src/app/api/series/[id]/recomendacoes/route.ts");
const creditosClient = () => ler("src/app/serie/[id]/SerieCreditosClient.tsx");
const recsClient = () => ler("src/app/serie/[id]/SerieRecomendacoesClient.tsx");

// ── Helper puro de pessoas ───────────────────────────────────────────────────

test("extrairPessoasSerie: criação + direção combinadas, elenco com até 16, só campos públicos", () => {
  const credits = {
    cast: Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i, name: `Ator ${i}`, character: `Pers ${i}`, profile_path: `/p${i}.jpg`, order: i,
    })),
    crew: [
      { id: 1, name: "Dir A", job: "Director", profile_path: null },
      { id: 2, name: "Dir B", jobs: [{ job: "Director" }], profile_path: "/d2.jpg" },
      { id: 3, name: "Editor X", job: "Editor", profile_path: null },
    ],
  };
  const details = {
    created_by: [
      { id: 1, name: "Dir A", profile_path: null },
      { id: 9, name: "Criador Y", profile_path: "/c.jpg" },
    ],
  };

  const { criacaoDirecao, elenco } = extrairPessoasSerie(credits as any, details as any);

  // Elenco limitado a 16; só campos públicos.
  assert.equal(elenco.length, 16);
  assert.deepEqual(elenco[0], { id: 100, name: "Ator 0", profile_path: "/p0.jpg", role: "Pers 0" });
  assert.deepEqual(Object.keys(elenco[0]).sort(), ["id", "name", "profile_path", "role"]);

  // created_by (Criação) + crew Director (id 1 vira "Criação e direção"); editor fora.
  const porId = new Map(criacaoDirecao.map((p) => [p.id, p]));
  assert.equal(porId.get(1)?.role, "Criação e direção");
  assert.equal(porId.get(9)?.role, "Criação");
  assert.equal(porId.get(2)?.role, "Direção");
  assert.equal(porId.get(3), undefined, "editor não é direção");
  for (const p of criacaoDirecao) {
    assert.deepEqual(Object.keys(p).sort(), ["id", "name", "profile_path", "role"]);
  }
});

test("extrairPessoasSerie seguro com entradas nulas", () => {
  assert.deepEqual(extrairPessoasSerie(null, null), { criacaoDirecao: [], elenco: [] });
});

// ── Endpoint de créditos ─────────────────────────────────────────────────────

test("créditos: valida id, só lê tmdbId, 404 se ausente", () => {
  const src = creditosEndpoint();
  assert.match(src, /prisma\.serie\.findUnique/);
  assert.match(src, /select: \{ tmdbId: true \}/);
  assert.match(src, /if \(!serie\) return NextResponse\.json\(\{ error: "Não encontrado" \}, \{ status: 404 \}\)/);
});

test("créditos: sem tmdbId ⇒ 200 vazio cacheável; credits OU details null ⇒ 503 no-store", () => {
  const src = creditosEndpoint();
  assert.match(src, /if \(!serie\.tmdbId\)/);
  assert.match(src, /criacaoDirecao: \[\], elenco: \[\]/);
  // Resposta parcial (credits OU details ausente) não pode ser cacheada 24h.
  assert.match(src, /if \(!credits \|\| !details\)/);
  const m = src.match(/if \(!credits \|\| !details\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "bloco 503 não encontrado");
  assert.match(m![0], /status: 503/);
  assert.match(m![0], /"Cache-Control": "no-store"/);
  assert.doesNotMatch(m![0], /s-maxage/);
});

test("créditos: sucesso usa extrairPessoasSerie e cache público", () => {
  const src = creditosEndpoint();
  assert.match(src, /extrairPessoasSerie\(credits, details\)/);
  assert.match(src, /Cache-Control.*public, s-maxage=86400/);
});

// ── Endpoint de recomendações ────────────────────────────────────────────────

test("recomendações: valida id, devolve só campos de card, com fallback por gênero", () => {
  const src = recsEndpoint();
  assert.match(src, /prisma\.serie\.findUnique/);
  assert.match(src, /if \(!serie\) return NextResponse\.json\(\{ error: "Não encontrado" \}, \{ status: 404 \}\)/);
  // SELECT só de card: nada de urlDub/urlLeg.
  assert.match(src, /titulo: true, poster: true/);
  assert.doesNotMatch(semBloco(src), /urlDub|urlLeg/);
  // Fallback por gênero.
  assert.match(src, /generoId: \{ in: generoIds \} \} \}/);
  assert.match(src, /Cache-Control.*public, s-maxage=86400/);
});

// ── Clientes: fora do ISR, tratam !ok como erro ──────────────────────────────

test("clientes são 'use client', buscam endpoints e tratam resposta não-OK como erro", () => {
  for (const src of [creditosClient(), recsClient()]) {
    assert.match(src, /^"use client";/);
    assert.match(src, /useEffect\(/);
    assert.match(src, /if \(!r\.ok\) throw new Error/);
    assert.match(src, /\.catch\(\(\) =>/);
  }
});

// ── Segurança: nada de provider/token/media URL/usuário nos endpoints ────────

test("endpoints secundários não expõem provider/token/sessão/URL de mídia", () => {
  for (const src of [creditosEndpoint(), recsEndpoint()]) {
    assert.doesNotMatch(semBloco(src), /urlDub|urlLeg|provider|token|authorization|getServerSession/i);
  }
});
