import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AcaoCancelada,
  ROTA_PLANOS,
  efeitoDoConvite,
  ehAcaoCancelada,
  ehAcaoInterrompida,
  liberarAcao,
  type FinalidadeDeAcao,
} from "../ads/acaoPatrocinada";
import type { PedidoDeAutorizacao, PortasDoFluxo, RespostaDeAutorizacao } from "../ads/fluxoDoCliente";
import { alvoDoPid, mensagemDeFalha, pidDeEpisodio, pidDeFilme, procurarFonteDeDownload } from "../androidMedia";

/**
 * Reproduzir, baixar e transmitir mediante anúncio, do lado do cliente.
 *
 * O que estes testes travam é a **ordem** e o que **não** acontece: a ação
 * protegida só roda depois de o servidor devolver a liberação, e fechar o modal
 * ou ir assinar nunca a executa nem reabre o modal na tentativa seguinte.
 */

const raiz = process.cwd();

const MP4 = { stream: "https://cdn-b.exemplo.com/serie/episodio.mp4", tipo: "mp4" };

function pedido(finalidade: FinalidadeDeAcao): PedidoDeAutorizacao & { finalidade: FinalidadeDeAcao } {
  return { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android", finalidade };
}

function portasFalsas(opcoes: {
  resposta?: RespostaDeAutorizacao;
  concluido?: boolean;
  concessao?: string | null;
  passos: string[];
}): { portas: PortasDoFluxo; pedidos: PedidoDeAutorizacao[] } {
  const pedidos: PedidoDeAutorizacao[] = [];
  return {
    pedidos,
    portas: {
      async autorizar(p) {
        pedidos.push(p);
        opcoes.passos.push(`autorizar:${p.finalidade ?? "reproducao"}`);
        return opcoes.resposta ?? { decisao: "PERMITIDO" };
      },
      async exibirAnuncio() {
        opcoes.passos.push("exibir");
        return { concluido: opcoes.concluido ?? true };
      },
      async concluir() {
        opcoes.passos.push("concluir");
        return opcoes.concessao === undefined ? "concessao-1" : opcoes.concessao;
      },
    },
  };
}

const ANUNCIO: RespostaDeAutorizacao = { decisao: "ANUNCIO_NECESSARIO", desafioId: "d1" };

describe("download grátis", () => {
  test("exige anúncio e retoma a procura sozinho depois da conclusão", async () => {
    const passos: string[] = [];
    const { portas } = portasFalsas({ resposta: ANUNCIO, concessao: "c-download", passos });

    const r = await procurarFonteDeDownload({
      resolverFonte: async (tentativa: number) => {
        if (tentativa === 0) {
          const c = await liberarAcao(pedido("download"), portas);
          passos.push(`sessao:${c}`);
        }
        return tentativa === 0 ? MP4 : null;
      },
      sondar: async () => {
        passos.push("sondar");
        return { ok: true, sondagemId: "s1" };
      },
    });

    assert.equal(r.ok, true);
    assert.deepEqual(passos, ["autorizar:download", "exibir", "concluir", "sessao:c-download", "sondar"],
      "sem clique extra: concluído o anúncio, a procura continua e chega à sondagem");
  });

  test("anúncio não transforma HLS em download: continua indisponível", async () => {
    const passos: string[] = [];
    const { portas } = portasFalsas({ resposta: ANUNCIO, passos });
    const r = await procurarFonteDeDownload({
      resolverFonte: async (tentativa: number) => {
        if (tentativa === 0) await liberarAcao(pedido("download"), portas);
        return tentativa === 0 ? { stream: "https://cdn-a.exemplo.com/x/master.m3u8", tipo: "hls" } : null;
      },
      sondar: async () => {
        passos.push("sondar");
        return { ok: true };
      },
    });
    assert.deepEqual(r, { ok: false, motivo: "download_indisponivel" });
    assert.equal(passos.includes("sondar"), false);
  });

  test("fechar no X não chama a ação protegida nem reabre o modal", async () => {
    const passos: string[] = [];
    const { portas } = portasFalsas({ resposta: ANUNCIO, concluido: false, passos });
    let resolucoes = 0;

    const r = await procurarFonteDeDownload({
      resolverFonte: async () => {
        resolucoes++;
        await liberarAcao(pedido("download"), portas);
        return MP4;
      },
      sondar: async () => {
        passos.push("sondar");
        return { ok: true };
      },
    });

    assert.deepEqual(r, { ok: false, motivo: "cancelado" });
    assert.equal(resolucoes, 1, "cancelar encerra a procura: nenhuma tentativa seguinte, nenhum modal novo");
    assert.equal(passos.includes("sondar"), false);
    assert.equal(passos.filter((p) => p === "exibir").length, 1);
  });
});

describe("transmissão grátis", () => {
  test("exige anúncio e continua o requestCast sozinho depois da conclusão", async () => {
    const passos: string[] = [];
    const { portas, pedidos } = portasFalsas({ resposta: ANUNCIO, concessao: "c-cast", passos });

    const concessao = await liberarAcao(pedido("transmissao"), portas);
    passos.push(`requestCast:${concessao}`);

    assert.deepEqual(passos, ["autorizar:transmissao", "exibir", "concluir", "requestCast:c-cast"]);
    assert.equal(pedidos[0].finalidade, "transmissao", "a finalidade chega ao servidor sem ser trocada");
  });

  test("fechar no X não transmite", async () => {
    const passos: string[] = [];
    const { portas } = portasFalsas({ resposta: ANUNCIO, concluido: false, passos });
    await assert.rejects(liberarAcao(pedido("transmissao"), portas), (e) => ehAcaoCancelada(e));
    assert.equal(passos.includes("concluir"), false);
  });
});

describe("convite do modal", () => {
  test("Assinar um plano cancela a ação e só depois navega para a escolha de planos", () => {
    assert.deepEqual(efeitoDoConvite("assinar"), {
      exibirAnuncio: false,
      cancelarAcao: true,
      navegarPara: ROTA_PLANOS,
    });
    assert.equal(ROTA_PLANOS, "/planos", "o CTA leva à escolha, sem pré-selecionar Premium");
  });

  test("Assinar um plano não executa a ação protegida", async () => {
    const passos: string[] = [];
    // O modal resolve a exibição como não concluída quando a pessoa vai assinar.
    const { portas } = portasFalsas({ resposta: ANUNCIO, concluido: false, passos });
    let executou = false;
    try {
      await liberarAcao(pedido("download"), portas);
      executou = true;
    } catch (e) {
      assert.ok(e instanceof AcaoCancelada || ehAcaoCancelada(e));
    }
    assert.equal(executou, false);
  });

  test("fechar cancela sem navegar; só assistir exibe", () => {
    assert.deepEqual(efeitoDoConvite("fechar"), { exibirAnuncio: false, cancelarAcao: true, navegarPara: null });
    assert.deepEqual(efeitoDoConvite("assistir"), { exibirAnuncio: true, cancelarAcao: false, navegarPara: null });
  });

  test("o modal tem Assistir anúncio, Assinar um plano e X; não tem Agora não", () => {
    const hook = readFileSync(join(raiz, "src/components/player/useAnuncio.tsx"), "utf8");
    assert.ok(hook.includes("Assista a um anúncio"));
    assert.ok(hook.includes("Assistir anúncio"));
    assert.ok(hook.includes("Assinar um plano"));
    assert.match(hook, /aria-label="Fechar"/);
    assert.equal(hook.includes("Agora não"), false, "o convite não oferece mais Agora não");
  });
});

describe("quem não precisa de anúncio", () => {
  test("assinante sem anúncios não vê modal: a ação segue direto", async () => {
    const passos: string[] = [];
    const { portas } = portasFalsas({ resposta: { decisao: "PERMITIDO" }, passos });
    for (const finalidade of ["reproducao", "download", "transmissao"] as const) {
      assert.equal(await liberarAcao(pedido(finalidade), portas), null);
    }
    assert.equal(passos.includes("exibir"), false);
  });

  test("episódio dentro da cota segue sem modal com o passe do servidor", async () => {
    const passos: string[] = [];
    const { portas } = portasFalsas({ resposta: { decisao: "PERMITIDO", passe: "passe-1" }, passos });
    assert.equal(await liberarAcao(pedido("reproducao"), portas), "passe-1");
    assert.equal(passos.includes("exibir"), false);
  });
});

describe("falha comercial não vira falha de mídia", () => {
  test("anúncio indisponível interrompe com motivo próprio", async () => {
    const passos: string[] = [];
    const { portas } = portasFalsas({ resposta: { decisao: "ANUNCIO_INDISPONIVEL" }, passos });
    await assert.rejects(
      liberarAcao(pedido("download"), portas),
      (e) => ehAcaoInterrompida(e) && e.motivo === "anuncio_indisponivel",
    );
  });

  test("as mensagens comerciais não falam de servidor nem de mídia", () => {
    for (const motivo of ["anuncio_indisponivel", "acao_nao_liberada"]) {
      const texto = mensagemDeFalha(motivo);
      assert.ok(texto !== mensagemDeFalha("desconhecido_xyz"), `${motivo} precisa de mensagem própria`);
      assert.ok(!/servidor|m[ií]dia/i.test(texto), `${motivo}: ${texto}`);
    }
  });
});

describe("o conteúdo da ação sai do pid", () => {
  test("filme e episódio voltam do pid sem perda", () => {
    assert.deepEqual(alvoDoPid(pidDeFilme("842")), { tipo: "filme", conteudoId: "842" });
    assert.deepEqual(alvoDoPid(pidDeEpisodio("12", 2, 7)), {
      tipo: "serie",
      conteudoId: "12",
      temporada: 2,
      numeroEp: 7,
    });
  });

  test("pid inesperado não vira conteúdo", () => {
    for (const pid of ["", "filme:", "serie:12:t2", "serie:12:tX:e1", "outro:1", null, undefined]) {
      assert.equal(alvoDoPid(pid), null, String(pid));
    }
  });
});

describe("recusa comercial encerra a procura de download", () => {
  test("ação não liberada não tenta o próximo servidor nem sonda", async () => {
    let resolucoes = 0;
    let sondagens = 0;
    const r = await procurarFonteDeDownload({
      resolverFonte: async () => {
        resolucoes++;
        throw Object.assign(new Error("x"), { name: "AcaoInterrompida", motivo: "acao_nao_liberada" });
      },
      sondar: async () => {
        sondagens++;
        return { ok: true };
      },
    });
    assert.deepEqual(r, { ok: false, motivo: "acao_nao_liberada" });
    assert.equal(resolucoes, 1);
    assert.equal(sondagens, 0);
  });
});

describe("enforcement de download e transmissão fica no servidor", () => {
  const rota = readFileSync(join(raiz, "src/app/api/player/fontes/route.ts"), "utf8");
  const acoes = readFileSync(join(raiz, "src/components/android/AndroidMediaActions.tsx"), "utf8");
  const fora = readFileSync(join(raiz, "src/components/android/useFonteParaMidia.ts"), "utf8");

  test("a ação sobre a sessão em curso consome a concessão antes de responder", () => {
    const inicio = rota.indexOf("corpo.acao === true");
    assert.ok(inicio > -1, "/fontes precisa do ramo de ação");
    const trecho = rota.slice(inicio, rota.indexOf("corpo.alternativas === true"));
    const finalidade = trecho.indexOf('finalidade !== "download" && finalidade !== "transmissao"');
    const sessao = trecho.indexOf("diagnosticarSessao(sessao, userId)");
    const consumo = trecho.indexOf("autorizarPorAnuncio(");
    const liberado = trecho.indexOf("liberado: true");
    assert.ok(finalidade > -1 && sessao > -1 && consumo > -1 && liberado > -1);
    assert.ok(finalidade < consumo && sessao < consumo && consumo < liberado);
  });

  test("fora do player a sessão da ação nasce com finalidade e concessão", () => {
    assert.ok(fora.includes("await liberar(finalidade)"));
    assert.ok(fora.indexOf("await liberar(finalidade)") < fora.indexOf('fetch("/api/player/fontes"'));
    assert.ok(fora.includes("finalidade,"));
    assert.ok(fora.includes("{ concessao }"));
  });

  test("os botões pedem cada finalidade separadamente e desenham o convite", () => {
    assert.ok(acoes.includes('resolverFonte(tentativa, "download", liberar)'));
    assert.ok(acoes.includes('resolverFonte(tentativa, "transmissao", liberar)'));
    assert.ok(acoes.includes("<ModalDeAnuncio"));
    assert.ok(acoes.includes('resultado.motivo === "cancelado"'));
    assert.ok(acoes.includes("ehAcaoCancelada(erro)"));
  });
});
