# Obaflix Android nativo — laboratório (fork NuvioMobile)

Branch `obaflix-native` sobre `nuvio-baseline` (cópia intacta do NuvioMobile). Só laboratório: não distribuir.
Package `com.obaflix.nativelab` (debug: `.debug`), nunca colide com o oficial `com.obaflix`.

## Pontos de integração (todo código Obaflix em `composeApp/src/commonMain/.../integration/obaflix/`)

| Peça | Onde | Contrato Obaflix usado |
|---|---|---|
| Sessão | `ObaflixSession` + `core/auth/AuthRepository.kt` | NextAuth credentials (`/api/auth/csrf`, `/callback/credentials`, `/session`); cookie só para a origem `ObaflixConfig.BASE_URL` (obaflixbr.com) |
| Nuvio cloud desligada | usuário publicado como `isAnonymous=true` (modo conta local do Nuvio); Supabase → `https://nuvio-cloud.invalid` | — |
| Catálogo | `ObaflixCatalogAddon` (addon Stremio em processo, fixo) | `/api/home`, `/api/filmes`, `/api/series`, `/{id}`, `/episodios`, `/api/search` |
| Gate | `ObaflixPlaybackGate`, chamado em `features/addons/AddonHttpClient.kt` (ponto único) | `POST /api/playback/authorize` (plataforma `android`, finalidade `reproducao`) |
| IDs | canônicos `obaflix:filme:<id>`, `obaflix:serie:<id>:<t>:<e>`; traduzidos para `tt…` só depois do gate | `imdbId` do próprio título |
| Progresso | `ObaflixProgressSyncAdapter` | `POST /api/progress` com `episodioId` |
| Addons de terceiros | só `stream`/`subtitles` (`AddonManifestParser`) | — |

Desligados em `androidFull/.../AppFeaturePolicy.android.kt`: updater, doações, P2P, plugins JS, servidores custom. Sentry não inicia.

## Pendências reais (nesta ordem)
1. Anúncio Android: feito (`androidMain/.../obaflix/ads`, cópia das classes oficiais + `UnityAdPresenter`; Unity em modo teste no lab). Falta validar em aparelho com conta sujeita a anúncio.
2. Fallback servidores Obaflix: feito ("Fontes Nativas" via `ServerStreams`/`ServerPlayback.prepare`, extrator oficial em `obaflix-core-extractor/`). Fontes com desafio WebView não são oferecidas.
3. Downloads: addons passam pela finalidade `download` por ação; servidores Obaflix ainda sem download; armazenamento/SAF oficial pendente. Transmissão: o player Nuvio não tem cast.
4. Login Google (contas sem senha não entram), cadastro nativo, pull do histórico Obaflix.
5. Rota de backend `/api/nuvio-addon/*` com o mesmo JSON (cache CDN; o app não muda).
6. Páginas de termos/privacidade no site (hoje `LEGAL_URL` = home). Licenças GPLv3 + AARs antes de qualquer distribuição.

## Verificar
`gradlew :composeApp:testAndroidHostTest --tests "com.nuvio.app.integration.obaflix.*"` · `gradlew :androidApp:assembleFullDebug`
Falhas pré-existentes no baseline (não regressões): RatingsVisibility, DownloadSubtitles ×2, WatchProgressIdentity; AndroidDownloadLifecycle exige JDK 21 no Robolectric.
