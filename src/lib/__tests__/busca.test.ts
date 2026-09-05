import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mesclarResultadosBusca } from "../busca";
import { ehRotaDeBusca, mostrarBuscaNaTopbar, rotaDeBusca } from "../../components/layout/androidNav";

/**
 * O caso reportado: buscar "Lanternas" devolvia varias versoes da mesma serie,
 * uma com 3 episodios, outra com 0 e outra com 2. Nao era falha de exibicao —
 * eram tres linhas reais, com ids de tres pipelines de importacao diferentes.
 */
const local3eps = { id: "wc_4412", tmdbId: "124364", titulo: "Lanternas", episodios: 3, tipo: "serie" };
const local2eps = { id: "98765", tmdbId: "124364", titulo: "Lanternas", episodios: 2, tipo: "serie" };
const local0eps = { id: "124364", tmdbId: "124364", titulo: "Lanternas", episodios: 0, tipo: "serie" };
const outra = { id: "555", tmdbId: "999", titulo: "Outra Serie", episodios: 5, tipo: "serie" };

describe("resultado da busca sem duplicata", () => {
  it("as tres Lanternas viram um resultado so", () => {
    const saida = mesclarResultadosBusca([local3eps, local2eps, local0eps], [], 30);
    assert.equal(saida.length, 1);
  });

  it("o resultado que sobra e o que tem episodios de verdade", () => {
    // Escolher pela metadata mais bonita entregaria a copia vazia, e o usuario
    // abriria uma serie sem nenhum episodio.
    const [serie] = mesclarResultadosBusca([local0eps, local2eps, local3eps], [], 30);
    assert.equal(serie.id, "wc_4412");
    assert.equal(serie.episodios, 3);
  });

  it("o cruzamento por tmdbId nao reintroduz as copias", () => {
    // `WHERE "tmdbId" = ANY(...)` devolve TODAS as linhas daquele tmdbId; era
    // por ai que as duplicatas voltavam mesmo com o filtro por id.
    const saida = mesclarResultadosBusca([local3eps], [local3eps, local2eps, local0eps], 30);
    assert.equal(saida.length, 1);
    assert.equal(saida[0].id, "wc_4412");
  });

  it("a mesma linha vinda pelos dois caminhos aparece uma vez", () => {
    const saida = mesclarResultadosBusca([outra], [outra], 30);
    assert.equal(saida.length, 1);
  });

  it("titulos distintos continuam todos no resultado", () => {
    const saida = mesclarResultadosBusca([local3eps, outra], [], 30);
    assert.deepEqual(saida.map((s) => s.id), ["wc_4412", "555"]);
  });

  it("o complemento do TMDB entra depois dos locais", () => {
    // Os locais ja chegam ordenados por nota; o cruzamento e complemento.
    const saida = mesclarResultadosBusca([outra], [local3eps], 30);
    assert.deepEqual(saida.map((s) => s.id), ["555", "wc_4412"]);
  });

  it("respeita o limite", () => {
    const muitos = Array.from({ length: 50 }, (_, i) => ({
      id: `f${i}`, tmdbId: String(i), titulo: `Filme ${i}`, tipo: "filme",
    }));
    assert.equal(mesclarResultadosBusca(muitos, [], 30).length, 30);
  });

  it("linha sem tmdbId nunca e descartada", () => {
    // Sem tmdbId nao ha prova de duplicata; sumir com o resultado seria pior
    // que mostrar dois.
    const semId = [
      { id: "a", tmdbId: null, titulo: "Lanternas" },
      { id: "b", tmdbId: null, titulo: "Lanternas" },
    ];
    assert.equal(mesclarResultadosBusca(semId, [], 30).length, 2);
  });

  it("busca sem resultado devolve lista vazia, nao erro", () => {
    assert.deepEqual(mesclarResultadosBusca([], [], 30), []);
  });
});

describe("uma acao de busca, e que funcione", () => {
  it("a tela de busca sempre oferece entrada, mesmo sem termo na URL", () => {
    // O defeito: a aba "Buscar" navegava para /buscar sem `q`, e a pagina nao
    // tinha campo nenhum — so lia a querystring. Chegava-se a uma tela onde
    // era impossivel buscar.
    assert.equal(ehRotaDeBusca("/buscar"), true);
  });

  it("a lupa da topbar nao coexiste com o campo da pagina", () => {
    assert.equal(mostrarBuscaNaTopbar("/buscar"), false);
    assert.equal(mostrarBuscaNaTopbar("/android"), true);
  });

  it("submeter vazio nao navega para a tela sem termo", () => {
    assert.equal(rotaDeBusca(""), null);
  });

  it("submeter um termo leva ao resultado", () => {
    assert.equal(rotaDeBusca("lanternas"), "/buscar?q=lanternas");
  });
});
