import assert from "node:assert/strict";
import test from "node:test";
import { latestItemPerContent } from "@/lib/continue-watching-items";

test("keeps the most recently updated history item for each content item", () => {
  const history = [
    { conteudoId: "serie-1", conteudoTipo: "serie", episodio: "T3E6" },
    { conteudoId: "filme-1", conteudoTipo: "filme", episodio: null },
    { conteudoId: "serie-1", conteudoTipo: "serie", episodio: "T1E2" },
    { conteudoId: "serie-2", conteudoTipo: "serie", episodio: "T1E1" },
    { conteudoId: "serie-1", conteudoTipo: "serie", episodio: "T1E1" },
  ];

  assert.deepEqual(
    latestItemPerContent(history).map((item) => item.episodio),
    ["T3E6", null, "T1E1"],
  );
});

test("does not merge a movie and a series with the same id", () => {
  const history = [
    { conteudoId: "123", conteudoTipo: "filme" },
    { conteudoId: "123", conteudoTipo: "serie" },
  ];

  assert.equal(latestItemPerContent(history).length, 2);
});
