# AdMob Rewarded Standard + SSV — infrastructure, all activation off

Worktree `ads-levelplay-monetization`, branch `feat/ads-levelplay-monetization`,
baseline HEAD `ab43cc984d8befa3126949ab828690cf714f1ff6`. Version stays 22/1.0.22.
No dashboard changes, live ads, real accounts, production SQL, deploy or publication.

## Implemented architecture

LevelPlay remains the Banner/Interstitial mediator with its existing adapters.
Direct Rewarded uses the already locked Google Mobile Ads **Next-Gen 1.5.0**; no
legacy SDK or extra SDK dependency is added. Its real AAR was inspected: RewardedAd
load/show and `ServerSideVerificationOptions(userId, customData)` are available.
The SDK's version uses a constructor, not the Builder shown in one guide example.

New independent build properties identify Standard units:
`ads.ADMOB_REWARDED_PLAY_STANDARD_ID` and `ads.ADMOB_REWARDED_DIRECT_STANDARD_ID`.
They default empty and are selected by the compiled Play flag. They are not the
Partner Bidding IDs used by the LevelPlay AdMob adapter. Serving type cannot be
inferred from an ID's syntax: the owner must verify Standard/Rewarded in the panel.

`GoogleAdsInitialization` coordinates initialization for direct Google formats;
App Open now shares it, preserving its hard off flag. No code globally disables
mediation adapters. Initialization requires advertising entitlement, CMP consent,
audience approval and public app ID. The optional bridge rechecks the authenticated
server challenge/entitlement before CMP or SDK requests. Subscribers without ads
are refused by the server. Both Play and Direct require a native affirmative choice.

Rewarded loads only on demand, uses bounded jittered retries, load/show timeouts,
weak Activity references, visibility/route checks and local frequency caps. SDK
errors/no inventory/cancellation are separate UI results. SDK reward callbacks and
close events are **only UI/polling signals**, never proof. SSV options are set on
the loaded object before show. Both user_id and custom_data contain only the same
256-bit random nonce, with no account/title/purpose or personal data.

The bridge/JS protocol is separate (`admob-ssv-v1`, `obaflixoptionalreward` event),
and never invokes the legacy player completion callback. The client helper is not
mounted in any product UI. Playback authorization, useAnuncio, entitlements,
authentication/revocation/account deletion, TV and Electron are not changed by
this stage. LevelPlay rewarded grants remain blocked by the previous stage.

## Commercial restriction and fixed off gates

`ADMOB_REWARDED_APPROVED=false` is fixed in both native release builds. Existing
`ADS_APPROVED=false`, `ADS_AUDIENCE_VALIDATED=false` and `APP_OPEN_APPROVED=false`
remain. No 18+ barrier was introduced. Missing units mean no ad requests.

Server `ADMOB_OPTIONAL_BENEFIT_APPROVED=false` is fixed in code; environment flags
alone cannot create challenges or unlock a benefit. The sole persisted purpose is
`optional_pending_policy`, explicitly excluding reproduction/download/transmission.
The SQL ledger records `verified` receipts but **every status has benefitGranted=false**.
No `emitirConcessao`, `marcarPago`, soft replacement or playback pass is called.

Possible benefits for a separate commercial decision include a cosmetic option,
an accessory feature, or a genuinely additional promotion beyond existing rights.
None is selected, priced, implemented or promised here. Declining/skipping must not
remove normal access. Before any activation, approve a precise benefit, disclosure,
non-transferability and reliable delivery/reconciliation flow. This infrastructure
is not approval to turn normal playback into an AdMob Rewarded toll.

## Server authorization and durable inbox

POST challenge uses existing authenticated sessions, origin protection, distribution
routing, entitlement checks and rate limit, verifies the content exists, then creates
a cryptographically random nonce bound to account, target, fixed optional purpose,
distribution, expected ad-unit/reward and ten-minute window. Only one pending active
operation per account/distribution is allowed. No account field is accepted from client.

The draft SQL uses a **private `ads_private` schema**, no User relationship changes,
RLS, no public/anon/authenticated grants, challenge table and durable SSV inbox.
Prisma parameterized SQL transactions explicitly use READ COMMITTED (independent
of database defaults), advisory scope/event locks, challenge row
locks, primary/unique constraints and checked write counts. Callback ACK occurs only
after COMMIT. A failed update rolls back the receipt insert too. Redis is not used
for reward persistence or callback acknowledgement; no in-memory production fallback.

Signature verification uses Node crypto ECDSA/SHA-256 DER over the original query
bytes preceding signature/key_id. No parameter sorting/re-encoding is performed.
Only the configured Standard units, matching reward, nonce/user_id and transaction
are accepted. Required fields must appear once; unknown fields are rejected. Public
keys are downloaded only from Google's fixed verifier URL, over HTTPS, with bounded
timeout, single-flight refresh, an EC key allowlist and cache shorter than 24 hours.
Unknown/unavailable keys fail closed. No Google private signing secret is required.

Configuration uses full AdMob IDs; SSV `ad_unit` is compared to their numeric unit
component, following the official callback contract. The guide describes timestamp
as milliseconds but shows a 16-digit microsecond example. Both explicit encodings
are normalized **after** signature validation; actual panel payloads must homologate
this interpretation. Nonce-only custom data and ASCII reward_item avoid escaping
ambiguities; validate genuine Google callback bytes before activation.

A delayed callback can validate only when its signed reward time was inside the
original challenge window (not merely because the app waited). First completion
after expiry is rejected. Cancelled challenges cannot validate. A receipt for another
unit/distribution/content does not migrate. Identical duplicate transaction is ACKed
without reprocessing; a transaction reused with different nonce/payload fails closed.
Valid but unauthorized events are persisted as `rejected` and ACKed as processed;
they never mark a challenge verified. A second transaction for a verified nonce is
also recorded rejected. Status/cancel require the original account/distribution.

SSV proves nonce/ad-unit/event, **not the actual originating APK binary**. Distribution
headers are routing contracts, not attestation. If originating-build proof becomes a
requirement, a separately reviewed platform-attestation design is needed.

## Endpoints and variables — not deployed/enabled

Use the verified HTTPS origin of the actual deployment; no invented host:

```text
POST /api/ads/admob/challenge
POST /api/ads/admob/status
GET  /api/ads/admob/callback
```

The AdMob callback URL is just the HTTPS callback path; Google appends its SSV query
including custom_data/user_id set per ad. Do not copy the LevelPlay callback template.
SSV HTTP 200 `OK` confirms a persisted processed/duplicate receipt, not benefit delivery.
Invalid signatures/scopes return 403; missing configuration, key or DB failure returns
503. No false success on storage failure. Google documents up to five re-attempts in
one-second intervals; a prolonged DB/key outage may exhaust them. PostgreSQL persistence
does not guarantee availability. Homologate latency/retries and an evidence-based
reconciliation procedure before promising rewards; never mint a client/time fallback.

Server variables, all new switches absent/off:

| Variable | Required value/role |
| --- | --- |
| ADMOB_REWARDED_PLAY_STANDARD_ID | Actual full Play Standard Rewarded unit ID |
| ADMOB_REWARDED_DIRECT_STANDARD_ID | Different actual full Direct Standard Rewarded unit ID |
| ADMOB_REWARD_AMOUNT | `1`, matched to panel configuration |
| ADMOB_REWARD_ITEM | Approved technical ASCII reward name, matched to panel; no value invented |
| ADMOB_SSV_RECEIVER_ENABLED | Default false; isolated receipt homologation only when authorized |
| ADMOB_OPTIONAL_REWARDED_ENABLED | Default false; fixed benefit approval still blocks issuance |
| DATABASE_URL / DIRECT_URL | Existing server-only Prisma configuration; no credentials changed |

Native public properties: `ads.ADMOB_APP_ID` and the two Standard IDs above. Never
include DATABASE_URL, session cookies or any server secret in Gradle/JS/APK/logs.
The exposed LevelPlay private key still needs rotation before any future LevelPlay
receiver use; it is not used by AdMob ECDSA verification.

## SQL approval, privacy and device blockers

`docs/sql/admob-rewarded-inbox.sql` is **draft migration DDL**, not applied to the real
project or production. It was executed only in an isolated PostgreSQL WASM test engine
with synthetic data. Review privileges/runtime DB role, migration registration and
rollback strategy before authorizing an application to a dedicated test database.
Do not expose the private schema in Supabase Data API. A failure/missing schema stays
503, without any grant. No real schema query or production migration was run.

Approve eligibility/CMP messages and vendor signals, child/Families treatment, Data
Safety, app-ads.txt ownership, and retention/erasure of private account-linked receipts
before real use. Account-deletion code was deliberately preserved; new data lifecycle
must be reviewed separately before storing real accounts. Test real consent refusal,
paid-plan transition, background/return/fullscreen and network outages in devices.
The previous Pangle/myTarget R8 warnings remain external homologation blockers.

## Exact future AdMob panel steps — do not perform now

1. Confirm app/account readiness, application ID, store association and developer
   domain/app-ads.txt. No live test traffic until readiness/privacy approval.
2. Create Android **Rewarded**, serving type **Standard** units named
   `Rewarded_Play_Standard` and `Rewarded_Direct_Standard`. Leave Partner Bidding off.
   Do not repurpose the existing LevelPlay Partner Bidding units.
3. Copy the two actual IDs to matching native/server properties. Select matching reward
   amount 1 and a commercially approved item name. Record serving type/format ownership
   for the server allowlist; names/ID syntax alone cannot verify serving type.
4. After authorized test deployment/SQL setup, Advanced settings → Server-side
   verification → Set up and verify callback URL. Use its real HTTPS callback path.
   Provide a synthetic server-created nonce as BOTH test User ID and Custom data.
   Verify genuine signature, unit, timestamp encoding, duplicate/late/error behavior.
5. Register test devices/use official test ads. Confirm Google/LevelPlay shared SDK
   initialization via inspector/integration helper and actual runtime traces. Compilation
   and source-contract tests are not SDK/device homologation.
6. Do not Save/activate real SSV/ads here. Future AdMob Mediation and "Apply to all
   networks in Mediation groups" are a separate stage; no Google third-party mediation
   adapters are added now. Existing LevelPlay adapters are preserved.

## Validation and files

New modules: `admobSsv`, `admobStore`, `admobOptionalRequest`, `admobOptionalClient`,
three AdMob routes; native `AdmobRewarded`, `GoogleAdsInitialization`,
`AdmobChallengeEligibility`; separate bridge/JS capability, public build fields and
App Open shared-init adjustment; tests and this draft SQL/report.

Directed web: 35 passing tests including 10 new AdMob tests and prior S2S/Play/remote
regressions. Embedded PostgreSQL: 8 passing tests with real SQL/transactions, schema
privacy, race/duplicate, cross-scope, delay/expiry, rollback and sequential Direct cases.
The embedded engine serializes local sessions; production multi-instance locking,
pool/role behavior and restart durability still require a dedicated staging database.
No dependencies are added to the app package manifest for these tests: PGlite 0.5.9
is installed only under ignored `android/app/build/ads-test-db`.

Test commands:
```text
npm install --prefix android/app/build/ads-test-db --no-package-lock --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.9
NODE_ENV=test node --test --import tsx src/lib/__tests__/admobSsv.test.ts
NODE_ENV=test node --test --import tsx scripts/__tests__/admobStore.postgres.test.mjs
```
Final checkpoint 2026-10-13: the joint directed run passed all 43 tests (35 web/SSV
plus 8 embedded PostgreSQL). TypeScript, targeted ESLint and git diff --check passed
after the explicit isolation correction and final client-event polling changes.
JVM variants have 173 tests each with no failures/errors. The final native command
passed release, playRelease and Play AAB packaging in 7m51s. APKs and AAB are unsigned
validation artifacts. No active Gradle wrapper/R8 process remained at checkpoint.
APK metadata/generated flags confirm version 22/1.0.22, Play flag only in playRelease,
all advertising/audience/App Open/AdMob approval flags false and Standard IDs empty.
Duplicate-class checks passed; the lockfile contains Next-Gen 1.5.0 only, with no
legacy Google Ads SDK alongside. Both merged manifests retain myTarget auto-init 0,
Unity startup removal and Play updater/download permission restrictions. Remaining
R8 warnings are the previously documented Pangle annotations/myTarget service class.
These checks do not constitute real-device/network/CMP homologation.
Evidence logs stay local and are not intended for commit. Baseline HEAD and all local
changes are preserved; no commit/push/migration/deploy/publication was performed.

Final versioning review: the complete web suite passed all 1,846 tests with zero
failures. The user subsequently authorized local commits only. Native sources are
unchanged from the successful 173-tests-per-variant/release/playRelease/AAB checkpoint;
the validated Android artifacts are reused. Local logs are preserved under ignored
`android/app/build/ads-evidence`, outside the selected source/test/documentation commits.
This authorization does not permit push, merge, real migrations, ads or production.

Official sources: [Next-Gen SSV](https://developers.google.com/admob/android/next-gen/ssv),
[Rewarded](https://developers.google.com/admob/android/next-gen/rewarded),
[unit serving types](https://support.google.com/admob/answer/12436136),
[Rewarded policies](https://support.google.com/admob/answer/7313578),
[PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html).
