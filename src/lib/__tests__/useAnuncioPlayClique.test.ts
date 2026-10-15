import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * O anúncio por clique da distribuição Google Play, provado pela fonte.
 *
 * O projeto testa a sequência de anúncio sem React (não há jsdom nem
 * testing-library — ver `adsFluxoDoCliente.test.ts` e `useAnuncioCountdown.test.ts`).
 * A contagem automática do Android é do APK direto; na Play, política de consumo
 * por clique, não pode haver disparo automático: o anúncio só abre após um toque
 * real. Esta é uma propriedade da fiação do hook e do modal, e é assim que se
 * afere aqui — a lógica pura reaproveitada (ponte, `aceitarRef`, `encerrar`)
 * continua coberta nos testes irmãos.
 */

const raiz = process.cwd();
const fonte = readFileSync(join(raiz, "src/components/player/useAnuncio.tsx"), "utf8");

/** O hook sem linhas de comentário, para checagens de "não pode aparecer". */
const codigo = fonte
  .split("\n")
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

describe("Play: o anúncio Android é por clique, sem disparo automático", () => {
  test("o convite Play ramifica por ehClientePlayNoNavegador() ANTES da contagem", () => {
    // A ramificação Play vive dentro de `exibirAnuncio`, depois do retorno do
    // Electron e antes de qualquer contagem.
    const iGuardaPlay = codigo.indexOf("if (ehClientePlayNoNavegador()) {");
    const iContagem = codigo.indexOf("criarContagemAndroid(");
    assert.ok(iGuardaPlay > -1, "o convite Android precisa ramificar no cliente Play");
    assert.ok(
      iContagem > iGuardaPlay,
      "a contagem automática só é alcançada quando NÃO é Play (APK direto)",
    );
  });

  test("a ramificação Play só abre o convite e retorna — nada de timer nem ponte", () => {
    const inicio = codigo.indexOf("if (ehClientePlayNoNavegador()) {");
    const bloco = codigo.slice(inicio, codigo.indexOf("criarContagemAndroid("));
    // Abre o convite por clique e sai.
    assert.match(bloco, /setModal\(\{ fase: "convite", plataforma: "android", finalidade \}\)/);
    assert.match(bloco, /return;/);
    // Nenhum disparo automático: a Play não conta sozinha nem chama a ponte aqui.
    assert.equal(bloco.includes("criarContagemAndroid"), false, "Play não arma contagem automática");
    assert.equal(bloco.includes("setInterval"), false, "Play não arma timer automático");
    assert.equal(bloco.includes("mostrarAnuncio"), false, "a ponte só é chamada após o toque (aceitarRef)");
    // A autorização do servidor permanece intacta: a ramificação não mexe nela.
    assert.equal(bloco.includes("concluir"), false, "Play não concede nem conclui por si");
    assert.equal(bloco.includes("encerrar(true"), false, "abrir o convite nunca concede acesso");
  });
});

describe("Play: o clique explícito é a única forma de exibir, e é disparo único", () => {
  const inicio = codigo.indexOf("const aoConfirmar = useCallback(");
  const corpo = codigo.slice(inicio, codigo.indexOf("}, [", inicio));

  test("aoConfirmar consome aceitarRef (disparo único) e só então chama a ponte", () => {
    assert.ok(inicio > -1, "aoConfirmar precisa existir");
    // Captura e anula a ref antes de chamar: toques repetidos não reabrem.
    assert.match(corpo, /const aceitar = aceitarRef\.current;/);
    assert.match(corpo, /aceitarRef\.current = null;/);
    assert.match(corpo, /aceitar\?\.\(\)/);
    // Anular acontece ANTES de chamar — single-thread garante o disparo único.
    const iNull = corpo.indexOf("aceitarRef.current = null");
    const iChama = corpo.indexOf("aceitar?.()");
    assert.ok(iNull > -1 && iChama > iNull, "anula a ref antes de disparar");
    // O clique nunca concede nem conclui por si: isso é do callback nativo + servidor.
    assert.equal(corpo.includes("concluir"), false, "o clique não conclui/concede");
    assert.equal(corpo.includes("encerrar(true"), false, "o clique não concede acesso");
  });

  test("o modal Play mostra o botão de clique, sem contagem automática", () => {
    const inicioAndroid = fonte.indexOf('estado.plataforma === "android" && (');
    const inicioElectron = fonte.indexOf('estado.plataforma !== "android" && (');
    const iTernario = fonte.indexOf("play ? (", inicioAndroid);
    const iElse = fonte.indexOf(") : (", iTernario);
    assert.ok(
      inicioAndroid > -1 && iTernario > inicioAndroid && iElse > iTernario && inicioElectron > iElse,
      "o convite Android ramifica play ? (clique) : (contagem)",
    );
    const ramoPlay = fonte.slice(iTernario, iElse);
    // O botão explícito pedido, ligado a aoConfirmar.
    assert.match(ramoPlay, /Assistir anúncio e continuar/);
    assert.match(ramoPlay, /onClick=\{aoConfirmar\}/);
    // Sem contagem no ramo Play.
    assert.equal(ramoPlay.includes("Anúncio em"), false, "o ramo Play não conta automaticamente");
  });
});

describe("Play: cancelar fecha sem conceder; a autorização do servidor fica intacta", () => {
  test("o X (aoFechar) encerra sem conceder e desarma o callback nativo", () => {
    const inicio = codigo.indexOf("const aoFechar = useCallback(");
    const corpo = codigo.slice(inicio, codigo.indexOf("}, [", inicio));
    assert.ok(inicio > -1, "aoFechar precisa existir");
    // Desarma a callback nativa tardia e cancela — nunca concede.
    assert.match(corpo, /window\.__obaflixAnuncioConcluido = undefined/);
    assert.match(corpo, /encerrar\(false\)/);
    assert.equal(corpo.includes("encerrar(true"), false, "fechar nunca concede acesso");
  });

  test("a ponte nativa continua amarrada ao desafio do servidor (callback tardia ignorada)", () => {
    // Reaproveitada do fluxo existente: o mesmo aceitarRef serve ao clique da Play.
    assert.match(codigo, /mostrarAnuncio\(capability, entrada\.desafioId\)/);
    assert.match(codigo, /if \(desafioId !== entrada\.desafioId\) return;/);
  });
});

describe("APK direto preservado: a contagem automática de 3 s continua", () => {
  test("fora da Play, o Android ainda arma a contagem pura ligada ao relógio real", () => {
    // A contagem segue depois da guarda Play — alcançada só no APK direto.
    assert.match(codigo, /criarContagemAndroid\(/);
    assert.match(codigo, /agora: \(\) => Date\.now\(\)/);
    assert.match(codigo, /aceitarRef\.current\?\.\(\)/);
    assert.match(codigo, /setInterval\(/);
  });

  test("o modal do APK direto mantém o texto de contagem e o botão de remover", () => {
    const inicioAndroid = fonte.indexOf('estado.plataforma === "android" && (');
    const inicioElectron = fonte.indexOf('estado.plataforma !== "android" && (');
    const iElse = fonte.indexOf(") : (", fonte.indexOf("play ? (", inicioAndroid));
    const ramoApk = fonte.slice(iElse, inicioElectron);
    assert.match(ramoApk, /Anúncio em \{estado\.contagem/);
    assert.match(ramoApk, /Remover anúncios/);
  });
});
