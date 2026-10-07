import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupGenres } from "@/lib/genres";

/**
 * Fase 4 — consolidação de gêneros duplicados + paginação rastreável.
 *
 * O agrupamento é testado de verdade (função pura). As decisões que dependeriam
 * de banco (redirect, `generoId in ids`, SEO de paginação, 1 URL por slug no
 * sitemap) são travadas por asserção de fonte, mesmo padrão dos testes de SEO já
 * existentes no projeto.
 */
const ler = (p: string) => readFileSync(p, "utf8");

// ── Agrupamento semântico (menor id = canônico) ──────────────────────────────

test("agrupa ids duplicados pelo slug e escolhe o menor id: terror [5,27] → 5", () => {
  const [g] = groupGenres([
    { id: 27, nome: "Terror" },
    { id: 5, nome: "Terror" },
  ]);
  assert.equal(g.id, 5);
  assert.deepEqual(g.ids, [5, 27]);
  assert.equal(g.nome, "Terror");
});

test("drama [4,18] → 4 e ação [1,28] → 1", () => {
  const drama = groupGenres([
    { id: 18, nome: "Drama" },
    { id: 4, nome: "Drama" },
  ])[0];
  assert.equal(drama.id, 4);
  assert.deepEqual(drama.ids, [4, 18]);

  const acao = groupGenres([
    { id: 28, nome: "Ação" },
    { id: 1, nome: "Ação" },
  ])[0];
  assert.equal(acao.id, 1);
  assert.deepEqual(acao.ids, [1, 28]);
});

test("gênero sem duplicata continua único", () => {
  const grupos = groupGenres([{ id: 9648, nome: "Mistério" }]);
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0].id, 9648);
  assert.deepEqual(grupos[0].ids, [9648]);
});

test("resultado independe da ordem recebida", () => {
  const entrada = [
    { id: 28, nome: "Ação" },
    { id: 1, nome: "Ação" },
    { id: 27, nome: "Terror" },
    { id: 5, nome: "Terror" },
  ];
  const a = groupGenres(entrada);
  const b = groupGenres([...entrada].reverse());
  assert.deepEqual(a, b);
  const acao = a.find((g) => g.ids.includes(1));
  assert.equal(acao?.id, 1);
});

test("nomes distintos que geram o MESMO slug são agrupados", () => {
  // "Ação" e "Acao" → slugifySeo → "acao": mesmo grupo, menor id vence.
  const grupos = groupGenres([
    { id: 10, nome: "Ação" },
    { id: 2, nome: "Acao" },
  ]);
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0].id, 2);
  assert.deepEqual(grupos[0].ids, [2, 10]);
});

// ── Resolução da página / redirect canônico ──────────────────────────────────

test("buscarGeneroPorParam agrupa e devolve ids do grupo (sem findUnique por id)", () => {
  const src = ler("src/app/genero/[id]/genero-data.ts");
  assert.match(src, /groupGenres\(todos\)/);
  assert.match(src, /\.find\(\(g\) => g\.ids\.includes\(id\)\)/);
  // Não resolve mais um id isolado: precisa do grupo inteiro.
  assert.doesNotMatch(src, /findUnique/);
});

test("página redireciona 308 do membro não canônico para o canônico do grupo", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  assert.match(src, /const canonico = genrePath\(genero\.id, genero\.nome\)/);
  assert.match(src, /permanentRedirect\(canonico\)/);
});

// ── Consulta consolidada + ordenação determinística ──────────────────────────

test("consulta usa TODOS os ids do grupo (generoId in ids), filmes e séries", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  const ocorrencias = src.match(/generoId: \{ in: genero\.ids \}/g) ?? [];
  assert.equal(ocorrencias.length, 2, "filmes e séries devem consultar o grupo inteiro");
  // `some` garante uma linha por título mesmo ligado a dois ids do grupo.
  assert.match(src, /some: \{ generoId: \{ in: genero\.ids \} \}/);
});

test("ordenação tem desempate determinístico por id", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  assert.match(src, /popularidade: \{ sort: "desc", nulls: "last" \}/);
  assert.match(src, /\{ id: "asc" as const \}/);
  assert.match(src, /orderBy: ordenacao/);
});

// ── SEO de paginação ─────────────────────────────────────────────────────────

test("page=1 usa canonical limpo; page>1 é self-canonical (?page=N), nunca a base", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  assert.match(src, /const path = page > 1 \? `\$\{base\}\?page=\$\{page\}` : base/);
  // O override antigo (noindex na página paginada + canonical na base) sumiu.
  assert.doesNotMatch(src, /md\.robots = \{ index: false, follow: true \}/);
});

test("title da página paginada inclui o número, sem keyword stuffing", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  assert.match(src, /Filmes e séries de \$\{genero\.nome\} — página \$\{page\}/);
});

test("paginação mantém links reais Anterior/Próxima (rel prev/next)", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  assert.match(src, /rel="prev"/);
  assert.match(src, /rel="next"/);
  assert.match(src, /← Anterior/);
  assert.match(src, /Próxima →/);
  // page=1 do botão Anterior aponta para a URL limpa.
  assert.match(src, /page === 2 \? canonico : `\$\{canonico\}\?page=\$\{page - 1\}`/);
});

test("página vazia (além do fim) continua respondendo 404", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  assert.match(src, /itens\.length === 0\)\s*notFound\(\)/);
});

// ── Robots da página paginada (mecanismo real) ───────────────────────────────
//
// A página delega robots/canonical inteiramente a mediaMetadata (sem override por
// page): com a flag ligada, page=2 herda index/follow e canoniza para si mesma.

let mediaMetadata: typeof import("../seo").mediaMetadata;

before(async () => {
  process.env.CONTENT_INDEXING_ENABLED = "true";
  ({ mediaMetadata } = await import("../seo"));
});

test("page=2 é index/follow quando CONTENT_INDEXING_ENABLED=true e self-canonical", () => {
  const md = mediaMetadata({
    title: "Filmes e séries de Terror — página 2",
    description: "x",
    path: "/genero/terror--5?page=2",
  });
  const robots = md.robots as { index?: boolean; follow?: boolean };
  assert.equal(robots.index, true);
  assert.equal(robots.follow, true);
  assert.equal((md.alternates as { canonical?: string }).canonical, "/genero/terror--5?page=2");
});

// ── Sitemap: uma URL por slug, canônico = menor id global ─────────────────────

test("sitemap gera UMA URL por gênero semântico (canônico do grupo), sem N+1", () => {
  const src = ler("src/app/sitemap/[shard]/route.ts");
  // Exatamente uma consulta de gêneros (sem N+1).
  const consultas = src.match(/prisma\.genero\.findMany/g) ?? [];
  assert.equal(consultas.length, 1);
  // Dedup por grupo e URL pelo representante (menor id).
  assert.match(src, /groupGenres\(/);
  assert.match(src, /genrePath\(grupo\.id, grupo\.nome\)/);
});

test("sitemap inclui o grupo quando QUALQUER membro tem conteúdo (canônico = menor id global)", () => {
  const src = ler("src/app/sitemap/[shard]/route.ts");
  // Disponibilidade por membro...
  assert.match(src, /filmeDisponivel\(\)/);
  assert.match(src, /serieDisponivel\(\)/);
  assert.match(src, /comConteudo/);
  // ...e o grupo entra se ALGUM id dele estiver disponível — então o menor id do
  // grupo (grupo.id, calculado sobre TODOS os gêneros) é quem vai pro sitemap.
  assert.match(src, /grupo\.ids\.some\(\(id\) => comConteudo\.has\(id\)\)/);
});
