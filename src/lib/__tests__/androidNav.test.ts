import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ANDROID_NAV_ITEMS,
  ROTA_BUSCA,
  ROTA_CONTA,
  abaAtiva,
  ehRotaDeBusca,
  mostrarBuscaNaTopbar,
  rotaDeBusca,
} from "../../components/layout/androidNav";

describe("abas da navegacao inferior", () => {
  it("Animes e Kids tem aba propria", () => {
    // O acesso a esses dois exigia entrar em Series e procurar
    // Familia/Animacao, apesar de /animes e /desenhos ja existirem e
    // funcionarem — faltava so a porta de entrada.
    const destinos = ANDROID_NAV_ITEMS.map((item) => item.href);
    assert.ok(destinos.includes("/animes"), "Animes precisa de aba");
    assert.ok(destinos.includes("/desenhos"), "Kids precisa de aba");
  });

  it("as cinco secoes do catalogo estao presentes, e so elas", () => {
    assert.deepEqual(
      ANDROID_NAV_ITEMS.map((item) => item.href),
      ["/android", "/filmes", "/series", "/animes", "/desenhos"],
    );
  });

  it("a barra continua com cinco itens — sete nao cabem num telefone", () => {
    assert.equal(ANDROID_NAV_ITEMS.length, 5);
  });

  it("Conta saiu da barra inferior e vive na topbar", () => {
    const destinos = ANDROID_NAV_ITEMS.map((item) => item.href);
    assert.ok(!destinos.includes(ROTA_CONTA));
  });

  it("Buscar deixou de ser aba: a lupa e a unica acao de busca", () => {
    const destinos = ANDROID_NAV_ITEMS.map((item) => item.href);
    assert.ok(!destinos.includes(ROTA_BUSCA));
  });

  it("nenhum destino se repete", () => {
    const destinos = ANDROID_NAV_ITEMS.map((item) => item.href);
    assert.deepEqual(destinos, [...new Set(destinos)]);
  });

  it("todo item tem rotulo e icone", () => {
    for (const item of ANDROID_NAV_ITEMS) {
      assert.ok(item.label.length > 0, `${item.href} sem rotulo`);
      assert.ok(item.icone.length > 0, `${item.href} sem icone`);
    }
  });
});

describe("aba ativa", () => {
  it("Inicio so acende na propria home", () => {
    assert.equal(abaAtiva("/android", "/android"), true);
    assert.equal(abaAtiva("/filmes", "/android"), false);
  });

  it("a secao acende nas subrotas dela", () => {
    assert.equal(abaAtiva("/animes", "/animes"), true);
    assert.equal(abaAtiva("/animes/qualquer", "/animes"), true);
  });

  it("o detalhe de um titulo nao acende a secao", () => {
    // /serie/123 e a pagina de um titulo, nao a secao Series.
    assert.equal(abaAtiva("/serie/123", "/series"), false);
    assert.equal(abaAtiva("/filme/9", "/filmes"), false);
  });

  it("uma rota so acende uma aba", () => {
    for (const pathname of ["/android", "/filmes", "/series", "/animes", "/desenhos"]) {
      const acesas = ANDROID_NAV_ITEMS.filter((item) => abaAtiva(pathname, item.href));
      assert.equal(acesas.length, 1, `${pathname} acendeu ${acesas.length} abas`);
    }
  });

  it("Kids e Series sao abas distintas e nao acendem juntas", () => {
    assert.equal(abaAtiva("/desenhos", "/series"), false);
    assert.equal(abaAtiva("/desenhos", "/desenhos"), true);
  });
});

describe("uma unica acao de busca", () => {
  it("a lupa aparece nas telas de catalogo", () => {
    for (const pathname of ["/android", "/filmes", "/series", "/animes", "/desenhos"]) {
      assert.equal(mostrarBuscaNaTopbar(pathname), true, pathname);
    }
  });

  it("na propria busca a lupa some — quem tem o campo e a pagina", () => {
    // Era daqui que vinha a impressao de duas buscas.
    assert.equal(mostrarBuscaNaTopbar(ROTA_BUSCA), false);
    assert.equal(ehRotaDeBusca("/buscar"), true);
    assert.equal(ehRotaDeBusca("/buscar/qualquer"), true);
  });

  it("nunca ha duas entradas de busca na mesma tela", () => {
    // A pagina de busca sempre tem campo; a topbar so tem lupa fora dela.
    const telas = ["/android", "/filmes", "/series", "/animes", "/desenhos", "/buscar"];
    for (const tela of telas) {
      const campos =
        Number(mostrarBuscaNaTopbar(tela)) + Number(ehRotaDeBusca(tela));
      assert.equal(campos, 1, `${tela} tem ${campos} entradas de busca`);
    }
  });
});

describe("rotaDeBusca", () => {
  it("leva a busca com o termo na querystring", () => {
    assert.equal(rotaDeBusca("lanternas"), "/buscar?q=lanternas");
  });

  it("recusa termo vazio em vez de abrir a tela sem nada", () => {
    // Navegar para /buscar sem `q` era exatamente o que a aba antiga fazia.
    assert.equal(rotaDeBusca(""), null);
    assert.equal(rotaDeBusca("   "), null);
  });

  it("ignora espaco em volta do termo", () => {
    assert.equal(rotaDeBusca("  lanternas  "), "/buscar?q=lanternas");
  });

  it("escapa o que quebraria a URL", () => {
    assert.equal(rotaDeBusca("tom & jerry"), "/buscar?q=tom%20%26%20jerry");
    assert.equal(rotaDeBusca("a?b=c"), "/buscar?q=a%3Fb%3Dc");
  });

  it("acento sobrevive a ida e volta", () => {
    const rota = rotaDeBusca("coração")!;
    const q = new URL(rota, "https://exemplo.test").searchParams.get("q");
    assert.equal(q, "coração");
  });
});
