import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  executarFluxoDeAnuncio,
  type PedidoDeAutorizacao,
  type PortasDoFluxo,
  type RespostaDeAutorizacao,
} from "../ads/fluxoDoCliente";

/**
 * A sequência do cliente, sem React e sem DOM.
 *
 * O que ela prova é o encadeamento — autorizar, exibir, concluir, devolver a
 * concessão — e, sobretudo, o que **não** acontece: o cliente nunca inventa uma
 * liberação quando o servidor não respondeu o que ele esperava.
 */

const raiz = process.cwd();

const PEDIDO: PedidoDeAutorizacao = {
  conteudoId: "filme-1",
  conteudoTipo: "filme",
  plataforma: "electron",
};

interface Registro {
  autorizou: number;
  exibiu: { plataforma: string; desafioId: string; directLink?: string }[];
  concluiu: { desafioId: string; concluido: boolean }[];
}

function portasFalsas(opcoes: {
  resposta?: RespostaDeAutorizacao | Error;
  exibicao?: { concluido: boolean } | Error;
  concessao?: string | null | Error;
}): { portas: PortasDoFluxo; reg: Registro } {
  const reg: Registro = { autorizou: 0, exibiu: [], concluiu: [] };

  return {
    reg,
    portas: {
      async autorizar() {
        reg.autorizou++;
        if (opcoes.resposta instanceof Error) throw opcoes.resposta;
        return opcoes.resposta ?? { decisao: "PERMITIDO" };
      },
      async exibirAnuncio(e) {
        reg.exibiu.push(e);
        if (opcoes.exibicao instanceof Error) throw opcoes.exibicao;
        return opcoes.exibicao ?? { concluido: true };
      },
      async concluir(e) {
        reg.concluiu.push(e);
        if (opcoes.concessao instanceof Error) throw opcoes.concessao;
        return opcoes.concessao === undefined ? "concessao-1" : opcoes.concessao;
      },
    },
  };
}

describe("PERMITIDO segue direto", () => {
  /** Cenário 1 e 13 do lado do cliente: assinante não vê nada de anúncio. */
  test("não exibe anúncio e não pede concessão", async () => {
    const { portas, reg } = portasFalsas({ resposta: { decisao: "PERMITIDO" } });

    const r = await executarFluxoDeAnuncio(PEDIDO, portas);

    assert.deepEqual(r, { situacao: "liberado", concessao: null });
    assert.equal(reg.exibiu.length, 0, "nenhum anúncio pode ser exibido");
    assert.equal(reg.concluiu.length, 0);
  });
});

describe("ANUNCIO_NECESSARIO exibe e conclui", () => {
  test("o caminho completo devolve a concessão do servidor", async () => {
    const { portas, reg } = portasFalsas({
      resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1", directLink: "https://rede.invalido/x" },
    });

    const r = await executarFluxoDeAnuncio(PEDIDO, portas);

    assert.deepEqual(r, { situacao: "liberado", concessao: "concessao-1" });
    assert.deepEqual(reg.exibiu, [
      { plataforma: "electron", desafioId: "d1", directLink: "https://rede.invalido/x" },
    ]);
    assert.deepEqual(reg.concluiu, [{ desafioId: "d1", concluido: true }]);
  });

  /**
   * Cenário 14: o Direct Link só chega quando o servidor manda. No Android o
   * campo simplesmente não existe na resposta, e o fluxo não o inventa.
   */
  test("sem directLink na resposta, nada é passado à exibição", async () => {
    const { portas, reg } = portasFalsas({
      resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" },
    });

    await executarFluxoDeAnuncio({ ...PEDIDO, plataforma: "android" }, portas);

    assert.equal(reg.exibiu[0].directLink, undefined);
  });

  /** Desistir é escolha, não erro — e não pede concessão. */
  test("usuário que não conclui devolve cancelado", async () => {
    const { portas, reg } = portasFalsas({
      resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" },
      exibicao: { concluido: false },
    });

    const r = await executarFluxoDeAnuncio(PEDIDO, portas);

    assert.deepEqual(r, { situacao: "cancelado" });
    assert.equal(reg.concluiu.length, 0, "não se pede concessão de anúncio não visto");
  });

  /** O servidor recusou a conclusão — cedo demais, desafio inválido, 429. */
  test("servidor que não emite concessão não libera", async () => {
    const { portas } = portasFalsas({
      resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" },
      concessao: null,
    });

    assert.deepEqual(await executarFluxoDeAnuncio(PEDIDO, portas), { situacao: "falhou" });
  });
});

describe("o cliente nunca inventa liberação", () => {
  /**
   * Uma resposta que não é nenhuma das duas — servidor mais novo, proxy no meio,
   * HTML de erro — não pode virar "pode assistir". É o tipo de fallback que
   * abriria o conteúdo justamente quando algo está errado.
   */
  test("decisão desconhecida falha, não libera", async () => {
    for (const resposta of [
      {},
      { decisao: "TALVEZ" },
      { decisao: null },
      { decisao: "PERMITIDO_" },
    ] as RespostaDeAutorizacao[]) {
      const { portas } = portasFalsas({ resposta });
      const r = await executarFluxoDeAnuncio(PEDIDO, portas);
      assert.equal(r.situacao, "falhou", JSON.stringify(resposta));
    }
  });

  test("ANUNCIO_NECESSARIO sem desafioId falha", async () => {
    const { portas, reg } = portasFalsas({ resposta: { decisao: "ANUNCIO_NECESSARIO" } });

    assert.deepEqual(await executarFluxoDeAnuncio(PEDIDO, portas), { situacao: "falhou" });
    assert.equal(reg.exibiu.length, 0);
  });

  test("plataforma nula (Web) não entra no fluxo de exibição", async () => {
    const { portas, reg } = portasFalsas({
      resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" },
    });

    const r = await executarFluxoDeAnuncio({ ...PEDIDO, plataforma: null }, portas);

    assert.equal(r.situacao, "falhou");
    assert.equal(reg.exibiu.length, 0);
  });

  test("erro de rede em qualquer etapa falha fechado", async () => {
    const erro = new Error("rede");

    for (const opcoes of [
      { resposta: erro },
      { resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" } as RespostaDeAutorizacao, exibicao: erro },
      { resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" } as RespostaDeAutorizacao, concessao: erro },
    ]) {
      const { portas } = portasFalsas(opcoes);
      assert.deepEqual(await executarFluxoDeAnuncio(PEDIDO, portas), { situacao: "falhou" });
    }
  });
});

describe("o player pergunta antes de abrir sessão", () => {
  const player = readFileSync(join(raiz, "src/components/player/CustomPlayer.tsx"), "utf8");
  const codigo = player
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  /**
   * A ordem é o que importa: se `/fontes` for chamado antes do fluxo, a sessão
   * nasce sem concessão e o servidor recusa — o usuário veria erro em vez de
   * anúncio.
   */
  test("o fluxo roda antes do fetch de /fontes", () => {
    // Medido dentro de `abrirSessao`: outras chamadas a /fontes (download e
    // transmissão sobre a sessão em curso) têm a própria liberação, conferida abaixo.
    const inicio = codigo.indexOf("const abrirSessao = useCallback(");
    assert.ok(inicio > -1);
    const trecho = codigo.slice(inicio);
    const fluxo = trecho.indexOf("await executarFluxoDeAnuncio(");
    const fontes = trecho.indexOf('await fetch("/api/player/fontes"');
    assert.ok(fluxo > -1 && fontes > -1);
    assert.ok(fluxo < fontes, "o anúncio precisa ser resolvido antes de abrir a sessão");
  });

  test("download e transmissão no player liberam a ação antes de reservar em /fontes", () => {
    const inicio = codigo.indexOf("const fonteAtualParaMidia = useCallback(");
    assert.ok(inicio > -1);
    const trecho = codigo.slice(inicio);
    const liberacao = trecho.indexOf("await liberar(finalidade)");
    const fontes = trecho.indexOf('await fetch("/api/player/fontes"');
    assert.ok(liberacao > -1 && fontes > -1);
    assert.ok(liberacao < fontes, "a ação precisa ser liberada antes de consumir a concessão");
    assert.match(trecho.slice(0, trecho.indexOf("expiresAt: streamExpiresAtRef.current")), /acao: true,\s*finalidade,/);
  });

  test("a concessão é encaminhada ao criar a sessão", () => {
    assert.match(codigo, /fluxo\.concessao \? \{ concessao: fluxo\.concessao \}/);
  });

  /** O player não decide nada de comercial: só encaminha o que o servidor disse. */
  test("o player não decide anúncio por conta própria", () => {
    for (const proibido of [
      "anunciosObrigatorios",
      "episodiosPorAnuncio",
      "planoId",
      '"premium"',
      '"gratuito"',
    ]) {
      assert.equal(codigo.includes(proibido), false, `${proibido} não pertence ao player`);
    }
  });

  /**
   * O Electron abre o Direct Link pelo caminho que já existia para links
   * externos — `setWindowOpenHandler` no main, que só aceita `https:` e manda ao
   * navegador do sistema. Nenhuma ponte nova, nenhum `nodeIntegration`.
   */
  test("o Direct Link usa a ponte restrita do Electron", () => {
    const hook = readFileSync(join(raiz, "src/components/player/useAnuncio.tsx"), "utf8");
    assert.match(hook, /\.openSponsoredLink\(entrada\.directLink\)/);

    // Sem comentários: o cabeçalho do hook cita `nodeIntegration` e
    // `contextIsolation` exatamente para dizer que não os toca, e leria como se
    // tocasse.
    const codigoHook = hook
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

    for (const proibido of ["nodeIntegration", "require(", "ipcRenderer", "contextIsolation"]) {
      assert.equal(codigoHook.includes(proibido), false, `${proibido} não pode aparecer no hook`);
    }
  });

  /**
   * Cenário 16, do lado do cliente: a ponte Android recebe o `desafioId` que o
   * **servidor** emitiu, e a conclusão só é aceita para aquele desafio. Uma
   * callback tardia de outro pedido não libera nada.
   */
  test("a ponte Android é mínima e amarrada ao desafio do servidor", () => {
    const hook = readFileSync(join(raiz, "src/components/player/useAnuncio.tsx"), "utf8");
    assert.match(hook, /mostrarAnuncio\(capability, entrada\.desafioId\)/);
    assert.match(hook, /if \(desafioId !== entrada\.desafioId\) return;/);
  });
});

describe("passe de cota e finalidade", () => {
  test("PERMITIDO com passe devolve o passe para a sessão, sem exibir anúncio", async () => {
    const { portas, reg } = portasFalsas({ resposta: { decisao: "PERMITIDO", passe: "passe-1" } });

    assert.deepEqual(await executarFluxoDeAnuncio(PEDIDO, portas), {
      situacao: "liberado",
      concessao: "passe-1",
    });
    assert.equal(reg.exibiu.length, 0);
  });

  test("passe vazio ou de tipo errado não vira concessão inventada", async () => {
    for (const passe of ["", 42, null, {}]) {
      const { portas } = portasFalsas({ resposta: { decisao: "PERMITIDO", passe } as RespostaDeAutorizacao });
      assert.deepEqual(await executarFluxoDeAnuncio(PEDIDO, portas), { situacao: "liberado", concessao: null });
    }
  });

  test("a finalidade vai ao servidor e ao modal", async () => {
    const pedidos: PedidoDeAutorizacao[] = [];
    const { portas, reg } = portasFalsas({ resposta: { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" } });
    const autorizar = portas.autorizar;
    portas.autorizar = async (p) => {
      pedidos.push(p);
      return autorizar(p);
    };

    await executarFluxoDeAnuncio({ ...PEDIDO, plataforma: "android", finalidade: "download" }, portas);

    assert.equal(pedidos[0].finalidade, "download");
    assert.equal((reg.exibiu[0] as { finalidade?: string }).finalidade, "download");
  });

  test("o player pede reprodução e trata recusa comercial sem mensagem de mídia", () => {
    const player = readFileSync(join(raiz, "src/components/player/CustomPlayer.tsx"), "utf8");
    assert.match(player, /finalidade: "reproducao"/);
    assert.ok(player.includes('e?.name === "LiberacaoComercial"'));
    assert.equal(player.includes("A reprodução precisa de um anúncio para começar."), false,
      "fechar o convite volta ao estado anterior, sem tela de erro");
  });
});
