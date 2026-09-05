import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  alvoDoHref,
  decidirAcaoDoHero,
  fontesCandidatas,
  mensagemDeFalha,
  pidDeEpisodio,
  pidDeFilme,
  pidDoAlvo,
  pontesDeMidia,
  rotuloDeEpisodio,
  rotuloDoAlvo,
} from "../androidMedia";

// ── Alvo: filme, série e anime ───────────────────────────────────────────────
// Animes e desenhos usam a rota de série, então o mesmo caminho cobre os três.
// O que este bloco protege é a promessa de que baixar alveja exatamente o que
// Assistir tocaria — o href é o mesmo nos dois casos.

test("filme: hero de filme vira alvo de filme", () => {
  const alvo = alvoDoHref("/assistir/filme/842");
  assert.deepEqual(alvo, { tipo: "filme", conteudoId: "842" });
  assert.equal(pidDoAlvo(alvo!), "filme:842");
  assert.equal(rotuloDoAlvo("Duna", alvo!), "Duna");
});

test("série: hero com episódio de retomada vira alvo daquele episódio", () => {
  const alvo = alvoDoHref("/assistir/serie/12/t2/ep7");
  assert.deepEqual(alvo, { tipo: "serie", conteudoId: "12", temporada: 2, numeroEp: 7 });
  assert.equal(pidDoAlvo(alvo!), "serie:12:t2:e7");
  assert.equal(rotuloDoAlvo("O Mentalista", alvo!), "O Mentalista - 2x7");
});

test("anime: usa a rota de série e produz o mesmo formato", () => {
  // Não existe /assistir/anime/...: no catálogo anime é série. Se um dia
  // existir, este teste falha e o parser precisa ganhar o caso — em vez de
  // silenciosamente devolver null e sumir com os botões.
  const alvo = alvoDoHref("/assistir/serie/9001/t1/ep12");
  assert.equal(alvo?.tipo, "serie");
  assert.equal(pidDoAlvo(alvo!), "serie:9001:t1:e12");
  assert.equal(rotuloDoAlvo("Frieren", alvo!), "Frieren - 1x12");
});

test("query string e âncora não atrapalham o alvo", () => {
  assert.deepEqual(alvoDoHref("/assistir/filme/5?autoplay=1#topo"), {
    tipo: "filme",
    conteudoId: "5",
  });
});

test("href inesperado não vira alvo", () => {
  // Melhor sumir com os botões do que baixar o conteúdo errado a partir de um
  // id mal interpretado.
  assert.equal(alvoDoHref(null), null);
  assert.equal(alvoDoHref(undefined), null);
  assert.equal(alvoDoHref("/serie/12"), null);
  assert.equal(alvoDoHref("/assistir/serie/12"), null);
  assert.equal(alvoDoHref("/assistir/serie/12/t2"), null);
  assert.equal(alvoDoHref("/assistir/novela/12/t1/ep1"), null);
});

test("os três pontos de uso produzem o mesmo pid para o mesmo episódio", () => {
  // Hero, linha de episódio e player. Se divergirem, a fila trata o mesmo
  // episódio como três itens e o "já está na fila" para de funcionar.
  const doHero = pidDoAlvo(alvoDoHref("/assistir/serie/12/t2/ep7")!);
  const daLinha = pidDeEpisodio("12", 2, 7);
  const doPlayer = pidDeEpisodio("12", 2, 7);
  assert.equal(doHero, daLinha);
  assert.equal(daLinha, doPlayer);
});

test("rótulo do episódio é o mesmo na linha e no hero", () => {
  assert.equal(
    rotuloDeEpisodio("O Mentalista", 1, 1),
    rotuloDoAlvo("O Mentalista", alvoDoHref("/assistir/serie/7/t1/ep1")!),
  );
});

test("pid de filme e de episódio não colidem", () => {
  assert.notEqual(pidDeFilme("12"), pidDeEpisodio("12", 1, 1));
});

// ── Hero: série nunca baixa sem episódio escolhido ───────────────────────────
//
// O `watchHref` que a página de série monta é o do PRIMEIRO episódio. Se o hero
// agisse sobre ele, tocar em "Baixar" numa série de seis temporadas entregaria
// o T1E1 sem ninguém ter pedido — e o arquivo ficaria no aparelho da pessoa.

const SERIES = ["serie", "anime", "desenho"] as const;

/** O href que a página de série monta: sempre o PRIMEIRO episódio. */
const HREF_PRIMEIRO_EP = "/assistir/serie/12/t1/ep1";

test("filme age direto: há uma mídia só", () => {
  const d = decidirAcaoDoHero({
    tipo: "filme",
    conteudoId: "842",
    watchHref: "/assistir/filme/842",
  });
  assert.equal(d.modo, "direto");
  assert.equal(pidDoAlvo(d.modo === "direto" ? d.alvo : ({} as never)), "filme:842");
});

test("filme sem href de reprodução fica indisponível, não inventa mídia", () => {
  assert.equal(decidirAcaoDoHero({ tipo: "filme", conteudoId: "842" }).modo, "indisponivel");
  assert.equal(
    decidirAcaoDoHero({ tipo: "filme", conteudoId: "842", watchHref: null }).modo,
    "indisponivel",
  );
});

// -- Zero episódios ---------------------------------------------------------

test("série, anime e desenho com ZERO episódios ficam indisponíveis", () => {
  for (const tipo of SERIES) {
    const d = decidirAcaoDoHero({ tipo, conteudoId: "12", totalEpisodios: 0 });
    assert.equal(d.modo, "indisponivel", `tipo ${tipo}`);
  }
});

test("contagem ausente é tratada como zero", () => {
  for (const tipo of SERIES) {
    assert.equal(decidirAcaoDoHero({ tipo, conteudoId: "12" }).modo, "indisponivel", `tipo ${tipo}`);
  }
});

test("zero episódios não vira ação nem mesmo com href de primeiro episódio", () => {
  // O href existe na página; a decisão não pode usá-lo para fabricar mídia.
  for (const tipo of SERIES) {
    const d = decidirAcaoDoHero({
      tipo,
      conteudoId: "12",
      watchHref: HREF_PRIMEIRO_EP,
      totalEpisodios: 0,
    });
    assert.equal(d.modo, "indisponivel", `tipo ${tipo}`);
  }
});

// -- Exatamente um episódio -------------------------------------------------

test("um episódio: age direto NAQUELE episódio, com o pid dele", () => {
  for (const tipo of SERIES) {
    const d = decidirAcaoDoHero({
      tipo,
      conteudoId: "12",
      totalEpisodios: 1,
      episodioUnico: { temporada: 3, numeroEp: 8 },
    });
    assert.equal(d.modo, "direto", `tipo ${tipo}`);
    if (d.modo !== "direto") continue;
    // O episódio único não é necessariamente T1E1 — e o pid tem de ser o dele.
    assert.deepEqual(d.alvo, { tipo: "serie", conteudoId: "12", temporada: 3, numeroEp: 8 });
    assert.equal(pidDoAlvo(d.alvo), "serie:12:t3:e8");
    assert.equal(rotuloDoAlvo("Chernobyl", d.alvo), "Chernobyl - 3x8");
  }
});

test("um episódio: usa a coleção, não o href do primeiro episódio", () => {
  // A página passaria watchHref=/t1/ep1; a coleção diz t3/ep8. Vence a coleção.
  const d = decidirAcaoDoHero({
    tipo: "serie",
    conteudoId: "12",
    watchHref: HREF_PRIMEIRO_EP,
    totalEpisodios: 1,
    episodioUnico: { temporada: 3, numeroEp: 8 },
  });
  assert.equal(d.modo === "direto" && pidDoAlvo(d.alvo), "serie:12:t3:e8");
});

test("total 1 sem identificação do episódio não chuta: fica indisponível", () => {
  for (const tipo of SERIES) {
    const d = decidirAcaoDoHero({ tipo, conteudoId: "12", totalEpisodios: 1, episodioUnico: null });
    assert.equal(d.modo, "indisponivel", `tipo ${tipo}`);
  }
});

// -- Vários episódios -------------------------------------------------------

test("dois ou mais episódios: nunca escolhe, sempre manda escolher", () => {
  for (const tipo of SERIES) {
    for (const total of [2, 3, 120]) {
      const d = decidirAcaoDoHero({ tipo, conteudoId: "12", totalEpisodios: total });
      assert.equal(d.modo, "escolher", `tipo ${tipo} com ${total}`);
    }
  }
});

test("com vários episódios o primeiroEp do watchHref é IGNORADO", () => {
  // O defeito que esta rodada corrigiu: a pessoa tocaria em Baixar numa série
  // de seis temporadas e receberia o T1E1 sem ter pedido.
  for (const tipo of SERIES) {
    const d = decidirAcaoDoHero({
      tipo,
      conteudoId: "12",
      watchHref: HREF_PRIMEIRO_EP,
      totalEpisodios: 60,
    });
    assert.equal(d.modo, "escolher", `tipo ${tipo}`);
    // E não existe alvo algum a que agarrar.
    assert.equal("alvo" in d, false, `tipo ${tipo} expôs um alvo`);
  }
});

// -- Precedência da retomada ------------------------------------------------

test("retomada tem precedência sobre a contagem, mesmo com muitos episódios", () => {
  for (const tipo of SERIES) {
    const d = decidirAcaoDoHero({
      tipo,
      conteudoId: "12",
      watchHref: HREF_PRIMEIRO_EP,
      retomada: { temporada: 4, numeroEp: 9 },
      totalEpisodios: 60,
    });
    assert.equal(d.modo, "direto", `tipo ${tipo}`);
    assert.equal(d.modo === "direto" && pidDoAlvo(d.alvo), "serie:12:t4:e9", `tipo ${tipo}`);
  }
});

test("retomada não ressuscita conteúdo sem episódio publicado", () => {
  // Progresso antigo de um episódio que saiu do catálogo: a decisão prefere a
  // retomada, mas se não há episódios a fonte simplesmente não resolve — e
  // quem barra de verdade é o classificador nativo. Aqui só se documenta que a
  // precedência é intencional.
  const d = decidirAcaoDoHero({
    tipo: "serie",
    conteudoId: "12",
    retomada: { temporada: 1, numeroEp: 1 },
    totalEpisodios: 0,
  });
  assert.equal(d.modo, "direto");
});

test("sem conteudoId não há decisão possível", () => {
  assert.equal(
    decidirAcaoDoHero({ tipo: "serie", conteudoId: "", totalEpisodios: 5 }).modo,
    "indisponivel",
  );
});

// -- Estrutura do componente ------------------------------------------------

test("o hero trata indisponível e escolher ANTES das ações diretas", () => {
  // Estrutura, não comportamento: sem jsdom, o jeito honesto de travar isto é
  // conferir a ordem no arquivo. Invertida, a série voltaria a agir sozinha.
  const src = readFileSync("src/components/android/AndroidHeroActions.tsx", "utf8");
  const indisponivel = src.indexOf('decisao.modo === "indisponivel"');
  const escolher = src.indexOf('decisao.modo === "escolher"');
  const direto = src.indexOf("<AndroidMediaActions");
  assert.ok(indisponivel > 0, "o ramo indisponível sumiu");
  assert.ok(escolher > 0, "o ramo escolher sumiu");
  assert.ok(direto > 0, "as ações diretas sumiram");
  assert.ok(indisponivel < direto && escolher < direto, "as ações diretas passaram na frente");
});

test("o ramo indisponível não resolve fonte nem pede download ou cast", () => {
  const src = readFileSync("src/components/android/AndroidHeroActions.tsx", "utf8");
  const inicio = src.indexOf('if (decisao.modo === "indisponivel")');
  const fim = src.indexOf('if (decisao.modo === "escolher")');
  const ramo = src.slice(inicio, fim);
  assert.ok(ramo.includes("desabilitado"), "os botões precisam aparecer desabilitados");
  assert.ok(!ramo.includes("resolverFonte"));
  assert.ok(!ramo.includes("requestDownload"));
  assert.ok(!ramo.includes("requestCast"));
});

test("o caminho de escolher episódio não resolve fonte nenhuma", () => {
  // Ele só rola a página até a lista. Nenhuma chamada a /api/player/fontes,
  // nenhuma extração — e nenhuma navegação, então o gate de anúncios não vê nada.
  const src = readFileSync("src/components/android/AndroidHeroActions.tsx", "utf8");
  const inicio = src.indexOf("const escolherEpisodio");
  const fim = src.indexOf("}, []);", inicio);
  const corpo = src.slice(inicio, fim);
  assert.ok(corpo.includes("scrollIntoView"));
  assert.ok(!corpo.includes("resolverFonte"));
  assert.ok(!corpo.includes("requestDownload"));
  assert.ok(!corpo.includes("requestCast"));
  assert.ok(!corpo.includes("router"));
  assert.ok(!corpo.includes("location"));
});

// ── Disponibilidade: só no APK Android ───────────────────────────────────────

test("sem ponte nativa, não há ações", () => {
  assert.equal(pontesDeMidia(undefined), null);
  assert.equal(pontesDeMidia(null), null);
});

test("Electron define obaflixDesktop mas não ganha as ações", () => {
  // A checagem é pelo campo mediaActions, não pela existência do objeto:
  // testar só o objeto faria os botões aparecerem no Electron e na TV.
  const electron = { platform: "electron", extractStream: () => {} };
  assert.equal(pontesDeMidia(electron as never), null);
});

test("APK Android com a interface registrada ganha as ações", () => {
  const android = { mediaActions: true, requestDownload: () => {} };
  assert.equal(pontesDeMidia(android), android);
});

// ── Fontes candidatas ────────────────────────────────────────────────────────

test("fontes presas à sessão do navegador não entram na lista", () => {
  const fontes = [
    { id: "a", disponivel: true, nativo: true },
    { id: "b", disponivel: true, nativo: true, superflixLocal: { sessionId: "x" } },
    { id: "c", disponivel: true, nativo: true, iframeDesafio: true },
    { id: "d", disponivel: true, nativo: true, iframeDireto: true },
    { id: "e", disponivel: false, nativo: true },
    { id: "f", disponivel: true, nativo: false },
  ];
  assert.deepEqual(
    fontesCandidatas(fontes).map((f) => f.id),
    ["a"],
  );
});

test("sem candidata alguma a lista é vazia, não parcial", () => {
  assert.deepEqual(fontesCandidatas([{ id: "a", disponivel: true, nativo: false }]), []);
});

// ── Mensagens ────────────────────────────────────────────────────────────────

test("fonte não exportável vira mensagem clara, sem detalhe técnico", () => {
  const msg = mensagemDeFalha("sessao_do_navegador");
  assert.equal(msg, "Nenhum servidor permite baixar este título");
  // Nada de provedor, host, token ou nome interno na tela.
  assert.ok(!/superflix|cloudflare|manifest|token|http/i.test(msg));
});

test("app de transmissão ausente tem mensagem própria", () => {
  assert.equal(mensagemDeFalha("app_ausente"), "Instale o app de transmissão");
});

test("motivo desconhecido não vaza o código do motivo", () => {
  const msg = mensagemDeFalha("erro_interno_xyz");
  assert.equal(msg, "Não foi possível concluir");
  assert.ok(!msg.includes("xyz"));
});

// ── Anúncios: as ações não podem ficar dentro de um link ─────────────────────
//
// O AdGateScript do APK intercepta clique em capture-phase no document e sai
// logo no `closest('a[href]')`. Como `closest` só sobe por ancestrais, um botão
// que não tem <a> acima nunca chega a acionar `requestPlayback` — não conta
// episódio, não arma AD_HOLD, não consome o ciclo ep1/ep2 livre, ep3 anúncio.
//
// Isso é estrutura de JSX, não comportamento de função: sem jsdom no projeto, o
// jeito honesto de travar a propriedade é conferir a ordem no próprio arquivo.
// Se alguém mover as ações para dentro do <Link>, este teste quebra antes de
// virar um anúncio disparado por um toque em "Baixar".

test("na grade, as ações do episódio ficam fora do <Link>", () => {
  const src = readFileSync("src/app/serie/[id]/EpisodeGrid.tsx", "utf8");
  const fimDoLink = src.lastIndexOf("</Link>");
  const acoes = src.indexOf("<AndroidEpisodeActions");
  assert.ok(fimDoLink > 0, "o <Link> do episódio sumiu do arquivo");
  assert.ok(acoes > 0, "as ações do episódio sumiram do arquivo");
  assert.ok(acoes > fimDoLink, "as ações do episódio entraram para dentro do <Link>");
});

test("no hero, as ações ficam fora do <Link> de Assistir", () => {
  const src = readFileSync("src/components/ui/MediaHero.tsx", "utf8");
  const fimDoLink = src.lastIndexOf("</Link>");
  const acoes = src.indexOf("<AndroidHeroActions");
  assert.ok(fimDoLink > 0, "o <Link> de Assistir sumiu do arquivo");
  assert.ok(acoes > 0, "as ações do hero sumiram do arquivo");
  assert.ok(acoes > fimDoLink, "as ações do hero entraram para dentro do <Link>");
});

test("os componentes de ação impedem a navegação no próprio clique", () => {
  // Segunda camada, para o caso de um cartão clicável em volta: o handler
  // chama preventDefault e stopPropagation antes de qualquer coisa.
  const src = readFileSync("src/components/android/AndroidMediaActions.tsx", "utf8");
  assert.ok(src.includes("e.preventDefault()"));
  assert.ok(src.includes("e.stopPropagation()"));
});

test("nenhum componente de mídia fala com o sistema de anúncios", () => {
  const arquivos = [
    "src/components/android/AndroidMediaActions.tsx",
    "src/components/android/AndroidHeroActions.tsx",
    "src/components/android/AndroidEpisodeActions.tsx",
    "src/components/android/DownloadQualityModal.tsx",
    "src/components/android/useFonteParaMidia.ts",
    "src/lib/androidMedia.ts",
  ];
  const proibidos = ["requestPlayback", "_obaflixAds", "AD_HOLD", "adGate", "AdGate"];
  for (const arquivo of arquivos) {
    const src = readFileSync(arquivo, "utf8");
    for (const termo of proibidos) {
      assert.ok(!src.includes(termo), `${arquivo} referencia ${termo}`);
    }
  }
});

test("toda mensagem conhecida é curta e legível", () => {
  const motivos = [
    "app_ausente",
    "sem_pasta",
    "pasta_invalida",
    "sessao_do_navegador",
    "expirada",
    "sondagem_expirada",
    "indisponivel",
    undefined,
  ];
  for (const m of motivos) {
    const texto = mensagemDeFalha(m);
    assert.ok(texto.length > 0 && texto.length <= 60, `mensagem ruim para ${m}: ${texto}`);
  }
});
