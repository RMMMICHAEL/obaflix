import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expandGenreIds,
  genreOptionValue,
  groupGenres,
  normalizeGenreName,
  parseGenreIds,
} from "../genres";

// Ids reais do TMDB, que e o ponto: os catalogos de filme e de TV nao usam a
// mesma tabela de generos, e o acervo importa das duas.
const ACAO_FILME = 28;
const AVENTURA_FILME = 12;
const ACAO_AVENTURA_TV = 10759;
const FICCAO_FILME = 878;
const FANTASIA_FILME = 14;
const FICCAO_FANTASIA_TV = 10765;

describe("expandGenreIds", () => {
  it("Aventura alcanca as series marcadas como Acao & Aventura", () => {
    // O caso da auditoria: "series em Aventura" devolvia quase nada porque o
    // acervo de TV esta sob 10759 e o filtro so procurava por 12.
    const expandido = expandGenreIds([AVENTURA_FILME]);
    assert.ok(expandido.includes(AVENTURA_FILME));
    assert.ok(expandido.includes(ACAO_AVENTURA_TV));
  });

  it("Acao & Aventura alcanca tanto Acao quanto Aventura de filme", () => {
    const expandido = expandGenreIds([ACAO_AVENTURA_TV]);
    assert.deepEqual(expandido, [AVENTURA_FILME, ACAO_FILME, ACAO_AVENTURA_TV].sort((a, b) => a - b));
  });

  it("Acao e Aventura continuam sendo filtros diferentes", () => {
    // A expansao e assimetrica de proposito. Se os tres virassem um grupo so,
    // Acao e Aventura passariam a devolver exatamente a mesma lista — e a
    // distincao e real para filmes.
    const acao = expandGenreIds([ACAO_FILME]);
    const aventura = expandGenreIds([AVENTURA_FILME]);

    assert.notDeepEqual(acao, aventura);
    assert.ok(!acao.includes(AVENTURA_FILME));
    assert.ok(!aventura.includes(ACAO_FILME));
  });

  it("cobre ficcao cientifica e fantasia", () => {
    assert.ok(expandGenreIds([FICCAO_FILME]).includes(FICCAO_FANTASIA_TV));
    assert.ok(expandGenreIds([FANTASIA_FILME]).includes(FICCAO_FANTASIA_TV));
    assert.ok(expandGenreIds([FICCAO_FANTASIA_TV]).includes(FICCAO_FILME));
  });

  it("genero sem equivalente atravessa inalterado", () => {
    // Drama (18) e Comedia (35) usam o mesmo id nos dois catalogos.
    assert.deepEqual(expandGenreIds([18]), [18]);
    assert.deepEqual(expandGenreIds([35]), [35]);
  });

  it("nao repete id e devolve ordem estavel", () => {
    const expandido = expandGenreIds([ACAO_FILME, AVENTURA_FILME, ACAO_AVENTURA_TV]);
    assert.deepEqual(expandido, [...new Set(expandido)]);
    assert.deepEqual(expandido, [...expandido].sort((a, b) => a - b));
  });

  it("lista vazia continua vazia — sem filtro nao vira filtro", () => {
    assert.deepEqual(expandGenreIds([]), []);
  });
});

describe("parseGenreIds", () => {
  it("le a lista agrupada que o FilterBar emite", () => {
    // `Number("12,10759")` era NaN, e a API perdia o filtro inteiro.
    assert.deepEqual(parseGenreIds("12,10759"), [12, 10759]);
  });

  it("aceita um id sozinho, que e o que /genero/[id] manda", () => {
    assert.deepEqual(parseGenreIds("18"), [18]);
  });

  it("descarta lixo sem derrubar o resto", () => {
    assert.deepEqual(parseGenreIds("12,abc,,0,-5,10759"), [12, 10759]);
  });

  it("ausencia de filtro e lista vazia, nao NaN", () => {
    assert.deepEqual(parseGenreIds(null), []);
    assert.deepEqual(parseGenreIds(undefined), []);
    assert.deepEqual(parseGenreIds(""), []);
  });
});

describe("parseGenreIds + expandGenreIds na consulta", () => {
  it("um id de filme alcanca o acervo de TV equivalente", () => {
    // Exatamente o que /api/series e /api/filmes fazem agora, e o caminho que
    // /genero/12 percorre.
    assert.deepEqual(expandGenreIds(parseGenreIds("12")), [12, 10759]);
  });

  it("selecionar o par ja agrupado fecha o conjunto pelos dois lados", () => {
    // "12,10759" traz 28 junto porque 10759 e, no TMDB, "Acao & Aventura": quem
    // pede o genero de TV esta pedindo os dois generos de filme que ele cobre.
    // Caminho raro na pratica — genreOptionValue so emite lista quando duas
    // linhas de Genero tem o mesmo nome — mas o fechamento tem de ser coerente.
    assert.deepEqual(expandGenreIds(parseGenreIds("12,10759")), [12, 28, 10759]);
  });

  it("sem filtro na querystring, nenhum genero entra na consulta", () => {
    assert.deepEqual(expandGenreIds(parseGenreIds(null)), []);
  });
});

describe("groupGenres", () => {
  it("funde linhas de genero com o mesmo nome e ids diferentes", () => {
    const grupos = groupGenres([
      { id: 16, nome: "Animação" },
      { id: 9999, nome: "Animacao" },
      { id: 18, nome: "Drama" },
    ]);

    assert.equal(grupos.length, 2);
    const animacao = grupos.find((g) => normalizeGenreName(g.nome) === "animacao");
    assert.deepEqual(animacao?.ids, [16, 9999]);
  });

  it("nao funde nomes diferentes — e por isso que a expansao existe", () => {
    // "Aventura" e "Ação & Aventura" sao o mesmo acervo, mas nomes distintos.
    // groupGenres nunca poderia junta-los; quem faz isso e expandGenreIds.
    const grupos = groupGenres([
      { id: AVENTURA_FILME, nome: "Aventura" },
      { id: ACAO_AVENTURA_TV, nome: "Ação & Aventura" },
    ]);

    assert.equal(grupos.length, 2);
  });

  it("genreOptionValue produz o formato que parseGenreIds le de volta", () => {
    const [grupo] = groupGenres([
      { id: 16, nome: "Animação" },
      { id: 9999, nome: "animação" },
    ]);

    const valor = genreOptionValue(grupo);
    assert.deepEqual(parseGenreIds(valor), grupo.ids);
  });

  it("ordena por nome em pt-BR", () => {
    const grupos = groupGenres([
      { id: 1, nome: "Terror" },
      { id: 2, nome: "Ação" },
      { id: 3, nome: "Drama" },
    ]);
    assert.deepEqual(grupos.map((g) => g.nome), ["Ação", "Drama", "Terror"]);
  });
});
