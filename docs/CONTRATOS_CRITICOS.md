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
