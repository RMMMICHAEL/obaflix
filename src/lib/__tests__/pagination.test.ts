import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  avancarFonte,
  fonteZerada,
  intercalar,
  proximaPagina,
  temMais,
  totalCombinado,
} from "../pagination";

describe("avancarFonte", () => {
  it("uma pagina cheia nao esgota a fonte", () => {
    const estado = avancarFonte(fonteZerada(), 24, 50);
    assert.deepEqual(estado, { page: 1, total: 50, carregados: 24, esgotada: false });
  });

  it("a fonte esgota exatamente quando o total e alcancado", () => {
    let estado = avancarFonte(fonteZerada(), 24, 48);
    assert.equal(estado.esgotada, false);

    estado = avancarFonte(estado, 24, 48);
    assert.equal(estado.carregados, 48);
    assert.equal(estado.esgotada, true);
  });

  it("ultima pagina parcial fecha a fonte", () => {
    let estado = avancarFonte(fonteZerada(), 24, 30);
    estado = avancarFonte(estado, 6, 30);
    assert.equal(estado.esgotada, true);
  });

  it("resposta vazia encerra mesmo com total inflado", () => {
    // Sem esta condicao, um total desatualizado deixaria "Carregar mais"
    // pedindo paginas vazias para sempre — que era o sintoma reportado.
    let estado = avancarFonte(fonteZerada(), 24, 999);
    estado = avancarFonte(estado, 0, 999);
    assert.equal(estado.esgotada, true);
  });

  it("total ausente na resposta preserva o que ja se sabia", () => {
    let estado = avancarFonte(fonteZerada(), 24, 50);
    estado = avancarFonte(estado, 24, undefined);
    assert.equal(estado.total, 50);
  });

  it("fonte vazia desde a primeira pagina ja nasce esgotada", () => {
    const estado = avancarFonte(fonteZerada(), 0, 0);
    assert.equal(estado.esgotada, true);
  });
});

describe("proximaPagina", () => {
  it("comeca na pagina 1", () => {
    assert.equal(proximaPagina(fonteZerada()), 1);
  });

  it("avanca uma pagina por resposta", () => {
    const estado = avancarFonte(fonteZerada(), 24, 100);
    assert.equal(proximaPagina(estado), 2);
  });

  it("devolve null quando a fonte acabou — e assim que a consulta deixa de ser feita", () => {
    const estado = avancarFonte(fonteZerada(), 5, 5);
    assert.equal(proximaPagina(estado), null);
  });
});

describe("duas fontes com totais independentes", () => {
  it("a fonte curta para de ser consultada e a longa continua", () => {
    // O defeito original: um numero de pagina so para filmes e series, e o
    // total somado. Quando os filmes acabavam, a tela seguia pedindo paginas
    // vazias de filme e nunca fechava o total.
    let filmes = avancarFonte(fonteZerada(), 10, 10); // acabou na primeira
    let series = avancarFonte(fonteZerada(), 24, 60);

    assert.equal(proximaPagina(filmes), null);
    assert.equal(proximaPagina(series), 2);
    assert.equal(temMais(filmes, series), true);

    series = avancarFonte(series, 24, 60);
    series = avancarFonte(series, 12, 60);

    assert.equal(temMais(filmes, series), false);
    assert.equal(totalCombinado(filmes, series), 70);
  });

  it("a grade alcanca exatamente o total anunciado", () => {
    let filmes = fonteZerada();
    let series = fonteZerada();
    let naTela = 0;

    while (temMais(filmes, series)) {
      if (proximaPagina(filmes) !== null) {
        const recebidos = Math.min(24, 30 - filmes.carregados);
        filmes = avancarFonte(filmes, recebidos, 30);
        naTela += recebidos;
      }
      if (proximaPagina(series) !== null) {
        const recebidos = Math.min(24, 51 - series.carregados);
        series = avancarFonte(series, recebidos, 51);
        naTela += recebidos;
      }
    }

    assert.equal(naTela, totalCombinado(filmes, series));
    assert.equal(naTela, 81);
  });

  it("nenhuma das duas fontes tem conteudo: nada a carregar", () => {
    const filmes = avancarFonte(fonteZerada(), 0, 0);
    const series = avancarFonte(fonteZerada(), 0, 0);
    assert.equal(temMais(filmes, series), false);
    assert.equal(totalCombinado(filmes, series), 0);
  });
});

describe("intercalar", () => {
  it("alterna as duas listas", () => {
    assert.deepEqual(intercalar(["f1", "f2"], ["s1", "s2"]), ["f1", "s1", "f2", "s2"]);
  });

  it("a sobra do lado mais longo vai para o fim, sem buraco", () => {
    assert.deepEqual(intercalar(["f1"], ["s1", "s2", "s3"]), ["f1", "s1", "s2", "s3"]);
    assert.deepEqual(intercalar(["f1", "f2", "f3"], ["s1"]), ["f1", "s1", "f2", "f3"]);
  });

  it("lista vazia de um lado devolve a outra intacta", () => {
    assert.deepEqual(intercalar([], ["s1", "s2"]), ["s1", "s2"]);
    assert.deepEqual(intercalar(["f1"], []), ["f1"]);
  });
});
