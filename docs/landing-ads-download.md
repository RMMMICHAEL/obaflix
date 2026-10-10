# Landing pública Android para campanhas

Base confirmada por fetch em 8 de outubro de 2026: `8b23090103f822cd83c5873a8e5d2190f5fd6273`.
Branch: `codex/landing-ads-download`. Worktree próprio: `landing-ads`.

## Experiência

`/baixar`: marca Obaflix, hero Android, CTA explícito, metadados verificados, quatro passos de instalação, nota sobre autorização do navegador, confiança, downloads secundários de TV/Windows, CTA final e footer legal. Barra móvel fixa com botão de 48px e safe-area; o espaço reservado ao final permite ler e acessar todo o footer. Sem detecção especulativa de navegador interno, imagens de terceiros, pixel ou download automático.

`/termos` e `/privacidade`: documentos públicos em português, legíveis no celular, sem consulta ao banco. Canonical e noindex/follow centralizados no helper SEO existente. Não foram acrescentadas ao sitemap.

O layout raiz não pode impor `force-dynamic` às páginas estáticas. Essa configuração foi transferida para os layouts legados e para a home, mantendo o regime de renderização anterior. O shell legado mantém a mesma hierarquia e componentes, carregado separadamente; os documentos novos não montam sessão, navegação, efeitos do player ou anúncios. As dicas globais de preconnect/DNS para imagens de catálogo foram removidas para evitar conexões desnecessárias na landing.

## Instalador realmente publicado

A variável pública de Production aponta para `https://app.obaflix.online/Obaflix-1.0.19-ambiente.apk`. O fallback antigo do código apontava para `1.0.10`; Preview não tinha os overrides Android de Production. O fallback Android foi alinhado ao instalador efetivo **após** verificar:

- resposta R2: HTTP 200, `Content-Length: 12626387`, tipo APK;
- manifesto de atualização R2: versão `1.0.19`, código `19`, tamanho `12626387`;
- `aapt dump badging` do arquivo baixado: pacote `com.obaflix`, versão `1.0.19`, código `19`, minSdk `26`, targetSdk `34`;
- SHA-256: `a47504a79de445b474e5c772a97970ba8551956c49a6a7cc23b1bb3549d5c241`, igual ao manifesto;
- tamanho mostrado em MB decimais: **12,6 MB**; compatibilidade: **Android 8 ou superior**.

Os metadados da landing só aparecem quando URL, versão e tamanho da configuração correspondem ao arquivo auditado. Um override diferente omite os metadados até nova verificação. Não foi gerado ou alterado APK. Os arquivos baixados para inspeção não fazem parte da PR.

## Download e segurança

Fluxo: toque → `/download/android` → HTTP 302 → R2. O handler usa `INSTALADORES.android`, não faz fetch, não cria stream e não carrega bytes do APK. Recusa qualquer query com HTTP 400. Configuração inválida recebe HTTP 503 sem Location.

Allowlist exata: `app.obaflix.online`. HTTPS obrigatório; credenciais, porta não padrão, query, fragmento, path codificado e extensão incorreta são rejeitados. Para a migração futura, verificar o novo domínio e acrescentar `app.obaflixbr.com` em `DOWNLOAD_HOSTS`; não há mudança arquitetural. O domínio atual não foi migrado.

Superfícies revisadas: endpoint, URLs dos três instaladores, roteamento público/admin/apps, shell, SEO/sitemap, textos legais, configuração de transparência, headers e limites das APIs legadas.

| Risco | Evidência / mitigação |
| --- | --- |
| Open redirect / destino arbitrário (WSTG-CLNT-04) | Queries recusadas; destino exclusivo do servidor; hostname exato, HTTPS e extensão validados. Testes incluem domínio parecido, subdomínio, userinfo, protocolo relativo, porta, encoding e host da requisição adulterado. |
| SSRF / proxy de arquivo (WSTG-INPV-19) | Handler retorna resposta vazia com Location; não faz requisição de saída. APK vai direto ao R2. |
| XSS / vazamento de env (WSTG-INPV-01, INFO-05) | Campos legais renderizados como texto React; e-mail validado; módulo server-only; somente cinco campos públicos são lidos. Links secundários também são validados. Sem HTML fornecido pelo usuário. |
| Abertura de rotas parecidas / apps (WSTG-AUTHZ-02) | Allowlist nova exata, incluindo somente trailing slash. Prefixos semelhantes e caminhos filhos continuam fechados para navegador. Gate admin e APIs mantidos. |
| Headers | Redirect no-store, nosniff, no-referrer e noindex/follow; headers globais existentes preservados. CSP global contém permissões amplas preexistentes para os apps; esta mudança não as amplia. |
| Transparência legal incompleta | **IDENTIDADE_LEGAL_PENDENTE**: nome legal não configurado. A página informa a pendência, sem inventar documento, endereço ou encarregado. |

Nenhuma vulnerabilidade nova identificada no escopo revisado. Não houve auditoria integral das integrações legadas nem alegação de conformidade total com a LGPD.

## Dados e transparência

Configuração pública server-side: `OBAFLIX_LEGAL_NAME`, `OBAFLIX_LEGAL_DOCUMENT`, `OBAFLIX_LEGAL_ADDRESS`, `OBAFLIX_PRIVACY_CONTACT_EMAIL`, `OBAFLIX_DPO_NAME`. Campos opcionais ausentes não quebram Preview. Contato público verificado nos três ambientes: `obaflixsuporte@gmail.com`. Nome legal não configurado; demais campos opcionais não foram inventados.

As páginas são estáticas: alterações dessas variáveis exigem novo build/deploy para aparecer. Nenhum segredo foi incluído em código, respostas, documentação ou PR. A inspeção de valores foi restrita a contato, URL pública e metadados públicos. Não foram alteradas variáveis de produção.

Evidências de produto: `src/lib/auth.ts` e cadastro (credenciais/hash/Google); `prisma/schema.prisma` (dados de conta e comentário de retenção mínima); `src/lib/billing/pagador.ts`, `pedidos.ts` e integração PIX (telefone/documento transitórios, não persistidos no banco da conta); histórico/lista/progresso; SDK Unity Ads no Android; publicidade do Electron. O provedor PIX é descrito genericamente, sem detalhes operacionais internos.

Referências públicas consultadas: [LGPD](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm), [CDC](https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm), [Unity para usuários de aplicativos](https://unity.com/legal/game-player-and-app-user-privacy-policy), [Monetag](https://monetag.com/privacy/).

## Validação e consumo

Checks: `npm run test:web`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `git diff --check`. A suíte inclui acesso público, prefixos parecidos, redirect, allowlist, ausência de proxy/auto download/mídia/player, metadados verificados, links legais e preservação do roteamento Android/Electron. O teste existente de anúncio desktop acompanha a extração do shell e continua exigindo montagem única somente no app.

Resultado final: **1.688 testes aprovados**, zero falhas; TypeScript, lint, build e diff-check aprovados. Build marcou `/baixar`, `/termos` e `/privacidade` como `○` estáticas. Revisão visual no navegador em 390×844, 320×640 e desktop: sem overflow horizontal; CTAs principais 56px; botão fixo 48px; footer e links legais acima da barra ao final. Canonical renderizado: `https://obaflixbr.com/baixar`. Screenshots locais em `evidence/` não fazem parte do código publicado.

Lint: 9 warnings anteriores em checkout, MelhoresClient, LandingHero, Vitrine e CustomPlayer. Esses arquivos não foram alterados. Nenhum warning novo nas páginas ou componentes desta fase.

Vercel: HTML estático servido por CDN, sem renderização de página por visita; middleware de roteamento existente continua aplicável. Por download Android, uma requisição leve ao handler mais o processamento existente de middleware. Tráfego de 12,6 MB por APK permanece no R2, **zero bytes do APK na Vercel**. JavaScript inicial da landing: aproximadamente 88,8 kB no build, incluindo runtime Next/React.

Supabase: **zero consultas** de `/baixar`, `/termos` e `/privacidade`, inclusive sem chamada de sessão pela página. Impacto incremental praticamente zero. Sem TMDB, ranking, imagens de catálogo ou requests do player.

Nenhum arquivo em `android/` ou `desktop/`, nem código funcional de player, extractor, provider, tokens, HLS, autenticação ou schema foi alterado. Os layouts das rotas legadas de reprodução receberam somente a configuração dinâmica que já herdavam da raiz. A `/tiktok` continua existente com o mesmo conteúdo. Sem merge ou deploy manual de produção; Preview deve ser criado pela integração Git da Vercel.

## Arquivos da PR

- `.env.example`
- `DESIGN.md`
- `PRODUCT.md`
- `docs/landing-ads-download.md`
- `src/app/admin/layout.tsx`
- `src/app/android/layout.tsx`
- `src/app/animes/layout.tsx`
- `src/app/assistir/layout.tsx`
- `src/app/baixar/baixar.module.css`
- `src/app/baixar/page.tsx`
- `src/app/buscar/layout.tsx`
- `src/app/cadastro/layout.tsx`
- `src/app/canais/layout.tsx`
- `src/app/checkout/layout.tsx`
- `src/app/colecao/layout.tsx`
- `src/app/conta/layout.tsx`
- `src/app/desenhos/layout.tsx`
- `src/app/desktop-auth/layout.tsx`
- `src/app/desktop/layout.tsx`
- `src/app/download/android/route.ts`
- `src/app/filme/layout.tsx`
- `src/app/filmes/layout.tsx`
- `src/app/genero/layout.tsx`
- `src/app/layout.tsx`
- `src/app/login/layout.tsx`
- `src/app/melhores/layout.tsx`
- `src/app/page.tsx`
- `src/app/parear/layout.tsx`
- `src/app/pessoa/layout.tsx`
- `src/app/planos/layout.tsx`
- `src/app/player/layout.tsx`
- `src/app/privacidade/page.tsx`
- `src/app/serie/layout.tsx`
- `src/app/series/layout.tsx`
- `src/app/termos/page.tsx`
- `src/app/tiktok/layout.tsx`
- `src/components/landing/DownloadFooter.tsx`
- `src/components/landing/LegalDocument.tsx`
- `src/components/layout/ApplicationShell.tsx`
- `src/components/layout/PublicDownloadShell.tsx`
- `src/config/downloads.ts`
- `src/config/legal.ts`
- `src/config/public-download.ts`
- `src/config/site-mode.ts`
- `src/config/verified-android.ts`
- `src/lib/__tests__/cliqueDesktop.test.ts`
- `src/lib/__tests__/downloadLanding.test.ts`
- `src/lib/seo.ts`
