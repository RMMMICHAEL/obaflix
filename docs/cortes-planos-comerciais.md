# Planos Obaflix Cortes — preparação local

Base: `5ec9a72`, branch `feat/cortes-permissoes`.

| Plano | Filmes/séries | Cortes | Download completo | Contratação |
| --- | --- | --- | --- | --- |
| Obaflix Cortes Start | Sim | Individual | Não | Indisponível |
| Obaflix Cortes Pro | Sim | Individual e lote | Não | Indisponível |
| Obaflix Cortes AI | Sim | Pro + permissão futura de IA | Não | Indisponível |

Os três usam `Plano`, `Assinatura` e entitlements existentes. Uma única assinatura Cortes já contém o direito de assistir: nenhuma assinatura tradicional adicional. IA permanece sem implementação.

Bootstrap: demais direitos herdados do Básico (2 telas, 1 perfil, HD, TV completa, sem canais, sem anúncios e sem VIP). Planos nascem com `ativo: false`, `ehPadrao: false`, sem linhas de preço ou adicionais. A lista tradicional e seu catálogo de preços permanecem intactos; a página de vendas não foi alterada.

O seed existente recebe também `PLANOS_CORTES`, cria somente o que falta e nunca sobrescreve linhas existentes. Não foi executado, nem em dry-run: validação somente em repositórios de memória. Nenhuma escrita em banco, assinatura ou preço.

## Pendências antes de oferecer

- Definir valores, durações e eventuais adicionais por decisão comercial.
- Definir renovação e troca entre famílias e entre níveis Cortes: crédito, vigência e ordem de upgrade/downgrade. `ordem` é herdada do Básico apenas para satisfazer o modelo existente; não representa uma regra aprovada de troca. Ajustar pelo fluxo comercial antes de ativar qualquer oferta.
- Implementação de IA é um trabalho futuro separado; `cortesNivel: ia` reserva a permissão e cobre os cortes já implementados.

## Validação e segurança

Testes: 84 Electron, 1.876 web e 11 de progresso passaram. Os 10 testes novos também passaram isoladamente: seed vazio/repetido/parcial, preservação de ajustes, direitos de assistir e cortes, expiração, assinaturas tradicionais, recusa de assinaturas ambíguas e bloqueio de compra com período em aberto.

Build completo passou (`prisma generate && next build`): compilação, tipos, lint, 26 páginas estáticas e traces. Somente avisos preexistentes de lint. `NODE_OPTIONS=--dns-result-order=ipv4first` limitado ao processo, como na validação anterior. A primeira tentativa coincidiu com testes usando a DLL do Prisma e retornou EPERM; a execução final serial terminou com código 0. Prisma generate não aplica migration.

Revisadas as superfícies de seed, entitlements, catálogo público, criação de pedido e planejamento de ativação. Nenhum novo risco de checkout encontrado: plano inativo e ausência de preço mantêm a contratação bloqueada. Testes do serviço real com portas em memória confirmam que preço ausente/inativo, plano inativo e preço de outro plano não gravam pedido nem chamam gateway. Não foi necessária mudança no checkout. Valores positivos em dublês são dados de teste, nunca preços comerciais.

Sem nova requisição no runtime, consulta ou cache. Nenhuma migration, flag, banco, produção ou página de vendas alterada. Sem push, merge ou deploy. Não houve validação contra banco real nem compra real, por escopo.
