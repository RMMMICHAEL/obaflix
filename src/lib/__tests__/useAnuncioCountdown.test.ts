import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A ligação da contagem do Android ao hook `useAnuncio`, provada pela fonte.
 *
 * O projeto testa a sequência de anúncio sem React (não há jsdom nem
 * testing-library — ver `adsFluxoDoCliente.test.ts`): a lógica pura da contagem
 * vive em `contagemAndroid` e é exercitada em `contagemAndroid.test.ts`. O que
 * falta garantir é a *fiação* — que o hook liga essa lógica ao relógio, à
 * visibilidade e à limpeza certos, e que o Electron não mudou. Isso é uma
 * propriedade do texto do hook, e é assim que se afere aqui.
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

describe("Android dispara a ponte pela contagem, sem clique", () => {
  test("o convite Android liga a contagem pura ao relógio e à visibilidade reais", () => {
    assert.match(codigo, /criarContagemAndroid\(/);
    assert.match(codigo, /agora: \(\) => Date\.now\(\)/);
    assert.match(codigo, /document\.visibilityState === "visible"/);
    // Cenários 3 e 4: pausa em background e retomada passam pelo visibilitychange.
    assert.match(codigo, /addEventListener\("visibilitychange"/);
    assert.match(codigo, /contagem\.marcarVisivel\(\)/);
  });

  /** Cenário 10: zerar só chama a ponte; a concessão não nasce da contagem. */
  test("ao zerar, o hook chama a ponte — nunca a conclusão/concessão", () => {
    const inicio = codigo.indexOf("aoZerar:");
    assert.ok(inicio > -1, "o hook precisa reagir ao zerar da contagem");
    const fim = codigo.indexOf("});", inicio);
    const bloco = codigo.slice(inicio, fim);

    assert.match(bloco, /aceitarRef\.current\?\.\(\)/, "zerar aciona o mesmo caminho que exibe o anúncio");
    assert.equal(bloco.includes("concluir"), false, "os 3 s não podem chamar /api/ads/complete");
    assert.equal(bloco.includes("encerrar(true"), false, "os 3 s não podem conceder acesso");
  });

  /** A ponte recebe capability + desafioId do servidor, como sempre. */
  test("a ponte nativa continua mínima e amarrada ao desafio do servidor", () => {
    assert.match(codigo, /mostrarAnuncio\(capability, entrada\.desafioId\)/);
    // Cenário 8: callback tardia de outro desafio é ignorada.
    assert.match(codigo, /if \(desafioId !== entrada\.desafioId\) return;/);
  });

  /** Cenário 7: sem ponte ou sem capability, falha fechada — nunca libera. */
  test("ponte ou capability ausente cancela sem conceder", () => {
    assert.match(codigo, /if \(!ponte\?\.mostrarAnuncio \|\| !capability\) \{/);
    const inicio = codigo.indexOf("if (!ponte?.mostrarAnuncio || !capability) {");
    const bloco = codigo.slice(inicio, codigo.indexOf("}", inicio));
    assert.match(bloco, /encerrar\(false\)/, "sem ponte, a ação é cancelada (fail-closed)");
  });

  /** Cenários 5 e 6: cancelar e desmontar limpam timer, listener e contagem. */
  test("a limpeza do Android remove timer, listener e encerra a contagem", () => {
    const inicio = codigo.indexOf("limparRef.current = () => {", codigo.indexOf("criarContagemAndroid"));
    assert.ok(inicio > -1, "a contagem precisa registrar sua própria limpeza");
    const bloco = codigo.slice(inicio, codigo.indexOf("};", inicio));
    assert.match(bloco, /clearInterval\(timer\)/);
    assert.match(bloco, /removeEventListener\("visibilitychange"/);
    assert.match(bloco, /contagem\.encerrar\(\)/);

    // O desmontar do hook chama essa limpeza (cenário 6) e resolve sem conceder.
    assert.match(codigo, /useEffect\(\(\) => \(\) => \{[\s\S]*?limparRef\.current\?\.\(\)/);
    assert.match(codigo, /resolverRef\.current\?\.\(\{ concluido: false \}\)/);
  });
});

describe("Electron mantém o fluxo e o botão atuais", () => {
  /** Cenário 9: a contagem automática é só do Android. */
  test("a contagem automática não alcança o Electron", () => {
    // O caminho do Electron é o guardado por "não é android", e sai antes da contagem.
    assert.match(codigo, /if \(entrada\.plataforma !== "android"\) \{/);
    // A contagem (setInterval de 200 ms + criarContagemAndroid) fica depois desse return.
    const retornoElectron = codigo.indexOf('if (entrada.plataforma !== "android") {');
    const contagem = codigo.indexOf("criarContagemAndroid(");
    assert.ok(retornoElectron > -1 && contagem > retornoElectron, "a contagem é exclusiva do Android");
  });

  test("o convite do Electron ainda pede o clique em Continuar gratuitamente", () => {
    assert.match(codigo, /estado\.plataforma !== "android"/);
    assert.match(fonte, /Continuar gratuitamente/);
    assert.match(fonte, /onClick=\{aoConfirmar\}/);
  });

  /** A interface do Android mostra a contagem simples pedida. */
  test("o Android mostra o texto de contagem, sem botão obrigatório", () => {
    assert.match(fonte, /Seu conteúdo começa após o anúncio/);
    assert.match(fonte, /Anúncio em \{estado\.contagem/);
    assert.match(codigo, /estado\.plataforma === "android"/);
  });
});

describe('o botão "Remover anúncios" no convite Android', () => {
  /** O bloco do convite Android, isolado do bloco do Electron. */
  const inicioAndroid = fonte.indexOf('estado.plataforma === "android" && (');
  const inicioElectron = fonte.indexOf('estado.plataforma !== "android" && (');
  const blocoAndroid = fonte.slice(inicioAndroid, inicioElectron);

  /** Teste 1: o botão aparece no modal Android, abaixo da contagem. */
  test("o botão existe no bloco Android, após a contagem", () => {
    assert.ok(inicioAndroid > -1 && inicioElectron > inicioAndroid, "os dois blocos de convite existem");
    assert.match(blocoAndroid, /Remover anúncios/);
    // Abaixo da contagem: o texto "Anúncio em" vem antes do botão no mesmo bloco.
    assert.ok(
      blocoAndroid.indexOf("Anúncio em") < blocoAndroid.indexOf("Remover anúncios"),
      "o botão fica abaixo da contagem",
    );
  });

  /** Teste 2: o clique chama exatamente `aoAssinar` — nada novo. */
  test("o botão reutiliza aoAssinar (sem rota nem lógica nova)", () => {
    assert.match(blocoAndroid, /onClick=\{aoAssinar\}/);
  });

  /**
   * Testes 3–5: o próprio `aoAssinar` encerra a ação antes de navegar, não
   * concede acesso e desarma o callback nativo. O encerramento do timer/listener
   * da contagem está em `encerrar` → `limparRef` (contagem.encerrar()), já
   * coberto acima — aqui prova-se que `aoAssinar` passa por ele.
   */
  test("aoAssinar encerra sem conceder e desarma o anúncio, antes de navegar", () => {
    const inicio = codigo.indexOf("const aoAssinar = useCallback(");
    assert.ok(inicio > -1);
    const corpo = codigo.slice(inicio, codigo.indexOf("}, [", inicio));

    // Teste 4: o callback nativo é anulado — uma conclusão tardia não concede.
    assert.match(corpo, /window\.__obaflixAnuncioConcluido = undefined/);
    // Teste 3: encerra a exibição (e, com ela, o timer/listener da contagem).
    assert.match(corpo, /encerrar\(false\)/);
    // Teste 5: cancela, nunca concede — `encerrar(true)` seria conceder.
    assert.equal(corpo.includes("encerrar(true"), false, "assinar nunca concede acesso");
    // Teste 6: navega para a rota de planos já existente.
    assert.match(corpo, /router\.push\(efeito\.navegarPara\)/);
    assert.match(corpo, /efeitoDoConvite\("assinar"\)/);

    // Ordem (defesa contra corrida clique × contagem): anular o callback e
    // encerrar acontecem ANTES do push. Como o JS é single-thread e
    // `encerrar`→`contagem.encerrar()` torna qualquer tick pendente um no-op, o
    // anúncio não dispara depois do clique.
    const iCallback = corpo.indexOf("__obaflixAnuncioConcluido = undefined");
    const iEncerrar = corpo.indexOf("encerrar(false)");
    const iPush = corpo.indexOf("router.push");
    assert.ok(iCallback < iEncerrar && iEncerrar < iPush, "anula callback e encerra antes de navegar");
  });

  /** Teste 7: o botão é só do Android; o Electron segue com seus próprios botões. */
  test("o botão não entra no convite do Electron", () => {
    const blocoElectron = fonte.slice(inicioElectron);
    assert.equal(blocoElectron.includes("Remover anúncios"), false, "Android-only");
    assert.match(blocoElectron, /Continuar gratuitamente/);
    assert.match(blocoElectron, /Ver planos e remover anúncios/);
  });
});
