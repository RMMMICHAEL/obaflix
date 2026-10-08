-- Métricas first-party da landing de download (/baixar).
--
-- Aditiva: uma tabela nova, nenhuma coluna alterada em tabela existente,
-- nenhum dado tocado. Nasce vazia e só recebe contadores agregados.
--
-- ── Por que agregada ─────────────────────────────────────────────────────────
-- Não guardamos evento bruto (uma linha por visita). Guardamos UMA linha por
-- combinação (dia, evento, contexto, placement, UTMs) e incrementamos `count`.
-- Com isso a tabela permanece pequena mesmo sob muito tráfego, e não há onde
-- gravar identificador de pessoa: sem userId, sessão, IP, User-Agent, cookie,
-- fingerprint, URL ou referrer completos — nada disso tem coluna aqui.
--
-- `android_download_click` é clique no botão, nunca instalação do APK.

BEGIN;

CREATE TABLE IF NOT EXISTS "MarketingLandingMetric" (
    "id"        TEXT NOT NULL,
    "day"       DATE NOT NULL,
    "event"     TEXT NOT NULL,
    "context"   TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "source"    TEXT NOT NULL,
    "medium"    TEXT NOT NULL,
    "campaign"  TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    "count"     INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingLandingMetric_pkey" PRIMARY KEY ("id")
);

-- A chave do upsert atômico: cada evento resolve para exatamente uma linha.
CREATE UNIQUE INDEX IF NOT EXISTS "MarketingLandingMetric_coordenada_key"
    ON "MarketingLandingMetric"("day", "event", "context", "placement", "source", "medium", "campaign", "content");

-- Janela por período (1/7/30 dias).
CREATE INDEX IF NOT EXISTS "MarketingLandingMetric_day_idx"
    ON "MarketingLandingMetric"("day");

-- Somatórios do funil (landing_view in_app/browser, cliques) por período.
CREATE INDEX IF NOT EXISTS "MarketingLandingMetric_event_context_day_idx"
    ON "MarketingLandingMetric"("event", "context", "day");

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Mesmo critério das migrations 20260812/20260911: a aplicação é server-only via
-- Prisma e não usa a Data API do Supabase. RLS é por tabela e não é herdado dos
-- ALTER DEFAULT PRIVILEGES, então liga-se aqui. Sem policy, PostgREST não lê.
ALTER TABLE "MarketingLandingMetric" ENABLE ROW LEVEL SECURITY;

COMMIT;
