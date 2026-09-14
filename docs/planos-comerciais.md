# Planos comerciais — definição final, estado e dependências

Estado em 2026-09-13, branch `feat/planos-checkout-comercial`. Nada aqui foi
aplicado em Production: nenhum preço, nenhuma migration, nenhuma flag.

## 1. Onde mora cada verdade

| O quê | Fonte única | Quem consome |
|---|---|---|
| Direitos (o que o backend concede) | `Plano` no Postgres, via `entitlements.ts` | rotas de reprodução, canais, downloads |
| Preço e duração (o que se cobra) | `PlanoPreco` ativo, via `resolverPreco` | checkout (`/api/billing/orders`) |
| Vitrine (o que se anuncia) | `src/lib/billing/vitrine.ts`, derivada de `Plano` | `GET /api/billing/plans` → TV, `/planos`, checkout |
| Bootstrap dos valores | `src/lib/planos.ts`, `src/lib/billing/catalogoComercial.ts` | só os scripts `seed:planos` e `precos:planos` |

Nenhum cliente guarda tabela própria de preço ou benefício. O APK da TV passa a
ler a vitrine da API (PR #27).

## 2. Matriz final e o que é aplicado

| Benefício | Gratuito | Básico | Plus | Premium | Aplicado no servidor? |
|---|---|---|---|---|---|
| Nome público | Gratuito | Básico | Plus | Premium | — (`nomePublicoDoPlano`; ids internos mantidos) |
| Telas | 1 (regra atual) | 2 | 2 | 2 | **sim**, `telasMax`, com `MONETIZACAO_ATIVA` |
| Filmes e séries | sim | sim | sim | sim | **sim** |
| Qualidade prevista | SD | HD | Full HD | até 4K | **não** — `resolucaoMax` gravado, nenhuma rota limita |
| Anúncios | obrigatórios | não | não | não | **sim**, `anunciosObrigatorios` |
| Downloads | não | não | sem anúncios | sem anúncios | **sim**, `downloads` (download existe só no Electron) |
| Canais | nenhum | nenhum | até `plus` | até `premium` | **sim**, `canaisNivel`, sempre |
| Servidor VIP | — | adicional | incluso | incluso | **não** — direito inexistente (seção 5) |
| Suporte | sem prioridade | padrão | suporte | prioritário | processo, não direito |

Vitrine: qualidade aparece como "Suporte a HD / Full HD / até 4K quando
disponível"; canais como "Canais até o nível Plus/Premium"; o Básico mostra
"Sem downloads"; VIP não aparece enquanto `SERVIDOR_VIP_NA_VITRINE = false`.

## 3. Preços e durações

| Plano | 30 dias | 5 meses | 1 ano |
|---|---:|---:|---:|
| Básico | R$ 10,00 | R$ 44,90 | R$ 95,90 |
| Plus | R$ 19,90 | R$ 89,90 | R$ 189,90 |
| Premium | R$ 29,90 | R$ 134,90 | R$ 284,90 |

- **30 dias:** representável hoje (`PlanoPreco.duracaoDias = 30`). Preparado no
  script `npm run precos:planos` (dry-run).
- **5 meses e 1 ano:** decisão tomada — **meses de calendário**. `PlanoPreco` e
  `PedidoPagamento` só guardam dias, e `periodoAssinatura` soma
  `dias × 86 400 000 ms`. Esses preços ficam em `PRECOS_PENDENTES_DE_SCHEMA` e
  **não são criados** até existir a coluna (proposta 6.1).
- Cada duração é uma linha de `PlanoPreco` do mesmo plano: não é plano novo e
  não muda direito. `/planos` já lista todas as linhas ativas; o checkout recebe
  `planoPrecoId`.

## 4. Checkout

| Requisito | Estado |
|---|---|
| Plano e duração | **pronto** — `planoId` + `planoPrecoId`; preço e duração só do banco |
| Total calculado no servidor | **pronto** — `resolverPreco`; campo financeiro no corpo é recusado |
| CPF e telefone | **pronto** — `montarPagador`; só no corpo POST, nunca em URL, QR ou log |
| Cupom | **contrato pronto, sempre recusado** — `cupom_invalido`; não existe catálogo nem regra de desconto |
| Telas adicionais | **contrato pronto, recusado** — `adicional_indisponivel` |
| VIP avulso (Básico) | **contrato pronto, recusado** — `adicional_indisponivel` |
| Pix | **pronto** — Blackcat, atrás de `BLACKCAT_PIX_ATIVO` |
| Confirmar antes de conceder | **pronto** — consulta servidor→servidor, `PAGO` antes de `Assinatura` |
| Notificação repetida | **pronto** — `EventoPagamento` único + `pedidoId` único na assinatura |
| Login no navegador | **pronto** — `/planos`, `/checkout`, `/conta` abertos; retorno preservado |

**Pendência comercial:** a rota de pedidos recusa compra de quem já tem
assinatura ativa (`assinatura_ativa`). "Fazer upgrade" na TV hoje termina nessa
recusa. Upgrade, renovação e crédito do período restante precisam de regra
aprovada.

## 5. Servidor VIP

- **Classificação confiável:** vídeo `is_premium` do provedor Webcine, lido no
  servidor em `src/lib/cinevs.ts`.
- **Pontos de filtragem:** `extractCineVs` — chamado por `/api/player/extract`
  (lista `fontes` ao cliente e resolve `video=`) e `/api/player/fonte-nativa`.
  Implementado: sem direito, premium não é listado, não é escolhido e o
  `videoId` direto é recusado.
- **Estado:** desligado. `servidorVipDaConta` devolve `undefined` (direito não
  modelado) e o filtro não age — premium segue chegando a qualquer conta, como
  antes. **Bloqueio de publicação da oferta de VIP.**

## 6. Propostas de schema (não criadas, não aplicadas)

### 6.1 Duração em meses

```text
PlanoPreco.duracaoMeses       INT NULL   CHECK (duracaoMeses BETWEEN 1 AND 24)
PlanoPreco                    CHECK ((duracaoDias IS NULL) <> (duracaoMeses IS NULL))
                              (duracaoDias passa a aceitar NULL)
PedidoPagamento.duracaoMeses  INT NULL   snapshot, mesma regra
```

Código: `resolverPreco` e o snapshot levam um dos dois; `periodoAssinatura`
soma meses de calendário. **Regra ainda a decidir:** fim de mês — ex. início em
31/01 + 1 mês termina em 28/02 ou 03/03.
Impacto: duas tabelas, validação e confirmação de pedido, rótulos na vitrine.
Nenhum cliente de app muda.

### 6.2 Servidor VIP

```text
Plano.servidorVip  BOOLEAN NOT NULL DEFAULT false      (dados: plus e premium = true)
AssinaturaAdicional(
  id, assinaturaId FK, tipo CHECK IN ('servidor_vip','tela'),
  quantidade INT, iniciaEm, terminaEm, status, pedidoId UNIQUE, criadoEm
)
```

Código: `DireitosDoPlano.servidorVip`; `entitlements.ts` resolve
`plano.servidorVip OR adicional servidor_vip vigente`; entrada em
`direitosAplicados.ts`; formato do cache de entitlements (invalidar na
implantação); `servidorVipDaConta` passa a devolver o direito atrás de
`MONETIZACAO_ATIVA`; `SERVIDOR_VIP_NA_VITRINE = true` só depois.
Impacto: com a flag ligada, Gratuito e Básico sem adicional deixam de receber os
vídeos premium que recebem hoje. **Regra ainda a decidir:** validade e cobrança
do adicional de R$ 5,90 em assinaturas de 30 dias, 5 meses e 1 ano.

### 6.3 Telas adicionais

A mesma `AssinaturaAdicional` com `tipo = 'tela'`; `telasMax` efetivo =
`Plano.telasMax + soma das telas vigentes`. Valores definidos: Básico R$ 10,00,
Plus R$ 9,95, Premium R$ 14,95. **A decidir:** máximo de telas, validade,
cálculo em 5 meses e 1 ano, contratação durante assinatura vigente.

### 6.4 Cupom

`Cupom(codigo UNIQUE, tipo, valor, validade, usosMax, ativo)` e, no pedido,
`cupomId` + `descontoCentavos` em snapshot. **A decidir:** qualquer regra de
desconto — hoje a definição comercial diz "sem descontos".

## 7. Controle de resolução (registro separado)

`resolucaoMax` não é aplicado. Aplicar exigiria filtrar variantes HLS/MP4 por
teto no servidor (manifesto) ou no player de cada cliente. Impactos: Electron e
Android usam extração nativa (o servidor não vê o manifesto em todos os
caminhos); a TV usa ExoPlayer; clientes publicados não aplicariam um teto novo
sem atualização. Até lá, a vitrine usa "Suporte a…".

## 8. Preview

`DATABASE_URL` e `DIRECT_URL` estão configurados para **Production e Preview**
na Vercel. Qualquer escrita "no Preview" é escrita em Production. O script:

```bash
npm run precos:planos                                  # dry-run
npm run precos:planos -- --apply --banco=<host>        # recusa sem o host exato
```

Só deve rodar com `--apply` depois de existir um banco próprio de Preview.
