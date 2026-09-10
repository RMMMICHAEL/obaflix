-- Confere o que a migration 20260910_planos_assinaturas deveria ter criado.
--
-- Somente leitura: nao altera nada. Rode DEPOIS de aplicar a migration, e antes
-- do seed. Cada bloco devolve uma coluna `ok` — todas precisam vir `true`.
--
-- Existe porque a migration foi escrita num ambiente sem Postgres: o corpo dos
-- CREATE TABLE saiu de `prisma migrate diff`, mas os CHECK, o indice parcial e o
-- RLS foram escritos a mao e nao chegaram a ser executados. Este arquivo e o que
-- transforma "deve funcionar" em "funcionou", sem depender de ninguem lembrar o
-- que conferir.

-- 1. As tres tabelas existem.
SELECT 'tabelas' AS item,
       count(*) = 3 AS ok,
       string_agg(tablename, ', ' ORDER BY tablename) AS encontrado
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('Plano', 'PlanoPreco', 'Assinatura');

-- 2. Os CHECK de dominio e de limite. Esperado: 8.
SELECT 'checks' AS item,
       count(*) = 8 AS ok,
       string_agg(conname, ', ' ORDER BY conname) AS encontrado
FROM pg_constraint
WHERE contype = 'c'
  AND conrelid::regclass::text IN ('"Plano"', '"PlanoPreco"', '"Assinatura"',
                                   'Plano', 'PlanoPreco', 'Assinatura');

-- 3. O indice unico PARCIAL de ehPadrao — o que o Prisma nao expressa.
--    `indpred IS NOT NULL` e o que prova que o WHERE sobreviveu.
SELECT 'indice parcial ehPadrao' AS item,
       count(*) = 1 AS ok
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'Plano_ehPadrao_unico_idx'
  AND i.indisunique
  AND i.indpred IS NOT NULL;

-- 4. O unico de pedidoId.
SELECT 'unique pedidoId' AS item,
       count(*) = 1 AS ok
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'Assinatura_pedidoId_key'
  AND i.indisunique;

-- 5. As quatro chaves estrangeiras, com a acao de delete correta.
SELECT 'chaves estrangeiras' AS item,
       count(*) = 4 AS ok,
       string_agg(conname || ' -> ' || confdeltype, ', ' ORDER BY conname) AS encontrado
       -- confdeltype: c=CASCADE, r=RESTRICT, n=SET NULL
       -- esperado: PlanoPreco_planoId c | Assinatura_userId c
       --           Assinatura_planoId r | Assinatura_planoPrecoId n
FROM pg_constraint
WHERE contype = 'f'
  AND conrelid::regclass::text IN ('"PlanoPreco"', '"Assinatura"',
                                   'PlanoPreco', 'Assinatura');

-- 6. RLS ligado nas tres.
SELECT 'rls' AS item,
       bool_and(rowsecurity) AS ok,
       string_agg(tablename || '=' || rowsecurity::text, ', ' ORDER BY tablename) AS encontrado
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('Plano', 'PlanoPreco', 'Assinatura');

-- 7. Nenhuma linha foi criada pela migration. O seed e um passo separado.
SELECT 'tabelas vazias' AS item,
       (SELECT count(*) FROM "Plano") = 0
       AND (SELECT count(*) FROM "PlanoPreco") = 0
       AND (SELECT count(*) FROM "Assinatura") = 0 AS ok;

-- 8. Os CHECK recusam de fato. Cada um destes precisa FALHAR com erro de
--    constraint — se algum passar, o CHECK correspondente nao esta valendo.
--    Rode um por vez, dentro de BEGIN/ROLLBACK para nao sujar a tabela.
--
--    BEGIN;
--      INSERT INTO "Plano" ("id","nome","atualizadoEm","canaisNivel")
--        VALUES ('teste','Teste',now(),'inexistente');       -- deve falhar
--    ROLLBACK;
--
--    BEGIN;
--      INSERT INTO "Plano" ("id","nome","atualizadoEm","telasMax")
--        VALUES ('teste','Teste',now(),0);                   -- deve falhar
--    ROLLBACK;
--
--    O do indice parcial precisa de duas linhas:
--
--    BEGIN;
--      INSERT INTO "Plano" ("id","nome","atualizadoEm","ehPadrao")
--        VALUES ('teste1','T1',now(),true);                  -- passa
--      INSERT INTO "Plano" ("id","nome","atualizadoEm","ehPadrao")
--        VALUES ('teste2','T2',now(),true);                  -- deve falhar
--    ROLLBACK;
--
--    E o de pedidoId aceita varios NULL, mas nao dois iguais:
--
--    BEGIN;
--      -- (precisa de um userId e um planoId reais para a FK)
--      -- dois INSERTs com o mesmo pedidoId: o segundo deve falhar
--    ROLLBACK;
