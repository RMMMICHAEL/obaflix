# Revisão manual de pagamentos

Estado em 2026-09-14, branch `feat/planos-checkout-comercial`. **Código pronto,
schema só proposto.** As tabelas abaixo não existem em banco nenhum; criar ou
aplicar a migration depende de autorização explícita. Sem elas, as rotas de
pedido, confirmação e revisão falham — não publicar antes.

## 1. O que o fluxo garante

| Garantia | Como |
|---|---|
| Pedido em revisão continua visível depois de recarregar, sair e entrar | `/api/billing/orders/pending` devolve primeiro o caso pendente da conta |
| Mensagem única, sem prazo nem notificação | `MENSAGEM_DE_REVISAO_AO_COMPRADOR` |
| Motivo, data e histórico gravados | `RevisaoPagamento` + `RevisaoPagamentoEvento`, códigos internos |
| Nenhuma compra nova com revisão pendente, inclusive simultânea | checagem inicial + regravação com trava transacional por conta (`pg_advisory_xact_lock`) na mesma transação do `INSERT` do pedido; quem abre revisão usa a mesma trava |
| Consulta administrativa protegida | `GET /api/admin/pagamentos/revisoes` com `requireAdmin` |
| Resolução autenticada, auditada e sem execução duplicada | `POST /api/admin/pagamentos/revisoes/:id` com chave de idempotência única, conta travada, caso relido travado e escritas condicionadas |
| Nenhuma ativação sem pagamento confirmado | `ativar` exige `PAID` com a mesma transação e o mesmo valor, consultado na hora |
| Nenhum estorno só por ação local | `confirmar_estorno` exige `REFUNDED` no provedor |
| Nenhum saldo ou carteira | não existe efeito que crie crédito; recompor só reativa períodos |

## 2. Motivos (códigos internos)

| Código | Quando |
|---|---|
| `criacao_valor_divergente` | venda criada com valor diferente do pedido |
| `criacao_falha_com_transacao` | provedor falhou na criação, mas a transação existe |
| `confirmacao_divergente` | transação ou valor da confirmação diferentes do pedido |
| `confirmacao_status_desconhecido` | status fora de `PENDING/PAID/CANCELLED/REFUNDED` |
| `pago_apos_expiracao` | `PAID` depois do vencimento do PIX |
| `pedido_em_estado_inesperado` | confirmação para pedido que não aguardava pagamento |
| `pedido_ja_vinculado` | assinatura já ligada ao pedido em estado inconsistente |
| `ativacao_periodo_em_aberto` | compra nova paga com período em aberto |
| `ativacao_substituicao_divergente` | upgrade pago com períodos diferentes dos creditados |
| `ativacao_duracao_invalida` / `ativacao_operacao_invalida` | snapshot do pedido inválido |
| `estorno_upgrade` | estorno confirmado de upgrade — recompor direitos |
| `reconciliacao_inconsistente` | conflito ao gravar a assinatura do pedido |

Tipos de evento: `aberta`, `motivo_registrado`, `acao_executada`,
`acao_recusada`, `resolvida`. Ator: `sistema`, `token_admin` ou id do admin.

## 3. Estorno de upgrade (regra aprovada)

1. **Na confirmação** (`REFUNDED` do provedor): pedido `ESTORNADO` já, a
   assinatura criada pelo upgrade é cancelada e o caso `estorno_upgrade` é
   aberto. **Nada é restaurado e nenhum crédito é criado.** Notificação repetida
   não abre segundo caso.
2. **Na análise**, a ação `recompor_upgrade`:
   - exige pedido `ESTORNADO`, operação `upgrade` e `REFUNDED` consultado na hora;
   - recusa se a conta tiver **qualquer** outro período em aberto (compra
     posterior, cortesia) — sobreporia períodos;
   - reativa só assinaturas listadas em `assinaturasSubstituidas`, com status
     `CANCELADA`, observação `substituida pelo pedido <id deste pedido>` e
     `terminaEm` no futuro;
   - cada reativação é condicional ao estado esperado; repetir não reativa de
     novo;
   - sem período vigente a restaurar, o caso é encerrado como
     `upgrade_sem_periodo_restante`.

**Consequência a conhecer:** entre o estorno e a análise, a conta fica sem o
plano do upgrade e sem os períodos substituídos. É o lado seguro — não mantém
acesso estornado — e o comprador vê a mensagem de análise.

## 4. Ações administrativas

| Ação | Exige | Efeito | Resolve |
|---|---|---|---|
| `reconsultar` | resposta do provedor com a mesma transação | registra o status informado | não |
| `ativar` | pedido `REVISAO_MANUAL`, sem assinatura, `PAID`, mesmo valor, vigência válida agora | cancela substituídos, cria assinatura (`pedidoId` único), pedido `PAGO` | `ativada` |
| `confirmar_estorno` | `REFUNDED`, mesmo valor | pedido `ESTORNADO`, assinatura do pedido cancelada; em upgrade, motivo vira `estorno_upgrade` | não em upgrade; `estorno_confirmado` nos demais |
| `confirmar_nao_pago` | pedido `REVISAO_MANUAL` sem assinatura; `CANCELLED`, ou `PENDING` com PIX vencido | pedido `CANCELADO`/`EXPIRADO` | `nao_pago_confirmado` |
| `recompor_upgrade` | seção 3 | reativa períodos elegíveis | `upgrade_recomposto` / `upgrade_sem_periodo_restante` |
| `encerrar_sem_alteracao` | observação ≥ 10 caracteres; pedido já fora de `REVISAO_MANUAL` | nenhum | `encerrada_sem_alteracao` |

Provedor sem resposta → `503 provedor_indisponivel`, nada muda. Recusa →
`422 <código>`, registrada no histórico. Caso já resolvido → `409`. Mesma chave
de novo → devolve o resultado anterior, sem consultar nem escrever.

**Limite:** o cliente da Blackcat não tem chamada de estorno. O estorno é feito
no painel do provedor; a ação só o **confirma** depois de o provedor informar
`REFUNDED`.

## 5. Roteiro operacional

Autenticação: sessão de usuário com papel `admin` no navegador, ou o cabeçalho
`x-admin-token` (valor só em variável de ambiente local, nunca em comando salvo).

```bash
curl -s -H "x-admin-token: $OBAFLIX_ADMIN_TOKEN" "https://<ambiente>/api/admin/pagamentos/revisoes?status=PENDENTE"
```

```bash
curl -s -X POST -H "x-admin-token: $OBAFLIX_ADMIN_TOKEN" -H "content-type: application/json" -d "{\"acao\":\"reconsultar\",\"chaveIdempotencia\":\"$(uuidgen | tr -d -)\"}" "https://<ambiente>/api/admin/pagamentos/revisoes/<revisaoId>"
```

Sequência sugerida por caso:

1. `reconsultar` — ver o estado real no provedor.
2. `PAID` com valor certo → `ativar`. Se recusar por período em aberto,
   investigar antes de qualquer outra ação.
3. `CANCELLED` ou PIX vencido → `confirmar_nao_pago`.
4. Estorno necessário → estornar no painel do provedor → `confirmar_estorno` →
   em upgrade, `recompor_upgrade`.
5. Caso já consistente por outro caminho → `encerrar_sem_alteracao` com
   observação.

Uma chave nova por **intenção**; reenviar a mesma chave é seguro.

## 6. Schema proposto (não criado, não aplicado)

```sql
BEGIN;

CREATE TABLE "RevisaoPagamento" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resolucao" TEXT,
    "abertaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvidaEm" TIMESTAMP(3),
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RevisaoPagamento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevisaoPagamento_pedidoId_fkey" FOREIGN KEY ("pedidoId")
        REFERENCES "PedidoPagamento"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "RevisaoPagamento_status_check" CHECK ("status" IN ('PENDENTE', 'RESOLVIDA')),
    CONSTRAINT "RevisaoPagamento_resolucao_check" CHECK (
        ("status" = 'PENDENTE' AND "resolucao" IS NULL AND "resolvidaEm" IS NULL)
        OR ("status" = 'RESOLVIDA' AND "resolucao" IS NOT NULL AND "resolvidaEm" IS NOT NULL)),
    CONSTRAINT "RevisaoPagamento_motivo_check" CHECK ("motivo" IN (
        'criacao_valor_divergente', 'criacao_falha_com_transacao', 'confirmacao_divergente',
        'confirmacao_status_desconhecido', 'pago_apos_expiracao', 'pedido_em_estado_inesperado',
        'pedido_ja_vinculado', 'ativacao_periodo_em_aberto', 'ativacao_substituicao_divergente',
        'ativacao_duracao_invalida', 'ativacao_operacao_invalida', 'estorno_upgrade',
        'reconciliacao_inconsistente'))
);

-- No máximo um caso pendente por pedido. Parcial: o Prisma 5 não o representa.
CREATE UNIQUE INDEX "RevisaoPagamento_pendente_unico_idx"
    ON "RevisaoPagamento"("pedidoId") WHERE "status" = 'PENDENTE';
CREATE INDEX "RevisaoPagamento_status_abertaEm_idx" ON "RevisaoPagamento"("status", "abertaEm");
CREATE INDEX "RevisaoPagamento_userId_status_idx" ON "RevisaoPagamento"("userId", "status");
CREATE INDEX "RevisaoPagamento_pedidoId_idx" ON "RevisaoPagamento"("pedidoId");

CREATE TABLE "RevisaoPagamentoEvento" (
    "id" TEXT NOT NULL,
    "revisaoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "ator" TEXT NOT NULL,
    "observacao" TEXT,
    "chaveIdempotencia" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RevisaoPagamentoEvento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevisaoPagamentoEvento_revisaoId_fkey" FOREIGN KEY ("revisaoId")
        REFERENCES "RevisaoPagamento"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "RevisaoPagamentoEvento_tipo_check" CHECK ("tipo" IN
        ('aberta', 'motivo_registrado', 'acao_executada', 'acao_recusada', 'resolvida')),
    CONSTRAINT "RevisaoPagamentoEvento_observacao_check" CHECK ("observacao" IS NULL OR length("observacao") <= 500)
);

CREATE UNIQUE INDEX "RevisaoPagamentoEvento_chaveIdempotencia_key"
    ON "RevisaoPagamentoEvento"("chaveIdempotencia");
CREATE INDEX "RevisaoPagamentoEvento_revisaoId_criadoEm_idx"
    ON "RevisaoPagamentoEvento"("revisaoId", "criadoEm");

-- Histórico imutável.
CREATE OR REPLACE FUNCTION "revisao_evento_imutavel"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'RevisaoPagamentoEvento e somente insercao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RevisaoPagamentoEvento_imutavel"
    BEFORE UPDATE OR DELETE ON "RevisaoPagamentoEvento"
    FOR EACH ROW EXECUTE FUNCTION "revisao_evento_imutavel"();

ALTER TABLE "RevisaoPagamento" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevisaoPagamentoEvento" ENABLE ROW LEVEL SECURITY;

COMMIT;
```

Pontos para decidir junto da autorização:

- `userId` sem chave estrangeira (desnormalizado para a trava e a consulta).
  Com FK `NO ACTION` para `User`, uma exclusão de conta com caso financeiro
  seria bloqueada — pode ser o desejado, mas afeta pedidos de exclusão de conta.
- O trigger impede corrigir histórico por SQL. Correção passa a ser um novo
  evento.

## 7. Verificado e não verificado

- **Coberto por testes (`billingRevisao.test.ts`):**
  - bloqueio de compra, inclusive com requisições simultâneas e revisão aberta no meio;
  - planejamento de cada ação e as recusas;
  - idempotência e concorrência do executor;
  - estorno de upgrade na confirmação, sem caso duplicado;
  - rotas do comprador e admin (autenticação, origem, ator, máscara).
- **Não verificado sem banco:**
  - `pg_advisory_xact_lock` via `$executeRaw`;
  - índice parcial, trigger e CHECKs;
  - serialização real de transações concorrentes.

  Isso entra no smoke do ambiente isolado, depois de autorizada a migration lá.
