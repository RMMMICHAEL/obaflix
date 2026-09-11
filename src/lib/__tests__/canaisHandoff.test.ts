/**
 * O protocolo de handoff do cliente web, testado como protocolo.
 *
 * Espelha `HandoffDeCanalTest.kt`: as duas plataformas têm de se comportar
 * igual, e é aqui que isso fica travado do lado do React/Electron.
 *
 * O relógio e o agendador são injetados — nada dorme de verdade, e ainda assim
 * os testes verificam *quando* cada coisa aconteceria.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  atrasoDeRenovacaoMs,
  criarHandoff,
  type Agenda,
  type ConcessaoDeCanal,
  type ResultadoDePedido,
} from "../canais/handoff";

/** Agendador manual: nada dispara sozinho, o teste decide quando. */
function agendaManual() {
  const tarefas = new Map<number, { fn: () => void; ms: number }>();
  let proximo = 1;
  const agenda: Agenda = {
    agendar: (fn, ms) => {
      const id = proximo++;
      tarefas.set(id, { fn, ms });
      return id;
    },
    cancelar: (id) => void tarefas.delete(id),
  };
  return {
    agenda,
    /** Dispara a tarefa pendente mais recente e devolve o atraso dela. */
    async disparar(): Promise<number> {
      const [id, tarefa] = [...tarefas].at(-1)!;
      tarefas.delete(id);
      tarefa.fn();
      // Deixa as microtasks do `renovar` rodarem.
      await new Promise((r) => setImmediate(r));
      return tarefa.ms;
    },
    pendentes: () => tarefas.size,
  };
}

function concessao(geracao: number, validoPorSegundos = 300): ConcessaoDeCanal {
  return {
    sessionId: "sessao-1",
    manifestUrl: `https://media.example.test/canal/sid/master.m3u8?e=${geracao}&k=sig${geracao}`,
    geracao,
    validoPorSegundos,
    expiraEm: 0,
  };
}

const ok = (g: number, v?: number): ResultadoDePedido => ({ ok: true, concessao: concessao(g, v) });

// ── Migração ─────────────────────────────────────────────────────────────────

test("migra o player a cada renovação, mandando o sessionId", async () => {
  const fontes: string[] = [];
  const sessoes: (string | undefined)[] = [];
  const m = agendaManual();
  let n = 0;

  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async (_id, sessionId) => {
      sessoes.push(sessionId);
      return ok(++n);
    },
    trocarFonte: (url) => void fontes.push(url),
    aoPerder: () => assert.fail("não devia perder"),
    agenda: m.agenda,
  });

  await h.iniciar();
  await m.disparar();
  await m.disparar();

  assert.equal(h.trocas(), 3);
  assert.equal(fontes.length, 3);
  assert.notEqual(fontes[0], fontes[1], "a fonte precisa mudar na renovação");
  assert.notEqual(fontes[1], fontes[2]);
  assert.equal(h.atual()!.manifestUrl, fontes.at(-1));
  // Primeira resolve do zero; as seguintes renovam — é o que evita voltar ao
  // provider.
  assert.deepEqual(sessoes, [undefined, "sessao-1", "sessao-1"]);
});

test("renova bem antes do vencimento", async () => {
  const m = agendaManual();
  let n = 0;
  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async () => ok(++n, 300),
    trocarFonte: () => {},
    aoPerder: () => {},
    agenda: m.agenda,
  });

  await h.iniciar();
  const atraso = await m.disparar();

  assert.equal(atraso, 180_000);
  assert.ok(atraso < 300_000, "a renovação tem de caber com folga");
});

test("o atraso tem piso", () => {
  assert.equal(atrasoDeRenovacaoMs(300), 180_000);
  assert.equal(atrasoDeRenovacaoMs(10), 30_000);
  assert.equal(atrasoDeRenovacaoMs(0), 30_000);
});

// ── Concorrência e ordem de chegada ──────────────────────────────────────────

test("resposta atrasada não faz a geração regredir", async () => {
  // O caso pedido na revisão: a geração mais nova chega primeiro, e depois
  // chega uma antiga. Sem a guarda monotônica, o cliente adotaria a última a
  // chegar e voltaria para uma geração que o servidor já aposentou — cuja URL
  // morre na grace seguinte, com o 403 aparecendo minutos depois.
  const fontes: string[] = [];
  const m = agendaManual();
  const fila = [ok(1), ok(3), ok(2)];

  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async () => fila.shift()!,
    trocarFonte: (url) => void fontes.push(url),
    aoPerder: () => assert.fail("não devia perder"),
    agenda: m.agenda,
  });

  await h.iniciar();
  assert.equal(h.atual()!.geracao, 1);

  await h.renovarAgora();
  assert.equal(h.atual()!.geracao, 3, "a geração 3 tem de ser adotada");

  await h.renovarAgora(); // chega a 2, atrasada
  assert.equal(h.atual()!.geracao, 3, "não pode voltar para a 2");
  assert.equal(h.recusasPorRegressao(), 1);

  // A fonte do player não pode ter sido trocada pela atrasada.
  assert.equal(fontes.length, 2);
  assert.equal(h.trocas(), 2);
  assert.ok(fontes.at(-1)!.includes("e=3"));
});

test("geração repetida não conta como troca", async () => {
  const fontes: string[] = [];
  const m = agendaManual();
  const fila = [ok(1), ok(2), ok(2)];

  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async () => fila.shift()!,
    trocarFonte: (url) => void fontes.push(url),
    aoPerder: () => {},
    agenda: m.agenda,
  });

  await h.iniciar();
  await h.renovarAgora();
  await h.renovarAgora();

  assert.equal(h.atual()!.geracao, 2);
  assert.equal(fontes.length, 2);
  assert.equal(h.recusasPorRegressao(), 1);
});

test("renovações simultâneas gastam um pedido só", async () => {
  // Sem single-flight, o ciclo somado a uma retomada de rede giraria o nonce
  // três vezes à toa — e cada giro encurta a vida da geração anterior.
  let pedidos = 0;
  let abrirPortao: () => void = () => {};
  const portao = new Promise<void>((r) => {
    abrirPortao = r;
  });
  const fontes: string[] = [];
  const m = agendaManual();

  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async (_id, sessionId) => {
      pedidos++;
      if (sessionId) await portao;
      return ok(pedidos);
    },
    trocarFonte: (url) => void fontes.push(url),
    aoPerder: () => {},
    agenda: m.agenda,
  });

  await h.iniciar();
  assert.equal(pedidos, 1);

  // As três disparam antes de qualquer uma resolver: é a concorrência real.
  const tres = [h.renovarAgora(), h.renovarAgora(), h.renovarAgora()];
  abrirPortao();
  await Promise.all(tres);

  assert.equal(pedidos, 2, "três chamadas, um pedido");
  assert.equal(h.trocas(), 2);
  assert.equal(fontes.length, 2);
});

test("três renovações em sequência sobem a geração de 1 até 4", async () => {
  const m = agendaManual();
  let n = 0;
  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async () => ok(++n),
    trocarFonte: () => {},
    aoPerder: () => {},
    agenda: m.agenda,
  });

  await h.iniciar();
  for (let i = 0; i < 3; i++) await m.disparar();

  assert.equal(h.atual()!.geracao, 4);
  assert.equal(h.trocas(), 4);
  assert.equal(h.recusasPorRegressao(), 0);
});

// ── Falhas ───────────────────────────────────────────────────────────────────

test("falha temporária mantém a concessão atual e reagenda", async () => {
  const fontes: string[] = [];
  const m = agendaManual();
  const fila: ResultadoDePedido[] = [ok(1), { ok: false, definitivo: false }, ok(2)];

  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async () => fila.shift()!,
    trocarFonte: (url) => void fontes.push(url),
    aoPerder: () => assert.fail("temporária não pode perder"),
    agenda: m.agenda,
  });

  await h.iniciar();

  const atrasoDaFalha = await m.disparar(); // dispara a renovação, que falha
  assert.equal(atrasoDaFalha, 180_000, "a renovação estava agendada no ritmo normal");
  assert.equal(h.atual()!.geracao, 1, "a concessão atual continua");
  assert.equal(fontes.length, 1, "falha temporária não troca fonte");

  // A nova tentativa fica agendada para a espera curta de falha, e não para o
  // ritmo normal: 30 s cabe de sobra antes de a concessão atual vencer.
  const atrasoDaRetentativa = await m.disparar();
  assert.equal(atrasoDaRetentativa, 30_000);
  assert.equal(h.atual()!.geracao, 2);
  assert.equal(fontes.length, 2);
  // E, dando certo, o ciclo volta ao ritmo normal.
  assert.equal(m.pendentes(), 1);
});

test("recusa definitiva encerra o ciclo e avisa", async () => {
  for (const mensagem of ["Seu plano não inclui este canal.", "Canal indisponível no momento."]) {
    const m = agendaManual();
    const fila: ResultadoDePedido[] = [ok(1), { ok: false, definitivo: true, mensagem }];
    let perdida: string | null = null;

    const h = criarHandoff({
      canalId: "canal-1",
      pedir: async () => fila.shift()!,
      trocarFonte: () => {},
      aoPerder: (msg) => {
        perdida = msg;
      },
      agenda: m.agenda,
    });

    await h.iniciar();
    await m.disparar();

    assert.equal(perdida, mensagem);
    assert.equal(h.trocas(), 1, "a recusa não troca fonte");
    assert.equal(m.pendentes(), 0, "o ciclo não pode continuar agendado");
  }
});

test("parar cancela o agendamento e nada mais roda", async () => {
  const m = agendaManual();
  let pedidos = 0;
  const h = criarHandoff({
    canalId: "canal-1",
    pedir: async () => {
      pedidos++;
      return ok(pedidos);
    },
    trocarFonte: () => {},
    aoPerder: () => {},
    agenda: m.agenda,
  });

  await h.iniciar();
  assert.equal(m.pendentes(), 1);
  h.parar();
  assert.equal(m.pendentes(), 0);
  assert.equal(pedidos, 1);
});
