# Contratos críticos — web/backend Obaflix

Leitura **obrigatória** antes de alterar as áreas abaixo (humanos, Claude, Codex, outras IAs). Texto completo e tabela de riscos do app Android:
`docs/CONTRATOS_CRITICOS.md` do repositório Android nativo. Aqui ficam os contratos do backend. Verificação automática: `src/lib/__tests__/contratos.test.ts` (roda em `npm run test:web`).
Risco ALTO/CRÍTICO ⇒ teste cobrindo a mudança + revisão antes de promover + commit com "Contrato: <área>". Sem autorização do dono: nada de push na `main`, merge, deploy/banco/variáveis de Production, DNS ou Google Cloud.

| Área | Risco | Arquivos | Regra |
|---|---|---|---|
| Login Google / NextAuth | CRÍTICO | `src/lib/googleSignIn.ts`, `googleLink.ts`, `authHost.ts`, `auth.ts`, `scripts/patch-next-auth-origin.cjs`, `src/app/api/auth/google-link/route.ts` | Identidade = `sub` (`User.googleSub` único). Sem vínculo automático por e-mail a conta com senha; vínculo exige senha atual + cookie de uso único. `hd` nunca vincula. Conta nova = plano Gratuito. Admin não é criado por Google. Só hosts oficiais (`obaflix.vercel.app`, `obaflixbr.com`, `obaflix.online`) e só confiados com `VERCEL=1`. O patch do `detect-origin` roda em `postinstall` e `build` e é verificado por hash. |
| Google nativo (Android) | CRÍTICO | `src/lib/googleIdToken.ts`, `src/app/api/desktop-auth/google-native/route.ts` | O ID token é validado no servidor (assinatura RS256 das chaves do Google, `iss`, `aud` = `GOOGLE_CLIENT_ID`, `exp`, `nonce` = desafio PKCE); identidade nunca vem só do cliente. Mesma regra do navegador (`resolverContaGoogle`, sem vínculo automático por e-mail a conta com senha; recusa = 403). Devolve ticket do handoff, trocado em `/exchange`. Rate limit 20/15 min por IP (Redis de segurança). Testes: `googleIdToken.test.ts`. Exige cliente OAuth Android no Google Cloud (SHA-1 de cada certificado) — mudança fora do código, só com autorização. |
| Handoff app/desktop | CRÍTICO | `src/lib/desktopAuth.ts`, `src/app/api/desktop-auth/*` | PKCE S256 + `state`; ticket de 180 s e **uso único** (`consumirTicketUmaVez`, Redis `SET NX`, falha fechada, chamado depois do PKCE). |
| Banco / migrations | CRÍTICO | `prisma/`, `scripts/aplicar-google-sub.ts` | Só migrations aditivas e idempotentes; dry-run, hash antes/depois, recusa de banco de teste. Antes de migrar Production: backup `pg_dump` cifrado restaurado e validado. Production não usa `_prisma_migrations`. Rollback de código mantém `googleSub`. |
| Contas excluídas | ALTO | `accountDeletion` | Entrar de novo com Google cria conta nova, nunca ressuscita a apagada. |
| Planos / Pix / Premium | CRÍTICO | `src/lib/planos.ts`, `src/lib/billing/*`, `/api/billing/orders` | Pedido exige `planoId` e `planoPrecoId`. Plano `seja-premium` / `preco-seja-premium-30d` (R$ 10, 30 dias) oculto da vitrine. Não alterar pagamentos sem autorização. |
| Rewarded S2S / anúncios | CRÍTICO | rotas de anúncio e `anunciosObrigatorios` em `/api/me` | Recompensa só com confirmação S2S assinada; regra de obrigatoriedade vem do servidor. |
| Reprodução | ALTO | `src/lib/playbackAuthorization.ts` | `POST /api/playback/authorize` é o único portão; clientes oficiais enviam `x-obaflix-client`. |
| Distribuição Android | CRÍTICO | `public/update-manifest.json` (se existir) / manifesto em `app.obaflix.online` | Formato `schemaVersion 1` → `android{versionName,versionCode,url,size,sha256}`; só publicar APK testado; guardar cópia anterior. |

Alterar: 1) ache a linha e o teste; 2) altere; 3) `npm run test:web`; 4) commit "Contrato: <área>"; 5) risco ALTO/CRÍTICO: revisão antes de promover.

## Monetização (2.0) — backend

Plano `seja-premium` (R$ 10 / 30 dias, `preco-seja-premium-30d`, `anunciosObrigatorios=false`) gravado em Production por `scripts/seja-premium.ts` (dry-run primeiro; aditivo; `--apply --banco=<host>`), fora da vitrine (`PLANOS_FORA_DA_VITRINE`) e visível só em `/api/billing/plans?oferta=seja-premium`. Quem decide anúncio é o servidor (`/api/billing/me`, `/api/playback/authorize`); Rewarded só vale com recibo S2S assinado do LevelPlay (`/api/ads/levelplay/*`, `/api/ads/complete`). Flags: `ANUNCIO_ANDROID_NATIVO_ATIVO`, `ANUNCIO_REWARDED_PLAYER_ATIVO`, `LEVELPLAY_S2S_RECEIVER_ENABLED`; o callback do painel LevelPlay deve apontar para `https://obaflix.vercel.app/api/ads/levelplay/callback`. Pix usa `/api/billing/orders` (pedido pendente reaproveitado, sem cobrança duplicada). Rollback: remover as duas linhas do plano e redeploy do deployment anterior.
