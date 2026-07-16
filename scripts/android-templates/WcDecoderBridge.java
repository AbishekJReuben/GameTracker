package __PACKAGE__;

import android.app.Activity;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.graphics.SurfaceTexture;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;
import java.lang.ref.WeakReference;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Low-latency H.264 decode for GameTracker Remote (DIRECT path).
 *
 * Patterns borrowed from (and re-tested against the actual sources):
 *  - moonlight-android MediaCodecHelper + MediaCodecDecoderRenderer
 *      • FEATURE_LowLatency + vendor keys (qualcomm / hisi / exynos / amlogic)
 *      • Progressive low-latency config attempts — try the most aggressive set
 *        first, fall back to a plain MediaFormat if {@link MediaCodec#configure}
 *        throws. This is the core fix for "MediaCodec unavailable" on devices
 *        whose driver rejects an unknown vendor key during configure.
 *      • {@code KEY_OPERATING_RATE = Short.MAX} + {@code KEY_PRIORITY = 0} as a
 *        secondary low-latency lever on Qualcomm.
 *      • Pick a low-latency variant if one exists (e.g. {@code c2.qti.avc.decoder
 *        .low_latency}) even when a non-LL decoder is listed first.
 *      • CSD-0/SPS+PPS extracted from the first Annex-B IDR and queued as
 *        {@link MediaCodec#BUFFER_FLAG_CODEC_CONFIG} before the slice — many
 *        Android HW decoders never produce output without an explicit CSD.
 *  - chiaki-ng video-decoder.c (AMediaCodec → Surface)
 *  - ALVR push_nal / deskstream VideoDecoder.kt (async callback, Annex-B AUs)
 *
 * Hot path: {@link JsApi#feed} via JavascriptInterface (base64 Annex-B).
 * Lifecycle: static methods called from Rust over JNI.
 *
 * Compositing: {@link TextureView} under a transparent WebView (NOT
 * SurfaceView hole-punch). SurfaceView punches through the window via
 * SurfaceFlinger; on Android 16 WebView that path fails to clear semi-opaque
 * DOM between frames ("UI burn-in" — stats text stacking, pins going opaque,
 * mouse-cursor trails). TextureView composites in the normal View hierarchy, so
 * the WebView clears and blends correctly while still showing video through
 * transparent pixels. Window/decor/content/wry/WebView backgrounds are cleared;
 * Control.tsx keeps opaque letterbox bars around the video box so chrome never
 * sits on an unbacked transparent region.
 */
public final class WcDecoderBridge {
  private static final String TAG = "GtWcDecoder";
  private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;

  // Vendor low-latency keys (Moonlight-known). Applied best-effort at configure;
  // unknown keys are dropped silently on most drivers, but a few reject them and
  // throw inside configure(), which is what the progressive retry undoes.
  private static final String[] VENDOR_LL_KEYS = {
      "vendor.qti-ext-dec-low-latency.enable", // Qualcomm
      "vendor.qti-ext-dec-picture-order.enable", // Qualcomm (POC hint)
      "vendor.low-latency.enable", // Amlogic
      "vendor.rtc-ext-dec-low-latency.enable", // Exynos
      "vendor.hisi-ext-low-latency-video-dec.video-scene-for-low-latency-req", // HiSilicon
  };

  private static WeakReference<Activity> actRef;
  /** Video sink under the WebView. Named historically; type is TextureView. */
  private static TextureView surfaceView;
  private static SurfaceTexture surfaceTexture;
  private static Surface surface;
  /** Serialises init runnables so concurrent decoder_init calls can't triple-start. */
  private static final AtomicInteger initGen = new AtomicInteger(0);
  /** Prevents overlapping startCodec from surface-available + init races. */
  private static final AtomicBoolean starting = new AtomicBoolean(false);
  private static MediaCodec codec;
  private static HandlerThread codecThread;
  private static Handler codecHandler;
  private static final ConcurrentLinkedQueue<Integer> freeInputs = new ConcurrentLinkedQueue<>();
  private static final ConcurrentHashMap<Long, Long> pendingMeta = new ConcurrentHashMap<>();
  private static final ConcurrentLinkedQueue<PendingFrame> backlog = new ConcurrentLinkedQueue<>();
  private static final AtomicBoolean started = new AtomicBoolean(false);
  private static final AtomicBoolean surfaceReady = new AtomicBoolean(false);
  /**
   * The decoder is meant to be running: set by {@link #init}, cleared by
   * {@link #teardown}. This — and nothing else — decides whether the SurfaceView
   * is VISIBLE, because the Surface's whole lifecycle hangs off that visibility
   * and must never be at the mercy of a racing JS call. See
   * {@link #applyVisibility}.
   */
  private static final AtomicBoolean wanted = new AtomicBoolean(false);
  /**
   * Self-healing safety net for "surfaceCreated never fires": set while we are
   * waiting for the SurfaceFlinger to hand us a Surface after a VISIBLE flip,
   * cleared the instant {@link SurfaceHolder.Callback#surfaceCreated} lands (or
   * on teardown). See {@link #armSurfaceWatchdog} / {@link #cancelSurfaceWatchdog}.
   */
  private static final AtomicBoolean surfaceWatchdogArmed = new AtomicBoolean(false);
  private static final AtomicBoolean awaitKey = new AtomicBoolean(true);
  private static final AtomicBoolean csdQueued = new AtomicBoolean(false);
  private static final AtomicInteger width = new AtomicInteger(0);
  private static final AtomicInteger height = new AtomicInteger(0);
  private static final AtomicInteger queueDepth = new AtomicInteger(0);
  private static final AtomicLong frames = new AtomicLong(0);
  private static final AtomicReference<String> lastError = new AtomicReference<>("");
  private static final AtomicReference<String> codecName = new AtomicReference<>("");
  private static final AtomicReference<String> lastProbeDetail = new AtomicReference<>("");
  private static final AtomicBoolean lowLatency = new AtomicBoolean(false);
  private static volatile double decodeMsEwma = 0.0;
  private static volatile boolean webViewHooked = false;

  /**
   * Watchdog that kicks a VISIBLE SurfaceView when SurfaceFlinger never hands us
   * a Surface. The MainActivity's window is already showing by {@link #init}, so
   * a brand-new VISIBLE SurfaceView should receive surfaceCreated within a frame
   * or two. When it does not (a finicky OEM/Android-16 build can wedge the
   * surface negotiation for a view that was created GONE at {@code onCreate} and
   * flipped VISIBLE later — the GtWcDecoder log shows nothing, and the JS
   * watchdog reports "accepted N frame(s) but decoded 0 ... surfaceReady=false"),
   * we detach the view and re-add it, which forces a fresh surface session.
   * Bounded: {@link #SURFACE_KICK_MAX} attempts × {@link #SURFACE_KICK_DELAY_MS}
   * = 2s, comfortably inside the 3s JS fallback deadline (cloud.ts), and
   * disarmed the moment a Surface arrives or the decoder is torn down. Uses the
   * {@link HandlerThread} that {@link #startCodecLocked} lazily creates — but
   * resolves a surface without ever needing the codec, so it creates its own
   * thread if the codec one isn't up yet.
   */
  private static final long SURFACE_KICK_DELAY_MS = 500L;
  private static final int SURFACE_KICK_MAX = 4;
  private static final AtomicInteger surfaceKicks = new AtomicInteger(0);
  private static HandlerThread watchdogThread;
  private static Handler watchdogHandler;

  /**
   * Timestamped ring buffer of every lifecycle event the bridge sees (attach,
   * init, visibility flips, surfaceCreated/Changed/Destroyed, kicks, codec
   * configure attempts and results, errors). This is the flight recorder for a
   * device we do not own: the black-screen family of bugs here has repeatedly
   * produced *no* codec error and *no* logcat we could reach, and each round
   * trip through a user toast has to carry everything we might want to ask.
   * Dumped (with device/decoder/view-hierarchy state) by {@link #dumpDiagnostics}.
   */
  private static final ConcurrentLinkedQueue<String> journal = new ConcurrentLinkedQueue<>();
  private static final int JOURNAL_MAX = 160;
  private static final long bootAt = SystemClock.elapsedRealtime();

  private static void jlog(String msg) {
    long t = SystemClock.elapsedRealtime() - bootAt;
    journal.offer("+" + (t / 1000) + "." + String.format("%03d", t % 1000) + "s " + msg);
    while (journal.size() > JOURNAL_MAX) journal.poll();
    Log.i(TAG, msg);
  }

  private static final class PendingFrame {
    final long tsUs;
    final boolean key;
    final byte[] data;
    final long arrivedAt;

    PendingFrame(long tsUs, boolean key, byte[] data, long arrivedAt) {
      this.tsUs = tsUs;
      this.key = key;
      this.data = data;
      this.arrivedAt = arrivedAt;
    }
  }

  /**
   * The ONE place TextureView visibility is decided: VISIBLE exactly while the
   * decoder is {@link #wanted}. Must be called on the UI thread.
   *
   * Visibility is not cosmetic here — a GONE TextureView never receives
   * {@code onSurfaceTextureAvailable}, so it never owns a Surface, so MediaCodec
   * is never configured. It therefore belongs to the decoder's lifecycle
   * (init/teardown) and to nothing else. In particular {@link #setBounds} must
   * not touch it: every bridge command is a separate `spawn_blocking` task on
   * the Rust side (decoder.rs), so an older setBounds(visible=false) can — and
   * on some devices routinely does — land on the UI thread AFTER init()'s
   * VISIBLE. That hid the view again with no error and no way back.
   */
  private static void applyVisibility(TextureView sv) {
    if (sv == null) return;
    int want = wanted.get() ? View.VISIBLE : View.GONE;
    if (sv.getVisibility() != want) sv.setVisibility(want);
  }

  /** Lazily create the watchdog {@link HandlerThread} (independent of the codec
   *  thread, which does not exist until a Surface is realised). */
  private static synchronized Handler watchdogLooper() {
    if (watchdogHandler != null) return watchdogHandler;
    watchdogThread =
        new HandlerThread("gt-wc-surface-watchdog", android.os.Process.THREAD_PRIORITY_BACKGROUND);
    watchdogThread.start();
    watchdogHandler = new Handler(watchdogThread.getLooper());
    return watchdogHandler;
  }

  /**
   * Arm the surface-creation watchdog. Call on the UI thread right after the
   * view is flipped VISIBLE expecting a SurfaceTexture. If
   * {@code onSurfaceTextureAvailable} hasn't fired within
   * {@link #SURFACE_KICK_DELAY_MS}, {@link #surfaceKick} re-attaches the view.
   */
  private static void armSurfaceWatchdog() {
    if (!wanted.get()) return;
    if (surfaceReady.get() || surfaceView == null) return;
    if (!surfaceWatchdogArmed.compareAndSet(false, true)) return;
    watchdogLooper()
        .postDelayed(
            () -> {
              if (surfaceView == null || !surfaceWatchdogArmed.get()) return;
              Activity act = activity();
              if (act == null) {
                surfaceWatchdogArmed.set(false);
                return;
              }
              // A Surface arrived between the schedule and the fire — nothing to do.
              if (surfaceReady.get()) {
                surfaceWatchdogArmed.set(false);
                return;
              }
              act.runOnUiThread(WcDecoderBridge::surfaceKick);
            },
            SURFACE_KICK_DELAY_MS);
  }

  /**
   * Disarm the watchdog. Safe to call from any thread; called from
   * {@code onSurfaceTextureAvailable} (UI thread) and {@link #teardown}.
   */
  private static void cancelSurfaceWatchdog() {
    surfaceWatchdogArmed.set(false);
    if (watchdogHandler != null) watchdogHandler.removeCallbacksAndMessages(null);
  }

  /**
   * Detach the TextureView from its parent and re-add it at the same position
   * with the same layout params. Re-parenting recovers a TextureView whose
   * {@code onSurfaceTextureAvailable} never fires. Must run on the UI thread.
   */
  private static void surfaceKick() {
    if (surfaceView == null) return;
    // We may have raced a successful surface — nothing to recover from.
    if (surfaceReady.get()) {
      cancelSurfaceWatchdog();
      return;
    }
    if (!wanted.get()) {
      cancelSurfaceWatchdog();
      return;
    }
    int kick = surfaceKicks.incrementAndGet();
    if (kick > SURFACE_KICK_MAX) {
      surfaceWatchdogArmed.set(false);
      lastProbeDetail.set(
          "onSurfaceTextureAvailable never fired after " + SURFACE_KICK_MAX + " re-attach kicks");
      Log.w(
          TAG,
          "SurfaceTexture never arrived — giving up after "
              + SURFACE_KICK_MAX
              + " kicks. The JS watchdog will fall back to WebCodecs.");
      return;
    }
    android.view.ViewGroup parent = (android.view.ViewGroup) surfaceView.getParent();
    if (parent == null) {
      ensureSurfaceViewReseat();
    } else {
      int index = parent.indexOfChild(surfaceView);
      android.view.ViewGroup.LayoutParams lp = surfaceView.getLayoutParams();
      jlog("SurfaceTexture never arrived — re-attaching TextureView (kick " + kick + ")");
      parent.removeView(surfaceView);
      surfaceReady.set(false);
      releaseSurfaceOnly();
      try {
        parent.addView(surfaceView, Math.max(0, index), lp);
      } catch (Exception e) {
        Log.w(TAG, "re-add failed, reseating under content", e);
        ensureSurfaceViewReseat();
      }
    }
    applyVisibility(surfaceView);
    surfaceWatchdogArmed.set(false);
    armSurfaceWatchdog();
  }

  /** Drop the MediaCodec Surface wrapper without touching the TextureView. */
  private static void releaseSurfaceOnly() {
    Surface s = surface;
    surface = null;
    surfaceTexture = null;
    if (s != null) {
      try {
        s.release();
      } catch (Exception ignored) {
      }
    }
  }

  /** Re-seat the existing TextureView under the content view (fallback). */
  private static void ensureSurfaceViewReseat() {
    Activity act = activity();
    if (act == null || surfaceView == null) return;
    ViewGroup content = act.findViewById(android.R.id.content);
    if (content == null) return;
    surfaceReady.set(false);
    releaseSurfaceOnly();
    android.view.ViewGroup.LayoutParams prev = surfaceView.getLayoutParams();
    FrameLayout.LayoutParams lp =
        prev instanceof FrameLayout.LayoutParams
            ? (FrameLayout.LayoutParams) prev
            : new FrameLayout.LayoutParams(1, 1);
    lp.gravity = Gravity.TOP | Gravity.START;
    jlog("reseat: fallback under content[0]");
    content.addView(surfaceView, 0, lp);
  }

  /**
   * Move the TextureView to be the WebView's immediate lower sibling. Only the
   * views drawn AFTER it can cover the video, so the fewer of those the better —
   * ideally exactly one: the WebView itself. No-op when already seated there,
   * when the WebView hasn't been created yet, or when the view currently owns a
   * live Surface (re-parenting destroys it). Must run on the UI thread.
   */
  private static void reseatBelowWebView(Activity act) {
    TextureView sv = surfaceView;
    if (sv == null) return;
    ViewGroup content = act.findViewById(android.R.id.content);
    WebView web = content == null ? null : findWebView(content);
    if (web == null || !(web.getParent() instanceof ViewGroup)) return;
    ViewGroup wparent = (ViewGroup) web.getParent();
    int webIdx = wparent.indexOfChild(web);
    // Already the immediate lower sibling — nothing to do.
    if (sv.getParent() == wparent && wparent.indexOfChild(sv) == webIdx - 1) return;
    android.view.ViewGroup.LayoutParams prev = sv.getLayoutParams();
    ViewGroup oldParent = sv.getParent() instanceof ViewGroup ? (ViewGroup) sv.getParent() : null;
    if (oldParent != null) oldParent.removeView(sv);
    surfaceReady.set(false);
    releaseSurfaceOnly();
    FrameLayout.LayoutParams lp =
        prev instanceof FrameLayout.LayoutParams
            ? (FrameLayout.LayoutParams) prev
            : new FrameLayout.LayoutParams(1, 1);
    lp.gravity = Gravity.TOP | Gravity.START;
    try {
      wparent.addView(sv, Math.max(0, wparent.indexOfChild(web)), lp);
      jlog("reseat: below WebView in " + wparent.getClass().getSimpleName());
    } catch (Exception e) {
      jlog("reseat below WebView failed: " + e);
      ensureSurfaceViewReseat();
    }
  }

  /** Bound from MainActivity.onCreate — owns the TextureView under the WebView. */
  public static void attach(Activity activity) {
    actRef = new WeakReference<>(activity);
    activity.runOnUiThread(() -> ensureSurfaceView(activity));
  }

  /**
   * Install the {@code window.__GT_DECODER__} JavascriptInterface.
   *
   * MUST run BEFORE the page loads. Android only exposes an injected object to
   * JavaScript on the NEXT page load — "injected objects will not appear in
   * JavaScript until the page is next (re)loaded" per the
   * {@link WebView#addJavascriptInterface} contract. This used to be called
   * from {@link #init} (i.e. when a DIRECT session starts, long after the app
   * page loaded), so {@code window.__GT_DECODER__} stayed undefined forever:
   * the JS feed path bailed on every frame, MediaCodec was fed nothing, and the
   * phone sat on a blank screen re-requesting keyframes in a loop while the
   * HUD showed "Frames 0 / Keyframes N".
   *
   * MainActivity calls this from WryActivity's {@code onWebViewCreate} hook,
   * which Tauri fires when the WebView is constructed — before it loads the app
   * URL. Idempotent.
   */
  public static void installJsInterface(WebView web) {
    if (web == null || webViewHooked) return;
    try {
      web.addJavascriptInterface(new JsApi(), "__GT_DECODER__");
      webViewHooked = true;
      Log.i(TAG, "JavascriptInterface __GT_DECODER__ installed (pre-load)");
    } catch (Exception e) {
      Log.w(TAG, "addJavascriptInterface failed", e);
    }
  }

  /** True once {@link JsApi} is bound — JS-visible only after the next page load. */
  public static boolean jsInterfaceReady() {
    return webViewHooked;
  }

  /**
   * One-line description of a Throwable for the probe-detail channel: class,
   * message, the top few stack frames, and the root cause. This is what ends up
   * in the phone's error toast (with a copy-to-clipboard button), so it must be
   * informative enough to debug a device we don't own.
   */
  private static String describeThrowable(Throwable t) {
    StringBuilder sb = new StringBuilder();
    sb.append(t.getClass().getName());
    String m = t.getMessage();
    if (m != null && !m.isEmpty()) sb.append(": ").append(m);
    StackTraceElement[] st = t.getStackTrace();
    for (int i = 0; i < Math.min(3, st.length); i++) sb.append(" @ ").append(st[i]);
    Throwable c = t.getCause();
    if (c != null && c != t) {
      sb.append(" | cause ").append(c.getClass().getName());
      if (c.getMessage() != null) sb.append(": ").append(c.getMessage());
    }
    return sb.toString();
  }

  /**
   * Probe only — NEVER throws (catch Throwable, not Exception: some OEM builds
   * raise Errors like NoClassDefFoundError / ExceptionInInitializerError out of
   * MediaCodecList, and an Error escaping here crossed JNI as an opaque
   * "Java exception was thrown" that told us nothing). A failed probe returns
   * false with the reason preserved in {@link #probeDetail}.
   */
  public static boolean probeAvailable() {
    try {
      String name = pickDecoderName();
      boolean ok = name != null;
      if (ok) {
        lastProbeDetail.set("picked=" + name);
      } else {
        // pickDecoderName may have recorded a specific failure — keep it.
        String d = lastProbeDetail.get();
        if (d == null || !d.startsWith("pickDecoder")) lastProbeDetail.set("no decoder found");
      }
      return ok;
    } catch (Throwable t) {
      lastProbeDetail.set("probeAvailable threw: " + describeThrowable(t));
      return false;
    }
  }

  public static boolean probeLowLatency() {
    String name;
    try {
      name = pickDecoderName();
    } catch (Throwable t) {
      return false;
    }
    if (name == null) return false;
    // IMPORTANT: probe must NOT instantiate a real MediaCodec. The previous
    // implementation called supportsKnownVendorParameter(name), which does
    // MediaCodec.createByCodecName + getSupportedVendorParameters — on some
    // Qualcomm/MTK drivers that leaves the codec in a state that breaks the
    // LATER real init(), producing "MediaCodec unavailable" fallbacks on
    // devices that have a perfectly good hardware decoder. The name-based
    // heuristic (low_latency / low-latency in the decoder name) and the
    // FEATURE_LowLatency capability check are both pure introspection and
    // sufficient for the boolean probe.
    try {
      MediaCodecInfo info = findInfo(name);
      if (info == null) {
        // No capability introspection possible — fall back to the name heuristic.
        String lower = name.toLowerCase();
        return lower.contains("low_latency") || lower.contains("low-latency");
      }
      MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(MIME);
      if (Build.VERSION.SDK_INT >= 30) {
        return caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
            || name.toLowerCase().contains("low_latency")
            || name.toLowerCase().contains("low-latency");
      }
      return name.toLowerCase().contains("low_latency")
          || name.toLowerCase().contains("low-latency");
    } catch (Throwable t) {
      return false;
    }
  }

  public static String probeName() {
    try {
      String n = pickDecoderName();
      return n == null ? "" : n;
    } catch (Throwable t) {
      return "";
    }
  }

  /** Diagnostic — surfaces the reason the probe returned its answer. */
  public static String probeDetail() {
    String d = lastProbeDetail.get();
    return d == null ? "" : d;
  }

  public static void init(int w, int h) {
    if (w < 16 || h < 16) throw new IllegalArgumentException("bad size " + w + "x" + h);
    // Coalesce duplicate inits (JS often fires twice in the same frame). A second
    // init used to flip awaitKey/csdQueued back to "need keyframe" WHILE the codec
    // was already running — every in-flight AU was then dropped or mis-fed, and
    // the TextureView stayed black with no error anywhere.
    if (wanted.get() && started.get() && width.get() == w && height.get() == h) {
      jlog("init " + w + "x" + h + " — already running, skip");
      return;
    }
    final int gen = initGen.incrementAndGet();
    width.set(w);
    height.set(h);
    lastError.set("");
    awaitKey.set(true);
    csdQueued.set(false);
    Activity act = activity();
    if (act == null) throw new IllegalStateException("no activity");
    // Latch BEFORE hopping to the UI thread: a setBounds already in flight on
    // another Rust worker must observe "decoder wanted" and leave the view
    // alone, whichever of the two runnables the looper happens to run first.
    wanted.set(true);
    // Keep the producer buffer aspect locked to the bitstream, not the view
    // layout size — TextureView then scales without stretching.
    applyBufferSize(w, h);
    jlog("init " + w + "x" + h + " surfaceReady=" + surfaceReady.get());
    act.runOnUiThread(
        () -> {
          // A newer init superseded us while we waited for the looper.
          if (gen != initGen.get()) {
            jlog("init " + w + "x" + h + " — superseded by newer init, skip");
            return;
          }
          // UI-thread re-check: concurrent inits can both pass the outer guard
          // before either sets started — without this we triple-start the codec.
          if (started.get() && width.get() == w && height.get() == h && surfaceReady.get()) {
            jlog("init " + w + "x" + h + " — already running on UI thread, skip");
            return;
          }
          ensureSurfaceView(act);
          // attach() ran before Tauri created the WebView, so the TextureView
          // was seated at content[0] — potentially below wry wrapper views.
          // Seat it as the WebView's immediate lower sibling.
          if (!surfaceReady.get()) reseatBelowWebView(act);
          hookWebView(act);
          makeCompositingTransparent(act);
          applyVisibility(surfaceView);
          if (surfaceReady.get()) {
            // Size change while a codec is live → rebuild against the new Surface.
            if (started.get()) {
              stopCodecLocked();
            }
            startCodecLocked();
          } else {
            surfaceKicks.set(0);
            armSurfaceWatchdog();
          }
        });
  }

  /** Push codec WxH into the SurfaceTexture so the view can scale without stretch. */
  private static void applyBufferSize(int w, int h) {
    SurfaceTexture st = surfaceTexture;
    if (st == null || w < 16 || h < 16) return;
    try {
      st.setDefaultBufferSize(w, h);
    } catch (Exception e) {
      jlog("setDefaultBufferSize failed: " + e.getMessage());
    }
  }

  /**
   * Geometry only. {@code visible} is accepted for call compatibility but
   * deliberately IGNORED — visibility follows {@link #wanted} (see
   * {@link #applyVisibility}). JS drives this from a React layout effect whose
   * view of "is the native path live" lags the decoder's own by a frame or two,
   * and the calls are unordered besides, so honouring the flag let a stale
   * {@code visible=false} tear the Surface out from under a running codec (blank
   * screen, no error) and a stale {@code visible=true} park a dead Surface on
   * top of the WebCodecs canvas (frozen picture).
   */
  public static void setBounds(double x, double y, double w, double h, boolean visible) {
    Activity act = activity();
    if (act == null) return;
    // An empty box is JS saying "I have no geometry for you" (it pairs the zeroes
    // with visible=false), not "shrink to a pixel". Keep whatever geometry we
    // have: collapsing a live decoder's Surface to 1×1 on a stale call is the
    // same class of bug as hiding it, just less obvious on screen.
    if (w < 1 || h < 1) return;
    act.runOnUiThread(
        () -> {
          TextureView sv = surfaceView;
          if (sv == null) return;
          float dpr = act.getResources().getDisplayMetrics().density;
          // JS sends CSS pixels from getBoundingClientRect; layout params are px.
          int ix = Math.round((float) (x * dpr));
          int iy = Math.round((float) (y * dpr));
          int iw = Math.max(1, Math.round((float) (w * dpr)));
          int ih = Math.max(1, Math.round((float) (h * dpr)));
          // getBoundingClientRect is relative to the WebView viewport; LayoutParams
          // are relative to the TextureView's parent. Add the WebView's offset
          // inside that parent or the picture (and hit-test) drifts — usually on Y
          // when a wrapper/inset sits above the WebView.
          ViewGroup parent = sv.getParent() instanceof ViewGroup ? (ViewGroup) sv.getParent() : null;
          WebView web = parent != null ? findWebView(parent) : null;
          if (web == null) {
            ViewGroup content = act.findViewById(android.R.id.content);
            web = content != null ? findWebView(content) : null;
          }
          if (web != null && parent != null) {
            int[] webLoc = new int[2];
            int[] parentLoc = new int[2];
            web.getLocationInWindow(webLoc);
            parent.getLocationInWindow(parentLoc);
            ix += webLoc[0] - parentLoc[0];
            iy += webLoc[1] - parentLoc[1];
          }
          FrameLayout.LayoutParams lp =
              (FrameLayout.LayoutParams) sv.getLayoutParams();
          if (lp == null) {
            lp = new FrameLayout.LayoutParams(iw, ih);
          }
          lp.width = iw;
          lp.height = ih;
          lp.leftMargin = ix;
          lp.topMargin = iy;
          lp.gravity = Gravity.TOP | Gravity.START;
          sv.setLayoutParams(lp);
          // NOT sv.setVisibility(visible ? ...) — see the javadoc above.
          applyVisibility(sv);
        });
  }

  public static void reset() {
    awaitKey.set(true);
    csdQueued.set(false);
    pendingMeta.clear();
    backlog.clear();
    queueDepth.set(0);
    freeInputs.clear();
    // Full stop+restart beats flush alone after a session gap (MediaCodec docs:
    // flush does not handle discontinuities; first input after restart must be
    // a keyframe — we gate that with awaitKey).
    stopCodecLocked();
    Activity act = activity();
    if (act != null && width.get() > 0 && height.get() > 0 && surfaceReady.get()) {
      act.runOnUiThread(WcDecoderBridge::startCodecLocked);
    }
  }

  /** Held while a remote session is live — see {@link #setStreamActive}. */
  private static android.net.wifi.WifiManager.WifiLock wifiLock;

  /**
   * Hold/release the Wi-Fi low-latency lock (and keep the screen on) while a
   * remote-control session is live. Android Wi-Fi power save parks the radio
   * between DTIM beacons whenever traffic looks idle; inbound video then
   * arrives in bursts — the exact periodic 100–700 ms frame gaps (healthy RTT
   * in between) the hitch log records on budget phones (moto g57 / SM6435).
   * WIFI_MODE_FULL_LOW_LATENCY (API 29+) disables power save while the app is
   * foreground+screen-on; WIFI_MODE_FULL_HIGH_PERF is the pre-29 fallback.
   * Same lever Moonlight pulls for game streaming.
   *
   * Called over JNI from decoder.rs ({@code stream_active}), driven by
   * cloud.ts on session connect/disconnect — for BOTH the native MediaCodec
   * and WebCodecs paths (the radio doesn't care who decodes). Idempotent;
   * never throws (a failed lock must not take the session down with it).
   */
  public static void setStreamActive(boolean active) {
    Activity act = activity();
    try {
      if (active) {
        if (wifiLock == null && act != null) {
          android.net.wifi.WifiManager wm =
              (android.net.wifi.WifiManager)
                  act.getApplicationContext()
                      .getSystemService(android.content.Context.WIFI_SERVICE);
          if (wm != null) {
            int mode =
                Build.VERSION.SDK_INT >= 29
                    ? android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "GameTracker:remote");
            wifiLock.setReferenceCounted(false);
          }
        }
        if (wifiLock != null && !wifiLock.isHeld()) {
          wifiLock.acquire();
          jlog("wifi low-latency lock acquired");
        }
      } else if (wifiLock != null && wifiLock.isHeld()) {
        wifiLock.release();
        jlog("wifi lock released");
      }
    } catch (Throwable t) {
      jlog("wifi lock " + (active ? "acquire" : "release") + " failed: " + t);
    }
    if (act != null) {
      act.runOnUiThread(
          () -> {
            try {
              if (active) {
                act.getWindow()
                    .addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
              } else {
                act.getWindow()
                    .clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
              }
            } catch (Throwable ignored) {
            }
          });
    }
  }

  public static void teardown() {
    // Clear the latch first, for the same reason init() sets it first: any
    // setBounds racing us must not re-show a view whose codec we just stopped.
    wanted.set(false);
    jlog("teardown");
    // Stop trying to conjure a Surface for a decoder the JS side has torn down.
    cancelSurfaceWatchdog();
    Activity act = activity();
    Runnable stop =
        () -> {
          stopCodecLocked();
          applyVisibility(surfaceView);
        };
    if (act != null) act.runOnUiThread(stop);
    else stop.run();
  }

  public static double statsDecodeMs() {
    return decodeMsEwma;
  }

  public static int statsQueue() {
    return queueDepth.get() + backlog.size();
  }

  public static long statsFrames() {
    return frames.get();
  }

  public static boolean statsActive() {
    return started.get();
  }

  /**
   * Whether the SurfaceView has handed us a live Surface. Reported alongside the
   * stats because "no picture" has exactly two shapes and they need opposite
   * fixes: the codec faulted (statsError says how), or the codec never started
   * for want of a Surface — which says nothing at all unless we surface this.
   */
  public static boolean statsSurfaceReady() {
    return surfaceReady.get() && surface != null;
  }

  /** True while the bridge is still waiting for an IDR (or CSD) before accepting deltas. */
  public static boolean statsAwaitKey() {
    return awaitKey.get();
  }

  /** True once SPS/PPS were accepted as BUFFER_FLAG_CODEC_CONFIG for this codec session. */
  public static boolean statsCsdQueued() {
    return csdQueued.get();
  }

  public static int statsWidth() {
    return width.get();
  }

  public static int statsHeight() {
    return height.get();
  }

  public static String statsError() {
    String e = lastError.get();
    return e == null ? "" : e;
  }

  /**
   * Everything we would ask for over a user's shoulder, in one copy-pastable
   * blob: device identity, decoder inventory with low-latency capabilities,
   * live codec/surface/view state, the full view hierarchy above the punch
   * (class, visibility, alpha, background, layer type — the black-screen bugs
   * live HERE, in whichever layer forgot to be transparent), and the lifecycle
   * journal. Called over JNI (decoder_dump_diag) and attached to the decoder
   * error toast's copy-to-clipboard payload.
   */
  public static String dumpDiagnostics() {
    StringBuilder sb = new StringBuilder(8192);
    try {
      sb.append("=== device ===\n");
      sb.append("model=").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
          .append(" device=").append(Build.DEVICE).append(" board=").append(Build.BOARD).append('\n');
      sb.append("android=").append(Build.VERSION.RELEASE).append(" sdk=").append(Build.VERSION.SDK_INT)
          .append(" build=").append(Build.DISPLAY).append('\n');
      sb.append("soc=");
      if (Build.VERSION.SDK_INT >= 31) {
        sb.append(Build.SOC_MANUFACTURER).append(' ').append(Build.SOC_MODEL);
      } else {
        sb.append(Build.HARDWARE);
      }
      sb.append(" abi=").append(Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?").append('\n');

      Activity act = activity();
      if (act != null) {
        android.util.DisplayMetrics dm = act.getResources().getDisplayMetrics();
        sb.append("screen=").append(dm.widthPixels).append('x').append(dm.heightPixels)
            .append(" dpr=").append(dm.density).append('\n');
      }

      sb.append("\n=== decoder state ===\n");
      sb.append("wanted=").append(wanted.get())
          .append(" started=").append(started.get())
          .append(" surfaceReady=").append(surfaceReady.get())
          .append(" surfaceValid=").append(surface != null && surface.isValid())
          .append('\n');
      sb.append("codec=").append(codecName.get())
          .append(" ll=").append(lowLatency.get())
          .append(" size=").append(width.get()).append('x').append(height.get())
          .append(" frames=").append(frames.get())
          .append(" queue=").append(queueDepth.get()).append('+').append(backlog.size())
          .append(" decodeMsEwma=").append(String.format("%.1f", decodeMsEwma))
          .append('\n');
      sb.append("awaitKey=").append(awaitKey.get())
          .append(" csdQueued=").append(csdQueued.get())
          .append(" kicks=").append(surfaceKicks.get())
          .append(" jsHooked=").append(webViewHooked)
          .append('\n');
      sb.append("lastError=").append(statsError()).append('\n');
      sb.append("probeDetail=").append(probeDetail()).append('\n');

      sb.append("\n=== h264 decoders ===\n");
      appendDecoderInventory(sb);

      sb.append("\n=== view stack (bottom→top; punch survives only if everything ABOVE the SurfaceView is transparent) ===\n");
      appendViewState(sb);

      sb.append("\n=== journal ===\n");
      for (String line : journal) sb.append(line).append('\n');
    } catch (Throwable t) {
      sb.append("\n[dumpDiagnostics itself threw: ").append(describeThrowable(t)).append(']');
    }
    return sb.toString();
  }

  /** Every H.264 decoder with the capability bits that decide our pick. */
  private static void appendDecoderInventory(StringBuilder sb) {
    MediaCodecInfo[] infos;
    try {
      infos = new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos();
    } catch (Throwable t) {
      sb.append("MediaCodecList threw: ").append(describeThrowable(t)).append('\n');
      return;
    }
    for (MediaCodecInfo info : infos) {
      try {
        if (info.isEncoder()) continue;
        boolean supports = false;
        for (String t : info.getSupportedTypes()) {
          if (MIME.equalsIgnoreCase(t)) {
            supports = true;
            break;
          }
        }
        if (!supports) continue;
        sb.append(info.getName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          sb.append(info.isHardwareAccelerated() ? " hw" : " sw");
          if (info.isAlias()) sb.append(" alias");
        }
        try {
          MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(MIME);
          if (Build.VERSION.SDK_INT >= 30
              && caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)) {
            sb.append(" FEATURE_LowLatency");
          }
          MediaCodecInfo.VideoCapabilities vc = caps.getVideoCapabilities();
          if (vc != null) {
            sb.append(" max=").append(vc.getSupportedWidths().getUpper())
                .append('x').append(vc.getSupportedHeights().getUpper());
          }
        } catch (Throwable ignored) {
        }
        sb.append('\n');
      } catch (Throwable perCodec) {
        // One rogue plugin must not sink the dump.
      }
    }
  }

  /** SurfaceView placement + every view drawn after it (those can cover the punch). */
  private static void appendViewState(StringBuilder sb) {
    Activity act = activity();
    if (act == null) {
      sb.append("no activity\n");
      return;
    }
    try {
      android.graphics.drawable.Drawable winBg = act.getWindow().getDecorView().getBackground();
      sb.append("window bg=").append(describeDrawable(winBg)).append('\n');
    } catch (Throwable ignored) {
    }
    ViewGroup content = act.findViewById(android.R.id.content);
    if (content == null) {
      sb.append("no content view\n");
      return;
    }
    SurfaceView sv = surfaceView;
    if (sv != null) {
      sb.append("SurfaceView attached=").append(sv.isAttachedToWindow())
          .append(" shown=").append(sv.isShown())
          .append(" vis=").append(visName(sv.getVisibility()))
          .append(" size=").append(sv.getWidth()).append('x').append(sv.getHeight())
          .append(" winVis=").append(visName(sv.getWindowVisibility()))
          .append(" mediaOverlay=true zTop=false")
          .append('\n');
    } else {
      sb.append("SurfaceView: null\n");
    }
    dumpViewTree(sb, content, 0);
  }

  private static String visName(int v) {
    return v == View.VISIBLE ? "VISIBLE" : v == View.INVISIBLE ? "INVISIBLE" : "GONE";
  }

  private static String describeDrawable(android.graphics.drawable.Drawable d) {
    if (d == null) return "null(transparent)";
    if (d instanceof android.graphics.drawable.ColorDrawable) {
      return String.format("#%08X", ((android.graphics.drawable.ColorDrawable) d).getColor());
    }
    return d.getClass().getSimpleName();
  }

  private static void dumpViewTree(StringBuilder sb, View v, int depth) {
    if (depth > 6) return;
    for (int i = 0; i < depth; i++) sb.append("  ");
    sb.append(v.getClass().getSimpleName())
        .append(' ').append(visName(v.getVisibility()))
        .append(' ').append(v.getWidth()).append('x').append(v.getHeight())
        .append(" alpha=").append(v.getAlpha())
        .append(" bg=").append(describeDrawable(v.getBackground()))
        .append(" layer=").append(v.getLayerType());
    if (v == surfaceView) sb.append("  <== OUR SURFACEVIEW");
    if (v instanceof WebView) sb.append("  <== WEBVIEW");
    sb.append('\n');
    if (v instanceof ViewGroup) {
      ViewGroup g = (ViewGroup) v;
      for (int i = 0; i < g.getChildCount(); i++) dumpViewTree(sb, g.getChildAt(i), depth + 1);
    }
  }

  /** JavascriptInterface — installed as {@code window.__GT_DECODER__}. */
  public static final class JsApi {
    @JavascriptInterface
    public void feed(double tsUs, boolean key, String b64) {
      if (b64 == null || b64.isEmpty()) return;
      byte[] data;
      try {
        data = Base64.decode(b64, Base64.DEFAULT);
      } catch (Exception e) {
        return;
      }
      submit(Math.round(tsUs), key, data);
    }

    @JavascriptInterface
    public void notifyFrame() {
      // Reserved: JS can ping us when Control paints (display fps). No-op for now.
    }
  }

  private static void submit(long tsUs, boolean key, byte[] data) {
    if (!started.get() && surfaceReady.get() && width.get() > 0) {
      Activity act = activity();
      if (act != null) {
        act.runOnUiThread(WcDecoderBridge::startCodecLocked);
      }
    }
    if (awaitKey.get() && !key) return;
    long arrived = SystemClock.elapsedRealtime();
    if (!started.get() || codec == null) {
      // Codec still coming up — keep a tiny backlog of keyframes only.
      if (key) {
        backlog.clear();
        backlog.offer(new PendingFrame(tsUs, true, data, arrived));
      }
      return;
    }
    // Extract SPS/PPS from the first keyframe and feed them as CSD before the
    // slice. Most Android HW decoders REQUIRE this (Moonlight/ALVR/Chiaki).
    // CRITICAL: after queuing CSD, strip SPS/PPS from the AU before queueInput —
    // feeding parameter sets twice (CSD + inline) makes c2.qti stall with
    // frames=0 / no error, which is exactly the black punched Surface.
    boolean needsCsd = key && !csdQueued.get();
    byte[] slice = data;
    if (needsCsd) {
      byte[] csd = extractCsd(data);
      if (csd == null) {
        jlog("submit: key without SPS/PPS — holding (await next IDR with param sets)");
        backlog.clear();
        backlog.offer(new PendingFrame(tsUs, true, data, arrived));
        return;
      }
      Integer csdIdx = freeInputs.poll();
      if (csdIdx == null) {
        backlog.clear();
        backlog.offer(new PendingFrame(tsUs, true, data, arrived));
        return;
      }
      if (!queueCsd(csdIdx, csd)) {
        // Start-code CSD rejected — try stripped (some OEM drivers want raw RBSP).
        byte[] stripped = extractCsdRaw(data);
        Integer retry = freeInputs.poll();
        if (stripped == null || retry == null || !queueCsd(retry, stripped)) {
          jlog("submit: CSD queue failed — holding keyframe");
          backlog.clear();
          backlog.offer(new PendingFrame(tsUs, true, data, arrived));
          return;
        }
      }
      slice = stripParameterSets(data);
      if (slice == null || slice.length < 4) {
        jlog("submit: strip left no VCL NAL — dropping");
        return;
      }
    } else if (key && csdQueued.get()) {
      // Later IDRs still carry SPS/PPS (NVENC repeatSPSPPS). Feeding them again
      // after CSD stalls c2.qti with frames=0 — always strip.
      byte[] stripped = stripParameterSets(data);
      if (stripped != null && stripped.length >= 4) slice = stripped;
    }
    Integer idx = freeInputs.poll();
    if (idx == null) {
      if (backlog.size() >= 2) backlog.poll();
      // Prefer the (possibly stripped) slice so drainBacklog doesn't re-inject
      // parameter sets after CSD was already queued on this attempt.
      backlog.offer(new PendingFrame(tsUs, key, slice, arrived));
      return;
    }
    queueInput(idx, tsUs, key, slice, arrived);
    drainBacklog();
  }

  private static void drainBacklog() {
    while (true) {
      PendingFrame pf = backlog.peek();
      if (pf == null) return;
      byte[] slice = pf.data;
      if (pf.key && !csdQueued.get()) {
        byte[] csd = extractCsd(pf.data);
        if (csd == null) {
          jlog("drainBacklog: keyframe without SPS/PPS — drop and wait");
          backlog.poll();
          continue;
        }
        Integer csdIdx = freeInputs.poll();
        if (csdIdx == null) return;
        if (!queueCsd(csdIdx, csd)) {
          byte[] stripped = extractCsdRaw(pf.data);
          Integer retry = freeInputs.poll();
          if (stripped == null || retry == null || !queueCsd(retry, stripped)) {
            jlog("drainBacklog: CSD queue failed");
            return;
          }
        }
        slice = stripParameterSets(pf.data);
        if (slice == null || slice.length < 4) {
          backlog.poll();
          continue;
        }
      } else if (pf.key && csdQueued.get()) {
        // CSD already live — still strip param sets from this IDR.
        byte[] stripped = stripParameterSets(pf.data);
        if (stripped != null && stripped.length >= 4) slice = stripped;
      }
      Integer idx = freeInputs.poll();
      if (idx == null) return;
      backlog.poll();
      queueInput(idx, pf.tsUs, pf.key, slice, pf.arrivedAt);
    }
  }

  /**
   * Pull SPS (7) + PPS (8) out of Annex-B and build CSD-0 WITH start codes
   * (Moonlight/Chiaki shape). Returns null if either NAL is missing.
   */
  private static byte[] extractCsd(byte[] annexB) {
    byte[][] hold = new byte[2][];
    if (!findSpsPps(annexB, hold)) {
      jlog("extractCsd: missing " + (hold[0] == null ? "SPS" : "") + (hold[1] == null ? "PPS" : ""));
      return null;
    }
    byte[] sps = hold[0];
    byte[] pps = hold[1];
    byte[] csd = new byte[4 + sps.length + 4 + pps.length];
    csd[0] = 0;
    csd[1] = 0;
    csd[2] = 0;
    csd[3] = 1;
    System.arraycopy(sps, 0, csd, 4, sps.length);
    int o = 4 + sps.length;
    csd[o] = 0;
    csd[o + 1] = 0;
    csd[o + 2] = 0;
    csd[o + 3] = 1;
    System.arraycopy(pps, 0, csd, o + 4, pps.length);
    return csd;
  }

  /** Same SPS/PPS but concatenated without start codes (fallback for picky OEMs). */
  private static byte[] extractCsdRaw(byte[] annexB) {
    byte[][] hold = new byte[2][];
    if (!findSpsPps(annexB, hold)) return null;
    byte[] sps = hold[0];
    byte[] pps = hold[1];
    byte[] csd = new byte[sps.length + pps.length];
    System.arraycopy(sps, 0, csd, 0, sps.length);
    System.arraycopy(pps, 0, csd, sps.length, pps.length);
    return csd;
  }

  /** Find first SPS + PPS NAL payloads (no start codes). */
  private static boolean findSpsPps(byte[] annexB, byte[][] outSpsPps) {
    try {
      byte[] sps = null;
      byte[] pps = null;
      int i = 0;
      int n = annexB.length;
      while (i + 3 <= n) {
        int scLen;
        if (i + 4 <= n
            && annexB[i] == 0 && annexB[i + 1] == 0 && annexB[i + 2] == 0 && annexB[i + 3] == 1) {
          scLen = 4;
        } else if (annexB[i] == 0 && annexB[i + 1] == 0 && annexB[i + 2] == 1) {
          scLen = 3;
        } else {
          i++;
          continue;
        }
        int nalStart = i + scLen;
        int j = nalStart;
        while (j + 3 <= n) {
          if ((annexB[j] == 0 && annexB[j + 1] == 0 && annexB[j + 2] == 1)
              || (j + 4 <= n
                  && annexB[j] == 0
                  && annexB[j + 1] == 0
                  && annexB[j + 2] == 0
                  && annexB[j + 3] == 1)) {
            break;
          }
          j++;
        }
        int nalEnd = (j + 3 <= n) ? j : n;
        if (nalEnd > nalStart) {
          int nalType = annexB[nalStart] & 0x1f;
          int len = nalEnd - nalStart;
          if (nalType == 7 && sps == null) {
            sps = new byte[len];
            System.arraycopy(annexB, nalStart, sps, 0, len);
          } else if (nalType == 8 && pps == null) {
            pps = new byte[len];
            System.arraycopy(annexB, nalStart, pps, 0, len);
          }
        }
        i = nalEnd;
        if (sps != null && pps != null) break;
      }
      outSpsPps[0] = sps;
      outSpsPps[1] = pps;
      return sps != null && pps != null;
    } catch (Exception e) {
      return false;
    }
  }

  /**
   * Drop SPS/PPS NALs from an Annex-B AU, keeping VCL (and SEI/AUD). Used after
   * CSD so the decoder never sees parameter sets twice.
   */
  private static byte[] stripParameterSets(byte[] annexB) {
    try {
      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(annexB.length);
      int i = 0;
      int n = annexB.length;
      boolean any = false;
      while (i + 3 <= n) {
        int scLen;
        int scStart = i;
        if (i + 4 <= n
            && annexB[i] == 0 && annexB[i + 1] == 0 && annexB[i + 2] == 0 && annexB[i + 3] == 1) {
          scLen = 4;
        } else if (annexB[i] == 0 && annexB[i + 1] == 0 && annexB[i + 2] == 1) {
          scLen = 3;
        } else {
          i++;
          continue;
        }
        int nalStart = i + scLen;
        int j = nalStart;
        while (j + 3 <= n) {
          if ((annexB[j] == 0 && annexB[j + 1] == 0 && annexB[j + 2] == 1)
              || (j + 4 <= n
                  && annexB[j] == 0
                  && annexB[j + 1] == 0
                  && annexB[j + 2] == 0
                  && annexB[j + 3] == 1)) {
            break;
          }
          j++;
        }
        int nalEnd = (j + 3 <= n) ? j : n;
        if (nalEnd > nalStart) {
          int nalType = annexB[nalStart] & 0x1f;
          // Keep everything except SPS(7) / PPS(8).
          if (nalType != 7 && nalType != 8) {
            out.write(annexB, scStart, nalEnd - scStart);
            any = true;
          }
        }
        i = nalEnd;
      }
      return any ? out.toByteArray() : null;
    } catch (Exception e) {
      return annexB;
    }
  }

  /** @return true if CSD was accepted by MediaCodec. */
  private static boolean queueCsd(int index, byte[] csd) {
    MediaCodec c = codec;
    if (c == null) {
      freeInputs.offer(index);
      return false;
    }
    try {
      ByteBuffer buf = c.getInputBuffer(index);
      if (buf == null) {
        freeInputs.offer(index);
        return false;
      }
      buf.clear();
      if (buf.remaining() < csd.length) {
        freeInputs.offer(index);
        jlog("queueCsd: buffer too small need=" + csd.length + " have=" + buf.remaining());
        return false;
      }
      buf.put(csd);
      c.queueInputBuffer(index, 0, csd.length, 0, MediaCodec.BUFFER_FLAG_CODEC_CONFIG);
      csdQueued.set(true);
      jlog("queueCsd ok bytes=" + csd.length);
      return true;
    } catch (Exception e) {
      freeInputs.offer(index);
      lastError.set("csd: " + e.getMessage());
      Log.w(TAG, "queueCsd failed", e);
      jlog("queueCsd failed: " + e.getMessage());
      return false;
    }
  }

  private static void queueInput(int index, long tsUs, boolean key, byte[] data, long arrivedAt) {
    MediaCodec c = codec;
    if (c == null) {
      freeInputs.offer(index);
      return;
    }
    try {
      ByteBuffer buf = c.getInputBuffer(index);
      if (buf == null) {
        freeInputs.offer(index);
        return;
      }
      buf.clear();
      if (buf.remaining() < data.length) {
        freeInputs.offer(index);
        lastError.set("input too small");
        return;
      }
      buf.put(data);
      pendingMeta.put(tsUs, arrivedAt);
      if (pendingMeta.size() > 120) {
        // Drop oldest — ConcurrentHashMap has no order; clear if bloated.
        pendingMeta.clear();
        pendingMeta.put(tsUs, arrivedAt);
      }
      int flags = key ? MediaCodec.BUFFER_FLAG_SYNC_FRAME : 0;
      c.queueInputBuffer(index, 0, data.length, tsUs, flags);
      if (key) awaitKey.set(false);
      queueDepth.incrementAndGet();
    } catch (Exception e) {
      freeInputs.offer(index);
      lastError.set(String.valueOf(e.getMessage()));
      awaitKey.set(true);
      Log.w(TAG, "queueInput failed", e);
    }
  }

  private static Activity activity() {
    WeakReference<Activity> ref = actRef;
    return ref == null ? null : ref.get();
  }

  private static void ensureSurfaceView(Activity act) {
    if (surfaceView != null) return;
    ViewGroup content = act.findViewById(android.R.id.content);
    if (content == null) return;
    WebView web = findWebView(content);
    ViewGroup parent;
    int index;
    if (web != null && web.getParent() instanceof ViewGroup) {
      parent = (ViewGroup) web.getParent();
      index = parent.indexOfChild(web);
    } else {
      parent = content;
      index = 0;
    }
    SurfaceView sv = new SurfaceView(act);
    // Hole-punch: the surface stays BEHIND the window (media-overlay only
    // orders it above other SurfaceViews, e.g. an exoplayer leftover — it is
    // NOT above the window). Video shows through because the whole compositing
    // chain above it is transparent in the video box; see the class javadoc.
    sv.setZOrderMediaOverlay(true);
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
    lp.gravity = Gravity.TOP | Gravity.START;
    sv.setVisibility(View.GONE);
    parent.addView(sv, Math.max(0, index), lp);
    sv.getHolder()
        .addCallback(
            new SurfaceHolder.Callback() {
              @Override
              public void surfaceCreated(SurfaceHolder holder) {
                surface = holder.getSurface();
                surfaceReady.set(true);
                jlog("surfaceCreated valid=" + holder.getSurface().isValid());
                // A Surface arrived — stop the re-attach watchdog (if it was
                // armed) and reset its kick count so a later teardown+init arms
                // a fresh one. Without this disarm the watchdog would happily
                // kick an already-working SurfaceView off the hierarchy.
                cancelSurfaceWatchdog();
                if (width.get() > 0 && height.get() > 0) startCodecLocked();
              }

              @Override
              public void surfaceChanged(SurfaceHolder holder, int format, int w, int h) {
                surface = holder.getSurface();
                surfaceReady.set(true);
                jlog("surfaceChanged " + w + "x" + h);
              }

              @Override
              public void surfaceDestroyed(SurfaceHolder holder) {
                surfaceReady.set(false);
                surface = null;
                jlog("surfaceDestroyed");
                stopCodecLocked();
              }
            });
    surfaceView = sv;
  }

  /**
   * Late fallback for the JS interface (normal path is {@link #installJsInterface}
   * from onWebViewCreate). Adding the object here only takes effect on the NEXT
   * page load, so this cannot rescue the current page — it exists so a webview
   * that Tauri rebuilt after onCreate still ends up bound. JS never assumes the
   * interface exists: `nativeFeedReady()` gates the native decode path.
   */
  private static void hookWebView(Activity act) {
    if (webViewHooked) return;
    ViewGroup content = act.findViewById(android.R.id.content);
    if (content == null) return; // no content view yet; onWebViewCreate covers the real path
    WebView web = findWebView(content);
    if (web == null) {
      // Tauri may attach the WebView a frame later.
      content.postDelayed(() -> hookWebView(act), 50);
      return;
    }
    installJsInterface(web);
  }

  /**
   * Make every layer that composites ABOVE the SurfaceView's punched hole
   * transparent: window background, DecorView, android.R.id.content, every
   * wry/Tauri wrapper between the WebView and the window, and the WebView
   * itself. One opaque layer anywhere in that chain paints straight over the
   * hole — the codec decodes happily (stats climb, no error, the JS watchdog
   * stays quiet because frames ARE being produced) while the user stares at
   * black. The PAGE is responsible for staying opaque outside the video box
   * (Control.tsx paints letterbox bars) so the transparent region — and with it
   * the Android-16 WebView redraw-accumulation "smudge" — is bounded to the
   * video rect.
   *
   * Deliberately does NOT force a hardware LAYER on the WebView.
   * setLayerType(LAYER_TYPE_HARDWARE) flattens the WebView into an offscreen
   * texture, and transparent-WebView-in-a-layer is a documented bug farm
   * (issuetracker 36925660 heritage): several Chromium builds composite the
   * layer as opaque. LAYER_TYPE_NONE is still hardware-accelerated rendering —
   * it is the layer, not the acceleration, that breaks alpha.
   *
   * Re-applied on a delay: some pages/OEM WebView builds repaint an opaque
   * background after load or after a renderer restart.
   */
  private static void makeCompositingTransparent(Activity act) {
    applyCompositingTransparency(act);
    ViewGroup content = act.findViewById(android.R.id.content);
    if (content != null) {
      content.postDelayed(() -> applyCompositingTransparency(act), 500);
      content.postDelayed(() -> applyCompositingTransparency(act), 2000);
    }
  }

  private static void applyCompositingTransparency(Activity act) {
    try {
      act.getWindow().setBackgroundDrawable(
          new android.graphics.drawable.ColorDrawable(0x00000000));
      // Some OEM themes paint the DecorView after setBackgroundDrawable — force
      // the root view transparent too so the SurfaceView hole punch survives.
      View decor = act.getWindow().getDecorView();
      if (decor != null) {
        decor.setBackgroundColor(0x00000000);
      }
    } catch (Exception e) {
      jlog("window bg clear failed: " + e);
    }
    ViewGroup content = act.findViewById(android.R.id.content);
    if (content != null) {
      content.setBackgroundColor(0x00000000);
    }
    WebView web = content == null ? null : findWebView(content);
    if (web == null) {
      jlog("compositing: no WebView found");
      return;
    }
    web.setBackgroundColor(0x00000000);
    // Also clear any ColorDrawable left by Tauri/wry on the WebView itself —
    // setBackgroundColor alone doesn't always replace a prior setBackground.
    try {
      web.setBackground(null);
      web.setBackgroundColor(0x00000000);
    } catch (Exception e) {
      /* older WebView */
    }
    if (web.getLayerType() != View.LAYER_TYPE_NONE) {
      web.setLayerType(View.LAYER_TYPE_NONE, null);
      jlog("webview layer -> NONE");
    }
    // Every wrapper between the WebView and the window: their backgrounds all
    // draw after the punch and each one can independently blacken it.
    View walk = web;
    while (walk.getParent() instanceof View) {
      walk = (View) walk.getParent();
      android.graphics.drawable.Drawable bg = walk.getBackground();
      if (bg != null) {
        jlog("cleared opaque bg on " + walk.getClass().getSimpleName() + " (" + describeDrawable(bg) + ")");
      }
      // Always force transparent — a null background can still inherit an opaque
      // theme colour on some devices; transparent is the safe punch.
      walk.setBackgroundColor(0x00000000);
    }
  }

  private static WebView findWebView(View root) {
    if (root instanceof WebView) return (WebView) root;
    if (root instanceof ViewGroup) {
      ViewGroup g = (ViewGroup) root;
      for (int i = 0; i < g.getChildCount(); i++) {
        WebView w = findWebView(g.getChildAt(i));
        if (w != null) return w;
      }
    }
    return null;
  }

  private static synchronized void startCodecLocked() {
    if (started.get()) return;
    Surface s = surface;
    int w = width.get();
    int h = height.get();
    if (s == null || !s.isValid() || w < 16 || h < 16) return;

    String name = pickDecoderName();
    if (name == null) {
      lastError.set("no H.264 decoder");
      lastProbeDetail.set("startCodec: no H.264 decoder");
      return;
    }
    codecName.set(name);
    lowLatency.set(probeLowLatency());

    if (codecThread == null) {
      codecThread = new HandlerThread("gt-wc-decoder", android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY);
      codecThread.start();
      codecHandler = new Handler(codecThread.getLooper());
    }

    // Moonlight-style progressive configure: try the most aggressive low-latency
    // MediaFormat first, then peel keys off until configure() accepts one. A
    // number of older Qualcomm/MTK drivers reject unknown vendor keys inside
    // configure() and the codec never starts — this is what "MediaCodec
    // unavailable" actually meant on those devices.
    List<MediaFormat> attempts = buildFormatLadder(w, h, name);
    Exception lastEx = null;
    MediaCodec c = null;
    for (int i = 0; i < attempts.size(); i++) {
      MediaFormat fmt = attempts.get(i);
      try {
        c = createCodecByName(name);
        if (c == null) {
          // createByCodecName returned null or threw — fall back to the
          // framework's by-mime picker, which selects the best HW decoder.
          c = createCodecByType();
        }
        if (c == null) {
          lastError.set("createCodec returned null");
          lastProbeDetail.set("startCodec: createCodec null");
          return;
        }
        c.setCallback(callback, codecHandler);
        c.configure(fmt, s, null, 0);
        applyRuntimeLowLatency(c);
        freeInputs.clear();
        // Do NOT clear backlog here — keyframes often arrive while the Surface is
        // still coming up (submit() parks them). Wiping them left awaitKey=true
        // with no IDR until the next host keyframe (~GOP), during which the
        // media-overlay Surface stayed black and the JS stall watchdog fell back.
        pendingMeta.clear();
        frames.set(0);
        decodeMsEwma = 0.0;
        c.start();
        codec = c;
        started.set(true);
        awaitKey.set(true);
        csdQueued.set(false);
        // Successful start clears any prior error: the progressive ladder may
        // have logged a configure/start failure on an earlier attempt, and that
        // stale string would otherwise be reported forever by statsError() —
        // which the JS poll surfaces as a "decoder error" toast even though the
        // codec is now running fine.
        lastError.set("");
        jlog(
            "MediaCodec started name="
                + name
                + " "
                + w
                + "x"
                + h
                + " ll="
                + lowLatency.get()
                + " fmtTry="
                + i);
        return;
      } catch (Exception e) {
        lastEx = e;
        jlog("configure/start attempt " + i + " failed: " + e.getMessage());
        if (c != null) {
          try {
            c.release();
          } catch (Exception ignored) {
          }
          c = null;
        }
      }
    }
    lastError.set(lastEx == null ? "all configure attempts failed" : String.valueOf(lastEx.getMessage()));
    lastProbeDetail.set("startCodec: all attempts failed (" + attempts.size() + ")");
    jlog("all codec configure attempts failed: " + (lastEx == null ? "?" : lastEx.getMessage()));
  }

  private static MediaCodec createCodecByName(String name) {
    try {
      return MediaCodec.createByCodecName(name);
    } catch (Exception e) {
      Log.w(TAG, "createByCodecName(" + name + ") failed: " + e.getMessage());
      return null;
    }
  }

  private static MediaCodec createCodecByType() {
    try {
      // createDecoderByType is deprecated but still the safest fallback — it
      // lets the framework pick the best HW decoder for the mime type when our
      // name-based pick is rejected.
      return MediaCodec.createDecoderByType(MIME);
    } catch (Exception e) {
      Log.w(TAG, "createDecoderByType failed: " + e.getMessage());
      return null;
    }
  }

  private static synchronized void stopCodecLocked() {
    started.set(false);
    MediaCodec c = codec;
    codec = null;
    freeInputs.clear();
    backlog.clear();
    pendingMeta.clear();
    queueDepth.set(0);
    csdQueued.set(false);
    if (c != null) {
      try {
        c.stop();
      } catch (Exception ignored) {
      }
      try {
        c.release();
      } catch (Exception ignored) {
      }
    }
  }

  private static final MediaCodec.Callback callback =
      new MediaCodec.Callback() {
        @Override
        public void onInputBufferAvailable(MediaCodec codec, int index) {
          freeInputs.offer(index);
          drainBacklog();
        }

        @Override
        public void onOutputBufferAvailable(
            MediaCodec codec, int index, MediaCodec.BufferInfo info) {
          long now = SystemClock.elapsedRealtime();
          Long arrived = pendingMeta.remove(info.presentationTimeUs);
          if (arrived != null) {
            double dec = (double) (now - arrived);
            double prev = decodeMsEwma;
            decodeMsEwma = prev == 0.0 ? dec : prev * 0.85 + dec * 0.15;
          }
          queueDepth.updateAndGet(v -> Math.max(0, v - 1));
          try {
            // Render immediately to the Surface (Moonlight/deskstream path).
            codec.releaseOutputBuffer(index, true);
            frames.incrementAndGet();
            // Codec is producing frames → any prior error is stale. Clear it so
            // statsError() stops reporting a configure-time failure that the
            // progressive ladder already recovered from.
            String le = lastError.get();
            if (le != null && !le.isEmpty()) lastError.set("");
          } catch (Exception e) {
            lastError.set(String.valueOf(e.getMessage()));
          }
        }

        @Override
        public void onError(MediaCodec codec, MediaCodec.CodecException e) {
          lastError.set(String.valueOf(e.getDiagnosticInfo()));
          awaitKey.set(true);
          csdQueued.set(false);
          jlog("codec onError: " + e.getDiagnosticInfo());
        }

        @Override
        public void onOutputFormatChanged(MediaCodec codec, MediaFormat format) {
          try {
            if (format.containsKey(MediaFormat.KEY_WIDTH)) {
              width.set(format.getInteger(MediaFormat.KEY_WIDTH));
            }
            if (format.containsKey(MediaFormat.KEY_HEIGHT)) {
              height.set(format.getInteger(MediaFormat.KEY_HEIGHT));
            }
          } catch (Exception ignored) {
          }
        }
      };

  /**
   * Build the progressive list of MediaFormats to try, most aggressive first.
   * Mirrors Moonlight's {@code setDecoderLowLatencyOptions(mediaFormat, decoderInfo,
   * tryNumber)} — try the full vendor-key set first, then peel them off one ring
   * at a time until a bare-bones {@code KEY_LOW_LATENCY}+{@code KEY_PRIORITY}
   * config is the last resort. A bare config (no LL keys at all) is the absolute
   * fallback so we never fail to start the codec on a device that just doesn't
   * grok any of the vendor hints.
   */
  private static List<MediaFormat> buildFormatLadder(int w, int h, String decoderName) {
    List<MediaFormat> ladder = new ArrayList<>();
    String lower = decoderName.toLowerCase();
    boolean isQualcomm = lower.contains("qcom") || lower.contains("qti") || lower.contains("c2.qti");
    boolean isMtk = lower.contains("mtk") || lower.contains("mediatek");

    // Attempt 0 — everything but the kitchen sink. This is what works on most
    // Snapdragon 7xx/8xx and modern MediaTek parts.
    MediaFormat full = baseFormat(w, h);
    applyStandardLowLatency(full);
    applyVendorKeys(full);
    applyOperatingRate(full, decoderName);
    ladder.add(full);

    // Attempt 1 — standard KEY_LOW_LATENCY + Qualcomm picture-order + operating
    // rate. Drops the catch-all vendor keys that some drivers reject.
    MediaFormat std = baseFormat(w, h);
    applyStandardLowLatency(std);
    if (isQualcomm) {
      setVendorInt(std, "vendor.qti-ext-dec-picture-order.enable", 1);
    }
    applyOperatingRate(std, decoderName);
    ladder.add(std);

    // Attempt 2 — KEY_LOW_LATENCY + KEY_PRIORITY only (no vendor keys at all).
    MediaFormat min = baseFormat(w, h);
    applyStandardLowLatency(min);
    ladder.add(min);

    // Attempt 3 — MediaTek/Amlogic "vdec-lowlatency" magic string (MediaTek
    // parts route this to OMX.MTK.index.param.video.LowLatencyDecode).
    if (isMtk) {
      MediaFormat mtk = baseFormat(w, h);
      applyStandardLowLatency(mtk);
      setVendorInt(mtk, "vdec-lowlatency", 1);
      ladder.add(mtk);
    }

    // Attempt 4 — plain video format with no LL hints. Last resort: still better
    // than no decoder. The SPS fixup on the host (refs=1, reorder=0, DPB=1) keeps
    // decode latency low even without the decoder's own LL mode.
    ladder.add(baseFormat(w, h));
    return ladder;
  }

  private static MediaFormat baseFormat(int w, int h) {
    MediaFormat format = MediaFormat.createVideoFormat(MIME, w, h);
    format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, Math.max(512_000, w * h));
    if (Build.VERSION.SDK_INT >= 23) {
      format.setInteger(MediaFormat.KEY_PRIORITY, 0);
    }
    return format;
  }

  private static void applyStandardLowLatency(MediaFormat format) {
    if (Build.VERSION.SDK_INT >= 30) {
      format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
    }
    // "low-latency" is the spelling Moonlight uses; some OEMs accept it pre-R.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      setVendorInt(format, "low-latency", 1);
    }
  }

  private static void applyVendorKeys(MediaFormat format) {
    for (String key : VENDOR_LL_KEYS) {
      setVendorInt(format, key, 1);
    }
    // HiSilicon's "ready" signal is -1, not 1.
    setVendorInt(format, "vendor.hisi-ext-low-latency-video-dec.video-scene-for-low-latency-rdy", -1);
  }

  private static void applyOperatingRate(MediaFormat format, String decoderName) {
    // Moonlight's decoderSupportsMaxOperatingRate: Qualcomm-only, not Adreno 620.
    // Crashes the codec on some older Snapdragon 7xx if it can't satisfy the
    // rate, so we gate it to known-good prefixes.
    String lower = decoderName.toLowerCase();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
        && (lower.contains("qcom") || lower.contains("qti") || lower.contains("c2.qti"))) {
      try {
        format.setInteger(MediaFormat.KEY_OPERATING_RATE, Short.MAX_VALUE);
      } catch (Exception ignored) {
      }
    }
  }

  private static void setVendorInt(MediaFormat format, String key, int value) {
    try {
      format.setInteger(key, value);
    } catch (Exception ignored) {
    }
  }

  private static void applyRuntimeLowLatency(MediaCodec c) {
    if (Build.VERSION.SDK_INT < 30) return;
    try {
      Bundle b = new Bundle();
      b.putInt(MediaCodec.PARAMETER_KEY_LOW_LATENCY, 1);
      c.setParameters(b);
    } catch (Exception ignored) {
    }
  }

  /**
   * Pick the best H.264 decoder, preferring a low-latency variant if one exists.
   * Returns null only if the device literally has no H.264 decoder (unheard of
   * on any shipping Android phone since ~2012). The previous version returned
   * null when every decoder failed the LL probe AND the framework fallback threw
   * — this version still returns a name in that case so the caller's progressive
   * {@link #startCodecLocked} can try plain-config too.
   */
  private static String pickDecoderName() {
    MediaCodecInfo[] infos;
    try {
      infos = new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos();
    } catch (Throwable t) {
      // Throwable, not Exception: some OEM framework builds throw Errors here.
      lastProbeDetail.set("pickDecoder: MediaCodecList threw " + describeThrowable(t));
      return null;
    }

    String llHw = null; // FEATURE_LowLatency hardware decoder
    String anyHw = null; // any hardware decoder (non-LL)
    String llVariant = null; // decoder explicitly named "*.low_latency"
    String anySw = null; // software fallback (last resort)

    for (MediaCodecInfo info : infos) {
      // Throwable guard around the whole entry: one rogue codec plugin (buggy
      // OEM builds throw Errors from the most innocent getters) must not sink
      // the whole scan.
      try {
        if (info.isEncoder()) continue;
        String[] types;
        try {
          types = info.getSupportedTypes();
        } catch (Exception e) {
          continue;
        }
        boolean supports = false;
        for (String t : types) {
          if (MIME.equalsIgnoreCase(t)) {
            supports = true;
            break;
          }
        }
        if (!supports) continue;

        String name = info.getName();
        String lower = name.toLowerCase();

        // Skip software decoders — they're tracked separately as the absolute
        // last resort. Don't gate on isSoftwareOnly() alone (some emulator
        // builds only ship SW).
        boolean looksSoftware =
            lower.contains("sw")
                || lower.contains("google")
                || lower.contains("android.video.avc")
                || lower.contains("c2.android")
                || lower.contains("omx.google")
                || lower.contains("avcdecoder");
        if (looksSoftware) {
          if (anySw == null) anySw = name;
          continue;
        }

        // Skip aliases on Q+ — they're the same decoder under two names.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          try {
            if (info.isAlias()) continue;
          } catch (Exception ignored) {
          }
        }

        // An explicit low_latency variant is the best pick — Pixel 4 ships
        // c2.qti.avc.decoder.low_latency SEPARATELY from the base decoder and
        // only the LL one advertises FEATURE_LowLatency (Moonlight errata #15).
        if (lower.contains("low_latency") || lower.contains("low-latency")) {
          if (llVariant == null) llVariant = name;
        }

        try {
          MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(MIME);
          boolean llFeature = false;
          if (Build.VERSION.SDK_INT >= 30) {
            try {
              llFeature = caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency);
            } catch (Exception ignored) {
            }
          }
          if (llFeature) {
            if (llHw == null) llHw = name;
          }
        } catch (Exception ignored) {
          // Buggy codec — pretend it's a generic HW decoder and move on.
        }
        if (anyHw == null) anyHw = name;
      } catch (Throwable perCodec) {
        continue;
      }
    }

    if (llVariant != null) return llVariant;
    if (llHw != null) return llHw;
    if (anyHw != null) return anyHw;

    // Framework pick: lets the platform decide the best decoder for the format.
    try {
      MediaFormat fmt = MediaFormat.createVideoFormat(MIME, 1280, 720);
      String found = new MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(fmt);
      if (found != null) return found;
    } catch (Throwable t) {
      lastProbeDetail.set("pickDecoder: findDecoderForFormat threw " + describeThrowable(t));
    }

    // Absolute last resort — a software decoder is still a decoder. The DIRECT
    // path's latency benefit (no jitter buffer) outweighs the SW decode cost on
    // any modern phone, and at least the user gets a picture instead of a black
    // screen + "MediaCodec unavailable" toast.
    return anySw;
  }

  /**
   * Whether the codec publishes any of the known vendor low-latency parameters.
   * Used as a secondary LL signal (matches Moonlight's heuristic). API 12+ only
   * because {@link MediaCodec#getSupportedVendorParameters()} is API 31+; on
   * older OSes we assume not.
   */
  private static boolean supportsKnownVendorParameter(String name) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
    MediaCodec test = null;
    try {
      test = MediaCodec.createByCodecName(name);
      List<String> params;
      try {
        // Available on API 31+ (S).
        params = test.getSupportedVendorParameters();
      } catch (Throwable t) {
        return false;
      }
      if (params == null) return false;
      List<String> known = Arrays.asList(VENDOR_LL_KEYS);
      for (String p : params) {
        for (String k : known) {
          if (p != null && p.equalsIgnoreCase(k)) return true;
        }
      }
    } catch (Exception ignored) {
      // Codec unavailable — assume not.
    } finally {
      if (test != null) {
        try {
          test.release();
        } catch (Exception ignored) {
        }
      }
    }
    return false;
  }

  private static MediaCodecInfo findInfo(String name) {
    try {
      for (MediaCodecInfo info :
          new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos()) {
        if (info.getName().equals(name)) return info;
      }
    } catch (Throwable ignored) {
    }
    return null;
  }

  private WcDecoderBridge() {}
}
