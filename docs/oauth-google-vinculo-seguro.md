# OAuth Google: vínculo explícito (primeira fase)

Base: `origin/main` em `3d7fdb932d94e4bd2bfeb2749cb3918fba575169`.
Esta fase é independente das PRs #60 e #61. Não modifica domínios, redirects,
middleware, Android, Electron, TV, NEXTAUTH_SECRET ou a criação de contas.

## Contrato

Google não cria User, não mescla contas e não resolve User por email. Apenas
`issuer + sub`, obtidos do ID Token validado pela biblioteca OIDC, resolvem uma
OAuthIdentity ativa. Os dados da sessão vêm exclusivamente do User local.
`email_verified` precisa ser boolean true; o email Google não é persistido.
Os emissores Google conhecidos são canonicalizados para
`https://accounts.google.com`. A unicidade inclui identidades revogadas:
transferência de identidade para outro usuário não está implementada.

## Persistência e migration

Migration aditiva: `20261008000000_oauth_google_identity`.
Adiciona `User.authVersion` (default 0), OAuthIdentity e OAuthLinkIntent.
Não existe backfill por email, atualização de dados pessoais ou criação de User.
Identidade tem FK User, UNIQUE(issuer, subject) e índice userId. Intenção contém
somente hashes do handle e da sessão, User.id, versão, origem e timestamps.
O índice parcial `OAuthIdentity_active_google_user_key` impõe um Google ativo
por usuário. Prisma 5 não o representa no schema: preservar este SQL nas
migrations futuras; não substituir o rollout por `prisma db push`.

A migration é testada em PostgreSQL embutido (PGlite), com fixture User e
relações de assinatura/histórico inteiramente sintéticas. As funções de
transação da aplicação executam contra um adaptador de teste SQL; o teste não
equivale a homologar o driver Prisma contra um PostgreSQL remoto.

## Rotas e vínculo

- GET `/api/account/google`: `{ linked: boolean }`, sessão válida, no-store.
- POST `/api/account/google/link-intents`: senha atual, Origin exata, token
  CSRF do NextAuth validado contra cookie assinado, rate limit por conta/IP.
- OAuth `google-link`: callback `/api/auth/callback/google-link`.
- POST `/api/account/google/unlink`: mesmos controles, com nova senha.
- UI mínima: `/conta/seguranca`.

A UI confirma credenciais para obter uma sessão nova com sid privado gerado
no servidor; o endpoint verifica novamente a senha atual. JWTs antigos sem sid
continuam servindo para login comum, mas precisam de reautenticação para gestão
do vínculo. Nenhum sid ou issuer/sub é retornado no estado de vínculo.

A intenção dura 5 minutos. O handle de 32 bytes aleatórios fica em cookie
HttpOnly, Secure em produção, SameSite=Lax, host-only, Path=/, maxAge=300;
somente SHA-256 do handle é persistido. A intenção pertence a User.id, sid
privado (hash), authVersion e origem configurada. Não é enviada em URL.

No callback, as opções do NextAuth são criadas por request, sem mutação das
opções compartilhadas e sem origem dinâmica. `google-link` mantém state/PKCE,
discovery, assinatura, issuer, audience e expiração do OIDC normal. Depois
disso verifica sessão cookie, identidade Google, intenção e reautenticação.
Uma transação bloqueia a linha User, reconfirma a versão, consome a intenção
e cria/reativa a identidade. Índices protegem também corridas entre usuários.
Vínculo já ativo do mesmo usuário é idempotente com uma NOVA intenção válida.
Intenção consumida nunca é aceita novamente. Falhas não caem em login comum.

O callback retorna um redirect interno fixo em signIn: no NextAuth 4.24.15 isso
encerra autenticação antes de jwt/session. A sessão local não é substituída.
Logout cancela intenções pendentes da mesma sid. Troca de sessão impede vínculo.
O cookie de intenção expira naturalmente; no unlink é removido imediatamente.

## Login e revogação

O Google comum resolve apenas a identidade ativa. Não há consulta por email
em signIn ou jwt. Falta de vínculo gera orientação genérica para entrar por
credenciais e vincular Google. Role/surface mantém a regra existente.

Unlink revoga identidade, consome intenções pendentes e incrementa authVersion
na mesma transação, com lock no User e reconfirmação do hash da senha verificada.
Limpa a sessão atual (inclusive chunks). Outros JWTs NextAuth são recusados na
próxima requisição. Credenciais continuam funcionando e emitem a versão nova.
Não existe rotação de NEXTAUTH_SECRET, transferência de cookie ou token em URL.

## Auditoria dos caminhos de autorização

| Caminho | Validação nesta fase |
|---|---|
| getServerSession(authOptions) | jwt.decode chama decodeVersionedSession; User.authVersion precisa coincidir |
| /api/auth/session e atualização de sessão | mesmo decode; payload client session.update não muda id, versão ou sid |
| getUserFromRequest / getToken com cookie | decoder explícito com versão, inclusive cookies em chunks |
| decodeObaflixSession | mesmo decoder versionado |
| Admin Edge withAuth | só triagem; middleware não foi alterado |
| Admin layout Node e APIs humanas | sessão versionada; APIs continuam reconfirmando role no banco |
| /api/desktop-auth/complete | getServerSession versionado, sem alteração de código desktop |
| /api/desktop-auth/exchange | inalterado; ainda emite JWT sem versão (equivale a 0) |
| Bearer TV | mecanismo próprio de aparelho/revogação preservado, sem mudança de política |

Não existe cache global de versões nem de sessão válida: ele atrasaria revogação.
É uma leitura pequena por validação de sessão no servidor, não uma consulta
por render React no cliente. Gestão de vínculo faz uma leitura adicional da
senha/role para reautenticação. Não usar Prisma no middleware Edge.

## Segurança e limites

Revisados: sessão, CSRF/origem, intenção/replay, OIDC, unicidades, corridas,
resolução de identidade, revogação, dados locais, logging e superfície admin.
Logs novos registram apenas AUTH_ERROR, AUTH_WARNING, GOOGLE_LINK_OK ou
GOOGLE_LINK_DENIED. Metadata do NextAuth e logs brutos Prisma são suprimidos:
erros podem conter claims, argumentos de query, cookies ou tokens. Erros de
lookup também não são colocados em redirects. Sem PII/hash de email em logs.

Banco indisponível implica negar autenticação/gestão. Há rate limit por conta
e IP nas mutações. Intenções expiradas não são válidas mesmo que permaneçam
armazenadas; uma limpeza periódica de registros expirados poderá ser adicionada
em operação posterior, sem influenciar a validade do vínculo.

Contas históricas sem senha não podem usar a gestão nesta fase. Precisam de
recuperação legítima, fora desta implementação. Cadastro sem verificação de
email permanece existente: não é promovido como prova de posse, e Google
nunca autentica uma conta pré-criada por igualdade de email.

O reset administrativo de senha existente não incrementa authVersion; ele não
foi ampliado nesta fase. Uma revisão posterior de recuperação/reset deve
invalidar sessões e intenções quando apropriado. Requisições já autorizadas
antes de uma revogação podem concluir; a garantia é sobre requisições seguintes.

## Bloqueadores de rollout (não houve deploy nem migration real)

1. Aplicar migration em ambiente de teste autorizado antes do runtime novo.
2. Autorizar no Google Cloud o callback google-link de cada origem em uso.
3. Homologar vínculo/login/unlink em navegador, sem registrar material OAuth.
4. Coordenar todos os runtimes que aceitam Google: um runtime antigo com
   correspondência por email preserva a vulnerabilidade antiga. Não realizar
   rollback para esse comportamento; desabilitar Google se necessário.
5. Resolver a fase desktop antes de liberar esta mudança para os instalados:
   tickets v1 não carregam authVersion. O exchange emite versão implícita 0;
   depois de unlink, inclusive um novo exchange legítimo fica inválido.
   NÃO copiar simplesmente a versão atual do banco no exchange: isso faria um
   ticket antigo ressuscitar sessão revogada. A fase desktop precisa vincular
   versão à emissão/verificação do ticket e validar no exchange.
6. Origens/callback/logout do Electron e Google em WebView Android continuam
   blockers separados. Nenhum código desses clientes foi modificado.
7. TV mantém User.id e pareamento; seus tokens de aparelho não são revogados
   por desvincular Google. Nenhum formato/protocolo de TV foi alterado.

## Verificação local

`npm run test:web` inclui os cenários de vínculo em PostgreSQL local e callback
real NextAuth contra OIDC de loopback com assinatura sintética. Cobre state,
PKCE, audience, sessão ausente/trocada, logout, intenção expirada/repetida,
reauth expirada, CSRF/origem, senha, corridas, identidade reservada, email
igual/alterado, dados/assinatura/histórico preservados, role, credenciais,
JWT antigo, novo JWT após unlink e manutenção do Bearer TV.
Também executar extractors, Prisma validate, tsc, lint, next build e diff-check.
Nenhum teste lê ou altera usuários/banco reais. CI remoto não foi disparado.
