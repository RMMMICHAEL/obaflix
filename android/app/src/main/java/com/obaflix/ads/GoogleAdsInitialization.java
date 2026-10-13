package com.obaflix.ads;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import com.obaflix.BuildConfig;
import com.google.android.libraries.ads.mobile.sdk.MobileAds;
import com.google.android.libraries.ads.mobile.sdk.initialization.InitializationConfig;
import java.util.ArrayList;
import java.util.List;

/** All callers must first resolve entitlement, audience and CMP consent. */
public final class GoogleAdsInitialization {
    public interface Result { void ready(boolean ready); }
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final List<Result> waiting = new ArrayList<>();
    private static boolean initializing;
    private static int generation;
    private GoogleAdsInitialization() {}
    public static void ensure(Activity activity, boolean eligible, boolean consent, Result result) {
        main.post(() -> {
            if (!eligible || !consent || !BuildConfig.ADS_APPROVED || !BuildConfig.ADS_AUDIENCE_VALIDATED ||
                BuildConfig.DEBUG || BuildConfig.ADMOB_APP_ID.isEmpty() || activity.isDestroyed() || activity.isFinishing()) {
                result.ready(false); return;
            }
            try { if (MobileAds.isInitialized()) { result.ready(true); return; } }
            catch (RuntimeException | LinkageError error) { result.ready(false); return; }
            waiting.add(result);
            if (initializing) return;
            initializing = true;
            final int run = ++generation;
            final android.content.Context app = activity.getApplicationContext();
            main.postDelayed(() -> finish(run, false), 30000);
            // Do not disable Google/LevelPlay mediation adapters globally.
            new Thread(() -> {
                try { MobileAds.initialize(app, new InitializationConfig.Builder(BuildConfig.ADMOB_APP_ID).build(),
                    status -> main.post(() -> finish(run, true))); }
                catch (RuntimeException | LinkageError error) { main.post(() -> finish(run, false)); }
            }, "ads-google-init").start();
        });
    }
    private static void finish(int run, boolean ready) {
        if (!initializing || run != generation) return;
        initializing = false; generation++;
        main.removeCallbacksAndMessages(null);
        List<Result> results = new ArrayList<>(waiting); waiting.clear();
        for (Result result : results) result.ready(ready);
    }
}
