-- PedidoPagamento — Fase 4 da camada de monetizacao.
--
-- Uma tabela nova e UMA chave estrangeira nova sobre coluna que ja existia
-- ("Assinatura"."pedidoId"). Nenhuma coluna alterada, nenhum dado tocado,
-- nenhuma linha criada. Catalogo, historico, watchlist, pareamento de TV,
-- Plano, PlanoPreco e Assinatura continuam exatamente como estao.
--
-- O que esta fase entrega e infraestrutura de cobranca: um pedido local e uma
-- venda PIX criada no provedor. **NAO ativa assinatura.** Nao existe neste
-- arquivo, nem no codigo que o acompanha, caminho que escreva 'PAGO' ou insira
-- em "Assinatura". Confirmacao servidor->servidor, webhook e reconciliacao
-- pertencem a Fase 5.
--
-- O corpo do CREATE TABLE segue o que `prisma migrate diff` produz para o
-- modelo, para o banco nao divergir do schema. O que este arquivo acrescenta
-- por cima e o que o Prisma 5 nao sabe expressar: CHECK, RLS e a verificacao de
-- integridade antes da FK.
--
-- ── Transacao ────────────────────────────────────────────────────────────────
-- Mesmo criterio de 20260910_planos_assinaturas: este repositorio executa o SQL
-- direto contra o Postgres, e nao por `prisma migrate deploy`. Sem BEGIN/COMMIT
-- explicitos, um erro no meio deixaria a fase pela metade — tabela criada sem
-- CHECK, ou com CHECK e sem RLS, ou com a FK de Assinatura pendurada numa
-- tabela incompleta. Todos os comandos abaixo sao transacionais.

BEGIN;

-- ── Tabela ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "PedidoPagamento" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planoId" TEXT NOT NULL,
    -- NOT NULL, ao contrario de "Assinatura"."planoPrecoId": um pedido so nasce
    -- de um preco. E o que torna SET NULL impossivel aqui — ver as FKs abaixo.
    "planoPrecoId" TEXT NOT NULL,
    "provedor" TEXT NOT NULL DEFAULT 'blackcat',
    "status" TEXT NOT NULL,
    -- Centavos, inteiro, SNAPSHOT. Nunca float, e nunca uma releitura de
    -- "PlanoPreco" no momento da conferencia: o preco pode mudar entre a criacao
    -- do PIX e o pagamento, e conferir contra o preco atual recusaria um
    -- pagamento correto — ou aceitaria um incorreto.
    "valorCentavos" INTEGER NOT NULL,
    "moeda" TEXT NOT NULL DEFAULT 'BRL',
    -- Snapshot pelo mesmo motivo. E a duracao que estava sendo comprada naquele
    -- instante, e nao a que a tabela de precos oferece hoje.
    "duracaoDias" INTEGER NOT NULL,
    "refExterna" TEXT NOT NULL,
    "transacaoId" TEXT,
    "expiraEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PedidoPagamento_pkey" PRIMARY KEY ("id")
);

-- ── Dominio dos campos de texto ──────────────────────────────────────────────
-- TEXT com CHECK, e nao `enum` nativo, pelas mesmas razoes registradas em
-- 20260910_planos_assinaturas e em docs/database.md.
--
-- A contrapartida continua valendo: os valores aceitos existem em dois lugares,
-- as constantes de src/lib/billing/pedidos.ts e os CHECK abaixo.
-- src/lib/__tests__/pedidoPagamento.test.ts le os dois arquivos e falha se
-- divergirem — entao mexer num lado sem o outro quebra o CI, e nao a producao.
--
-- DROP antes de ADD para o arquivo tolerar reexecucao. "Tolerar" e o termo
-- certo: reexecutar depois que houver pedidos pega lock e revalida as linhas.

-- A maquina de estados inteira, inclusive os estados que so a Fase 5 escreve.
-- Declarar os nove agora evita uma migration de dominio no meio do fluxo de
-- pagamento, que e o pior momento possivel para pegar lock nesta tabela.
--
-- A Fase 4 escreve apenas CRIADO, AGUARDANDO, FALHOU e REVISAO_MANUAL.
-- **PAGO nao e escrito por nenhum caminho desta fase.**
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_status_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_status_check"
    CHECK ("status" IN ('CRIADO', 'AGUARDANDO', 'CONFIRMANDO', 'PAGO', 'EXPIRADO', 'CANCELADO', 'FALHOU', 'ESTORNADO', 'REVISAO_MANUAL'));

-- Um provedor so, hoje. O CHECK existe porque a Fase 5 procura pedido por
-- (provedor, transacaoId): um valor digitado errado criaria um conjunto de
-- pedidos que nenhuma reconciliacao encontra, e sem o CHECK isso passaria em
-- silencio. Acrescentar um segundo gateway e uma linha aqui, de proposito.
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_provedor_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_provedor_check"
    CHECK ("provedor" IN ('blackcat'));

-- Cobranca de zero nao e cobranca, e duracao zero e uma assinatura que nasce
-- vencida. O banco recusa as duas, em vez de deixar a Fase 5 decidir o que
-- fazer com um pedido que nao significa nada.
--
-- `> 0` e mais estrito que o `>= 0` de "PlanoPreco"."precoCentavos", e e
-- deliberado: um preco pode ser zero (uma linha de vitrine sem cobranca), um
-- pedido nao — nada gratuito passa por PIX.
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_valores_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_valores_check"
    CHECK ("valorCentavos" > 0 AND "duracaoDias" > 0);

-- ── Indices ──────────────────────────────────────────────────────────────────

-- Nossa referencia, 128 bits de aleatoriedade, enviada a Blackcat em
-- `externalRef`. O unico garante que duas geracoes nunca colidam — e a colisao
-- aqui nao seria cosmetica: dois pedidos com a mesma referencia tornariam
-- ambiguo qual venda pertence a qual pedido na reconciliacao.
CREATE UNIQUE INDEX IF NOT EXISTS "PedidoPagamento_refExterna_key"
    ON "PedidoPagamento"("refExterna");

-- O transactionId da Blackcat. Nulo ate a venda existir; o indice unico do
-- Postgres aceita varios NULL, entao os dois requisitos convivem: "todo pedido
-- nasce sem transacao" e "uma transacao pertence a no maximo um pedido".
--
-- Este unico e a trava que impede a Fase 5 de ativar duas assinaturas a partir
-- da mesma transacao — no banco, e nao em `if`.
CREATE UNIQUE INDEX IF NOT EXISTS "PedidoPagamento_transacaoId_key"
    ON "PedidoPagamento"("transacaoId");

-- "os pedidos desta conta" — suporte, e a leitura que uma trava de retentativa
-- faria antes de criar mais um PIX.
CREATE INDEX IF NOT EXISTS "PedidoPagamento_userId_status_criadoEm_idx"
    ON "PedidoPagamento"("userId", "status", "criadoEm");

-- A varredura da reconciliacao da Fase 5: pedidos parados, por estado e
-- vencimento, sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS "PedidoPagamento_status_expiraEm_idx"
    ON "PedidoPagamento"("status", "expiraEm");

-- ── Chaves estrangeiras da propria tabela ────────────────────────────────────

-- CASCADE: apagar a conta leva os pedidos dela junto. Mesmo criterio de
-- "Assinatura"."userId". Ver a nota da FK de Assinatura abaixo sobre por que
-- isso exige NO ACTION, e nao RESTRICT, do outro lado.
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_userId_fkey";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT: plano com pedido nao e apagado. Descontinuar e `ativo = false`,
-- como em "Assinatura".
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_planoId_fkey";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_planoId_fkey"
    FOREIGN KEY ("planoId") REFERENCES "Plano"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, e nao SET NULL como em "Assinatura"."planoPrecoId": aqui a coluna e
-- NOT NULL. A diferenca nao e estilistica — apagar uma tabela de precos com
-- pedidos apagaria a prova de quanto foi cobrado.
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_planoPrecoId_fkey";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_planoPrecoId_fkey"
    FOREIGN KEY ("planoPrecoId") REFERENCES "PlanoPreco"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Integridade de "Assinatura"."pedidoId" ANTES de criar a FK ───────────────
--
-- A coluna existe desde a Fase 1 sem chave estrangeira, porque "PedidoPagamento"
-- nao existia. Producao pode ter linhas. Assumir que toda linha nao-nula aponta
-- para um pedido valido e exatamente o tipo de suposicao que quebra em
-- producao — e o ADD CONSTRAINT falharia com uma mensagem generica do Postgres,
-- num arquivo que ja teria criado a tabela.
--
-- Esta verificacao aborta a migration inteira com uma mensagem que diz o que
-- fazer. **Nada e apagado e nada e corrigido em silencio**: uma linha de
-- "Assinatura" apontando para pedido inexistente e direito concedido cuja
-- origem se perdeu, e isso e decisao humana, nao efeito colateral de migration.
--
-- Na pratica hoje o count e zero: a Fase 1 nasceu com a tabela vazia e nenhuma
-- rota escreve "Assinatura" ate a Fase 5. O bloco existe para o caso em que
-- isso deixou de ser verdade sem que este arquivo soubesse.
DO $$
DECLARE
    orfaos BIGINT;
BEGIN
    SELECT count(*) INTO orfaos
    FROM "Assinatura" a
    WHERE a."pedidoId" IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM "PedidoPagamento" p WHERE p."id" = a."pedidoId"
      );

    IF orfaos > 0 THEN
        RAISE EXCEPTION
            'Migration abortada: % assinatura(s) com pedidoId sem PedidoPagamento correspondente. Investigue uma a uma antes de continuar. NAO limpe a coluna para fazer a migration passar.',
            orfaos;
    END IF;
END $$;

-- ── A FK de "Assinatura"."pedidoId" ──────────────────────────────────────────
--
-- NO ACTION, e a escolha e tecnica, nao apenas conservadora:
--
--   * CASCADE esta fora de questao. Apagar um pedido apagaria a assinatura que
--     ele originou — direito pago desaparecendo por causa de uma limpeza de
--     pedidos. A Fase 1 ja registrava isso como proibido.
--
--   * RESTRICT recusa o DELETE **imediatamente, linha a linha**. NO ACTION faz
--     a mesma recusa, mas a verificacao roda no fim do comando. A diferenca
--     aparece num caso real: `DELETE FROM "User"` cascateia para "Assinatura"
--     (userId CASCADE) e para "PedidoPagamento" (userId CASCADE), e a ordem
--     entre as duas nao e definida. Com RESTRICT, apagar o pedido antes da
--     assinatura que o referencia aborta a exclusao da conta. Com NO ACTION, no
--     fim do comando as duas linhas ja sairam e a verificacao passa.
--
-- Ou seja: NO ACTION preserva a mesma protecao contra apagar pedido a mao — o
-- DELETE isolado continua sendo recusado — sem quebrar a exclusao de conta.
--
-- Opcionalidade e unicidade ficam como estao: a coluna continua nullable e o
-- indice unico "Assinatura_pedidoId_key" da Fase 1 continua valendo. Um pedido
-- ativa no maximo uma assinatura, garantido pelo banco.
ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_pedidoId_fkey";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_pedidoId_fkey"
    FOREIGN KEY ("pedidoId") REFERENCES "PedidoPagamento"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Mesmo criterio das tabelas da Fase 1 e da migration
-- 20260812_lock_down_supabase_public_roles: a aplicacao e server-only via
-- Prisma e nao usa a Data API do Supabase. Os grants de `anon`/`authenticated`
-- ja estao revogados por ALTER DEFAULT PRIVILEGES, que alcanca tabelas futuras
-- — mas RLS e por tabela e NAO e herdado.
--
-- Nenhuma policy, e nenhum GRANT: sem policy e com RLS ligado, ninguem le nada
-- por PostgREST. O Prisma conecta como dono da tabela e passa por cima, que e o
-- desenho. Numa tabela que guarda valor cobrado e referencia de transacao, a
-- segunda camada importa mais do que nas outras.

ALTER TABLE "PedidoPagamento" ENABLE ROW LEVEL SECURITY;

COMMIT;
