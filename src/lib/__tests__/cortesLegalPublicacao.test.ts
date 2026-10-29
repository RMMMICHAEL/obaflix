import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ler = (arquivo: string) => readFileSync(arquivo, "utf8");

test("documentos comerciais nao exibem avisos de rascunho nem dados ficticios", () => {
  const modelo = ler("src/components/legal/PaginaLegal.tsx");
  assert.doesNotMatch(modelo, /Rascunho em revisão|Dados oficiais ainda não informados|pendencias/i);
  for (const nome of ["termos", "privacidade", "reembolso", "suporte"]) {
    const pagina = ler(`src/app/${nome}/page.tsx`);
    assert.match(pagina, /PaginaLegal/);
    assert.doesNotMatch(pagina, /CNPJ ficticio|CNPJ em definicao|Rascunho em revisão/);
  }
  assert.match(ler("src/app/reembolso/page.tsx"), /7 dias corridos/);
  assert.match(ler("src/app/suporte/page.tsx"), /obaflixsuporte@gmail.com/);
});

test("FAQ publica do Cortes AI fala do beneficio sem expor mecanismo interno", () => {
  const pagina = ler("src/app/cortes/page.tsx");
  assert.doesNotMatch(pagina, /A IA não processa o vídeo visualmente/);
  assert.match(pagina, /Há limites de análises por dia e por mês/);
});
