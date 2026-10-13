package com.obaflix.ads;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import com.obaflix.BuildConfig;
import com.google.android.libraries.ads.mobile.sdk.MobileAds;
import com.google.android.libraries.ads.mobile.sdk.initialization.InitializationConfig;
import com.google.android.libraries.ads.mobile.sdk.appopen.AppOpenAd;
import com.google.android.libraries.ads.mobile.sdk.appopen.AppOpenAdEventCallback;
import com.google.android.libraries.ads.mobile.sdk.appopen.AppOpenAdRequest;
import com.google.android.libraries.ads.mobile.sdk.common.AdLoadCallback;
import com.google.android.libraries.ads.mobile.sdk.common.FullScreenContentError;
import com.google.android.libraries.ads.mobile.sdk.common.LoadAdError;

/** Separate Google Next-Gen App Open, with no foreground/autoresume trigger.
 * The build approval is false in every shipped variant. A reviewed native loading
 * surface must explicitly invoke this after eligibility and CMP confirmation.
 */
public final class AppOpenAds {
    private final Handler main = new Handler(Looper.getMainLooper());
    private AppOpenAd ad;
    private boolean loading;
    private boolean initializing;
    private boolean showing;
    private long loadedAt;
    private long lastShown;
    private long otherAdClosedAt;
    private int shows;
    private int generation;

    public void otherAdClosed() { otherAdClosedAt = android.os.SystemClock.elapsedRealtime(); }
    public void clear() { generation++; ad = null; loading = false; initializing = false; main.removeCallbacksAndMessages(null); }
    private boolean approved(boolean eligible, boolean consent) {
        return BuildConfig.ADS_APPROVED && BuildConfig.ADS_AUDIENCE_VALIDATED && BuildConfig.APP_OPEN_APPROVED && !BuildConfig.PLAY_STORE_BUILD &&
            !BuildConfig.DEBUG && eligible && consent && !BuildConfig.ADMOB_APP_OPEN_ID.isEmpty();
    }
    public void preload(Activity activity, boolean eligible, boolean consent) {
        if (!approved(eligible, consent) || loading || showing || ad != null) return;
        if (!MobileAds.isInitialized()) {
            if (BuildConfig.ADMOB_APP_ID.isEmpty() || initializing) return;
            initializing = true;
            final int run = ++generation;
            java.lang.ref.WeakReference<Activity> ref = new java.lang.ref.WeakReference<>(activity);
            final android.content.Context app = activity.getApplicationContext();
            main.postDelayed(() -> { if (run == generation) clear(); }, 30000);
            GoogleAdsInitialization.ensure(activity, eligible, consent,
                ready -> main.post(() -> {
                    if (run != generation) return;
                    initializing = false; main.removeCallbacksAndMessages(null);
                    Activity host = ref.get();
                    if (ready && host != null && !host.isDestroyed()) preload(host, eligible, consent);
                }));
            return;
        }
        loading = true;
        final int run = ++generation;
        main.postDelayed(() -> { if (run == generation) clear(); }, 30000);
        AdMetrics.INSTANCE.count(AdFormat.APP_OPEN, "request");
        AppOpenAd.load(new AppOpenAdRequest.Builder(BuildConfig.ADMOB_APP_OPEN_ID).build(), new AdLoadCallback<AppOpenAd>() {
            @Override public void onAdLoaded(AppOpenAd value) {
                main.post(() -> {
                    if (run != generation) return;
                    main.removeCallbacksAndMessages(null);
                    loading = false; ad = value;
                    loadedAt = android.os.SystemClock.elapsedRealtime();
                    AdMetrics.INSTANCE.count(AdFormat.APP_OPEN, "load");
                });
            }
            @Override public void onAdFailedToLoad(LoadAdError error) {
                main.post(() -> { if (run == generation) { clear(); AdMetrics.INSTANCE.count(AdFormat.APP_OPEN, "failure"); } });
            }
        });
    }
    public boolean showAtLoadingScreen(Activity activity, boolean eligible, boolean consent,
            boolean naturalLoadingScreen, boolean playing, boolean fullscreen) {
        long now = android.os.SystemClock.elapsedRealtime();
        if (!approved(eligible, consent) || !naturalLoadingScreen || playing || fullscreen || showing || ad == null ||
            activity.isFinishing() || activity.isDestroyed() || !activity.hasWindowFocus() ||
            now - loadedAt > 4 * 60 * 60 * 1000L || shows >= 4 ||
            (lastShown != 0 && now - lastShown < 120000) || (otherAdClosedAt != 0 && now - otherAdClosedAt < 120000)) return false;
        AppOpenAd value = ad; ad = null; showing = true; lastShown = now; shows++;
        value.setAdEventCallback(new AppOpenAdEventCallback() {
            @Override public void onAdShowedFullScreenContent() { AdMetrics.INSTANCE.count(AdFormat.APP_OPEN, "show"); }
            @Override public void onAdDismissedFullScreenContent() { showing = false; }
            @Override public void onAdFailedToShowFullScreenContent(FullScreenContentError error) { showing = false; AdMetrics.INSTANCE.count(AdFormat.APP_OPEN, "failure"); }
        });
        value.show(activity);
        return true;
    }
}
