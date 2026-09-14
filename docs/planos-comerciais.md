# Planos comerciais — definição final, estado e dependências

Estado em 2026-09-13, branch `feat/planos-checkout-comercial`. Nada aqui foi
aplicado em Production: nenhum preço, nenhuma migration, nenhuma flag.

> **Ordem obrigatória de implantação.** O código desta branch lê colunas criadas
> pela migration `20260913_duracoes_adicionais_vip` (`Plano.servidorVip`,
> `PlanoPreco.duracaoMeses`, `PlanoAdicionalPreco`, `Assinatura.telasAdicionais`,
> `Assinatura.servidorVip`, colunas novas de `PedidoPagamento`). Implantar sem a
> migration aplicada quebra `/api/billing/plans`, `/api/billing/orders` e a
> resolução de entitlements. A migration foi **criada e não aplicada**; aplicar
> exige autorização explícita.

## 1. Onde mora cada verdade

| O quê | Fonte única | Quem consome |
|---|---|---|
| Direitos (o que o backend concede) | `Plano` + `Assinatura` no Postgres, via `entitlements.ts` | reprodução, canais, downloads, servidor VIP |
| Preço e duração do plano | `PlanoPreco` ativo, via `resolverPreco` | `/api/billing/orders` |
| Preço mensal dos adicionais | `PlanoAdicionalPreco` ativo | `/api/billing/orders`, `/api/billing/plans` |
| Total, operação e crédito | `montarCompra` (`pedidos.ts`), só com dados do servidor | `/api/billing/orders` |
| Vigência na ativação | `planejarAtivacao` (`confirmacao.ts`), recalculada na transação | confirmação de pagamento |
| Vitrine (o que se anuncia) | `src/lib/billing/vitrine.ts`, derivada de `Plano` | `GET /api/billing/plans` → TV, `/planos`, checkout |
| Bootstrap dos valores | `src/lib/planos.ts`, `src/lib/billing/catalogoComercial.ts` | só os scripts `seed:planos` e `precos:planos` |

Nenhum cliente guarda tabela própria de preço ou benefício, e nenhum valor
enviado pelo cliente é usado como preço.

## 2. Matriz final e o que é aplicado

| Benefício | Gratuito | Básico | Plus | Premium | Aplicado no servidor? |
|---|---|---|---|---|---|
| Nome público | Gratuito | Básico | Plus | Premium | — (`nomePublicoDoPlano`; ids internos mantidos) |
| Telas | 1 | 2 | 2 | 2 | **sim**, `telasMax` + `Assinatura.telasAdicionais` (máx. 2), com `MONETIZACAO_ATIVA` |
| Filmes e séries | sim | sim | sim | sim | **sim** |
| Qualidade prevista | SD | HD | Full HD | até 4K | **não** — anunciada como "Suporte a…" (seção 7) |
| Anúncios | obrigatórios | não | não | não | **sim**, `anunciosObrigatorios` |
| Downloads | não | não | sem anúncios | sem anúncios | **sim**, `downloads` |
| Canais | nenhum | nenhum | até `plus` | até `premium` | **sim**, `canaisNivel` |
| Servidor VIP | não | adicional (fora da oferta) | incluso | incluso | **sim**, `Plano.servidorVip OR Assinatura.servidorVip`, com `MONETIZACAO_ATIVA` |
| Suporte | sem prioridade | padrão | suporte | prioritário | processo, não direito |

VIP nunca é inferido pelo nome ou id do plano, nem autorizado por flag do
cliente. A vitrine não o anuncia enquanto `SERVIDOR_VIP_NA_VITRINE = false`, e
o checkout recusa o avulso enquanto `SERVIDOR_VIP_AVULSO_OFERTADO = false`.

## 3. Preços e durações

| Plano | 30 dias | 5 meses | 1 ano | Tela extra (mês) |
|---|---:|---:|---:|---:|
| Básico | R$ 10,00 | R$ 44,90 | R$ 95,90 | R$ 10,00 |
| Plus | R$ 19,90 | R$ 89,90 | R$ 189,90 | R$ 9,95 |
| Premium | R$ 29,90 | R$ 134,90 | R$ 284,90 | R$ 14,95 |

Servidor VIP avulso do Básico: R$ 5,90 por mês (linha criada **inativa**).

- **30 dias** é `PlanoPreco.duracaoDias = 30`; **5 meses** e **1 ano** são
  `duracaoMeses = 5 / 12`. Exatamente um dos dois (CHECK no banco).
- **Meses de calendário** em America/Sao_Paulo: quando o dia não existe no mês
  final, usa o último dia daquele mês (31/01 + 1 mês → 28/02). `vigencia.ts`.
- **Adicionais** custam `mensal × meses cobráveis` (30 dias = 1 mês; 5 meses = 5;
  1 ano = 12) e acompanham a duração inteira. Duração legada em dias sem
  meses cobráveis continua comprável, mas sem adicional (`duracao_invalida`).
- Máximo de **2 telas adicionais** (até 4 telas). CHECK no banco e validação no
  servidor (`telas_acima_do_limite`).

## 4. Renovação, upgrade e downgrade

Classificação no servidor por `Plano.ordem`, contra as assinaturas `ATIVA`
ainda não terminadas da conta (a vigente e as agendadas):

| Operação | Quando | Início | Crédito |
|---|---|---|---|
| `nova` | nenhum período em aberto | agora | — |
| `renovacao` | mesmo plano do último período | fim do último período | — |
| `downgrade` | plano de ordem menor | fim do período já pago | — |
| `upgrade` | plano de ordem maior | **agora** | não utilizado da vigente (proporcional, arredondado para baixo) + **valor integral** dos agendados |

- O crédito é calculado **só pelo servidor**, a partir de `PedidoPagamento.valorCentavos`
  dos períodos substituídos. Período sem pagamento (cortesia) não gera crédito.
- **Crédito maior ou igual ao total é recusado** (`credito_maior_que_compra`):
  o cliente precisa escolher uma duração que cubra o crédito. Não há saldo
  guardado nem PIX de valor zero.
- O pedido grava o snapshot: `valorPlanoCentavos`, `valorAdicionaisCentavos`,
  `creditoCentavos`, `operacao`, `assinaturasSubstituidas`. CHECK garante
  `valorCentavos = plano + adicionais − crédito` e crédito só em upgrade.
- **Na confirmação** a vigência é recalculada dentro da transação serializável:
  - renovação/downgrade começam no maior `terminaEm` em aberto naquele instante;
  - upgrade cancela exatamente os períodos creditados; se existir período em
    aberto que não estava no snapshot (outra compra no meio), o pedido vai para
    `REVISAO_MANUAL` em vez de ativar com crédito errado;
  - compra `nova` que encontra período em aberto também vai para revisão.
- **Estorno de upgrade** vai para revisão manual auditada: os períodos
  substituídos já foram cancelados e não são restaurados automaticamente.

## 5. Checkout

| Requisito | Estado |
|---|---|
| Plano e duração | **pronto** — `planoId` + `planoPrecoId`; preço e duração só do banco |
| Total calculado no servidor | **pronto** — `montarCompra`; campo financeiro no corpo é recusado |
| Telas adicionais | **pronto** — 0 a 2, preço de `PlanoAdicionalPreco`; seletor aparece só com preço ativo |
| VIP avulso (Básico) | **fora da oferta** — `adicional_indisponivel` |
| Cupom | **indisponível** — qualquer cupom é recusado (`cupom_invalido`); sem desconto fictício |
| CPF e telefone | **pronto** — `montarPagador`; só no corpo POST, nunca em URL, QR ou log |
| Pix | **pronto** — Blackcat, atrás de `BLACKCAT_PIX_ATIVO` |
| Renovação / upgrade / downgrade | **pronto** — seção 4; resposta informa `operacao`, `creditoCentavos`, `iniciaEm` |
| Confirmar antes de conceder | **pronto** — consulta servidor→servidor, `PAGO` antes de `Assinatura` |
| Notificação repetida | **pronto** — `EventoPagamento` único + `pedidoId` único na assinatura |
| Login no navegador | **pronto** — `/planos`, `/checkout`, `/conta` abertos; retorno preservado |

## 6. Servidor VIP

- **Classificação confiável:** vídeo `is_premium` do provedor, lido no servidor
  em `src/lib/cinevs.ts`.
- **Pontos de filtragem:** `extractCineVs`, chamado por `/api/player/extract` e
  `/api/player/fonte-nativa`. Sem direito, premium não é listado, não é
  escolhido e o `videoId` direto é recusado.
- **Direito:** `servidorVipDaConta` devolve `undefined` com `MONETIZACAO_ATIVA`
  desligada (sem filtro, comportamento atual) e, ligada, o
  `direitos.servidorVip` resolvido. Falha ao resolver **não libera** VIP.
- **Cache:** entrada de entitlements sem `servidorVip` é formato antigo e vira
  miss — recarrega do banco.
- **Oferta:** continua fora da vitrine e do checkout até decisão explícita.

## 7. Controle de resolução (registro separado)

`resolucaoMax` não é aplicado. Aplicar exigiria filtrar variantes HLS/MP4 por
teto no servidor (manifesto) ou no player de cada cliente. Impactos: Electron e
Android usam extração nativa (o servidor não vê o manifesto em todos os
caminhos); a TV usa ExoPlayer; clientes publicados não aplicariam um teto novo
sem atualização. Até lá, a vitrine usa "Suporte a…".

## 8. Migration e dados

`prisma/migrations/20260913_duracoes_adicionais_vip/`:

- `migration.sql` — transacional; colunas, CHECKs, `PlanoAdicionalPreco` com
  índice único parcial `(planoId, tipo) WHERE ativo` e RLS. **Não aplicada.**
- `VERIFICACAO.sql` — confere colunas, nulabilidade, CHECKs, índice e RLS.
- `ROLLBACK.sql` — reverte a estrutura.

Depois da migration, os dados comerciais vêm do script (dry-run por padrão):

```bash
npm run precos:planos
```

```bash
npm run precos:planos -- --apply --banco=<host>
```

Ele cria 9 preços, 4 adicionais (VIP inativo) e ajusta `Plano` (nome "Básico",
Plus em `fhd`, `servidorVip` em Plus e Premium). Valor divergente já ativo é
conflito e bloqueia o `--apply`; nada é sobrescrito.

## 9. Preview

`DATABASE_URL` e `DIRECT_URL` estão configurados para **Production e Preview**
na Vercel. Qualquer escrita "no Preview" é escrita em Production. Por isso a
migration e o script **não foram executados**, e só devem ser depois de existir
um banco próprio de Preview ou com autorização explícita para Production.
