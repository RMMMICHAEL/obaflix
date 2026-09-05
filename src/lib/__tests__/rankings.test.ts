import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dedupeCatalogo } from "../canonical";

/**
 * As duas paginas de ranking sofriam do mesmo dado duplicado, mas com sintomas
 * opostos:
 *
 *  - `sync-top250` grava o rank em TODA linha que tenha aquele tmdbId, entao o
 *    mesmo titulo ocupava a mesma posicao duas ou tres vezes na tela;
 *  - `popular-sync` colapsa por tmdbId num Map e grava numa linha so, escolhida
 *    pela ordem que o banco devolveu — que podia ser a de 0 episodios, e ai o
 *    titulo aparecia marcado como indisponivel.
 *
 * `dedupeCatalogo` e o que as duas telas usam agora. As linhas abaixo tem a
 * forma que o Prisma devolve, com a contagem em `_count`.
 */

const serieCompleta = {
  id: "wc_4412",
  tmdbId: "124364",
  titulo: "Lanternas",
  top250: 42,
  _count: { episodios: 3 },
};

const serieParcial = {
  id: "98765",
  tmdbId: "124364",
  titulo: "Lanternas",
  top250: 42,
  _count: { episodios: 2 },
};

const serieVazia = {
  id: "124364",
  tmdbId: "124364",
  titulo: "Lanternas",
  top250: 42,
  _count: { episodios: 0 },
};

const outraSerie = {
  id: "555",
  tmdbId: "999",
  titulo: "Outra",
  top250: 43,
  _count: { episodios: 8 },
};

describe("Top 250 do IMDb", () => {
  it("o mesmo titulo nao ocupa a mesma posicao mais de uma vez", () => {
    const ranking = dedupeCatalogo([serieCompleta, serieParcial, serieVazia, outraSerie], "serie");

    assert.equal(ranking.length, 2);
    assert.deepEqual(ranking.map((r) => r.top250), [42, 43]);
  });

  it("a posicao sobrevivente e a da primeira ocorrencia", () => {
    // A lista chega ordenada por top250; trocar o conteudo nao pode reordenar.
    const ranking = dedupeCatalogo([serieVazia, outraSerie, serieCompleta], "serie");
    assert.deepEqual(ranking.map((r) => r.top250), [42, 43]);
  });

  it("nenhuma posicao do ranking se repete", () => {
    const ranking = dedupeCatalogo([serieCompleta, serieParcial, serieVazia, outraSerie], "serie");
    const posicoes = ranking.map((r) => r.top250);
    assert.deepEqual(posicoes, [...new Set(posicoes)]);
  });
});

describe("Em Alta", () => {
  it("a linha vazia nunca ganha da que tem episodios", () => {
    // Era o defeito visivel: popularRank caia numa duplicata sem episodios e o
    // titulo saia marcado como indisponivel numa lista de "em alta".
    const [vencedor] = dedupeCatalogo([serieVazia, serieParcial, serieCompleta], "serie");
    assert.equal(vencedor.id, "wc_4412");
    assert.equal(vencedor._count.episodios, 3);
  });

  it("o resultado nao depende da ordem em que o banco devolveu", () => {
    const ordens = [
      [serieVazia, serieParcial, serieCompleta],
      [serieCompleta, serieVazia, serieParcial],
      [serieParcial, serieCompleta, serieVazia],
    ];
    for (const ordem of ordens) {
      assert.equal(dedupeCatalogo(ordem, "serie")[0].id, "wc_4412");
    }
  });
});

describe("filmes em ranking", () => {
  const comPlayer = { id: "wc_1", tmdbId: "700", titulo: "Filme", urlDub: "u", top250: 7 };
  const semPlayer = { id: "700", tmdbId: "700", titulo: "Filme", urlDub: null, top250: 7 };

  it("a copia com player vence a copia sem player", () => {
    const [vencedor] = dedupeCatalogo([semPlayer, comPlayer], "filme");
    assert.equal(vencedor.id, "wc_1");
  });

  it("filme e serie com o mesmo tmdbId nao se confundem", () => {
    const filmes = dedupeCatalogo([comPlayer], "filme");
    const series = dedupeCatalogo([{ id: "s700", tmdbId: "700", titulo: "Serie" }], "serie");
    assert.equal(filmes.length, 1);
    assert.equal(series.length, 1);
  });
});

describe("listas que ja estao corretas", () => {
  it("ranking sem duplicata atravessa sem perder item nem trocar ordem", () => {
    const entrada = [outraSerie, { ...serieCompleta, tmdbId: "111" }];
    const saida = dedupeCatalogo(entrada, "serie");
    assert.deepEqual(saida.map((r) => r.id), entrada.map((r) => r.id));
  });

  it("linha sem tmdbId nunca e removida de um ranking", () => {
    const sem = [
      { id: "a", tmdbId: null, titulo: "Sem id", top250: 1 },
      { id: "b", tmdbId: null, titulo: "Sem id", top250: 2 },
    ];
    assert.equal(dedupeCatalogo(sem, "filme").length, 2);
  });
});
