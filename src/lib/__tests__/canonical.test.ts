import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  agruparDuplicatas,
  canonicalKey,
  compararRegistros,
  dedupeCanonical,
  elegerVencedor,
  pontuarRegistro,
  tipoMidia,
  type RegistroCatalogo,
} from "../canonical";

/**
 * O caso real da auditoria: "Lanternas" existe tres vezes porque tres
 * importadores usaram espacos de id diferentes para o mesmo tmdbId. Os ids sao
 * fieis ao formato de cada pipeline — Megaflix numerico puro, WebCine com
 * prefixo `wc_`, EmbedMovies usando o proprio tmdbId como chave primaria.
 */
const lanternasMegaflix: RegistroCatalogo = {
  id: "98765",
  tmdbId: "124364",
  tipo: "serie",
  titulo: "Lanternas",
  poster: "/p.jpg",
  ano: 2026,
  episodios: 2,
  createdAt: new Date("2026-01-10T00:00:00Z"),
};

const lanternasWebcine: RegistroCatalogo = {
  id: "wc_4412",
  tmdbId: "124364",
  tipo: "serie",
  titulo: "Lanternas",
  poster: "/p.jpg",
  background: "/bg.jpg",
  ano: 2026,
  episodios: 3,
  createdAt: new Date("2026-02-01T00:00:00Z"),
};

const lanternasEmbed: RegistroCatalogo = {
  id: "124364",
  tmdbId: "124364",
  tipo: "serie",
  titulo: "Lanternas",
  poster: "/p.jpg",
  background: "/bg.jpg",
  logo: "/logo.png",
  sinopse: "…",
  ano: 2026,
  nota: 7.8,
  episodios: 0,
  createdAt: new Date("2026-03-01T00:00:00Z"),
};

describe("canonicalKey", () => {
  it("usa tmdbId + midia, nao o id da linha", () => {
    assert.equal(canonicalKey(lanternasMegaflix), "serie:124364");
    assert.equal(canonicalKey(lanternasWebcine), "serie:124364");
    assert.equal(canonicalKey(lanternasEmbed), "serie:124364");
  });

  it("separa filme de serie com o mesmo tmdbId", () => {
    const filme: RegistroCatalogo = { id: "1", tmdbId: "500", tipo: "filme" };
    const serie: RegistroCatalogo = { id: "2", tmdbId: "500", tipo: "serie" };
    assert.notEqual(canonicalKey(filme), canonicalKey(serie));
  });

  it("nao colapsa por secao do catalogo: serie, anime e desenho sao a mesma midia", () => {
    // O cron do WebCine trazia o mesmo titulo pelos endpoints de series e de
    // animes. Se a secao entrasse na chave, esse caso continuaria duplicando.
    const comoSerie: RegistroCatalogo = { id: "a", tmdbId: "77", tipo: "serie" };
    const comoAnime: RegistroCatalogo = { id: "b", tmdbId: "77", tipo: "anime" };
    const comoDesenho: RegistroCatalogo = { id: "c", tmdbId: "77", tipo: "desenho" };

    assert.equal(tipoMidia(comoAnime), "serie");
    assert.equal(tipoMidia(comoDesenho), "serie");
    assert.equal(canonicalKey(comoSerie), canonicalKey(comoAnime));
    assert.equal(canonicalKey(comoAnime), canonicalKey(comoDesenho));
  });

  it("devolve null sem tmdbId — titulo nunca e prova de identidade", () => {
    assert.equal(canonicalKey({ id: "x", titulo: "Lanternas" }), null);
    assert.equal(canonicalKey({ id: "y", tmdbId: null, titulo: "Lanternas" }), null);
    assert.equal(canonicalKey({ id: "z", tmdbId: "   ", titulo: "Lanternas" }), null);
  });
});

describe("pontuarRegistro", () => {
  it("um episodio com fonte vale mais que toda a metadata somada", () => {
    // Metadata se rebusca no TMDB; episodio perdido nao volta.
    const soMetadata: RegistroCatalogo = {
      id: "a", tmdbId: "1", tipo: "serie",
      titulo: "t", tituloOriginal: "t", poster: "p", background: "b",
      logo: "l", sinopse: "s", ano: 2020, nota: 9,
      episodios: 0,
    };
    const soUmEpisodio: RegistroCatalogo = { id: "b", tmdbId: "1", tipo: "serie", episodios: 1 };

    assert.ok(pontuarRegistro(soUmEpisodio) > pontuarRegistro(soMetadata));
  });

  it("mais episodios vence menos episodios", () => {
    assert.ok(pontuarRegistro(lanternasWebcine) > pontuarRegistro(lanternasMegaflix));
  });

  it("filme com player vence filme sem player", () => {
    const semFonte: RegistroCatalogo = { id: "a", tmdbId: "1", tipo: "filme", titulo: "x" };
    const comFonte: RegistroCatalogo = { id: "b", tmdbId: "1", tipo: "filme", urlDub: "u" };
    assert.ok(pontuarRegistro(comFonte) > pontuarRegistro(semFonte));
  });

  it("string vazia nao conta como campo preenchido", () => {
    const vazio: RegistroCatalogo = { id: "a", tmdbId: "1", logo: "", sinopse: "" };
    assert.equal(pontuarRegistro(vazio), 0);
  });
});

describe("elegerVencedor", () => {
  it("elege a linha com mais episodios, nao a com metadata mais bonita", () => {
    const vencedor = elegerVencedor([lanternasEmbed, lanternasMegaflix, lanternasWebcine]);
    assert.equal(vencedor.id, "wc_4412");
  });

  it("nao depende da ordem de entrada", () => {
    const ordens = [
      [lanternasMegaflix, lanternasWebcine, lanternasEmbed],
      [lanternasEmbed, lanternasWebcine, lanternasMegaflix],
      [lanternasWebcine, lanternasEmbed, lanternasMegaflix],
    ];
    for (const ordem of ordens) {
      assert.equal(elegerVencedor(ordem).id, "wc_4412");
    }
  });

  it("empatado em conteudo, sobrevive o registro mais antigo", () => {
    // O mais antigo e o que tem mais chance de ja estar em link, historico e
    // watchlist — manter ele torna o merge menos observavel para o usuario.
    const antigo: RegistroCatalogo = {
      id: "zzz", tmdbId: "9", tipo: "filme", titulo: "t",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    };
    const novo: RegistroCatalogo = {
      id: "aaa", tmdbId: "9", tipo: "filme", titulo: "t",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    assert.equal(elegerVencedor([novo, antigo]).id, "zzz");
  });

  it("sem createdAt, o desempate por id mantem o resultado estavel", () => {
    // Dry-run e apply precisam eleger o mesmo vencedor.
    const a: RegistroCatalogo = { id: "aaa", tmdbId: "9", tipo: "filme" };
    const b: RegistroCatalogo = { id: "bbb", tmdbId: "9", tipo: "filme" };
    assert.equal(elegerVencedor([b, a]).id, "aaa");
    assert.equal(elegerVencedor([a, b]).id, "aaa");
  });

  it("comparador ordena do melhor para o pior", () => {
    const ordenado = [lanternasEmbed, lanternasMegaflix, lanternasWebcine].sort(compararRegistros);
    assert.deepEqual(ordenado.map((r) => r.id), ["wc_4412", "98765", "124364"]);
  });
});

describe("agruparDuplicatas", () => {
  it("junta as tres Lanternas num grupo com um vencedor e dois perdedores", () => {
    const grupos = agruparDuplicatas([lanternasMegaflix, lanternasEmbed, lanternasWebcine]);

    assert.equal(grupos.length, 1);
    assert.equal(grupos[0].chave, "serie:124364");
    assert.equal(grupos[0].vencedor.id, "wc_4412");
    assert.deepEqual(grupos[0].perdedores.map((p) => p.id).sort(), ["124364", "98765"]);
  });

  it("ignora quem nao tem duplicata", () => {
    const sozinho: RegistroCatalogo = { id: "1", tmdbId: "999", tipo: "filme" };
    assert.deepEqual(agruparDuplicatas([sozinho, lanternasWebcine]), []);
  });

  it("nunca agrupa linhas sem tmdbId, mesmo com titulo identico", () => {
    // Foi assim que o script antigo apagava "Lanternas" de 2011 por causa de
    // "Lanternas" de 2024.
    const a: RegistroCatalogo = { id: "a", titulo: "Lanternas", ano: 2011 };
    const b: RegistroCatalogo = { id: "b", titulo: "Lanternas", ano: 2024 };
    assert.deepEqual(agruparDuplicatas([a, b]), []);
  });
});

describe("dedupeCanonical", () => {
  it("devolve um titulo so, mantendo o registro mais completo", () => {
    const resultado = dedupeCanonical([lanternasMegaflix, lanternasWebcine, lanternasEmbed]);
    assert.equal(resultado.length, 1);
    assert.equal(resultado[0].id, "wc_4412");
  });

  it("preserva a posicao da primeira ocorrencia", () => {
    // Em /melhores as linhas chegam ordenadas por top250 e as duplicatas
    // carregam o mesmo rank: o titulo tem de sair no lugar dele, uma vez.
    const outro: RegistroCatalogo = { id: "outro", tmdbId: "555", tipo: "serie", titulo: "Outro" };
    const resultado = dedupeCanonical([lanternasMegaflix, outro, lanternasWebcine]);

    assert.deepEqual(resultado.map((r) => r.id), ["wc_4412", "outro"]);
  });

  it("nao colapsa linhas sem tmdbId", () => {
    const a: RegistroCatalogo = { id: "a", titulo: "Sem id" };
    const b: RegistroCatalogo = { id: "b", titulo: "Sem id" };
    assert.equal(dedupeCanonical([a, b]).length, 2);
  });

  it("lista sem duplicata atravessa intacta", () => {
    const entrada = [lanternasWebcine, { id: "x", tmdbId: "1", tipo: "filme" }];
    assert.deepEqual(dedupeCanonical(entrada), entrada);
  });

  it("ranking com tres duplicatas devolve uma linha por posicao", () => {
    const ranking = [
      { ...lanternasMegaflix, top250: 42 },
      { ...lanternasWebcine, top250: 42 },
      { ...lanternasEmbed, top250: 42 },
      { id: "outro", tmdbId: "777", tipo: "serie", titulo: "Outro", top250: 43 },
    ];
    const resultado = dedupeCanonical(ranking);

    assert.deepEqual(resultado.map((r) => r.top250), [42, 43]);
    assert.equal(resultado[0].id, "wc_4412");
  });
});
