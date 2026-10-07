# Migração web para obaflixbr.com

Base: `3d7fdb932d94e4bd2bfeb2749cb3918fba575169` (origin/main confirmada em 2026-10-07).

## Política

Na superfície pública, páginas de navegador em `obaflix.online`,
`obaflix.vercel.app` e `www.obaflixbr.com` recebem 308 para
`https://obaflixbr.com`, preservando pathname e query. A decisão ocorre antes
do gate e do roteamento da landing. Hosts desconhecidos, previews e a
superfície admin não migram. Não configurar redirect global na Vercel.

`/api` e `/api/*` não migram. A exclusão atual das APIs do matcher continua;
`/api/admin/*` mantém exclusivamente seu gate de superfície. Um matcher por
host inclui arquivos públicos nos três aliases da migração; `_next` e fontes
mantêm as exclusões. Assets no domínio canônico não ganham invocações.
Robots, sitemap e seus shards entram explicitamente no matcher.

Os marcadores existentes `x-obaflix-client=android|desktop`, `ObaflixApp/` e
`ObaflixDesktop/`, além de `ObaflixTV/`, preservam o host antigo. São sinais
de roteamento, nunca credenciais. 308 usa `private, no-store` e `Vary` por
User-Agent/header para não contaminar clientes nativos com redirects cacheados.

`NEXT_PUBLIC_SITE_URL` continua sendo a fonte SEO, com fallback para
`NEXTAUTH_URL`. Aliases de produção conhecidos convergem para a origem oficial;
sem env, o fallback agora é a origem oficial. Configuração explícita de local,
preview ou admin permanece. `metadataBase`, canonical, OpenGraph, JSON-LD,
`absoluteUrl`, robots e todos os sitemaps herdam a mesma origem. Flags de
indexação permanecem como estavam.

## Compatibilidade e inventário

- Android móvel: `android/gradle.properties` mantém `obaflix.url=https://obaflix.online`;
  `MainActivity.kt` envia `ObaflixApp/1.0`.
- Android TV: usa a mesma propriedade; `tv/.../sessao/SessaoTv.kt` envia
  `ObaflixTV/<versão>`; QR de planos pode migrar no navegador externo.
- Electron: `desktop/electron/main.js`, `extractors.js`, `browser-extractor.js`
  e `superflix-extractor.js` mantêm origem/referer antigos; o main envia
  `ObaflixDesktop/1.0`. Login no navegador externo em `/desktop-auth` migra
  preservando challenge/state/callback; APIs de exchange permanecem.
- `.github/workflows/android-build.yml`, `release-tv.yml` e
  `release-electron.yml`: sem domínio público antigo hardcoded a trocar;
  feeds e publicação de binários ficam intactos.
- `docs/android.md`, `electron.md`, `architecture.md`, `tv-planos-publicacao.md`,
  `admin-cutover-final.md`, `admin-separado-fase-1.md` e relatos de homologação
  mantêm exemplos/inventário de clientes e integrações legadas.
- `src/lib/catalog-destino.ts`, scripts de sync e testes mantêm endpoints de
  integração antigos: não são canonical/SEO e APIs não migram.
- `ads-site/public/banner.html` e `ads-site/vercel.json` mantêm allowlist do
  Electron instalado. O iframe de anúncio é destinado ao app desktop legado;
  não ampliar CORS/postMessage/CSP nesta migração web.

Nenhuma alteração em Android/Electron, extractor, provider, HLS ou tokens.
Cookies são host-only: uma sessão de navegador no domínio antigo não passa
automaticamente ao novo. As sessões dos apps continuam no host original.
Testes locais não substituem homologação de Google OAuth com credenciais reais:
antes do merge validar login web e desktop-auth de um Electron instalado,
além de navegação/player dos apps, em ambiente autorizado.

## Segurança e consumo

Validação final: 1.670 testes web passaram (nove testes de migração),
TypeScript e build de produção passaram, lint passou com avisos preexistentes,
`git diff --check` passou. O matcher compilado pelo Next.js passou em 29
verificações de hosts, arquivos públicos, exclusão de APIs/_next/fontes e host
malicioso. Nenhuma credencial ou banco de produção foi usado nesses checks.

1. Revisado: Host/URL, query, redirects, headers/cache, matcher, gates admin,
   detecção nativa, cookies/auth, SEO e allowlists do banner (WSTG-INPV-17,
   CLNT-04, SESS-02).
2. Riscos considerados: open redirect por pathname `//`, injeção de host,
   reutilização de 308 em app, bypass de gate por UA e transferência de sessão.
   Nenhuma nova vulnerabilidade encontrada na mudança. Não há novos logs,
   segredos, URLs de provider ou acesso a banco.
3. Mitigação: allowlist exata e destino fixo, atribuição de pathname/search em
   URL com origem fixa, nenhuma confiança em x-forwarded-host, no-store/Vary,
   APIs e superfície admin excluídas, autorização existente mantida.

Vercel: comparação em memória no middleware existente; novas invocações em
robots/sitemap/manifest e arquivos públicos nos aliases, sem fetch.
Navegador legado faz um salto HTTP extra,
mas evita render no host antigo. APIs/player não recebem invocações extras.
Supabase: zero consultas/escritas adicionais e nenhuma migration. Sem deploy
manual e sem merge nesta PR.

## Fase posterior: app.obaflix.online / R2 (preservado)

- `src/config/downloads.ts`: APK móvel, APK TV, instalador Windows.
- `src/lib/desktop/versaoMinima.ts`: instalador mínimo do Electron.
- `android/gradle.properties`: `update-manifest.json`.
- `scripts/gerar-manifesto-atualizacao.js`: manifesto e exemplos de APKs.
- `docs/auto-atualizacao.md`: distribuição R2, manifesto e exemplos.
- `docs/android-tv-final.md`: `anuncio.mp4` promocional.
- Testes Android de manifesto/update e contrato de planos: fixtures e guardas.

Migrar somente depois de verificar DNS/R2 de `app.obaflixbr.com`, existência e
integridade dos arquivos e compatibilidade das versões já instaladas.
