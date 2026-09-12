-- Row Level Security nas tabelas de pareamento de TV.
--
-- Aditiva e idempotente: nenhuma tabela criada, nenhuma coluna alterada,
-- nenhum dado tocado. Somente o flag de RLS de duas tabelas existentes.
--
-- ── Por que existe ───────────────────────────────────────────────────────────
-- A migration 20260812_lock_down_supabase_public_roles ligou RLS em todas as
-- tabelas que existiam naquele dia e revogou os grants de `anon`/`authenticated`,
-- inclusive para tabelas futuras, via ALTER DEFAULT PRIVILEGES.
--
-- O que o ALTER DEFAULT PRIVILEGES NAO faz e ligar RLS: isso e por tabela e nao
-- e herdado. Todas as tabelas criadas depois ligaram o seu proprio RLS na
-- migration que as criou — `Plano`, `PlanoPreco`, `Assinatura`,
-- `PedidoPagamento`, `EventoPagamento`, `Canal`, `CanalFonte`. As duas de
-- 20260827_tv_pairing ficaram para tras: sao as unicas do schema sem RLS.
--
-- `TvRefreshToken` guarda o SHA-256 de uma credencial de longa duracao e a
-- familia de rotacao; `TvDevice` liga aparelho a usuario. Sao exatamente as
-- tabelas onde a segunda camada mais importa.
--
-- ── Efeito pratico ───────────────────────────────────────────────────────────
-- Nenhum sobre a aplicacao. O Prisma conecta como dono da tabela e passa por
-- cima de RLS por desenho. O que muda e que, se um grant de `anon` ou
-- `authenticated` voltar por engano, PostgREST nao le nada: RLS ligado e sem
-- policy nega tudo. Mesmo criterio, mesma escolha de "sem policy e sem GRANT"
-- das migrations 20260910_* e 20260911_canais.
--
-- ── Como aplicar ─────────────────────────────────────────────────────────────
-- Mesma rota das demais: SQL direto contra o Postgres (SQL Editor do Supabase),
-- nao `prisma migrate deploy`. Reexecutavel sem efeito colateral — ENABLE ROW
-- LEVEL SECURITY numa tabela que ja o tem e no-op.

BEGIN;

ALTER TABLE "TvDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TvRefreshToken" ENABLE ROW LEVEL SECURITY;

-- Cinto e suspensorio: as duas nasceram depois do lockdown de 20260812, entao
-- os grants ja deveriam estar ausentes pelo ALTER DEFAULT PRIVILEGES. Revogar
-- de novo e barato e fecha o caso de terem sido criadas por outro role, que o
-- default privilege daquela migration (FOR ROLE postgres) nao alcancaria.
REVOKE ALL PRIVILEGES ON TABLE "TvDevice" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "TvRefreshToken" FROM anon, authenticated;

COMMIT;
