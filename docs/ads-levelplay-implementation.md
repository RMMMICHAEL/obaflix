# Android monetization: LevelPlay rollout

Base: `ab43cc984d8befa3126949ab828690cf714f1ff6` (`origin/main`). Branch:
`feat/ads-levelplay-monetization`, isolated `ads-levelplay-monetization` worktree.
Version stays **22 / 1.0.22**. No production change, migration, deployment or publication.

## Stage 1 — grants and Play restrictions

The baseline regression reproduces a legacy Android soft grant after seven seconds,
even with `concluido=false` and no ad. This remains an explicitly **soft** direct-APK
contract; TV/Electron contracts are unchanged. Play-marked requests cannot redeem
legacy Android challenges. User-Agent is a restriction signal, not attestation;
the retained legacy protocol is not upgraded into a strong proof by this change.

New rewarded challenges use a separate `ads:levelplay:*` namespace. The S2S endpoint
accepts only the official signed fields, validates MD5 using the server private key
with constant-time comparison, requires one reward unit, validates timestamp and
binds the signed opaque initialization user ID to one account, purpose and title/episode.
Custom fields, dynamic IDs, elapsed time and Android callbacks are not proof.

Events and proofs have atomic Redis NX reservations; polling requires the account
session. Parallel polls have a permanent grant claim, preserving at-most-once
issuance. A process failure between claiming and persisting a grant fails closed:
manual reconciliation is required, never an automatic second grant. Challenges expire
after ten minutes; duplicate callback receipts survive nine days. Polling is bounded
and a delayed proof can be queried again before challenge expiry. No DDL is required.
Verified playback grants reuse the existing exact-title/episode paid marker for
retry/resume. Download/transmission do not acquire that playback window.

Play UI has an explicit rewarded choice and a native confirmation; the native build
blocks legacy interstitial regardless of JS/remote configuration. APK direct retains
the three-second invitation and soft redemption, now via a mediated interstitial.
An unavailable SDK/consent/inventory returns unavailability without opening playback.

## Stage 2 — pinned SDKs

Only `:app` depends on these SDKs; TV, core extraction and Electron are not changed.
Dependencies are reproducible through `android/app/gradle.lockfile`. Network binaries
are runtime dependencies; only the Java App Open boundary uses Google's runtime API.
The app compiles against Kotlin 1.9/coroutines 1.7 APIs while packaging the newer
runtime required by networks. No metadata check is suppressed or runtime downgraded.

| Network | Official adapter | SDK |
| --- | --- | --- |
| LevelPlay / ironSource | Built into mediation | 9.5.0 |
| Unity Ads | 5.14.0 | 4.21.0 |
| AdMob, Next-Gen | 5.16.0 | 1.5.0 |
| Pangle | 5.24.0 | 8.3.0.4 |
| InMobi | 5.10.0 | 11.5.0 |
| Liftoff / Vungle | 5.16.0 | 7.7.9 |
| DT Exchange / Fyber | 5.10.0 | 8.4.7 |
| myTarget / VK | 5.2.0 | 5.27.2 |

Ad Quality is pinned to 9.9.0, inside LevelPlay's declared supported range. The official
myTarget guide publishes this adapter/SDK pair; no custom/invented adapter is used.
No legacy Google Mobile Ads SDK is added alongside Next-Gen.

## Stage 3 — formats, privacy and remote controls

Interstitial and Rewarded use LevelPlay listeners, bounded load retries with jitter,
single-flight operations, lifecycle guards and watchdogs. Reward completion in Android
only initiates server polling; it cannot issue a grant. Banner uses a labeled 74dp band
outside the WebView, reserving space instead of overlaying posters/controls. Refresh
is paused; route changes, backgrounding and native/web fullscreen remove the band.
Placements: Home, Filmes, Séries, Animes and individual movie/series pages.

Kids is blocked, including remote attempts to enable its placement, pending Families
and network approval. The unapproved 18+ advertising gate was removed by explicit user
direction. Content rating 16 does not define advertising eligibility. The native
`ADS_AUDIENCE_VALIDATED=false` gate keeps new networks disabled until an audience/CMP
integration is reviewed; remote configuration cannot change it. No age is collected.
Free/ad-required entitlement is checked
on the server before offering ads; subscription users never trigger SDK initialization.
UMP 4.0.0 runs before SDK initialization, rejects storage-consent refusal, propagates
TCF/Additional Consent through LevelPlay, and conservatively sets no sale/share.
Privacy options are available on catalog/account surfaces with enabled formats.
Unity's automatic SDK startup is removed; myTarget auto-initialization is explicitly
disabled using its supported metadata switch. Existing lifecycle providers remain.

`GET /api/ads/config` authenticates the session, resolves entitlements and clamps the
server-owned JSON config. Format booleans cannot override Play/native restrictions;
caps are at most four/session and intervals at least 120 seconds. No configuration
contains URLs, credentials or code. All formats start off. App Open has real Google
load/show APIs, but its build approval is fixed false, with no automatic foreground
trigger. A reviewed natural loading surface is still required. Native ads are not added.

Native metrics aggregate request/load/failure/show/completion and revenue per format
in memory, without user/device/challenge/auction identifiers. New server grants and
verified proofs have daily Redis counters. These metrics are not authorization.

## External blockers — do not enable real ads yet

1. **LP-S2S-REUSE:** the documented signature covers the initialization user ID, not
   `dynamicUserId` or custom parameters. One initialization identity is therefore bound
   to one rewarded challenge. A second challenge in the same SDK process is rejected;
   initializing Banner/Interstitial first also prevents replacing that identity for
   Rewarded. Repeated cross-format use requires a provider-confirmed authenticated
   challenge-binding protocol and tests; do not relax the identity check to bypass this.
2. No LevelPlay app key/ad unit IDs, AdMob application ID, test-device registration or
   production S2S secret was supplied. Obtain these from their actual dashboards.
3. Configure an authenticated **rewarded-only** callback and reward amount **1**:
   `/api/ads/levelplay/callback?applicationUserId=[USER_ID]&eventId=[EVENT_ID]&rewards=[REWARDS]`.
   Verify that LevelPlay appends lowercase `timestamp` and `signature`, that timestamp
   is UTC `YYYYMMDDHHMM`, and test genuine, duplicate, delayed and replayed callbacks.
   The private key must be server-only and at least 32 characters.
4. Review UMP vendor lists, Additional Consent, US-state messages, denial/revocation,
   an explicitly approved audience policy and each network's child/Families requirements.
   Kids and `ADS_AUDIENCE_VALIDATED` stay off. Do not infer an 18+ policy from rating 16.
5. Review Data Safety and privacy policy for all included SDKs: advertising identifiers,
   device/app information, IP-derived location, interactions, diagnostics and revenue.
   Optional location, phone-state and QUERY_ALL_PACKAGES permissions are removed.
   AD_ID/network access remain; merged SDK permissions also include AdServices Topics/
   Attribution, billing, attest, wake lock and install-referrer binding. Their presence
   is not proof of collection; verify actual behavior on test devices and disclose
   applicable SDK use. Direct updater/download permissions remain direct-only.
6. `public/app-ads.txt` is preserved. It contains existing reseller inventory, not proof
   that every requested account is authorized. Add only dashboard-issued seller lines
   after verifying developer-domain/account ownership; none are invented here.
7. Validate real release builds on registered test devices via LevelPlay Integration
   Helper/Test Suite, each network dashboard, no-fill, consent refusal, paid entitlement,
   fullscreen and natural lifecycle transitions. Compilation is not homologation.
   R8 reports missing Pangle internal annotation types (`NetExtParams.RenderType`,
   `TTSdkSettings.FETCH_REQUEST_SOURCE`) and a myTarget tracer service manifest class.
   No fake classes or blanket warning suppressions were added. These SDK warnings
   require provider/runtime verification before enabling either network.

Public Gradle properties: `ads.LEVELPLAY_APP_KEY`, `ads.LEVELPLAY_INTERSTITIAL_ID`,
`ads.LEVELPLAY_REWARDED_ID`, `ads.LEVELPLAY_BANNER_ID`, `ads.ADMOB_APP_ID`,
`ads.ADMOB_APP_OPEN_ID`. Empty defaults are intentional. `ads.approved=false` by default;
debug never requests ads. App Open cannot be remotely enabled.

Server gates (all absent/off initially): `LEVELPLAY_REWARDED_ENABLED`,
`LEVELPLAY_S2S_VALIDATED`, `LEVELPLAY_S2S_PRIVATE_KEY`, `LEVELPLAY_REMOTE_CONFIG`.
Do not set the validation gate before resolving the blockers above. Conservative config:

```json
{"interstitial":false,"rewarded":false,"banner":false,"appOpen":false,"placements":[],"sessionCap":0,"intervalSeconds":120}
```

Network dashboard setup: Unity Game ID/placements; AdMob app/ad units and account
connection; ironSource bidder/ad units; Pangle application/placements and reporting
access; InMobi account/placements; Liftoff app/reference placements/reporting access;
DT publisher/app/placements/reporting access; VK/myTarget slot IDs/generated token.
Reporting secrets belong in dashboards/server integrations, never Gradle/JS/APK.

## Checkpoint validation — 2026-10-12

The final incremental run, including the renderer lifecycle fixes, passed in 9m46s:
`:app:testReleaseUnitTest`, `:app:testPlayReleaseUnitTest`, `:app:assembleRelease`,
`:app:assemblePlayRelease` and `:app:bundlePlayRelease`. Both JVM variants report
170 tests with zero failures/errors. The earlier Play R8 run failed with a 2GB heap;
validation succeeded using command-local `-Dorg.gradle.jvmargs=-Xmx4096m -Dfile.encoding=UTF-8`
and `--max-workers=1`. Shared project memory settings were not changed.

Artifacts: `android/app/build/outputs/apk/release/app-release-unsigned.apk`,
`android/app/build/outputs/apk/playRelease/app-playRelease-unsigned.apk` and
`android/app/build/outputs/bundle/playRelease/app-playRelease.aab` (unsigned validation
artifacts). APK metadata and generated BuildConfig retain 22/1.0.22. The Play flag
is true only in playRelease; advertising approval, audience validation and App Open
approval are false in both variants. Duplicate-class checks passed; the lockfile
contains Next-Gen Google Mobile Ads only, with no legacy Google Ads SDK alongside.

Reused verified web checkpoint: 147 directed tests passed. The affected checkpoint
subset passed 52 tests; after the playback marker and renderer corrections, the
current S2S/blocker subset passed all 9 tests. These overlapping runs are not additive.
TypeScript `--noEmit --incremental false`, targeted ESLint, Next lint and final
`git diff --check` passed. Regression evidence includes red-before/green-after Play
autoplay and renderer recovery checks. Tests used synthetic identities and local
Redis fallback, with remote Redis credentials cleared; no production data was used.

Merged manifests were inspected for both variants: Unity automatic initialization
is absent, myTarget auto-init is 0, optional location/phone/package-query permissions
are absent and direct updater/download permissions are absent from Play. Static
guards and JVM tests are not a substitute for device verification of consent,
collection, fullscreen, inventory and real signed callbacks. Pangle/myTarget R8
warnings and all external activation blockers above remain open.

Local changes and evidence logs are preserved on the baseline HEAD. This checkpoint
does not claim real-ad homologation, apply migrations, deploy, publish or activate ads.

## Official references inspected

- [LevelPlay Android integration](https://docs.unity.com/en-us/grow/levelplay/sdk/android/sdk-integration)
- [Official adapter compatibility table](https://docs.unity.com/en-us/grow/levelplay/sdk/android/mediation-networks)
- [S2S protocol and signature](https://docs.unity.com/en-us/grow/levelplay/platform/settings/event-handlers)
- [S2S configuration/retry behavior](https://docs.unity.com/en-us/grow/levelplay/platform/settings/server-to-server-callback)
- [Rewarded and dynamic IDs](https://docs.unity.com/en-us/grow/levelplay/sdk/android/rewarded-ads-integration)
- [AdMob Next-Gen adapter](https://docs.unity.com/en-us/grow/levelplay/sdk/android/networks/guides/google-admob)
- [Official myTarget/VK pair](https://docs.unity.com/en-us/grow/levelplay/sdk/android/networks/guides/vk-ad-network)
- [UMP](https://developers.google.com/admob/android/privacy)
- [Google Next-Gen App Open](https://developers.google.com/admob/android/next-gen/app-open)

Implementation files: `android/app` ads package/build/manifest/MainActivity and JVM tests;
`android/settings.gradle` scoped Pangle repository; `src/lib/ads` rewarded/config/client flow;
`/api/ads/{config,levelplay/*,complete}`; playback authorization; `useAnuncio`, native placement
component and its single layout mounting point. Authentication/account-deletion/TV/Electron
implementations are unchanged.
