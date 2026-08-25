"use strict";

// Testes do extrator PlayHide/Hide. Nenhuma requisição de rede real: global.fetch
// é substituído por um provedor falso. Rodar com: npm run test:extractors
//
// A lógica coberta aqui é espelhada em Kotlin (PlayerExtractors.kt); ao mudar uma
// das implementações, ajuste a outra e este arquivo.

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractStream } = require("../extractors");

const CDN = "https://cdn-teste.invalid/hls2/01/00000/abc_,l,n,.urlset/master.m3u8?t=fake";

/**
 * Página do Hide com um packer mínimo: contagem zero de palavras, então o
 * "descompactador" devolve o payload intacto. Formato igual ao do provedor.
 */
function paginaHide(streamUrl) {
  const payload = `var links={"hls2":"${streamUrl}"};`;
  return [
    "<html><body>",
    "<script>eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(",
    "new RegExp('\\b'+c.toString(a)+'\\b','g'),k[c]);return p}",
    `('${payload}',10,0,''.split('|'),0,{}))</script>`,
    "</body></html>",
  ].join("");
}

/**
 * Substitui global.fetch. `vivos` são os hosts de página que respondem 200;
 * `statusCdn` é o que o CDN devolve para o master.
 */
function comProvedorFalso(vivos, statusCdn, corpo) {
  const original = global.fetch;
  const chamadas = [];
  global.fetch = async (url, init = {}) => {
    const alvo = new URL(String(url));
    chamadas.push({ url: alvo.href, headers: init.headers || {} });
    if (alvo.hostname === "cdn-teste.invalid") {
      return new Response("", { status: statusCdn });
    }
    if (!vivos.includes(alvo.hostname)) throw new TypeError("fetch failed");
    return new Response(corpo, { status: 200, headers: { "Content-Type": "text/html" } });
  };
  return { chamadas, restaurar: () => { global.fetch = original; } };
}

test("referer é o espelho que respondeu, não o domínio morto recebido", async () => {
  const falso = comProvedorFalso(["hidehide.shop"], 200, paginaHide(CDN));
  try {
    const r = await extractStream("https://playhide.shop/v/abc");
    assert.equal(r.stream, CDN);
    assert.equal(r.referer, "https://hidehide.shop/v/abc");
  } finally {
    falso.restaurar();
  }
});

test("espelho vivo recebido é usado sem tentar os outros", async () => {
  const falso = comProvedorFalso(["hidehide.shop", "vidhidehub.com"], 200, paginaHide(CDN));
  try {
    const r = await extractStream("https://vidhidehub.com/v/abc");
    assert.equal(r.referer, "https://vidhidehub.com/v/abc");
    const paginas = falso.chamadas.filter((c) => !c.url.includes("cdn-teste"));
    assert.equal(paginas.length, 1, "não deve consultar espelhos além do recebido");
  } finally {
    falso.restaurar();
  }
});

test("404 no CDN vira erro nomeado em vez de stream morto", async () => {
  const falso = comProvedorFalso(["hidehide.shop"], 404, paginaHide(CDN));
  try {
    await assert.rejects(
      () => extractStream("https://hidehide.shop/v/abc"),
      /não tem mais este arquivo/,
    );
  } finally {
    falso.restaurar();
  }
});

test("403 no CDN não invalida o stream: é token, não arquivo sumido", async () => {
  const falso = comProvedorFalso(["hidehide.shop"], 403, paginaHide(CDN));
  try {
    const r = await extractStream("https://hidehide.shop/v/abc");
    assert.equal(r.stream, CDN);
  } finally {
    falso.restaurar();
  }
});

test("checagem do CDN manda o referer do espelho usado", async () => {
  const falso = comProvedorFalso(["hidehide.shop"], 200, paginaHide(CDN));
  try {
    await extractStream("https://playhide.shop/v/abc");
    const noCdn = falso.chamadas.find((c) => c.url.includes("cdn-teste"));
    assert.equal(noCdn.headers.Referer, "https://hidehide.shop/v/abc");
    assert.equal(noCdn.headers.Origin, "https://hidehide.shop");
  } finally {
    falso.restaurar();
  }
});
