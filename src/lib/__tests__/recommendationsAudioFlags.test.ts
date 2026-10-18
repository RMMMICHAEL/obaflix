// Prova que carregarFlagsDeAudio deriva temDub/temLeg SEM trazer URLs e que o
// resultado é equivalente ao indicador antigo `some(ep => Boolean(ep.urlX))`,
// incluindo string vazia e séries com mais de 20 episódios. O mock de groupBy
// aplica EXATAMENTE o `where` que o código monta (serieId IN + `not null` E
// `not ""` por campo), então o teste valida a lógica dada a semântica do SQL.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { carregarFlagsDeAudio } from "../recommendations";

type Ep = { serieId: string; urlDub?: string | null; urlLeg?: string | null };

/** Mock de prisma.episodio.groupBy que honra o `where` montado pelo código. */
function mockDb(episodios: Ep[]) {
  let groupByCalls = 0;
  const db = {
    episodio: {
      async groupBy(args: any) {
        groupByCalls++;
        const ids: string[] = args.where.serieId.in;
        const conds: Array<Record<string, { not: unknown }>> = args.where.AND;
        const presentes = new Set<string>();
        for (const ep of episodios) {
          if (!ids.includes(ep.serieId)) continue;
          // Cada clausula { campo: { not: X } } exige (valor ?? null) !== X.
          const ok = conds.every((c) => {
            const [campo, pred] = Object.entries(c)[0] as [keyof Ep, { not: unknown }];
            const valor = (ep[campo] ?? null) as unknown;
            return valor !== pred.not;
          });
          if (ok) presentes.add(ep.serieId);
        }
        return [...presentes].map((serieId) => ({ serieId }));
      },
    },
  };
  return { db, calls: () => groupByCalls };
}

// Mesma regra do indicador antigo, para comparar.
const antigoTem = (eps: Ep[], id: string, campo: "urlDub" | "urlLeg") =>
  eps.some((e) => e.serieId === id && Boolean(e[campo]));

describe("carregarFlagsDeAudio", () => {
  const episodios: Ep[] = [
    { serieId: "s1", urlDub: "https://d/1", urlLeg: null },        // dub válido; sem leg
    { serieId: "s2", urlDub: "", urlLeg: "" },                     // string vazia: ausente nos dois
    // s3: 20 episódios só com legenda, e no 21º aparece a dublagem
    ...Array.from({ length: 20 }, (_, i) => ({ serieId: "s3", urlDub: null, urlLeg: `https://l/${i}` })),
    { serieId: "s3", urlDub: "https://d/21", urlLeg: null },
    { serieId: "s4", urlDub: null, urlLeg: null },                 // nada elegível
  ];
  const ids = ["s1", "s2", "s3", "s4"];

  test("equivale a Boolean(url): vazio é ausente; dub após o 20º episódio conta", async () => {
    const m = mockDb(episodios);
    const { temDub, temLeg } = await carregarFlagsDeAudio(ids, m.db as any);

    assert.deepEqual([...temDub].sort(), ["s1", "s3"]);
    assert.deepEqual([...temLeg].sort(), ["s3"]);

    // Equivalência explícita com o indicador antigo, série a série.
    for (const id of ids) {
      assert.equal(temDub.has(id), antigoTem(episodios, id, "urlDub"), `temDub ${id}`);
      assert.equal(temLeg.has(id), antigoTem(episodios, id, "urlLeg"), `temLeg ${id}`);
    }
  });

  test("string vazia NÃO classifica como disponível (COUNT contaria, Boolean não)", async () => {
    const m = mockDb([{ serieId: "sx", urlDub: "", urlLeg: "" }]);
    const { temDub, temLeg } = await carregarFlagsDeAudio(["sx"], m.db as any);
    assert.equal(temDub.has("sx"), false);
    assert.equal(temLeg.has("sx"), false);
  });

  test("série sem fontes elegíveis não é classificada", async () => {
    const m = mockDb([{ serieId: "s4", urlDub: null, urlLeg: null }]);
    const { temDub, temLeg } = await carregarFlagsDeAudio(["s4"], m.db as any);
    assert.equal(temDub.has("s4"), false);
    assert.equal(temLeg.has("s4"), false);
  });

  test("duas consultas fixas, sem N+1 por série", async () => {
    const m = mockDb(episodios);
    await carregarFlagsDeAudio(ids, m.db as any);
    assert.equal(m.calls(), 2); // uma para dub, uma para leg — não cresce com o nº de séries
  });

  test("lista vazia não consulta o banco", async () => {
    const m = mockDb(episodios);
    const { temDub, temLeg } = await carregarFlagsDeAudio([], m.db as any);
    assert.equal(m.calls(), 0);
    assert.equal(temDub.size, 0);
    assert.equal(temLeg.size, 0);
  });
});
