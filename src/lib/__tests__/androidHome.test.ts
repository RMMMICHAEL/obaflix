import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BUSCA,
  CAMPOS_TRILHA,
  NEW_MS,
  POR_TRILHA,
  paraHero,
  paraTrilha,
} from "../androidHome";
import { dedupeCatalogo } from "../canonical";

const AGORA = new Date("2026-09-04T12:00:00Z").getTime();

const linhaCompleta = {
  id: "42",
  tmdbId: "700",
  titulo: "Lanternas",
  poster: "/p.jpg",
  background: "/bg.jpg",
  logo: "/logo.png",
  ano: 2026,
  nota: 7.8,
  createdAt: new Date("2026-09-03T12:00:00Z"),
};

describe("metadata do card da home", () => {
  it("o logo chega ao item — era ele que faltava", () => {
    // O `select` da home nao pedia `logo` e o tipo do item nao tinha o campo,
    // entao TODO card caia para o rotulo de texto enquanto o resto do projeto
    // desenhava o logo oficial do TMDB dentro do banner.
    const item = paraTrilha(linhaCompleta, "filme", AGORA);
    assert.equal(item.logo, "/logo.png");
  });

  it("`logo` esta na lista de campos que a consulta pede", () => {
    assert.ok(CAMPOS_TRILHA.includes("logo"));
  });

  it("o item tem tudo o que o LandscapeCard consome", () => {
    const item = paraTrilha(linhaCompleta, "serie", AGORA);
    for (const campo of ["id", "tipo", "titulo", "poster", "background", "logo", "ano", "nota"]) {
      assert.ok(campo in item, `falta ${campo}`);
    }
  });

  it("sem logo o card cai para texto, sem quebrar", () => {
    const item = paraTrilha({ ...linhaCompleta, logo: null }, "filme", AGORA);
    assert.equal(item.logo, null);
    assert.equal(item.titulo, "Lanternas");
  });

  it("campo ausente vira null, nunca undefined", () => {
    const item = paraTrilha({ id: "1", titulo: "So o titulo" }, "filme", AGORA);
    assert.deepEqual(
      { poster: item.poster, background: item.background, logo: item.logo, ano: item.ano, nota: item.nota },
      { poster: null, background: null, logo: null, ano: null, nota: null },
    );
  });

  it("o tipo pedido vira o tipo do card — e o que decide o link do titulo", () => {
    assert.equal(paraTrilha(linhaCompleta, "anime", AGORA).tipo, "anime");
    assert.equal(paraTrilha(linhaCompleta, "desenho", AGORA).tipo, "desenho");
  });

  it("nenhuma URL de provedor atravessa a conversao", () => {
    const comFonte = { ...linhaCompleta, urlDub: "https://provedor/x", urlLeg: "https://provedor/y" };
    const item = paraTrilha(comFonte, "filme", AGORA) as unknown as Record<string, unknown>;
    assert.ok(!("urlDub" in item));
    assert.ok(!("urlLeg" in item));
    assert.ok(!("tmdbId" in item));
  });
});

describe("selo de novidade", () => {
  it("adicionado ontem e novo", () => {
    assert.equal(paraTrilha(linhaCompleta, "filme", AGORA).isNew, true);
  });

  it("adicionado ha mais de tres dias nao e novo", () => {
    const antigo = { ...linhaCompleta, createdAt: new Date(AGORA - NEW_MS - 1000) };
    assert.equal(paraTrilha(antigo, "filme", AGORA).isNew, false);
  });

  it("sem data nao inventa novidade", () => {
    assert.equal(paraTrilha({ id: "1", titulo: "x" }, "filme", AGORA).isNew, false);
  });

  it("data em string — como volta do cache — funciona igual", () => {
    // unstable_cache serializa em JSON e um Date volta como string.
    const item = paraTrilha({ ...linhaCompleta, createdAt: "2026-09-03T12:00:00Z" }, "filme", AGORA);
    assert.equal(item.isNew, true);
  });
});

describe("carrossel de destaque", () => {
  it("aproveita todos os destaques, nao so o primeiro", () => {
    // A consulta sempre pagou por 8 linhas; a home antiga usava uma e
    // descartava sete.
    const destaques = Array.from({ length: 8 }, (_, i) => ({
      id: String(i), titulo: `Filme ${i}`, sinopse: "s", background: `/bg${i}.jpg`,
    }));
    assert.equal(paraHero(destaques).length, 8);
  });

  it("descarta quem nao tem arte de fundo", () => {
    const itens = paraHero([
      { id: "1", titulo: "Com arte", background: "/bg.jpg" },
      { id: "2", titulo: "Sem arte", background: null },
    ]);
    assert.deepEqual(itens.map((i) => i.id), ["1"]);
  });

  it("catalogo sem arte nenhuma devolve carrossel vazio, nao um hero quebrado", () => {
    assert.deepEqual(paraHero([{ id: "1", titulo: "x", background: null }]), []);
  });
});

describe("prateleira sem titulo repetido", () => {
  it("a folga de busca cobre o que a deduplicacao remove", () => {
    assert.ok(BUSCA > POR_TRILHA, "buscar so o necessario deixaria a trilha curta");
  });

  it("tres copias do mesmo titulo viram um card so, com a mais completa", () => {
    const linhas = [
      { id: "98765", tmdbId: "124364", titulo: "Lanternas", logo: null, _count: { episodios: 2 } },
      { id: "wc_4412", tmdbId: "124364", titulo: "Lanternas", logo: "/logo.png", _count: { episodios: 3 } },
      { id: "124364", tmdbId: "124364", titulo: "Lanternas", logo: "/logo.png", _count: { episodios: 0 } },
      { id: "555", tmdbId: "999", titulo: "Outra", logo: null, _count: { episodios: 1 } },
    ];

    const trilha = dedupeCatalogo(linhas, "serie")
      .slice(0, POR_TRILHA)
      .map((linha) => paraTrilha(linha, "serie", AGORA));

    assert.equal(trilha.length, 2);
    assert.equal(trilha[0].id, "wc_4412");
    assert.equal(trilha[0].logo, "/logo.png");
  });
});
