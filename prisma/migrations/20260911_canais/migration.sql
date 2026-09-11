-- Canais ao vivo — catalogo publico e fonte privada.
--
-- Aditiva: duas tabelas novas, nenhuma coluna alterada em tabela existente,
-- nenhum dado tocado. Filmes, series, planos e pareamento ficam como estao.
--
-- Aplicar esta migration nao muda o comportamento de nenhum usuario: `Canal`
-- nasce vazia, e mesmo depois do import toda linha entra com `ativo = false`.
-- Quem publica um canal e o script de curadoria (scripts/canais-curadoria.ts),
-- editando uma linha — e nao um deploy.
--
-- ── Por que duas tabelas ─────────────────────────────────────────────────────
-- `Canal` e o que pode ser visto; `CanalFonte` e como chegar no stream. A
-- separacao existe para o vazamento da fonte exigir uma decisao explicita: a
-- rota de catalogo consulta `Canal` e nao tem como devolver o id do provider
-- por acidente, porque a coluna nao esta na tabela que ela le.
--
-- `CanalFonte` NAO guarda `.m3u8`. A URL de midia deste provider e permanente e
-- sem assinatura — gravar seria criar no nosso banco o mesmo link eterno que
-- estamos tentando nao entregar. Guarda-se como chegar nela, e resolve-se a
-- cada sessao.

BEGIN;

-- ── Tabelas ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Canal" (
    "id"            TEXT NOT NULL,
    "slug"          TEXT NOT NULL,
    "nome"          TEXT NOT NULL,
    "categoria"     TEXT NOT NULL,
    "logoUrl"       TEXT,
    "nivelMinimo"   TEXT NOT NULL DEFAULT 'premium',
    "nivelRevisado" BOOLEAN NOT NULL DEFAULT false,
    "ativo"         BOOLEAN NOT NULL DEFAULT false,
    "adulto"        BOOLEAN NOT NULL DEFAULT false,
    "ordem"         INTEGER NOT NULL DEFAULT 0,
    "criadoEm"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Canal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CanalFonte" (
    "canalId"           TEXT NOT NULL,
    "provider"          TEXT NOT NULL,
    "providerChannelId" TEXT NOT NULL,
    "criadoEm"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanalFonte_pkey" PRIMARY KEY ("canalId")
);

-- ── Indices ──────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "Canal_slug_key" ON "Canal"("slug");

-- Cobre a consulta de catalogo, que e sempre a mesma forma:
-- ativo = true AND adulto = false [AND categoria = ?] ORDER BY ordem.
CREATE INDEX IF NOT EXISTS "Canal_ativo_adulto_categoria_ordem_idx"
    ON "Canal"("ativo", "adulto", "categoria", "ordem");

CREATE INDEX IF NOT EXISTS "CanalFonte_provider_idx" ON "CanalFonte"("provider");

-- ── Chave estrangeira ────────────────────────────────────────────────────────
-- CASCADE: a fonte nao tem vida propria. Apagar o canal tem de levar embora o
-- ponteiro para o provider, e nao deixar uma linha orfa com o id do provider
-- dentro dela.
ALTER TABLE "CanalFonte" DROP CONSTRAINT IF EXISTS "CanalFonte_canalId_fkey";
ALTER TABLE "CanalFonte" ADD CONSTRAINT "CanalFonte_canalId_fkey"
    FOREIGN KEY ("canalId") REFERENCES "Canal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECK ────────────────────────────────────────────────────────────────────
-- Espelho de CANAIS_NIVEIS em src/lib/planos.ts. O mesmo dominio fechado que
-- `Plano.canaisNivel` usa: o nivel exigido por um canal e o nivel concedido por
-- um plano sao comparados entre si, entao tem de vir do mesmo conjunto.
ALTER TABLE "Canal" DROP CONSTRAINT IF EXISTS "Canal_nivelMinimo_dominio";
ALTER TABLE "Canal" ADD CONSTRAINT "Canal_nivelMinimo_dominio"
    CHECK ("nivelMinimo" IN ('nenhum', 'gratuito', 'plus', 'premium'));

-- Um canal so pode estar no catalogo se alguem decidiu o nivel dele na mao.
-- Sem isto, `ativo = true` num canal ainda nao revisado dependeria de ninguem
-- errar no script de curadoria. Com isto, o banco recusa.
ALTER TABLE "Canal" DROP CONSTRAINT IF EXISTS "Canal_ativo_exige_revisao";
ALTER TABLE "Canal" ADD CONSTRAINT "Canal_ativo_exige_revisao"
    CHECK ("ativo" = false OR "nivelRevisado" = true);

-- Canal adulto nao entra no catalogo nesta fase. A regra tambem esta na
-- consulta (src/lib/canais/catalogo.ts); aqui ela fica no banco, onde um
-- import mal feito nao alcanca.
ALTER TABLE "Canal" DROP CONSTRAINT IF EXISTS "Canal_adulto_fora_do_catalogo";
ALTER TABLE "Canal" ADD CONSTRAINT "Canal_adulto_fora_do_catalogo"
    CHECK ("adulto" = false OR "ativo" = false);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Mesmo criterio da migration 20260910_planos_assinaturas: a aplicacao e
-- server-only via Prisma e nao usa a Data API do Supabase. RLS e por tabela e
-- NAO e herdado dos ALTER DEFAULT PRIVILEGES, entao liga-se aqui.
--
-- `CanalFonte` e a tabela que mais justifica isto no repositorio inteiro: e o
-- ponteiro para o provider. Sem policy e com RLS ligado, PostgREST nao le.

ALTER TABLE "Canal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CanalFonte" ENABLE ROW LEVEL SECURITY;

COMMIT;
