-- Compra Cortes sem login: o pedido nasce sem conta, com o e-mail de quem
-- comprou; a conta é criada ou vinculada na confirmação autenticada do
-- pagamento. Expand puro: só relaxa NOT NULL e acrescenta colunas anuláveis.
-- Linhas existentes não mudam e o código anterior continua funcionando.
-- Nunca CPF: o documento vai só ao provedor.
ALTER TABLE "PedidoPagamento" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "emailComprador" TEXT;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "nomeComprador" TEXT;

-- Todo pedido tem dono: a conta ou o e-mail que vai virar a conta.
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_dono_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_dono_check"
    CHECK ("userId" IS NOT NULL OR "emailComprador" IS NOT NULL);

-- Revisão de pedido sem conta ainda não tem conta a desnormalizar.
ALTER TABLE "RevisaoPagamento" ALTER COLUMN "userId" DROP NOT NULL;
