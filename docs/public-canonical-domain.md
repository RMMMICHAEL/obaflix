# Consolidação do domínio público, sem migração dos aplicativos

Base e Production observados: `719115cd478d7adbfbfdf3bd0e282f143030f70f`.
Branch isolada: `codex/public-canonical-domain`.
PRs #65 e #70 não foram incorporadas; respectivas worktrees foram preservadas.

## Evidência e configuração atual

Inspeção fornecida pelo usuário: home rastreada em 07/10/2026 às 21:52:09,
Googlebot Smartphone, canonical declarado `https://obaflixbr.com/`, escolhido pelo
Google `https://obaflix.vercel.app/`. Essa decisão é histórica; não se presume uma
nova decisão do Google a partir dos testes HTTP atuais.

Hoje, ambos os hosts entregam home, filme Bigfoot, série Shadowverse Flame e
gênero Ação com 200/index/follow e canonical absoluto do domínio oficial. O
hostname www também entrega a home com 200. A duplicação HTTP está confirmada;
não é possível provar quais sinais levaram à escolha histórica do Google.
Robots e sitemap respondem 200 nos dois hosts e anunciam URLs oficiais.
APIs anônimas: `/api/auth/session` 200 e `/api/player/proxy` 401, nos dois hosts.

Vercel: domínio oficial, www, legado obaflix.online e hostname técnico são aliases
do mesmo deployment READY, sem redirects configurados entre eles. O alias
obaflix-brown.vercel.app tem 307 para o hostname técnico. HTTP é promovido a HTTPS
com 308 pela plataforma. Nenhuma configuração Vercel foi alterada.

## Por que não usar redirect global de domínio

- Electron usa obaflix.vercel.app em main.js:46, extractors.js:26 e
  browser-extractor.js:63, incluindo backend e descoberta de mídia.
- Ads-site permite essa origem em frame-ancestors e no postMessage do banner.
- Android/TV atuais usam obaflix.online (`android/gradle.properties:9`); versões
  de homologação podem substituir o backend. APIs permanecem fora da regra.
- Sessões NextAuth são vinculadas à origem. Login/OAuth/desktop-auth podem voltar
  à raiz; redirecionar uma sessão existente perderia seus cookies host-only.

Não aplicar redirect global pela Vercel a esses hosts nesta fase.

## Regra proposta

308 para `https://obaflixbr.com`, preservando caminho e parâmetros, somente em
obaflix.vercel.app e www.obaflixbr.com, para GET/HEAD de raiz, /filmes, /series e
fichas de um segmento de /filme, /serie e /genero.

Usa o Host de entrada com correspondência exata; ignora x-forwarded-host. O
destino é constante e pathname/search são atribuídos separadamente, sem construir
um destino a partir de uma URL fornecida pelo cliente.

Não redireciona apps identificados pelo detector existente, cookies NextAuth
(sessão, chunks, CSRF, callback e estados OAuth), métodos de escrita, RSC, Accept
não HTML, preview, APIs, login, checkout, conta, pareamento, entradas nativas,
players ou assets. Se o streaming web for reaberto, a regra é desativada para
não migrar a experiência autenticada sem planejamento próprio.

O 308 usa `Cache-Control: private, no-store`: evita que browser/CDN reutilize um
redirect anônimo depois de um login. O status permanente permanece como sinal
de canonicalização, sem fixar no cache uma decisão dependente de cookies/cliente.

Não distingue Googlebot de outro navegador comum. As exceções preservam fluxos
funcionais existentes, não ocultam conteúdo. Clientes podem optar por não entrar
no redirect via seus identificadores/cookies, sem ganhar autorização ou dados.

Os canonicals e helpers SEO existentes não mudam. Os links relativos dos
documentos públicos passam a resolver no domínio oficial após o redirect; não
são convertidos globalmente, pois também pertencem às interfaces dos aplicativos.
Não há noindex novo, bloqueio robots, alteração de sitemap ou mudança de conteúdo.

## Validação e limites

33 testes direcionados (11 novos), TypeScript e lint dos arquivos alterados.
Testes cobrem métodos, hosts HTTP/HTTPS/www, path/query, destino fixo, ausência de
loop, Googlebot/mobile, apps, cookies OAuth, APIs, matcher XML/assets e admin.
TypeScript e lint aprovados; build aprovado com nove warnings preexistentes fora
do diff. Smoke HTTP com Host real confirmou 12 redirects 308 (seis paths por
host), preservação de query/encoding e Cache-Control private/no-store. Auth/session,
robots e TikTok seguem 200 sem redirect nos dois hosts. O destino oficial do
gênero com page=2 responde 200 com canonical próprio da página 2.

Build/smoke local usam banco fictício, sem credenciais de produção. Renderização
local da home dependente de catálogo não foi homologada sem banco; o proxy de
player local retorna 500 por exigir Redis distribuído em production. Essa
proteção não foi alterada ou desabilitada. Os handlers e o matcher das APIs
permanecem intactos; em Production o proxy anônimo retorna 401 nos dois hosts.

Aplicativos instalados e reprodução real não foram executados; a validação dos
ambientes nativos nesta PR cobre o roteamento e a preservação dos endpoints.
Produção mantém o comportamento anterior até merge e publicação autorizados.
Previews automáticos de Git têm Vercel Authentication e não usam a regra, pois
seus hostnames não estão na lista. Não houve deploy manual ou solicitação Google.

Rollback: reverter somente o commit desta PR, sem alterar domínios ou variáveis.
Após eventual publicação autorizada, o reprocessamento depende de novo
rastreamento do Google; não há garantia de prazo ou de escolha de canonical.
Esta alteração não resolve automaticamente o alerta Safe Browsing.
