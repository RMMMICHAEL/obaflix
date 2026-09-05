import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LIMITE_TOP10,
  LIMITE_VITRINE,
  ORDEM_POPULARIDADE,
  ORDEM_TOP10,
} from "../ranking";

// ── Forma do descritor ───────────────────────────────────────────────────────

test("popularidade desc, com nulos no fim", () => {
  assert.deepEqual(ORDEM_POPULARIDADE[0], {
    popularidade: { sort: "desc", nulls: "last" },
  });
});

test("nota desempata a popularidade", () => {
  // Faltava no site e no Electron: era metade do motivo de a TV mostrar uma
  // lista e o aplicativo mostrar outra.
  assert.deepEqual(ORDEM_POPULARIDADE[1], { nota: "desc" });
});

test("o último critério é determinístico", () => {
  // Sem ele, empatados voltam na ordem que o plano do Postgres produzir — que
  // pode mudar entre conexões e execuções. É a mesma decisão que
  // catalog-showcases.ts já usava para não escolher duplicata ao acaso.
  const ultimo = ORDEM_POPULARIDADE[ORDEM_POPULARIDADE.length - 1];
  assert.deepEqual(ultimo, { id: "asc" });
});

test("o Top 10 também termina com desempate determinístico", () => {
  assert.deepEqual(ORDEM_TOP10[0], { popularRank: "asc" });
  assert.deepEqual(ORDEM_TOP10[ORDEM_TOP10.length - 1], { id: "asc" });
});

test("limites são números úteis", () => {
  assert.equal(LIMITE_VITRINE, 24);
  assert.equal(LIMITE_TOP10, 10);
});

// ── A propriedade que importa: ordem total ───────────────────────────────────
//
// Aplica o descritor a objetos simples. Não é a implementação de produção (quem
// ordena é o Postgres) — é a prova de que ESTES três critérios resolvem todo
// empate, e portanto que qualquer `take` devolve um prefixo da mesma lista.

type Linha = { id: string; popularidade: number | null; nota: number | null };

function aplicarOrdem(linhas: Linha[]): Linha[] {
  return [...linhas].sort((a, b) => {
    // nulls: "last" — nulo perde de qualquer valor.
    const pa = a.popularidade;
    const pb = b.popularidade;
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa;
    }
    const na = a.nota;
    const nb = b.nota;
    if (na !== nb) {
      if (na === null) return 1;
      if (nb === null) return -1;
      return nb - na;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const CATALOGO: Linha[] = [
  { id: "c", popularidade: 100, nota: 8 },
  { id: "a", popularidade: 100, nota: 8 }, // empata em tudo com "c" e "b"
  { id: "b", popularidade: 100, nota: 8 },
  { id: "d", popularidade: 100, nota: 9 },
  { id: "e", popularidade: 50, nota: 10 },
  { id: "f", popularidade: null, nota: 10 }, // sem sincronização
  { id: "g", popularidade: null, nota: null },
];

test("popularidade manda antes da nota", () => {
  // Um clássico de nota 10 e popularidade baixa não é tendência.
  const ordem = aplicarOrdem(CATALOGO).map((l) => l.id);
  assert.ok(ordem.indexOf("d") < ordem.indexOf("e"));
});

test("nulos de popularidade vão para o fim", () => {
  const ordem = aplicarOrdem(CATALOGO).map((l) => l.id);
  assert.deepEqual(ordem.slice(-2), ["f", "g"]);
});

test("empate total é resolvido por id, sem sobrar arbitrariedade", () => {
  const ordem = aplicarOrdem(CATALOGO).map((l) => l.id);
  assert.deepEqual(ordem.slice(1, 4), ["a", "b", "c"]);
});

test("a ordem é estável para qualquer embaralhamento da entrada", () => {
  // É isto que faltava: o mesmo catálogo, consultado por conexões diferentes,
  // tem de sair igual.
  const base = aplicarOrdem(CATALOGO).map((l) => l.id);
  const embaralhado = [...CATALOGO].reverse();
  assert.deepEqual(aplicarOrdem(embaralhado).map((l) => l.id), base);
  const outro = [CATALOGO[3], CATALOGO[6], CATALOGO[0], CATALOGO[5], CATALOGO[1], CATALOGO[4], CATALOGO[2]];
  assert.deepEqual(aplicarOrdem(outro).map((l) => l.id), base);
});

test("take menor devolve um prefixo da MESMA lista, não outra lista", () => {
  // É o que permite o celular pedir 18 e a TV pedir 24 sem divergirem.
  const completa = aplicarOrdem(CATALOGO).map((l) => l.id);
  for (const take of [1, 3, 5, 8, 18, 24]) {
    assert.deepEqual(aplicarOrdem(CATALOGO).slice(0, take).map((l) => l.id), completa.slice(0, take));
  }
});

// ── Guarda: uma fonte só ─────────────────────────────────────────────────────

const CONSUMIDORES = [
  "src/components/home/HomeStreaming.tsx",
  "src/app/android/page.tsx",
  "src/app/api/tv/home/route.ts",
  "src/app/api/home/route.ts",
];

test("nenhuma superfície redeclara a ordenação de popularidade", () => {
  // A regressão real: alguém copia o literal para "não mexer no que já
  // funciona", e três meses depois as listas divergem outra vez.
  for (const arquivo of CONSUMIDORES) {
    const src = readFileSync(arquivo, "utf8");
    const semComentarios = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((l) => (l.indexOf("//") >= 0 ? l.slice(0, l.indexOf("//")) : l))
      .join("\n");
    assert.ok(
      !semComentarios.includes('popularidade: { sort:'),
      `${arquivo} voltou a declarar a ordenação por conta própria`,
    );
  }
});

test("todas as superfícies importam a ordenação canônica", () => {
  for (const arquivo of CONSUMIDORES) {
    const src = readFileSync(arquivo, "utf8");
    assert.ok(src.includes('from "@/lib/ranking"'), `${arquivo} não importa @/lib/ranking`);
    assert.ok(src.includes("ORDEM_POPULARIDADE"), `${arquivo} não usa ORDEM_POPULARIDADE`);
  }
});

test("o Top 10 do site e o da TV saem da mesma constante", () => {
  for (const arquivo of ["src/components/home/HomeStreaming.tsx", "src/app/api/tv/home/route.ts"]) {
    const src = readFileSync(arquivo, "utf8");
    const semComentarios = src.replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.ok(semComentarios.includes("ORDEM_TOP10"), `${arquivo} não usa ORDEM_TOP10`);
    assert.ok(
      !semComentarios.includes('popularRank: "asc"'),
      `${arquivo} voltou a declarar a ordem do Top 10`,
    );
  }
});
