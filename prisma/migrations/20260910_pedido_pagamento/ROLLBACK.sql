-- Rollback de 20260910_pedido_pagamento.
--
-- ESTE ARQUIVO NAO E EXECUTADO POR NADA. Fica versionado ao lado da migration
-- para que desfazer nao dependa de alguem reescrever o SQL sob pressao.
--
-- Antes de rodar isto, saiba que quase nunca e o que voce quer:
--
--   1. O rollback real da Fase 4 e **desligar a flag**:
--        BLACKCAT_PIX_ATIVO=false   (ou remover a variavel)
--      Com ela desligada, POST /api/billing/orders recusa antes de qualquer
--      coisa: nao chama a Blackcat e nao cria pedido. E instantaneo, nao
--      precisa de deploy e nao perde nada.
--
--   2. O segundo passo, se preciso, e reverter o PR. Nenhuma outra rota le
--      "PedidoPagamento", entao o aplicativo volta ao estado anterior mesmo com
--      a tabela presente no banco.
--
--   3. So chegue ate aqui se a tabela precisar sumir de fato.
--
-- ── A ordem importa, e aqui mais do que na Fase 1 ────────────────────────────
--
-- "Assinatura"."pedidoId" agora referencia esta tabela. Um `DROP TABLE
-- "PedidoPagamento"` puro seria recusado pelo Postgres por causa dessa FK — e a
-- tentacao seguinte, `DROP TABLE ... CASCADE`, derrubaria a **constraint** (nao
-- a tabela "Assinatura"), deixando a coluna orfa em silencio. Por isso a FK sai
-- explicitamente antes, num comando que da para ler.
--
-- ── A conferencia que nao pode ser pulada ────────────────────────────────────
--
-- A partir do momento em que existir UMA linha em "PedidoPagamento", este
-- arquivo deixa de ser seguro: ele apaga registro de cobranca — quanto foi
-- pedido, por quem, com qual transacao no provedor. Se alguma dessas transacoes
-- foi paga, o rastro some, e nao ha como reconstrui-lo a partir da Blackcat sem
-- a refExterna que estava aqui.
--
-- Rode os dois SELECT abaixo ANTES. Os dois precisam vir 0.
--
--   SELECT count(*) FROM "PedidoPagamento";
--   SELECT count(*) FROM "Assinatura" WHERE "pedidoId" IS NOT NULL;
--
-- Se o primeiro nao vier 0, **pare**. Exporte a tabela antes de qualquer coisa:
--
--   \copy (SELECT * FROM "PedidoPagamento") TO 'pedidos-backup.csv' CSV HEADER
--
-- Se o segundo nao vier 0, ha assinatura ligada a pedido: apagar a tabela
-- apagaria a origem de um direito concedido. Isso e decisao humana, e a
-- resposta quase certamente e nao apagar.
--
-- O bloco abaixo recusa sozinho, para o arquivo nao depender de quem executa
-- ter lido este cabecalho.

BEGIN;

DO $$
DECLARE
    pedidos BIGINT;
    ligadas BIGINT;
BEGIN
    SELECT count(*) INTO pedidos FROM "PedidoPagamento";
    SELECT count(*) INTO ligadas FROM "Assinatura" WHERE "pedidoId" IS NOT NULL;

    IF pedidos > 0 OR ligadas > 0 THEN
        RAISE EXCEPTION
            'ROLLBACK abortado: % pedido(s) e % assinatura(s) ligadas a pedido. Nada foi apagado. Exporte "PedidoPagamento" e decida caso a caso antes de continuar.',
            pedidos, ligadas;
    END IF;
END $$;

-- A FK primeiro, explicitamente. Ver a nota acima sobre por que nao CASCADE.
ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_pedidoId_fkey";

-- A coluna "Assinatura"."pedidoId" e o indice unico dela NAO sao removidos:
-- nasceram na Fase 1, e desfazer a Fase 4 nao desfaz a Fase 1.
DROP TABLE IF EXISTS "PedidoPagamento";

COMMIT;
