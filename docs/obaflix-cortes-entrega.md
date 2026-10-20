# Obaflix Cortes — requisitos comerciais de entrega

Status: **requisitos registrados, nada implementado**. Este documento descreve
como um cliente passa a ter um plano Cortes. Não altera código, banco, Preview
nem produção. Relacionados: `cortes-planos-comerciais.md`,
`cortes-permissoes-servidor.md`, `cortes-electron-integracao.md`,
`monetizacao-arquitetura.md`.

## Regras de acesso já vigentes (branch `feat/cortes-permissoes`)

| Conta | Download completo | Corte individual | Corte em lote |
|---|---|---|---|
| Gratuita | Sim, com anúncio quando a política exige | Não | Não |
| Básico / Plus / Premium | Sim, conforme isenções do plano | Não | Não |
| Cortes Start | Sim, com as regras de anúncio aplicáveis | Sim | Não |
| Cortes Pro | Sim, idem | Sim | Sim |
| Cortes AI | Sim, idem | Sim | Sim (IA ainda não disponível) |

O Cortes é o Obaflix completo com ferramentas de corte, não uma versão
reduzida: o download completo é de toda conta, e o que varia é o anúncio
(`anunciosObrigatorios`). Decisão no servidor (`downloadPermitido`,
`direitosDoCliente` em `src/lib/playbackAuthorization.ts`), obedecida pelo
modal de downloads do Electron.

## Fluxo 1 — usuário Obaflix existente

1. O usuário continua com a conta, o histórico e o plano atuais (gratuito ou
   tradicional). Nada muda no acesso ao catálogo nem no download completo, que
   segue as regras de anúncio e isenções do plano.
2. Ao escolher trecho ou lote sem plano Cortes, o modal mostra a opção bloqueada
   e o CTA **Conhecer planos** (abre `/planos` no navegador do sistema).
3. A contratação do plano Cortes **soma** ao plano tradicional; não o substitui
   nem encerra. Ver "Acúmulo de assinaturas".
4. Ao confirmar o pagamento, o direito de cortes passa a valer na próxima
   resolução de entitlements (cache curto já existente), sem novo login.

## Fluxo 2 — comprador pela página de vendas (BlackCat)

1. **Checkout** coleta: nome completo, e-mail, CPF e data de nascimento.
   - O CPF é exigido pelo meio de pagamento e vai **somente** à BlackCat.
2. **Confirmação autenticada** do pagamento: a conta só é criada/vinculada após
   evento de pagamento confirmado e autenticado (webhook com segredo de caminho
   e verificação do pedido junto à BlackCat). Retorno de navegador, parâmetro de
   URL ou status informado pelo cliente **nunca** concedem plano.
3. **Criação ou vinculação idempotente da conta** (ver seção própria).
4. **Ativação**: assinatura Cortes com `origem = "pagamento"`, vinculada ao
   pedido (`pedidoId` único: um pedido ativa no máximo um direito).
5. **Entrega**: e-mail com o link de download do aplicativo e as instruções de
   acesso. O e-mail não contém senha nem link que dispense a verificação.
6. **Primeiro acesso no app**:
   1. o comprador informa o e-mail;
   2. o Obaflix envia **código de uso único ou link seguro** (curta validade,
      uso único, limitado por tentativas e por IP/conta);
   3. só após confirmar a titularidade o comprador **define a senha**;
   4. a sessão é aberta normalmente e os direitos Cortes já aparecem no modal.
7. Se o e-mail já pertence a uma conta Obaflix, o passo 6 vale como login/
   recuperação daquela conta: nenhuma conta nova é criada e a senha existente só
   é trocada se o titular escolher redefini-la.

## Dados pessoais

| Dado | Coletado no checkout | Persistido no Obaflix |
|---|---|---|
| Nome completo | Sim | Sim |
| E-mail | Sim | Sim (chave de vínculo da conta) |
| Data de nascimento | Sim | Sim (regras de anúncio por idade) |
| CPF | Sim | **Não** — nunca gravado em banco, log, auditoria, cache ou fila |

Além disso, apenas identificadores técnicos mínimos da compra: id do pedido
interno, id da transação/pedido na BlackCat, plano e período, valores, status e
datas. Sem dados de cartão, sem documento, sem endereço.

Requisitos derivados:
- logs e auditoria mascaram o payload do webhook (o CPF pode vir nele);
- a política de privacidade passa a citar nascimento e a finalidade;
- hoje o modelo `User` **não** tem campo de nascimento: exigirá migration
  (fora desta etapa).

## Idempotência e não duplicação por e-mail

- E-mail normalizado (trim + minúsculas) é a chave de vínculo; uma conta por
  e-mail, garantido por índice único no banco, não por `if`.
- O processamento do webhook é idempotente por pedido: reentregas do mesmo
  evento não criam conta, assinatura nem e-mail duplicados (`pedidoId` único +
  transação atômica "busca ou cria conta → cria assinatura do pedido").
- Duas compras simultâneas com o mesmo e-mail convergem para a mesma conta.
- Pagamento confirmado para e-mail com conta existente → vincula a essa conta.

## Clientes existentes e acúmulo de assinaturas

- Clientes existentes mantêm conta, histórico e benefícios antigos.
- Uma conta pode ter **ao mesmo tempo** uma assinatura tradicional
  (Básico/Plus/Premium) e um plano Cortes.
- Direito efetivo = combinação dos dois: catálogo, telas, anúncios e download
  completo vêm do tradicional (ou do gratuito); `cortesNivel` vem do Cortes.
  Encerrar um não afeta o outro.

## Arquitetura atual: adaptação obrigatória antes do checkout

Hoje a conta tem **uma única assinatura** (`User.assinatura Assinatura?`,
relação 1:1) e os entitlements são resolvidos a partir dela. Contratar Cortes
nesse modelo substituiria o plano tradicional — inaceitável pelas regras acima.

Antes de abrir o checkout Cortes é preciso:
1. permitir mais de uma assinatura ativa por conta, separadas por família
   (`tradicional` e `cortes`), no máximo uma ativa por família;
2. resolver os entitlements combinando as assinaturas ativas (incluindo cache e
   invalidação);
3. adaptar telas de conta, admin, vencimento, renovação e relatórios;
4. migration expand/contract sem perder assinaturas existentes.

Nenhum checkout Cortes deve ir a produção sem esses itens.

## Cancelamentos e estornos

- **Cancelamento** pelo cliente: o plano Cortes vale até o fim do período pago,
  depois expira; o tradicional não é tocado.
- **Estorno / chargeback / reembolso** confirmado pela BlackCat (evento
  autenticado): a assinatura Cortes do pedido é encerrada imediatamente
  (`CANCELADA`/`SUSPENSA`), o direito de cortes sai na próxima resolução de
  entitlements. A conta **não** é apagada e o plano tradicional permanece.
- Eventos idempotentes e auditados por pedido; estorno de pedido desconhecido
  é registrado e não cria nada.
- Arquivos já baixados ficam com o usuário (o corte roda no cliente); a regra
  vale para novas operações.

## Anúncios por idade

- A data de nascimento coletada alimenta as regras de anúncio por faixa etária
  (ex.: nenhum anúncio inadequado a menores; categorias restritas só para
  maiores de idade), aplicadas no servidor junto da política de anúncios.
- Sem data válida, aplica-se o perfil mais restritivo.
- As faixas e categorias exatas são decisão comercial/jurídica pendente.

## Fora do escopo desta etapa

Implementação de checkout, webhook, criação de conta, verificação de e-mail,
migrations, e-mails transacionais e regras de anúncio por idade.
