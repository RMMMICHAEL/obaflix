-- Confere o que a migration 20260910_pedido_pagamento deveria ter criado.
--
-- Somente leitura: nao altera nada. Rode DEPOIS de aplicar a migration. Cada
-- bloco devolve uma coluna `ok` — todas precisam vir `true`.
--
-- Existe pelo mesmo motivo do arquivo equivalente da Fase 1: a migration foi
-- escrita num ambiente sem Postgres. O corpo do CREATE TABLE segue o que o
-- Prisma produz, mas os CHECK, o bloco de integridade, as acoes de delete e o
-- RLS foram escritos a mao e nao chegaram a ser executados.
--
-- O item 9 e o mais importante desta fase, e o unico que nao existia na Fase 1:
-- **esta migration nao pode ter criado assinatura nenhuma.**

-- 1. A tabela existe.
SELECT 'tabela' AS item,
       count(*) = 1 AS ok
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'PedidoPagamento';

-- 2. As colunas, com tipo e nulidade. Esperado: 14 linhas, e as tres marcadas
--    abaixo sao as unicas que aceitam NULL.
SELECT 'colunas' AS item,
       count(*) = 14 AS ok,
       string_agg(column_name || ':' || data_type || ':' || is_nullable, ', ' ORDER BY column_name) AS encontrado
       -- esperado nullable = YES apenas em: transacaoId, expiraEm
       -- valorCentavos e duracaoDias precisam vir como `integer`, nunca numeric
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'PedidoPagamento';

-- 2b. O que o item acima poderia deixar passar por leitura desatenta: os dois
--     campos de dinheiro/duracao sao inteiros, e nao numeric ou double.
SELECT 'valor e duracao sao integer' AS item,
       count(*) = 2 AS ok
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'PedidoPagamento'
  AND column_name IN ('valorCentavos', 'duracaoDias')
  AND data_type = 'integer';

-- 3. Os CHECK de dominio e de valor. Esperado: 3
--    (status, provedor, valores).
SELECT 'checks' AS item,
       count(*) = 3 AS ok,
       string_agg(conname, ', ' ORDER BY conname) AS encontrado
FROM pg_constraint
WHERE contype = 'c'
  AND conrelid = '"PedidoPagamento"'::regclass;

-- 4. Os dois indices unicos.
SELECT 'uniques' AS item,
       count(*) = 2 AS ok,
       string_agg(c.relname, ', ' ORDER BY c.relname) AS encontrado
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = '"PedidoPagamento"'::regclass
  AND i.indisunique
  AND c.relname IN ('PedidoPagamento_refExterna_key', 'PedidoPagamento_transacaoId_key');

-- 5. Os dois indices de consulta.
SELECT 'indices de consulta' AS item,
       count(*) = 2 AS ok,
       string_agg(c.relname, ', ' ORDER BY c.relname) AS encontrado
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = '"PedidoPagamento"'::regclass
  AND c.relname IN ('PedidoPagamento_userId_status_criadoEm_idx',
                    'PedidoPagamento_status_expiraEm_idx');

-- 6. As tres chaves estrangeiras da propria tabela, com a acao de delete certa.
SELECT 'fks de PedidoPagamento' AS item,
       count(*) = 3 AS ok,
       string_agg(conname || ' -> ' || confdeltype::text, ', ' ORDER BY conname) AS encontrado
       -- confdeltype: c=CASCADE, r=RESTRICT, a=NO ACTION, n=SET NULL
       -- esperado: userId c | planoId r | planoPrecoId r
FROM pg_constraint
WHERE contype = 'f'
  AND conrelid = '"PedidoPagamento"'::regclass;

-- 7. A FK nova de Assinatura -> PedidoPagamento, e ela precisa ser NO ACTION.
--    Se vier `c` (CASCADE), apagar um pedido apagaria direito pago: pare e
--    corrija antes de qualquer outra coisa.
SELECT 'Assinatura.pedidoId -> PedidoPagamento' AS item,
       count(*) = 1 AS ok,
       string_agg(confdeltype::text, ', ') AS acao_de_delete   -- esperado: a
FROM pg_constraint
WHERE contype = 'f'
  AND conname = 'Assinatura_pedidoId_fkey'
  AND conrelid = '"Assinatura"'::regclass
  AND confrelid = '"PedidoPagamento"'::regclass
  AND confdeltype = 'a';

-- 8. RLS ligado, e nenhuma policy.
SELECT 'rls ligado' AS item,
       bool_and(rowsecurity) AS ok
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'PedidoPagamento';

SELECT 'sem policy publica' AS item,
       count(*) = 0 AS ok,
       string_agg(policyname, ', ') AS encontrado
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'PedidoPagamento';

-- 9. **O item desta fase.** A migration nao popula nada, e nao pode ter criado
--    assinatura. Se "Assinatura" tinha linhas antes, este bloco nao serve —
--    compare com a contagem anotada antes de aplicar.
SELECT 'nada foi criado por esta migration' AS item,
       (SELECT count(*) FROM "PedidoPagamento") = 0
       AND (SELECT count(*) FROM "Assinatura") = 0 AS ok;

-- 10. Nenhuma assinatura orfa. O bloco DO da migration ja aborta nesse caso,
--     entao aqui isto e confirmacao, nao descoberta.
SELECT 'sem assinatura orfa' AS item,
       count(*) = 0 AS ok
FROM "Assinatura" a
WHERE a."pedidoId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "PedidoPagamento" p WHERE p."id" = a."pedidoId");

-- 11. Os CHECK recusam de fato. Cada um destes precisa FALHAR com erro de
--     constraint — se algum passar, o CHECK correspondente nao esta valendo.
--     Rode um por vez, dentro de BEGIN/ROLLBACK para nao sujar a tabela, e
--     substitua <user>, <plano> e <preco> por ids reais (as FKs sao checadas).
--
--     BEGIN;
--       INSERT INTO "PedidoPagamento"
--         ("id","userId","planoId","planoPrecoId","status","valorCentavos",
--          "duracaoDias","refExterna","atualizadoEm")
--       VALUES ('t1','<user>','<plano>','<preco>','INVENTADO',100,30,'r1',now());
--     ROLLBACK;                                      -- deve falhar: status
--
--     BEGIN;
--       ... mesma linha com "valorCentavos" = 0      -- deve falhar: valores
--     ROLLBACK;
--
--     BEGIN;
--       ... mesma linha com "duracaoDias" = 0        -- deve falhar: valores
--     ROLLBACK;
--
--     BEGIN;
--       ... mesma linha com "provedor" = 'outro'     -- deve falhar: provedor
--     ROLLBACK;
--
--     O unico de refExterna:
--
--     BEGIN;
--       ... duas linhas validas com a MESMA refExterna  -- a segunda deve falhar
--     ROLLBACK;
--
--     E o de transacaoId, que precisa aceitar varios NULL e recusar dois iguais:
--
--     BEGIN;
--       ... duas linhas com "transacaoId" NULL         -- as duas devem passar
--       ... duas linhas com "transacaoId" = 'TXN-1'    -- a segunda deve falhar
--     ROLLBACK;
--
--     E a FK nova, que precisa recusar apagar pedido com assinatura:
--
--     BEGIN;
--       -- crie um pedido, uma assinatura apontando para ele, e entao:
--       DELETE FROM "PedidoPagamento" WHERE "id" = 't1';   -- deve falhar
--     ROLLBACK;
