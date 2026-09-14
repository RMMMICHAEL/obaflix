-- Copia da migration 20260812_lock_down_supabase_public_roles para o banco
-- EXCLUSIVO de testes (Neon).
--
-- Unica diferenca: sem os tres `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`.
-- No Neon o dono do banco nao pode alterar os privilegios padrao do papel
-- `postgres` ("permission denied to change default privileges"), e esses
-- comandos so protegem a Data API do Supabase, que nao existe aqui. Os REVOKE e
-- o RLS de todas as tabelas ficam identicos. Production mantem a migration
-- original, ja aplicada la.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_ObaflixAmbiente') THEN
        RAISE EXCEPTION 'Sem marcador _ObaflixAmbiente: NAO e o banco de testes. Abortado.';
    END IF;
END $$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER TABLE "Episodio" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Filme" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FilmeGenero" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Genero" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Like" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PopularHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Saga" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Serie" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SerieGenero" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WatchHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Watchlist" ENABLE ROW LEVEL SECURITY;
