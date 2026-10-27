-- Data de nascimento informada na compra Cortes sem login. Expand puro: duas
-- colunas anuláveis, sem default e sem reescrita; contas e pedidos existentes
-- não mudam e o código anterior continua funcionando.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dataNascimento" DATE;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "nascimentoComprador" DATE;
