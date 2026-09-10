-- Planos, precos e assinatura — Fase 1 da camada de monetizacao.
--
-- Aditiva: tres tabelas novas, nenhuma coluna alterada em tabela existente,
-- nenhum dado tocado. Catalogo, historico, watchlist e pareamento de TV ficam
-- exatamente como estao. `assinaturas` em User e relacao virtual do Prisma e
-- nao gera coluna.
--
-- Nenhuma rota le estas tabelas nesta fase, e nenhuma linha de Assinatura e
-- criada. Aplicar esta migration nao muda o comportamento de nenhum usuario.
-- Quem abre e fecha direito depois e o seed do plano padrao (scripts/seed-planos.ts),
-- editando UMA linha — e nao um deploy.
--
-- O corpo do CREATE TABLE saiu de `prisma migrate diff` e nao foi editado a
-- mao, para o banco nao divergir do schema. O que este arquivo acrescenta por
-- cima e o que o Prisma 5 nao sabe expressar: CHECK, indice unico parcial e RLS.
--
-- DIVERGENCIA CONHECIDA E DELIBERADA: `Plano_ehPadrao_unico_idx` e um indice
-- unico PARCIAL. O Prisma 5 nao representa `WHERE` em indice, entao um
-- `prisma migrate diff` futuro vai propor derrubar este indice. Nao derrube —
-- e ele que garante, no banco, que existe no maximo um plano padrao. Mesmo
-- criterio da migration 20260827_tv_pairing, que ignorou de proposito um item
-- do diff por ele ser outra decisao, com outro risco.

-- ── Tabelas ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Plano" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ehPadrao" BOOLEAN NOT NULL DEFAULT false,
    -- Default restritivo de proposito: plano criado sem informar um direito nao
    -- o concede por acidente. So o seed do Gratuito abre tudo, e abre para
    -- preservar o comportamento de hoje.
    "anunciosObrigatorios" BOOLEAN NOT NULL DEFAULT true,
    "episodiosPorAnuncio" INTEGER,
    "janelaAnuncioHoras" INTEGER NOT NULL DEFAULT 24,
    "filmes" BOOLEAN NOT NULL DEFAULT true,
    "series" BOOLEAN NOT NULL DEFAULT true,
    "canaisNivel" TEXT NOT NULL DEFAULT 'nenhum',
    "downloads" BOOLEAN NOT NULL DEFAULT false,
    "telasMax" INTEGER NOT NULL DEFAULT 1,
    "perfisMax" INTEGER NOT NULL DEFAULT 1,
    "resolucaoMax" TEXT NOT NULL DEFAULT 'hd',
    "tvNivel" TEXT NOT NULL DEFAULT 'limitado',
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plano_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PlanoPreco" (
    "id" TEXT NOT NULL,
    "planoId" TEXT NOT NULL,
    "rotulo" TEXT NOT NULL,
    "duracaoDias" INTEGER NOT NULL,
    -- Centavos, inteiro. Nunca float: 8.90 nao existe em binario, e o erro
    -- apareceria justamente na conferencia entre valor pago e valor esperado.
    "precoCentavos" INTEGER NOT NULL,
    "precoOriginalCentavos" INTEGER,
    "moeda" TEXT NOT NULL DEFAULT 'BRL',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanoPreco_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Assinatura" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planoId" TEXT NOT NULL,
    "planoPrecoId" TEXT,
    "status" TEXT NOT NULL,
    "iniciaEm" TIMESTAMP(3) NOT NULL,
    "terminaEm" TIMESTAMP(3) NOT NULL,
    "origem" TEXT NOT NULL DEFAULT 'pagamento',
    -- Trava de idempotencia do pagamento. Sem chave estrangeira nesta fase:
    -- PedidoPagamento ainda nao existe. O unico entra agora porque a tabela
    -- esta vazia — criar unico sobre tabela povoada e outra migration, com
    -- risco de colisao e janela.
    "pedidoId" TEXT,
    "observacao" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assinatura_pkey" PRIMARY KEY ("id")
);

-- ── Dominio dos campos de texto ──────────────────────────────────────────────
-- O Prisma 5 nao expressa CHECK, e a alternativa seria `enum` nativo. Fugimos
-- de enum de proposito: `ALTER TYPE ... ADD VALUE` nao roda dentro de transacao
-- no Postgres, entao acrescentar um nivel de canal viraria migration com
-- janela. CHECK valida igual e muda numa linha, dentro de transacao.
--
-- DROP antes de ADD para o arquivo poder ser reexecutado, como as demais.

ALTER TABLE "Plano" DROP CONSTRAINT IF EXISTS "Plano_canaisNivel_check";
ALTER TABLE "Plano" ADD CONSTRAINT "Plano_canaisNivel_check"
    CHECK ("canaisNivel" IN ('nenhum', 'gratuito', 'plus', 'premium'));

ALTER TABLE "Plano" DROP CONSTRAINT IF EXISTS "Plano_resolucaoMax_check";
ALTER TABLE "Plano" ADD CONSTRAINT "Plano_resolucaoMax_check"
    CHECK ("resolucaoMax" IN ('sd', 'hd', 'fhd', '4k'));

ALTER TABLE "Plano" DROP CONSTRAINT IF EXISTS "Plano_tvNivel_check";
ALTER TABLE "Plano" ADD CONSTRAINT "Plano_tvNivel_check"
    CHECK ("tvNivel" IN ('nenhum', 'limitado', 'completo'));

-- Limites nao podem ser negativos, e "zero tela" nao e um plano — e um plano
-- que ninguem consegue usar.
ALTER TABLE "Plano" DROP CONSTRAINT IF EXISTS "Plano_limites_check";
ALTER TABLE "Plano" ADD CONSTRAINT "Plano_limites_check"
    CHECK ("telasMax" >= 1 AND "perfisMax" >= 1 AND "janelaAnuncioHoras" >= 1
           AND ("episodiosPorAnuncio" IS NULL OR "episodiosPorAnuncio" >= 1));

ALTER TABLE "PlanoPreco" DROP CONSTRAINT IF EXISTS "PlanoPreco_valores_check";
ALTER TABLE "PlanoPreco" ADD CONSTRAINT "PlanoPreco_valores_check"
    CHECK ("duracaoDias" > 0 AND "precoCentavos" >= 0
           AND ("precoOriginalCentavos" IS NULL OR "precoOriginalCentavos" >= 0));

ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_status_check";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_status_check"
    CHECK ("status" IN ('ATIVA', 'EXPIRADA', 'CANCELADA', 'SUSPENSA'));

ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_origem_check";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_origem_check"
    CHECK ("origem" IN ('pagamento', 'cortesia', 'migracao', 'admin'));

-- Uma assinatura que termina antes de comecar concede direito por tempo
-- negativo. O banco recusa, em vez de deixar a conta num estado que nenhuma
-- consulta de vencimento sabe interpretar.
ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_periodo_check";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_periodo_check"
    CHECK ("terminaEm" > "iniciaEm");

-- ── Indices ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "Plano_ativo_ordem_idx" ON "Plano"("ativo", "ordem");

-- No maximo um plano padrao, garantido pelo banco. Sem isto, dois planos
-- marcados `ehPadrao` fariam a resolucao de "usuario sem assinatura" depender
-- da ordem de leitura — dois usuarios receberiam direitos diferentes sem que
-- nada estivesse errado no codigo. Ver a nota de divergencia no cabecalho.
CREATE UNIQUE INDEX IF NOT EXISTS "Plano_ehPadrao_unico_idx"
    ON "Plano"("ehPadrao") WHERE "ehPadrao";

CREATE INDEX IF NOT EXISTS "PlanoPreco_planoId_ativo_ordem_idx"
    ON "PlanoPreco"("planoId", "ativo", "ordem");

CREATE UNIQUE INDEX IF NOT EXISTS "Assinatura_pedidoId_key"
    ON "Assinatura"("pedidoId");

-- "esta conta tem assinatura ativa?" — a consulta do caminho quente.
CREATE INDEX IF NOT EXISTS "Assinatura_userId_status_terminaEm_idx"
    ON "Assinatura"("userId", "status", "terminaEm");

-- Varredura de vencimento sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS "Assinatura_status_terminaEm_idx"
    ON "Assinatura"("status", "terminaEm");

-- ── Chaves estrangeiras ──────────────────────────────────────────────────────
-- CASCADE onde a linha filha nao faz sentido sozinha; RESTRICT onde apagar o
-- pai destruiria historico de direito; SET NULL onde a referencia e informativa.

ALTER TABLE "PlanoPreco" DROP CONSTRAINT IF EXISTS "PlanoPreco_planoId_fkey";
ALTER TABLE "PlanoPreco" ADD CONSTRAINT "PlanoPreco_planoId_fkey"
    FOREIGN KEY ("planoId") REFERENCES "Plano"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Apagar a conta leva a assinatura junto: nao deve sobrar direito de uma conta
-- que nao existe.
ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_userId_fkey";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT: um plano com assinante nao pode ser apagado. Descontinuar plano e
-- `ativo = false`, que preserva quem ja comprou.
ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_planoId_fkey";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_planoId_fkey"
    FOREIGN KEY ("planoId") REFERENCES "Plano"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL: apagar uma tabela de precos encerrada nao pode apagar a assinatura
-- de ninguem. Perde-se qual duracao foi comprada, nao o direito.
ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_planoPrecoId_fkey";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_planoPrecoId_fkey"
    FOREIGN KEY ("planoPrecoId") REFERENCES "PlanoPreco"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Mesmo criterio da migration 20260812_lock_down_supabase_public_roles: a
-- aplicacao e server-only via Prisma e nao usa a Data API do Supabase. Os
-- grants de `anon`/`authenticated` ja estao revogados por ALTER DEFAULT
-- PRIVILEGES, que alcanca tabelas futuras — mas RLS e por tabela e NAO e
-- herdado. Ligar aqui mantem a segunda camada caso um grant seja restaurado
-- por engano.
--
-- Nenhuma policy: sem policy e com RLS ligado, ninguem le nada por PostgREST.
-- O Prisma conecta como dono da tabela e passa por cima, que e o desenho.

ALTER TABLE "Plano" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlanoPreco" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Assinatura" ENABLE ROW LEVEL SECURITY;
