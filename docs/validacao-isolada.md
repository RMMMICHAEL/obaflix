# Validação isolada — ambiente, decisões, implantação e revisão manual

Estado em 2026-09-13. **Nada deste documento foi executado.** Nenhuma migration
aplicada, nenhum preço criado, nenhuma variável da Vercel alterada. Os PRs #28 e
#27 continuam bloqueados para publicação.

## 1. Ambiente isolado de testes

### 1.1 Por que o Preview atual não serve

`DATABASE_URL` e `DIRECT_URL` estão configurados para Production **e** Preview.
Qualquer smoke no Preview de hoje escreve no banco de Production, e o código do
#28 lê colunas que só existem depois da migration. Um Preview que compila não
prova que `/api/billing/plans`, `/api/billing/orders` ou entitlements funcionam.

### 1.2 Configuração mínima proposta

Variáveis da Vercel com escopo **Preview restrito a uma branch** (ex.:
`feat/tv-planos-promocao`), ou um ambiente personalizado `teste`. Production não
é tocada, e os demais Previews continuam como estão.

| Recurso | Isolamento necessário | Por quê |
|---|---|---|
| Postgres (`DATABASE_URL`, `DIRECT_URL`) | projeto/banco **novo**, só com dados fictícios | migration, preços, pedidos e assinaturas de teste |
| Redis (`UPSTASH_REDIS_REST_URL/TOKEN`, `REDIS_URL`) | banco Upstash **separado** | pareamento TV, concessões/promoção, cache de entitlements, rate limit e bloqueio de IP usam chaves globais; compartilhar afetaria contas reais |
| Sessões (`NEXTAUTH_SECRET`, `NEXTAUTH_URL`) | segredo **diferente** e URL do Preview | cookies e access tokens da TV assinados com outro segredo não valem em Production, e vice-versa |
| Pagamento (`BLACKCAT_API_KEY`) | credencial de **sandbox**, se o provedor oferecer; senão, ver 1.4 | nenhuma cobrança real |
| Webhook (`BLACKCAT_WEBHOOK_PATH_SECRET`) | segredo **diferente** | o `postbackUrl` é montado por cobrança a partir da origem do próprio deploy e só com `BLACKCAT_CONFIRMACAO_ATIVA=true`; com origem e segredo próprios, notificação de teste não chega a Production |
| Flags | `MONETIZACAO_ATIVA=true`, `BLACKCAT_PIX_ATIVO`, `BLACKCAT_CONFIRMACAO_ATIVA` só neste escopo | Production segue sem monetização |
| `CRON_SECRET`, `ADMIN_SECRET_TOKEN` | valores **diferentes** | um vazamento do ambiente de teste não abre Production. Cron da Vercel só roda em Production: a reconciliação no teste é manual |
| Canais (Worker `media-proxy`) | Worker de teste ou canais fora do smoke | o Worker publicado lê o Redis de Production; sessões criadas no Redis de teste não existiriam lá |
| Provedor VIP (`WEBCINE_*`) | pode ser o mesmo, somente leitura | não escreve nada, mas conta no uso da conta do provedor |
| Proteção do Preview | token de bypass para automação ou acesso da equipe | a TV não passa pela autenticação da Vercel |
| APK de teste | build com `OBAFLIX_URL` do Preview isolado | o APK publicado aponta para Production |

Dados fictícios: contas com e-mail em domínio reservado (`@teste.obaflix.invalid`),
um usuário por plano, CPF de teste gerado para validação de formato, nenhum dado
de pessoa real.

### 1.3 Identificação inequívoca do banco de destino

Hostname sozinho não basta: ele pode ser copiado errado e não diz nada sobre o
conteúdo. Proposta, em camadas, para migration e para `precos:planos`:

1. **Marcador dentro do banco de teste**, criado só nele no bootstrap:
   tabela `_ObaflixAmbiente(id UUID, ambiente TEXT CHECK (ambiente = 'teste'))`
   com uma linha. Production não tem essa tabela.
2. **Pré-verificação SQL** antes da migration, na mesma sessão `psql`: aborta se
   o marcador não existir, se `ambiente <> 'teste'` ou se o `id` não for o
   informado no pedido de autorização.
3. **Conteúdo compatível com teste**: aborta se existir `PedidoPagamento` com
   status `PAGO` ou `User` com e-mail fora do domínio fictício.
4. **Confirmação humana** com: nome do ambiente, identificador do projeto do
   provedor de Postgres (sem segredo), `current_database()`, `id` do marcador e
   contagem de usuários. Só então a autorização é pedida.
5. O script `precos:planos` passaria a exigir `--ambiente-id=<uuid>` além de
   `--banco=<host>` e a repetir as verificações 1 e 3 antes do `--apply`.

Os itens 1–5 são proposta; a implementação e a aplicação dependem de
autorização.

### 1.4 Pagamento no smoke

Em ordem de preferência: (a) sandbox do provedor; (b) confirmação simulada no
banco de teste por script de teste — valida ativação e direitos, não o
provedor; (c) um PIX real de valor mínimo com preço exclusivo do ambiente de
teste — só com autorização explícita, porque envolve dinheiro real.

## 2. Decisões comerciais — aprovadas e pendentes

Fonte: mensagens desta conversa. "Implementado" não conta como aprovação.

| Regra | Situação | Fonte |
|---|---|---|
| 5 meses e 1 ano em meses de calendário; dia inexistente → último dia do mês | **aprovada** | "5 meses e 1 ano usam meses de calendário; quando o dia não existir no mês final, usar o último dia daquele mês." |
| Máximo de 2 telas adicionais (até 4) | **aprovada** | "Permitir no máximo 2 telas adicionais, totalizando até 4 telas." |
| Telas: valor mensal, pela duração inteira (10,00 / 9,95 / 14,95) | **aprovada** | "Elas acompanham a duração da assinatura." + valores mensais |
| Conversão de **30 dias = 1 mês** para cobrar adicional no plano de 30 dias | **pendente** | não foi dita; foi escolha de implementação |
| VIP do Básico: R$ 5,90 por mês, pela duração inteira | **aprovada** | "custa R$ 5,90 por mês e acompanha a duração inteira da assinatura." |
| VIP fora da oferta até entitlement real | **aprovada** — mantido fora (`SERVIDOR_VIP_AVULSO_OFERTADO=false`) | "Servidor VIP continua fora da oferta até existir entitlement real" |
| Renovação soma ao vencimento | **aprovada** | "Renovação do mesmo plano acrescenta a nova duração ao vencimento atual." |
| Upgrade imediato com crédito proporcional calculado no servidor | **aprovada** | "Upgrade deve ser imediato e preservar como crédito o valor proporcional..." |
| Downgrade no fim do período pago | **aprovada** | "Downgrade só entra em vigor ao terminar o período já pago." |
| Recusar quando o crédito cobre a compra (exigir duração maior) | **aprovada** | resposta "Exigir duração que cubra o crédito" |
| Período agendado substituído no upgrade e creditado integralmente | **aprovada** | resposta "Substituir e creditar integral" |
| Arredondamento do crédito para baixo (centavo) e proporção por tempo | **pendente** | detalhe de implementação |
| Estorno de upgrade vai para revisão manual | **pendente** | decisão de implementação, sem caminho operacional (seção 4) |
| Cupom indisponível | **aprovada** | "manter indisponível até existir regra/server-side apropriada" |

**Oferta pública:** hoje nada é ofertado — Production não tem preços, e os
adicionais só existiriam depois do script. Antes de rodar o script em qualquer
banco que atenda pessoas reais, as três pendências acima precisam de decisão;
até lá o preço de tela para o plano de 30 dias e o estorno de upgrade não
devem entrar em oferta.

## 3. Schema e implantação

A migration `20260913_duracoes_adicionais_vip` é **proposta para revisão**.

### 3.1 Compatibilidade com o código atualmente em Production

| Situação | Código de Production | Resultado |
|---|---|---|
| Migration aplicada, **sem** linhas em meses | colunas novas têm default; `duracaoDias` segue preenchido em todas as linhas | compatível |
| Pedido criado pelo código antigo | não informa colunas novas → `operacao='nova'`, `valorPlanoCentavos=NULL`, crédito 0 | passa nos CHECKs (composição só vale com `valorPlanoCentavos` preenchido) |
| Assinatura criada pelo código antigo | `telasAdicionais=0`, `servidorVip=false` | compatível |
| Linha de `PlanoPreco` ou `PedidoPagamento` **em meses** | o Prisma client antigo declara `duracaoDias` obrigatório; ler `NULL` gera erro de conversão | **incompatível** — quebra listagem de planos e leitura do pedido |

`MONETIZACAO_ATIVA=false` não elimina essa dependência: rotas de billing e a
consulta de entitlements do código novo selecionam as colunas novas mesmo com
a flag desligada.

### 3.2 Ordem obrigatória

1. Banco isolado criado e identificado (seção 1.3).
2. **Migration** aplicada e `VERIFICACAO.sql` conferido.
3. **Deploy** do código novo no mesmo ambiente.
4. Smoke das rotas sem preços em meses.
5. **Script de preços** (`--apply`) — cria linhas em meses e adicionais.
6. Smoke completo (seção 6).

Em Production a mesma ordem vale, com a migration antes do deploy e o script
somente depois do código novo estar servindo. Invertida, ou o código novo
quebra por falta de colunas (deploy antes da migration), ou o código antigo
quebra ao ler meses (script antes do deploy).

### 3.3 Pedidos e assinaturas existentes

- Pedidos antigos continuam válidos; confirmação de um pedido antigo pendente
  segue como compra `nova`. Se a conta já tiver período em aberto, vai para
  `REVISAO_MANUAL` em vez de criar período sobreposto.
- Assinaturas antigas não ganham telas nem VIP avulso.
- `Plano.servidorVip` nasce `false` para todos; Plus e Premium só ganham VIP
  quando o script ajusta os planos. Com monetização desligada, nada muda para
  o usuário nesse intervalo.
- Cache de entitlements sem `servidorVip` é descartado e relido do banco.

### 3.4 Recuperação em caso de falha

- **Antes do script (sem meses):** `ROLLBACK.sql` desfaz a estrutura; não há
  dado novo a perder.
- **Depois de existirem meses, adicionais ou crédito:** não usar `ROLLBACK.sql`.
  Ele derruba colunas de crédito e adicionais e para no `SET NOT NULL` — de
  propósito. Recuperação é para frente:
  1. `BLACKCAT_PIX_ATIVO=false` para parar vendas novas;
  2. exportar `PedidoPagamento` e `Assinatura` com as colunas novas (snapshot
     de valor, crédito, adicionais e substituições);
  3. desativar (`ativo=false`) as linhas de preço em meses e os adicionais, sem
     apagar — o código antigo só lê preços ativos;
  4. só então reverter o deploy, se necessário; pedidos em meses pendentes
     aguardam o código novo e não passam pela reconciliação durante a reversão;
  5. corrigir e reimplantar.
- Upgrade confirmado cancela os períodos substituídos apenas mudando `status`;
  datas originais e `assinaturasSubstituidas` ficam gravadas, o que permite
  restaurá-los se o pagamento for estornado.

## 4. Revisão manual de pagamentos (`REVISAO_MANUAL`)

### 4.1 Quando acontece

- valor devolvido pelo provedor diferente do snapshot;
- falha do provedor com `transacaoId` conhecido (a venda pode existir);
- confirmação que encontra assinatura já ligada a outro pedido;
- ativação impossível: compra `nova` com período em aberto, ou upgrade cujos
  períodos em aberto não batem com `assinaturasSubstituidas`;
- estorno de upgrade;
- divergência na reconciliação.

Nenhum desses caminhos cria ou estende assinatura. `Assinatura.pedidoId` é
único, o que impede ativação duplicada do mesmo pedido.

### 4.2 Como aparece hoje — com lacunas

| Para quem | Hoje | Lacuna |
|---|---|---|
| Comprador | checkout mostra "Pagamento pendente" e `Status: REVISAO_MANUAL`; o polling para | texto técnico, sem prazo nem orientação; ao recarregar, `/api/billing/orders/pending` só devolve `AGUARDANDO` e o pedido some — a pessoa pode pagar de novo |
| Operação | evento `billing_payment_review` no log de auditoria em parte dos caminhos | não há lista, painel, alerta nem motivo gravado no pedido; nenhum fluxo para resolver |

**Conclusão:** `REVISAO_MANUAL` hoje protege contra ativação indevida, mas
**não é solução completa** — falta o caminho operacional. Isso bloqueia a
publicação de vendas.

### 4.3 Caminho proposto (não implementado)

1. **Comprador:** mensagem "Pagamento em análise. Você não precisa pagar de
   novo; avisaremos em até X horas", e `pending` passando a devolver também
   pedidos em revisão, bloqueando um segundo PIX para o mesmo plano.
2. **Registro:** motivo da revisão gravado no pedido (coluna nova, depende de
   migration autorizada) em vez de só no log.
3. **Operação:** rota admin autenticada listando pedidos em revisão com motivo,
   valor, `transacaoId` mascarado e estado no provedor consultado na hora.
4. **Resoluções**, sempre dentro de transação serializável e idempotentes:
   - *ativar*: reaproveita a confirmação — recalcula a vigência, respeita
     `pedidoId` único e registra auditoria de quem aprovou;
   - *estornar*: estorno no provedor, pedido `ESTORNADO`; se era upgrade,
     restaura os períodos em `assinaturasSubstituidas`;
   - *manter pago sem ativar*: registra crédito para uso futuro — **depende de
     decisão comercial**, porque hoje não existe saldo de crédito.
5. **Prazo e alerta:** revisão mais antiga que o prazo gera alerta para a
   operação.

Nada disso substitui a regra atual: o valor pago nunca é descartado e nenhuma
ativação acontece sem confirmação do provedor.

## 5. CI e testes intermitentes

- **CI no código integrado:** CI Web rodou no commit do #27 (disparo manual,
  sucesso). O workflow passa a rodar também em PR com base `feat/**`.
- **Falha no #28:** "A continua valendo DURANTE a grace" (e o teste pai).
  Causa: a comparação usava segmentos cunhados em subtestes diferentes; cada
  URL leva `e = segundo atual + TTL`. Evidência: forçando uma fronteira de
  segundo entre os dois manifestos, a falha reproduz com o mesmo caminho,
  `e` +1 e `k` diferente. Correção: comparar dois manifestos do mesmo instante
  (relógio congelado), com igualdade exata.
- **Segundo defeito encontrado na investigação:** "descobertas concorrentes de
  bases diferentes" assumia que a primeira chamada recebe o primeiro manifesto
  da fila. Com a ordem perturbada, a primeira recebeu o segundo e o teste
  falhou sem defeito no Worker. Correção: casar cada segmento com o upstream
  que ele realmente busca; a garantia continua exata.
- Com as duas perturbações aplicadas, os testes corrigidos passam; nenhum
  teste foi desativado ou afrouxado.

## 6. Smoke — pendente de ambiente e autorização

Depende das seções 1 e 3. Roteiro:

1. Compra e autorização dos quatro planos (Gratuito sem compra; Básico, Plus,
   Premium em 30 dias, 5 meses e 1 ano).
2. Preços por duração iguais na TV, em `/planos` e no checkout.
3. QR na TV → navegador → login/cadastro → checkout com o plano escolhido.
4. VIP e canais conforme entitlement de cada plano.
5. Gratuito: promoção → conclusão → reprodução; nova promoção no episódio
   seguinte.
6. Assinante: reprodução sem promoção.
7. Cancelamento da promoção, falha de rede e recuperação no mesmo aparelho.
8. Foco, D-pad e Voltar em dispositivo ou emulador.
9. Login persistente da TV (ver `docs/tv-login-persistente.md` no #27).

Screenshots só serão anexados quando o smoke for executado de fato.
