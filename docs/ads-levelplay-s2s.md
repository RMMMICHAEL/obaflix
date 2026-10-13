# LevelPlay S2S stage — blocked for real grants

Baseline `ab43cc984d8befa3126949ab828690cf714f1ff6`; isolated branch
`feat/ads-levelplay-monetization`. Stage 3, Android SDKs/CMP/formats, authentication,
revocation, TV, Electron and version 22/1.0.22 are unchanged in this stage.

## Protocol evidence and limits

The [official event-handler contract](https://docs.unity.com/en-us/grow/levelplay/platform/settings/event-handlers)
signs MD5 of the concatenation of timestamp, event ID, URL-decoded initialization
USER_ID, reward amount and private key. It does not specify signed format, app/ad-unit,
placement, distribution, dynamicUserId or custom parameters. Timestamp is callback
time, not impression time or challenge proof. The receiver accepts exactly one copy
of each signed query field and never uses unsigned metadata to authorize a grant.

The [Android rewarded guide](https://docs.unity.com/en-us/grow/levelplay/sdk/android/rewarded-ads-integration)
allows dynamicUserId to change before showAd (1–64 alphanumeric characters), but
does not add it to the published signature. Local inspection of the installed
mediation-sdk 9.5.0 AAR with javap confirms LevelPlayInitRequest.Builder.withUserId,
LevelPlay.init and LevelPlay.setDynamicUserId as separate APIs. This proves API
availability, not backend signature coverage or safe reinitialization between ads.
No identity mutation/reinitialization guarantee was found.

**BLOCKER LP-S2S-SIGNED-SCOPE:** a valid commission signature is not demonstrable
proof of Rewarded format or originating APK distribution. Administrative configuration
and a client-reported placement/build are not signed evidence. This blocks real grants
even with valid credentials and environment flags. `LEVELPLAY_SIGNED_SCOPE_SUPPORTED`
is fixed false in server code; the real emitter also checks the gate before consumption.
Signed callbacks can only be stored as quarantined receipts. No Interstitial, Banner,
App Open, Offerwall or client callback can create a real grant through this flow.

**BLOCKER LP-S2S-REUSE** remains: a fresh opaque initialization identity is required
per challenge; the SDK is not proven to rotate it safely between shows. Never bind a
fixed account USER_ID to whichever challenge happens to be active when a callback
arrives. That would allow an old, unseen legitimate event to pay a new title/purpose.

## Server state and failure behavior

The new versioned namespace `ads:levelplay:v2:*` does not consume legacy challenges or
pre-stage receipts. Random 48-hex initialization IDs map immutably to account, exact
title/episode, purpose, distribution, format and expiry. Distribution defaults to the
existing Play-only rewarded flow. One active operation per account/distribution is
reserved with Redis SET NX. Old identities are never rebound to a new challenge.

Global event reservation plus per-challenge receipt prevent cross-challenge replay.
Missing/replaced active-operation reservations fail closed even for valid signatures.
Only persisted, matching reservations receive ACK. A partial write yields no ACK;
a retry may complete the same receipt, never redirect it. The status consumer checks
both reservations. Cancellation and grant consumption race on a single permanent
terminal SET NX key: one wins. A cancelled challenge cannot grant, including when
its receipt races with cancellation. Cancelling an old ID uses compare-and-delete
and cannot release a newer operation's reservation.

Challenge expiry is ten minutes; receipt/event/terminal retention is nine days.
Duplicates of an already persisted receipt can be acknowledged after challenge expiry
without another grant. First callbacks after expiry are rejected. Return-to-app polling
recovers the same persisted result while valid. A crash after consumption claim but
before result persistence requires manual reconciliation, never automatic re-emission.
The new status request supports `cancelar:true` for the authenticated owner, subject
to the same distribution scope; the public status flow remains gated off.

UA distribution checks preserve the existing request contract but are **not attestation**.
They do not prove which APK displayed an ad. Real grants remain blocked. Synthetic
grant emitters in tests validate the state machine without minting real playback access.
Paid entitlements and soft legacy grants are unchanged.

No persistent-Redis configuration means no receiver initialization, including staging:
there is no implicit per-process memory fallback for ACK. Memory storage is explicitly
injected only into isolated tests. Redis errors produce non-200 responses with no ACK;
errors never release playback. No database migration is needed or applied.

## Exact endpoint contract — not deployed or activated

Use the **verified HTTPS origin of the actual deployment** plus this exact path/query:

```text
GET /api/ads/levelplay/callback?applicationUserId=[USER_ID]&eventId=[EVENT_ID]&rewards=[REWARDS]
```

LevelPlay adds lowercase `timestamp` and `signature`, as in its official PHP sample.
All five fields are required exactly once. Reward amount must be `1`; event ID is
alphanumeric; USER_ID is the server-issued opaque 48-hex ID. Timestamp must be
YYYYMMDDHHMM; the UTC interpretation still requires confirmation with genuine panel
callbacks. Optional metadata is ignored for authorization. Do not embed a private key
in the URL, Android, JS, documentation or logs. No host, key or credential is invented.

HTTP 200 with body `EVENT_ID:OK` means the receipt is processed and persistently stored
or is an identical persisted duplicate. **It does not mean a playback grant was issued.**
Invalid/unknown/cancelled/expired first events return 400/403, disabled or unavailable
storage returns 503; none contain `:OK`. No redirect or HTTP endpoint is accepted.

The [official retry contract](https://docs.unity.com/en-us/grow/levelplay/platform/settings/server-to-server-callback)
requires ACK within 400ms, offers a 20s slow-callback queue, and retries for eight days.
The implementation uses several Redis round trips. The 400ms budget is unmeasured
and must be verified in staging; a timeout/retry cannot grant twice. There is no claim
of real Redis latency, network callback authenticity or production durability testing.

## Variables and dashboard procedure

- `LEVELPLAY_S2S_RECEIVER_ENABLED`: absent/false now. Enables quarantined receipt
  ingestion only after an approved isolated endpoint test; it does not enable grants.
- `LEVELPLAY_S2S_PRIVATE_KEY`: server-only, at least 32 characters. **Rotate the
  previously displayed key before use.** Never reuse it in another app/callback scope.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: dedicated persistent
  test storage for staging verification; production credentials are not used in tests.
- `LEVELPLAY_REWARDED_ENABLED` and `LEVELPLAY_S2S_VALIDATED`: remain absent/false.
  Even true values cannot bypass the fixed signed-scope blocker.
- `LEVELPLAY_REMOTE_CONFIG` and native approval/audience guards remain off as in Stage 3.

Unity Ads, LevelPlay, AdMob and Pangle dashboard setup and an available App Key were
reported by the user. This stage did not inspect those accounts, copy the App Key,
rotate secrets, save dashboard settings or turn S2S on.

1. Resolve signed-scope requirements with Unity before real-grant activation. Obtain
   explicit guarantees for challenge identity rotation and signed format/ad-unit/build
   scope; retain grants off if the published protocol is unchanged.
2. Rotate the exposed private key. Separately prepare a reviewed HTTPS test deployment
   with dedicated Redis, receiver-only enablement and real-grant gates still off.
3. Provision a synthetic challenge in that test store using the service/test harness;
   do not add a public arbitrary-challenge creation endpoint or use a real account.
4. In the panel Callback test, use that exact synthetic initialization USER_ID and
   reward amount 1. Use the actual verified HTTPS origin/path above. Disable optional
   metadata dependency. Confirm timestamp/timezone and exact signature formula.
5. Test wrong signature, unknown ID, duplicate, delayed/expired, cancelled and outage
   cases; verify no ACK before persistence and no real playback grant in every case.
   Measure receipt latency and retry/slow-queue behavior against the published limits.
6. Do not Save/activate S2S or ads as part of this stage. Saving activates callbacks,
   according to the official guide; dashboard actions require a separate authorized
   homologation step with all blockers resolved.

## Technically viable alternative — proposed, not implemented

Use a rewarded path with per-impression server-issued nonce in **signed** custom data
and a signed ad-unit identifier. [Google Next-Gen rewarded SSV](https://developers.google.com/admob/android/next-gen/ssv)
uses ECDSA verification of callback parameters including custom_data, ad_unit and
transaction_id. An immutable nonce can then select the exact server-authorized
account/content/purpose/distribution, with an allowlist of Rewarded units and atomic
consumption. This addresses per-show binding and format identification without SDK
reinitialization. It requires a separately scoped rewarded integration/homologation;
it is not assumed to be available through the existing LevelPlay adapter.

Signed custom data still does not attest the actual APK binary. If originating-build
proof is required, combine server-side challenge issuance with verified platform
attestation and enforce distribution scope at consumption; UA alone is insufficient.
No alternative SDK/network change is made in this stage.

## Validation

OWASP WSTG-BUSL-02/03/04/05/06: forged requests, integrity, races, limits and workflow.
The four new baseline regressions failed before correction and passed afterward.
Current directed run: 25 tests passed (new scope tests plus existing S2S, blocker and
remote-control regressions), including storage failures, sequential IDs, cross-account/
content/purpose replay, cancellation, concurrent consumption, delayed receipts and resume.
TypeScript, targeted ESLint and diff checks are recorded in local stage evidence logs.
No external callback, production database or real ad traffic was exercised. Previous
170 JVM tests per variant, 147 web tests and release/playRelease builds are reused;
no Android build input was changed in this stage. No commit/push/merge/deploy/publication.
