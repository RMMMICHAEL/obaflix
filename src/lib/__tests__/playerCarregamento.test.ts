// Carregamento inicial do player: a tela de carregamento cobre toda a carga, e
// erro de uma fonte só aparece quando não existe mais recuperação pendente.
// Lógica pura, sem rede. Vale para Website, Electron e Android.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  passoDoCarregamentoInicial,
  telaDoPlayer,
  type StatusDoPlayer,
  type TelaDoPlayer,
} from "../playerCarregamento";
import { LIMITES } from "../playerFailover";

/**
 * Uma montagem do player reduzida ao que decide a tela: os mesmos campos que o
 * CustomPlayer guarda, e o mesmo laço que o efeito dele roda a cada mudança.
 */
function montarPlayer(totalInicial = 0) {
  const p = {
    carregamentoInicial: true,
    status: "idle" as StatusDoPlayer,
    nativo: false,
    autoPlayBlocked: false,
    indiceDaFonte: 0,
    totalDeFontes: totalInicial,
    sessaoPendente: true,
    alternativasPendentes: false,
    erroTerminal: false,
    escolhaManual: false,
    failoversUsados: 0,
    trocas: 0,
    telas: [] as TelaDoPlayer[],
  };

  const tela = () => telaDoPlayer(p);

  /** O efeito do CustomPlayer: aplica o passo e registra o que ficou visível. */
  const reagir = () => {
    p.telas.push(tela());
    const passo = passoDoCarregamentoInicial({ ...p, tetoDeFailovers: LIMITES.FAILOVERS_ANTES_FIRSTFRAME });
    if (passo === "concluir" || passo === "encerrar_com_erro") p.carregamentoInicial = false;
    if (passo === "trocar_fonte") {
      p.failoversUsados += 1;
      p.trocas += 1;
      p.indiceDaFonte += 1;
      p.status = "idle"; // switchFonte
      p.telas.push(tela());
      p.status = "extracting"; // o efeito de extração da nova fonte
    }
    p.telas.push(tela());
  };

  return {
    p,
    tela,
    sessaoAberta(total: number, alternativasPendentes = false) {
      p.sessaoPendente = false;
      p.totalDeFontes = total;
      p.alternativasPendentes = alternativasPendentes;
      p.status = "extracting";
      reagir();
    },
    fonteFalhou() {
      p.status = "error";
      reagir();
    },
    alternativasChegaram(total: number) {
      p.totalDeFontes = total;
      p.alternativasPendentes = false;
      reagir();
    },
    midiaCarregando() {
      p.status = "loading";
      reagir();
    },
    midiaPronta() {
      p.status = "playing";
      reagir();
    },
  };
}

describe("carregamento inicial do player", () => {
  test("a montagem já começa na tela de carregamento, antes da sessão e do anúncio", () => {
    const player = montarPlayer();
    assert.equal(player.tela(), "carregando");
    // Sem fontes ainda, a tela antiga mostrava "Nenhuma fonte disponível".
    assert.notEqual(player.tela(), "sem_fontes");
  });

  test("primeira fonte falha com fallback: continua carregando e não mostra erro", () => {
    const player = montarPlayer();
    player.sessaoAberta(3);
    player.fonteFalhou();
    assert.equal(player.p.indiceDaFonte, 1, "tentou a próxima fonte");
    assert.equal(player.p.carregamentoInicial, true);
    assert.ok(!player.p.telas.includes("erro"), `telas: ${player.p.telas.join(",")}`);
    assert.ok(!player.p.telas.includes("midia"), "o player vazio não pisca entre as fontes");
  });

  test("segunda fonte entra: o carregamento segue até a mídia ficar pronta", () => {
    const player = montarPlayer();
    player.sessaoAberta(3);
    player.fonteFalhou();
    player.midiaCarregando();
    assert.equal(player.tela(), "carregando");
    player.midiaPronta();
    assert.equal(player.tela(), "midia");
    assert.equal(player.p.carregamentoInicial, false);
    assert.ok(!player.p.telas.includes("erro"));
  });

  test("todas as fontes falham: só então aparece o erro terminal", () => {
    const player = montarPlayer();
    player.sessaoAberta(3);
    player.fonteFalhou(); // fonte 1 → 2
    assert.notEqual(player.tela(), "erro");
    player.fonteFalhou(); // fonte 2 → 3
    assert.notEqual(player.tela(), "erro");
    assert.ok(!player.p.telas.includes("erro"), "nenhum erro antes da última fonte");
    player.fonteFalhou(); // fonte 3: acabou
    assert.equal(player.tela(), "erro");
    assert.equal(player.p.carregamentoInicial, false);
    assert.equal(player.p.trocas, 2);
  });

  test("última fonte falha com alternativas a caminho: espera a lista crescer", () => {
    const player = montarPlayer();
    player.sessaoAberta(1, true);
    player.fonteFalhou();
    assert.equal(player.tela(), "carregando");
    assert.equal(player.p.trocas, 0);
    player.alternativasChegaram(3);
    assert.equal(player.p.indiceDaFonte, 1, "a fonte nova é tentada");
    assert.equal(player.tela(), "carregando");
    assert.ok(!player.p.telas.includes("erro"));
  });

  test("alternativas chegam vazias: a falha pendente vira erro, sem ficar presa", () => {
    const player = montarPlayer();
    player.sessaoAberta(1, true);
    player.fonteFalhou();
    player.alternativasChegaram(1);
    assert.equal(player.tela(), "erro");
  });

  test("falha de uma sessão que está sendo reaberta não aparece", () => {
    const player = montarPlayer();
    player.fonteFalhou(); // extração antiga em voo, sessão nova ainda pendente
    assert.equal(player.tela(), "carregando");
    assert.equal(player.p.carregamentoInicial, true);
  });

  test("falha terminal por natureza aparece na hora", () => {
    const player = montarPlayer();
    player.p.erroTerminal = true;
    player.p.sessaoPendente = false;
    player.fonteFalhou();
    assert.equal(player.tela(), "erro");
    assert.equal(player.p.carregamentoInicial, false);
  });

  test("o teto de failover antes do primeiro frame continua valendo", () => {
    const total = LIMITES.FAILOVERS_ANTES_FIRSTFRAME + 5;
    const player = montarPlayer();
    player.sessaoAberta(total);
    for (let i = 0; i < total && player.p.carregamentoInicial; i++) player.fonteFalhou();
    assert.equal(player.p.trocas, LIMITES.FAILOVERS_ANTES_FIRSTFRAME);
    assert.equal(player.tela(), "erro");
  });

  test("escolha manual não é atropelada pelo failover automático", () => {
    assert.equal(
      passoDoCarregamentoInicial({
        carregamentoInicial: true,
        status: "error",
        indiceDaFonte: 0,
        totalDeFontes: 3,
        sessaoPendente: false,
        alternativasPendentes: false,
        erroTerminal: false,
        escolhaManual: true,
        failoversUsados: 0,
        tetoDeFailovers: LIMITES.FAILOVERS_ANTES_FIRSTFRAME,
      }),
      "encerrar_com_erro",
    );
  });

  test("depois da primeira mídia pronta, as telas são as de antes", () => {
    const base = { carregamentoInicial: false, nativo: false, autoPlayBlocked: false, totalDeFontes: 2, erroTerminal: false };
    assert.equal(telaDoPlayer({ ...base, status: "error" }), "erro");
    assert.equal(telaDoPlayer({ ...base, status: "extracting" }), "carregando");
    assert.equal(telaDoPlayer({ ...base, status: "loading" }), "carregando");
    assert.equal(telaDoPlayer({ ...base, status: "loading", nativo: true }), "buffer_nativo");
    assert.equal(telaDoPlayer({ ...base, status: "loading", nativo: true, autoPlayBlocked: true }), "midia");
    assert.equal(telaDoPlayer({ ...base, status: "idle", totalDeFontes: 0 }), "sem_fontes");
    assert.equal(telaDoPlayer({ ...base, status: "playing" }), "midia");
  });
});

describe("o CustomPlayer desenha a tela pelo estado de carregamento", () => {
  const player = readFileSync(join(process.cwd(), "src/components/player/CustomPlayer.tsx"), "utf8");

  test("o carregamento inicial nasce verdadeiro", () => {
    assert.ok(player.includes("const [carregamentoInicial, setCarregamentoInicial] = useState(true);"));
  });

  test("os overlays de estado saem de telaDoPlayer, não de status solto", () => {
    assert.ok(player.includes("const tela = telaDoPlayer({"));
    for (const t of ['tela === "carregando"', 'tela === "buffer_nativo"', 'tela === "erro"', 'tela === "sem_fontes"']) {
      assert.ok(player.includes(t), t);
    }
    assert.ok(!player.includes('{status === "error" && ('), "erro não pode ser desenhado direto do status");
    assert.ok(!player.includes('{status === "idle" && allFontes.length === 0 && ('));
  });

  test("o efeito do carregamento aplica o passo decidido", () => {
    assert.ok(player.includes("passoDoCarregamentoInicial({"));
    assert.ok(player.includes('passo === "trocar_fonte"'));
    assert.ok(player.includes('passo === "encerrar_com_erro"'));
  });
});
