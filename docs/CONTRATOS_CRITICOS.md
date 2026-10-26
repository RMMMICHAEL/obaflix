# Contratos críticos do Obaflix (Android nativo + backend)

Leitura **obrigatória** antes de alterar qualquer área abaixo (humanos, Claude, Codex ou outra IA). Documentação não impede regressão sozinha:
cada contrato tem um teste ou verificação automática (`node docs/verificar-contratos.mjs`, roda no CI e antes de todo build de release).
Regra geral: **risco ALTO/CRÍTICO ⇒ teste novo ou existente cobrindo a mudança + revisão de outra pessoa/IA + nota no commit "Contrato: <área>".**
Não alterar sem autorização do dono: Production (deploy, banco, variáveis), DNS, Google Cloud, chaves de assinatura, manifesto de atualização.

Repositórios: **Android nativo** (este, fork NuvioMobile; código Obaflix em `composeApp/src/*/kotlin/com/nuvio/app/integration/obaflix/`) e **web/backend** (`RMMMICHAEL/obaflix`, Next.js na Vercel; ver `docs/CONTRATOS_CRITICOS.md` de lá).

| # | Área | Risco | Onde | Teste / verificação |
|---|------|-------|------|---------------------|
| 1 | Login Google / NextAuth | CRÍTICO | Android: `ObaflixGoogleLogin*.kt`, `ObaflixSession.kt`, `AuthRepository`, filtro `obaflix://auth/callback` em `androidApp/.../AndroidManifest.xml`. Web: `src/lib/googleSignIn.ts`, `googleLink.ts`, `authHost.ts`, `auth.ts`, `scripts/patch-next-auth-origin.cjs` | testes `googleSignIn/googleLink/authHost` (web); `verificar-contratos` |
| 2 | Contas e sessões | CRÍTICO | cookie de sessão só para o host de `ObaflixConfig.BASE_URL`; chamadas autenticadas nunca vão para fallback | testes `ObaflixSession*` |
| 3 | Banco / migrations / backup | CRÍTICO | web: `prisma/`, `scripts/aplicar-google-sub.ts`. Backup lógico cifrado em `D:\ObaflixNativeLab\backups-producao` | dry-run + hash antes/depois; backup restaurado e validado antes de migrar |
| 4 | Recuperação de dados | ALTO | `ObaflixDataImport.kt` (somente leitura, aditivo, idempotente, progresso local mais novo vence) | `ObaflixDataImportTest` |
| 5 | Domínios e fallback | ALTO | `ObaflixConfig.kt` (`PRODUCTION_BASE_URL`, `OFFICIAL_ORIGINS`), `ObaflixHostFallback.kt` (só GET público de catálogo) | `verificar-contratos` |
| 6 | Publicidade / Rewarded S2S | CRÍTICO | `ads/*`, `ObaflixPlaybackGate.kt`, `ObaflixAdChoice.kt`, `ObaflixRewardedApi.kt`; web `rewarded` S2S | testes `Rewarded*`, `ObaflixAd*` |
| 7 | Pix / planos / Premium | CRÍTICO | `ObaflixPremium*.kt`; web `/api/billing/orders` (precisa `planoId` **e** `planoPrecoId`), plano `seja-premium`, preço `preco-seja-premium-30d` | `ObaflixPremium*Test` |
| 8 | Addons oficiais | ALTO | `AddonRepository.isOfficialAddon`, `ObaflixCatalogAddon.kt`: addon oficial não pode ser removido/editado | testes de addon |
| 9 | Player | ALTO | `PlayerEpisodeSwitch.kt`, `PlayerObaflixEpisodes.kt`, `ObaflixPlayerAuto.kt` | testes de player |
| 10 | Certificados / assinatura | CRÍTICO | upload key só em segredos do GitHub (`ANDROID_KEYSTORE_B64` …); SHA-256 esperado `BD:F6:4E:BF:…:F6:A0:DE:04` | job de CI compara o certificado |
| 12 | Capas / imagens | ALTO | `ObaflixDataImport.kt` (usa `image()` do `ObaflixCatalogAddon.kt`), `WatchProgressRepository.applyExternalProgress` | `ObaflixDataImportTest`, `verificar-contratos` |
| 13 | Google nativo (Credential Manager) | CRÍTICO | `ObaflixGoogleLogin.kt`, `ObaflixGoogleLoginAndroid.kt`; backend `/api/desktop-auth/google-native` | `ObaflixGoogleNativeTest`; web `googleIdToken.test.ts` |
| 14 | Progresso local | ALTO | `ObaflixProgressSyncAdapter.kt` (`remoteSyncEnabled=false`) | `ObaflixIntegrationTest`, `verificar-contratos` |
| 11 | Distribuição e atualizador | CRÍTICO | flavor `playstore` (Play) × `full` + `-PobaflixExternalOfficial=true` (APK externo); manifesto legado `app.obaflix.online/update-manifest.json` | `verificar-contratos` + CI |

## Contratos (regras que não podem quebrar)

**Google/NextAuth.** Fluxo: navegador do sistema → `/desktop-auth` (PKCE S256 + `state`) → `obaflix://auth/callback?ticket&state` → `POST /api/desktop-auth/exchange` (ticket + verifier) → cookie da mesma origem. Ticket é de **uso único** (Redis `SET NX`). Identidade = `sub` do Google (`User.googleSub` único). Nunca vincular automaticamente por e-mail a conta com senha (pré-sequestro); vínculo exige senha atual (`google-link`). `hd` (Workspace) nunca vincula. Conta nova pelo Google = plano Gratuito. Admin não é criado por Google. O `detect-origin` do next-auth só é corrigido pelo patch com hash verificado; hosts oficiais apenas.
Risco: login quebrado para todos. Mudou? rode os testes web e faça uma tentativa real.

**Sessões.** Mesma origem para cookie e chamadas autenticadas. O app nunca grava senha. Logout apaga o cookie.

**Banco.** Migrations só **aditivas** e idempotentes (`IF NOT EXISTS`); script com dry-run, hash antes/depois e recusa de banco de teste. Antes de qualquer migration em Production: backup `pg_dump` cifrado (AES-256) **restaurado e validado** num Postgres isolado. Rollback de código **não** remove `googleSub`.

**Recuperação de dados.** Importação lê `/api/user/watchlist`, `/api/user/history` (teto 20), `/api/continuar-assistindo` (teto 24). Limite conhecido: histórico parcial; teto atingido ⇒ importação não é marcada como completa. O armazenamento local do WebView antigo **não** migra para o nativo. Nunca afirmar migração completa sem prova; nunca instruir o usuário a desinstalar como solução automática.

**Domínios.** Principal `https://obaflix.vercel.app`; oficiais: `obaflixbr.com`, `obaflix.online`. Fallback só para GET público do catálogo.

**Publicidade.** Anúncio só pelo gate de reprodução; recompensa só vale com confirmação S2S do servidor; tempo de anúncio não conta no orçamento de rede; recriação de Activity não cancela a confirmação. Regras de obrigatoriedade vêm do servidor (`anunciosObrigatorios`).

**Pix / Premium.** Plano "SEJA PREMIUM" R$ 10 / 30 dias, oculto da vitrine, direitos do Gratuito. No Google Play o Pix é desativado (`obaflix.play_distribution=true`); fixture `premium_demo` nunca fora de build de homologação.

**Certificados.** Nunca commitar keystore/senhas. Build assinado só no CI (`native-release-*`). Pacote `com.obaflix` em todos os canais oficiais; versionCode só cresce: APK externo `N`, AAB Play `N+1` (próximo release: ambos acima do maior já usado, incluindo todas as faixas da Play).

**Distribuição.** Flavor `playstore`: sem `REQUEST_INSTALL_PACKAGES`, sem atualizador próprio, sem Preview, `premium_demo=false`. APK externo (`full` + `obaflixExternalOfficial`): mesmo pacote e mesma chave de upload dos APKs legados, atualizado pelo manifesto legado (`schemaVersion 1`, bloco `android` com `versionName`, `versionCode`, `url`, `size`, `sha256`). Só publicar manifesto **depois** de testar atualização sobre o app antigo sem desinstalar. Manter cópia do manifesto anterior para reversão.

## Como alterar com segurança
1. Leia a linha da tabela; identifique o teste. 2. Altere. 3. `node docs/verificar-contratos.mjs` + testes do módulo. 4. Commit com "Contrato: <área>". 5. Se for ALTO/CRÍTICO, peça revisão antes de promover.

## Decisões 2.0 (imagens, Google nativo, progresso local)

**Capas.** O catálogo e a importação do servidor devem normalizar imagens do mesmo jeito: `image(valor, tamanho)` (URL https fica; caminho `/x.jpg` vira TMDB `w500`/`w1280`; resto é descartado). Antes, a importação gravava o campo bruto e Continuar assistindo/Salvos ficavam sem capa (os cartões usam miniatura do episódio, depois `background`, depois `poster`). A importação repara só a arte quebrada de itens já importados (posição e tempo locais nunca são sobrescritos; itens salvos só são regravados se a capa guardada não for https). Risco: voltar a gravar campo bruto. Teste: `ObaflixDataImportTest` (mapeamento e reparo).

**Google nativo.** O app pede o seletor de contas (Credential Manager, `serverClientId` = client Web do Obaflix, `nonce` = desafio PKCE) e envia o ID token a `POST /api/desktop-auth/google-native`. O servidor valida assinatura RS256 com as chaves do Google, emissor, público (`GOOGLE_CLIENT_ID`), validade e `nonce`; **identidade nunca vem só do cliente**. Depois aplica o mesmo `resolverContaGoogle` do login pelo navegador (por `sub`; sem vínculo automático a conta com senha; plano Gratuito para conta nova; admin bloqueado) e devolve um ticket do handoff existente, trocado em `/exchange` com o verifier (que não sai do aparelho). Falha/ausência do seletor ⇒ cai no navegador; recusa do servidor (403) **não** cai no navegador; cancelar não abre nada. Pré-requisito externo: cliente OAuth **Android** no Google Cloud para `com.obaflix` com o SHA-1 de cada certificado (APK externo/upload e app signing da Play, que podem diferir); sem ele o seletor falha e vale o navegador. Mudar o domínio do backend, o público ou as regras do resolvedor exige teste e autorização.

**Progresso local.** Posição e Continuar assistindo vivem só no aparelho (por conta/perfil): `ObaflixProgressSyncAdapter.remoteSyncEnabled = false`, sem `POST /api/progress` e sem Upstash para essa função. A importação do servidor (somente leitura, Postgres) roda uma vez por conta, é idempotente e nunca sobrescreve dado local mais novo; o histórico no servidor é preservado. Upstash segue só para autenticação, segurança e anúncios. Limite conhecido: tetos de 20/24 itens dos endpoints.

## Monetização (2.0)

Free vê anúncio; Premium (plano `seja-premium`, R$ 10 / 30 dias, preço `preco-seja-premium-30d`, `anunciosObrigatorios=false`) não vê. **Quem decide é o servidor** (`/api/billing/me` → `anunciosObrigatorios`, `/api/playback/authorize`): o cliente nunca ativa Premium nem remove anúncio por conta própria. Rewarded: o anúncio só libera a reprodução com recibo S2S do LevelPlay (callback assinado, `/api/ads/levelplay/*` + `/api/ads/complete`). Flags de servidor: `ANUNCIO_ANDROID_NATIVO_ATIVO`, `ANUNCIO_REWARDED_PLAYER_ATIVO`, `LEVELPLAY_S2S_RECEIVER_ENABLED` (desligadas = nenhum anúncio é pedido). O callback S2S precisa apontar, no painel do LevelPlay, para `https://obaflix.vercel.app/api/ads/levelplay/callback`.
Canais: o APK externo vende por Pix (`/api/billing/orders`, confirmação por webhook; pedido pendente é reaproveitado, sem cobrança duplicada). O build Play mantém `purchasesEnabled=false`: sem "SEJA PREMIUM", sem "REMOVER ANÚNCIOS", sem Pix nem link de pagamento externo, até existir Google Play Billing (pendência registrada). Ambos os builds saem com `-PobaflixRewardedRelease=true` (CI confere `obaflix.rewarded_release=true`, e `play_distribution` conforme o canal).
Testes: web `sejaPremium`, `recompensaLevelPlay`, `androidNativo*`, `billing*`; Android `ObaflixPremium*`, `ObaflixRewardedGate*`.
