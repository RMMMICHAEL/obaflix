-- SOMENTE no banco exclusivo de testes (Neon).
--
-- As migrations do projeto revogam privilegios dos papeis `anon` e
-- `authenticated`, que existem no Supabase (Production) e nao no Neon. Criar os
-- dois papeis, sem login e sem privilegio nenhum, deixa as migrations serem
-- aplicadas sem alterar uma linha delas.
--
-- Pre-requisito: marcador gravado e verificado (ambiente-teste.ts verificar).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_ObaflixAmbiente') THEN
        RAISE EXCEPTION 'Sem marcador _ObaflixAmbiente: NAO e o banco de testes. Abortado.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    -- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` (migration 20260812) exige o
    -- papel `postgres` e que o usuario atual seja membro dele. No Neon o dono do
    -- banco e outro; o papel criado aqui nao tem login nem privilegio proprio.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        CREATE ROLE postgres NOLOGIN;
    END IF;
    IF NOT pg_has_role(current_user, 'postgres', 'MEMBER') THEN
        EXECUTE format('GRANT postgres TO %I', current_user);
    END IF;
END $$;
