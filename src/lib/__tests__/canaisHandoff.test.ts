/**
 * O controle de reprodução de canal do cliente web, testado como protocolo.
 *
 * O foco é a garantia que sustenta a arquitetura direta (`/play → streamUrl →
 * device`): **re-resolução controlada em erro, sem laço infinito**. O relógio e o
 * agendador são injetados — nada dorme de verdade, e ainda assim os testes
 * verificam o teto por janela deslizante e o single-flight.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  criarControleDeCanal,
  type Agenda,
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
    async disparar(): Promise<number> {
      const [id, tarefa] = [...tarefas].at(-1)!;
      tarefas.delete(id);
      tarefa.fn();
      await new Promise((r) => setImmediate(r));
      return tarefa.ms;
    },
    pendentes: () => tarefas.size,
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const ok = (url: string): ResultadoDePedido => ({ ok: true, streamUrl: url });

// ── Abertura e re-resolução ───────────────────────────────────────────────────

test("abertura toca a streamUrl e não pede re-resolução", async () => {
  const fontes: string[] = [];
  const reres: boolean[] = [];
  const m = agendaManual();
  let n = 0;

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async (_id, r) => {
      reres.push(r);
      return ok(`u${++n}`);
    },
    trocarFonte: (u) => void fontes.push(u),
    aoPerder: () => assert.fail("não devia perder"),
    agenda: m.agenda,
  });

  await c.iniciar();

  assert.deepEqual(reres, [false], "a abertura não é re-resolução");
  assert.deepEqual(fontes, ["u1"]);
  assert.equal(c.fonteAtual(), "u1");
  assert.equal(c.reresolucoes(), 0);
});

test("erro de reprodução re-resolve com reresolucao=true e troca a fonte", async () => {
  const fontes: string[] = [];
  const reres: boolean[] = [];
  const m = agendaManual();
  let n = 0;

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async (_id, r) => {
      reres.push(r);
      return ok(`u${++n}`);
    },
    trocarFonte: (u) => void fontes.push(u),
    aoPerder: () => assert.fail("não devia perder"),
    agenda: m.agenda,
  });

  await c.iniciar();
  c.aoErroDeReproducao();
  await tick();

  assert.deepEqual(reres, [false, true]);
  assert.equal(c.fonteAtual(), "u2");
  assert.deepEqual(fontes, ["u1", "u2"]);
  assert.equal(c.reresolucoes(), 1);
});

// ── Teto: sem laço infinito ───────────────────────────────────────────────────

test("teto: no máximo N re-resoluções na janela, depois perde", async () => {
  let perdeu: string | null = null;
  const m = agendaManual();

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async (_id, r) => (r ? ok("nova") : ok("inicial")),
    trocarFonte: () => {},
    aoPerder: (msg) => {
      perdeu = msg;
    },
    agenda: m.agenda,
    maxReresolucoes: 3,
    janelaS: 60,
    agora: () => 1000, // relógio parado: tudo cai na mesma janela
  });

  await c.iniciar();
  for (let i = 0; i < 5; i++) {
    c.aoErroDeReproducao();
    await tick();
  }

  assert.equal(c.reresolucoes(), 3, "não passa do teto — é o fim do laço");
  assert.ok(perdeu, "estourado o teto, tem de perder");

  // Depois de perder, novos erros não fazem mais nada.
  c.aoErroDeReproducao();
  await tick();
  assert.equal(c.reresolucoes(), 3);
});

test("a janela desliza: passado o intervalo, re-resolve de novo", async () => {
  let relogio = 0;
  const m = agendaManual();
  let perdeu = false;

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async (_id, r) => (r ? ok("nova") : ok("inicial")),
    trocarFonte: () => {},
    aoPerder: () => {
      perdeu = true;
    },
    agenda: m.agenda,
    maxReresolucoes: 2,
    janelaS: 60,
    agora: () => relogio,
  });

  await c.iniciar();
  c.aoErroDeReproducao();
  await tick();
  c.aoErroDeReproducao();
  await tick();
  assert.equal(c.reresolucoes(), 2);

  // Avança além da janela: os carimbos antigos saem da conta.
  relogio = 61_000;
  c.aoErroDeReproducao();
  await tick();

  assert.equal(c.reresolucoes(), 3, "fora da janela, re-resolve sem estourar");
  assert.equal(perdeu, false);
});

// ── Falhas ────────────────────────────────────────────────────────────────────

test("recusa definitiva na re-resolução encerra e avisa", async () => {
  const m = agendaManual();
  let perdeu: string | null = null;
  const fila: ResultadoDePedido[] = [
    ok("inicial"),
    { ok: false, definitivo: true, mensagem: "Seu plano não inclui este canal." },
  ];

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async () => fila.shift()!,
    trocarFonte: () => {},
    aoPerder: (msg) => {
      perdeu = msg;
    },
    agenda: m.agenda,
  });

  await c.iniciar();
  c.aoErroDeReproducao();
  await tick();

  assert.equal(perdeu, "Seu plano não inclui este canal.");
  assert.equal(m.pendentes(), 0, "não pode ficar nada agendado");
  // Encerrado: mais erros não disparam pedido.
  c.aoErroDeReproducao();
  await tick();
  assert.equal(c.reresolucoes(), 1);
});

test("falha temporária reagenda e recupera, ainda sob o teto", async () => {
  const fontes: string[] = [];
  const m = agendaManual();
  const fila: ResultadoDePedido[] = [ok("inicial"), { ok: false, definitivo: false }, ok("nova")];

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async () => fila.shift()!,
    trocarFonte: (u) => void fontes.push(u),
    aoPerder: () => assert.fail("temporária não pode perder"),
    agenda: m.agenda,
    esperaAposFalhaS: 3,
  });

  await c.iniciar();
  c.aoErroDeReproducao();
  await tick();

  assert.deepEqual(fontes, ["inicial"], "falha temporária não troca a fonte");
  assert.equal(m.pendentes(), 1, "reagendou a nova tentativa");

  const espera = await m.disparar();
  assert.equal(espera, 3000);
  assert.deepEqual(fontes, ["inicial", "nova"]);
});

test("single-flight: vários erros com um pedido em voo gastam um só", async () => {
  let pedidos = 0;
  let abrir: () => void = () => {};
  const portao = new Promise<void>((r) => {
    abrir = r;
  });
  const m = agendaManual();

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async (_id, r) => {
      pedidos++;
      if (r) await portao;
      return ok(`u${pedidos}`);
    },
    trocarFonte: () => {},
    aoPerder: () => {},
    agenda: m.agenda,
  });

  await c.iniciar();
  assert.equal(pedidos, 1);

  c.aoErroDeReproducao();
  c.aoErroDeReproducao();
  c.aoErroDeReproducao();
  abrir();
  await tick();

  assert.equal(pedidos, 2, "três erros, um pedido de re-resolução");
  assert.equal(c.reresolucoes(), 1);
});

// ── Início e parada ───────────────────────────────────────────────────────────

test("abertura recusada perde e não toca nada", async () => {
  const fontes: string[] = [];
  let perdeu: string | null = null;
  const m = agendaManual();

  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async () => ({ ok: false, definitivo: true, mensagem: "Faça login para assistir." }),
    trocarFonte: (u) => void fontes.push(u),
    aoPerder: (msg) => {
      perdeu = msg;
    },
    agenda: m.agenda,
  });

  await c.iniciar();

  assert.equal(perdeu, "Faça login para assistir.");
  assert.equal(fontes.length, 0);
  assert.equal(c.fonteAtual(), null);
});

test("parar impede re-resolução", async () => {
  let pedidos = 0;
  const m = agendaManual();
  const c = criarControleDeCanal({
    canalId: "c1",
    pedir: async () => {
      pedidos++;
      return ok(`u${pedidos}`);
    },
    trocarFonte: () => {},
    aoPerder: () => {},
    agenda: m.agenda,
  });

  await c.iniciar();
  assert.equal(pedidos, 1);
  c.parar();
  c.aoErroDeReproducao();
  await tick();
  assert.equal(pedidos, 1, "parado, nada mais pede");
});
