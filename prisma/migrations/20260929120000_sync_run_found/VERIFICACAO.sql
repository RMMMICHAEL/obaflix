-- Confere 20260928150000_admin_surface_observability + 20260929120000_sync_run_found.
--
-- Somente leitura. Rode DEPOIS das duas migrations. Toda coluna `ok` precisa
-- vir `true`.

-- 1. As duas tabelas existem.
SELECT 'tabelas' AS item,
       count(*) = 2 AS ok
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('SyncRun', 'AdminAudit');

-- 2. Colunas: SyncRun com 17 (16 + found), AdminAudit com 8.
SELECT 'colunas SyncRun' AS item,
       count(*) = 17 AS ok,
       string_agg(column_name, ', ' ORDER BY column_name) AS encontrado
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'SyncRun';

SELECT 'colunas AdminAudit' AS item,
       count(*) = 8 AS ok,
       string_agg(column_name, ', ' ORDER BY column_name) AS encontrado
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'AdminAudit';

-- 3. found é inteiro e aceita NULL.
SELECT 'found integer nullable' AS item,
       count(*) = 1 AS ok
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'SyncRun'
  AND column_name = 'found' AND data_type = 'integer' AND is_nullable = 'YES';

-- 4. Os 5 índices.
SELECT 'indices' AS item,
       count(*) = 5 AS ok
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'SyncRun_source_job_startedAt_idx', 'SyncRun_status_startedAt_idx',
    'AdminAudit_adminUserId_createdAt_idx', 'AdminAudit_targetType_targetId_createdAt_idx',
    'AdminAudit_action_createdAt_idx');

-- 5. FK de AdminAudit para User, NO ACTION ('a') — nunca CASCADE ('c').
SELECT 'fk NO ACTION' AS item,
       count(*) = 1 AS ok
FROM pg_constraint
WHERE conname = 'AdminAudit_adminUserId_fkey'
  AND confdeltype = 'a';

-- 6. RLS ligado e nenhuma policy (acesso só pelo servidor).
SELECT 'rls ligado' AS item,
       count(*) = 2 AS ok
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('SyncRun', 'AdminAudit') AND c.relrowsecurity;

SELECT 'sem policy' AS item,
       count(*) = 0 AS ok
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('SyncRun', 'AdminAudit');

-- 7. Sem privilégio para anon/authenticated.
SELECT 'sem grant anon/authenticated' AS item,
       count(*) = 0 AS ok
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('SyncRun', 'AdminAudit')
  AND grantee IN ('anon', 'authenticated');

-- 8. Nada foi alterado fora: as tabelas nascem vazias.
SELECT 'vazias' AS item,
       (SELECT count(*) FROM "SyncRun") = 0 AND (SELECT count(*) FROM "AdminAudit") = 0 AS ok;
