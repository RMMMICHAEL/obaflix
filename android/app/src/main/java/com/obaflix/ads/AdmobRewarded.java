package com.obaflix.ads;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import com.obaflix.BuildConfig;
import com.google.android.libraries.ads.mobile.sdk.common.*;
import com.google.android.libraries.ads.mobile.sdk.rewarded.*;
import java.lang.ref.WeakReference;

/** Standard rewarded only. Client events are UI signals, never playback proof. */
public final class AdmobRewarded {
    public interface Result { void event(String event); }
    public interface Visible { boolean allowed(); }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AdSessionCap cap = new AdSessionCap(() -> android.os.SystemClock.elapsedRealtime());
    private boolean busy;
    private int generation;
    public void clear() { generation++; busy = false; main.removeCallbacksAndMessages(null); }
    public void show(Activity activity, String nonce, boolean eligible, boolean consent, boolean optIn,
                     Visible visible, Result result) {
        String unit = BuildConfig.PLAY_STORE_BUILD ? BuildConfig.ADMOB_REWARDED_PLAY_STANDARD_ID : BuildConfig.ADMOB_REWARDED_DIRECT_STANDARD_ID;
        if (!BuildConfig.ADMOB_REWARDED_APPROVED || !optIn || !eligible || !consent || busy ||
            !nonce.matches("[a-f0-9]{64}") || unit.isEmpty() || !visible.allowed() || !cap.available(4, 120000)) {
            result.event("unavailable"); return;
        }
        busy = true;
        final int run = ++generation;
        WeakReference<Activity> host = new WeakReference<>(activity);
        GoogleAdsInitialization.ensure(activity, eligible, consent, ready -> {
            if (run != generation) return;
            if (!ready) { finish(run, "unavailable", result); return; }
            load(host, unit, nonce, run, 0, visible, result);
        });
    }
    private void load(WeakReference<Activity> host, String unit, String nonce, int run, int attempt, Visible visible, Result result) {
        if (run != generation) return;
        Activity activity = host.get();
        if (activity == null || activity.isDestroyed() || activity.isFinishing() || !visible.allowed()) { finish(run, "cancelled", result); return; }
        main.postDelayed(() -> finish(run, "timeout", result), 45000);
        AdMetrics.INSTANCE.count(AdFormat.REWARDED, "request");
        try { RewardedAd.load(new AdRequest.Builder(unit).build(), new AdLoadCallback<RewardedAd>() {
            @Override public void onAdFailedToLoad(LoadAdError error) { main.post(() -> {
                if (run != generation) return;
                main.removeCallbacksAndMessages(null);
                if (String.valueOf(error.getCode()).contains("NO_FILL")) { finish(run, "no_inventory", result); return; }
                Long delay = AdSafetyPolicy.INSTANCE.retryDelay(attempt, Math.random());
                if (delay == null) finish(run, "load_failed", result);
                else main.postDelayed(() -> load(host, unit, nonce, run, attempt + 1, visible, result), delay);
            }); }
            @Override public void onAdLoaded(RewardedAd ad) { main.post(() -> {
                if (run != generation) return;
                main.removeCallbacksAndMessages(null);
                Activity current = host.get();
                if (current == null || current.isDestroyed() || current.isFinishing() || !visible.allowed()) { finish(run, "cancelled", result); return; }
                // Both opaque values select one immutable server challenge; no account/title PII.
                ad.setServerSideVerificationOptions(new ServerSideVerificationOptions(nonce, nonce));
                ad.setAdEventCallback(new RewardedAdEventCallback() {
                    @Override public void onAdShowedFullScreenContent() { cap.recordShow(); AdMetrics.INSTANCE.count(AdFormat.REWARDED, "show"); }
                    @Override public void onAdDismissedFullScreenContent() { main.post(() -> finish(run, "closed", result)); }
                    @Override public void onAdFailedToShowFullScreenContent(FullScreenContentError error) { main.post(() -> finish(run, "show_failed", result)); }
                });
                main.postDelayed(() -> finish(run, "timeout", result), 180000);
                try { ad.show(current, reward -> main.post(() -> {
                    // A late reward signal can initiate status polling; it cannot issue a benefit.
                    AdMetrics.INSTANCE.count(AdFormat.REWARDED, "completion");
                    result.event("client_reward_signal");
                })); } catch (RuntimeException | LinkageError error) { finish(run, "sdk_unavailable", result); }
            }); }
        }); } catch (RuntimeException | LinkageError error) { finish(run, "sdk_unavailable", result); }
    }
    private void finish(int run, String event, Result result) {
        if (run != generation) return;
        clear(); result.event(event);
    }
}
