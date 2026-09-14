-- Confere o que 20260913_duracoes_adicionais_vip deveria ter criado.
-- Somente leitura. Rode DEPOIS de aplicar. Toda coluna `ok` precisa vir `true`.

-- 1. Colunas novas.
SELECT 'colunas' AS item,
       count(*) = 12 AS ok,
       string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name, column_name) AS encontrado
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'Plano' AND column_name = 'servidorVip')
    OR (table_name = 'PlanoPreco' AND column_name = 'duracaoMeses')
    OR (table_name = 'Assinatura' AND column_name IN ('telasAdicionais', 'servidorVip'))
    OR (table_name = 'PedidoPagamento' AND column_name IN (
          'duracaoMeses', 'telasAdicionais', 'servidorVip', 'valorPlanoCentavos',
          'valorAdicionaisCentavos', 'creditoCentavos', 'operacao', 'assinaturasSubstituidas')));

-- 2. duracaoDias aceita NULL nas duas tabelas.
SELECT 'duracaoDias_nullable' AS item,
       count(*) = 2 AS ok
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'duracaoDias' AND is_nullable = 'YES'
  AND table_name IN ('PlanoPreco', 'PedidoPagamento');

-- 3. CHECKs novos. Esperado: 10.
SELECT 'checks' AS item,
       count(*) = 10 AS ok,
       string_agg(conname, ', ' ORDER BY conname) AS encontrado
FROM pg_constraint
WHERE contype = 'c'
  AND conname IN (
    'PlanoPreco_valores_check', 'PlanoPreco_duracao_check',
    'PlanoAdicionalPreco_tipo_check', 'PlanoAdicionalPreco_valor_check',
    'Assinatura_telasAdicionais_check',
    'PedidoPagamento_valores_check', 'PedidoPagamento_operacao_check',
    'PedidoPagamento_adicionais_check', 'PedidoPagamento_composicao_check',
    'PedidoPagamento_credito_check');

-- 4. Indice unico PARCIAL de preco ativo por (plano, tipo).
SELECT 'indice_parcial' AS item,
       count(*) = 1 AS ok
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'PlanoAdicionalPreco_ativo_unico_idx' AND i.indisunique AND i.indpred IS NOT NULL;

-- 5. RLS ligado na tabela nova.
SELECT 'rls' AS item, relrowsecurity AS ok
FROM pg_class WHERE relname = 'PlanoAdicionalPreco';

-- 6. Nenhuma linha existente violaria a regra de duracao (deve ser 0).
SELECT 'precos_sem_duracao' AS item, count(*) = 0 AS ok
FROM "PlanoPreco" WHERE "duracaoDias" IS NULL AND "duracaoMeses" IS NULL;
