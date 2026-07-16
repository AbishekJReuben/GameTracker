package __PACKAGE__;

import android.app.Activity;
import android.graphics.Color;
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
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
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
  private static SurfaceView surfaceView;
  private static Surface surface;
  private static MediaCodec codec;
  private static HandlerThread codecThread;
  private static Handler codecHandler;
  private static final ConcurrentLinkedQueue<Integer> freeInputs = new ConcurrentLinkedQueue<>();
  private static final ConcurrentHashMap<Long, Long> pendingMeta = new ConcurrentHashMap<>();
  private static final ConcurrentLinkedQueue<PendingFrame> backlog = new ConcurrentLinkedQueue<>();
  private static final AtomicBoolean started = new AtomicBoolean(false);
  private static final AtomicBoolean surfaceReady = new AtomicBoolean(false);
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

  /** Bound from MainActivity.onCreate — owns the SurfaceView under the WebView. */
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
    width.set(w);
    height.set(h);
    lastError.set("");
    awaitKey.set(true);
    csdQueued.set(false);
    Activity act = activity();
    if (act == null) throw new IllegalStateException("no activity");
    act.runOnUiThread(
        () -> {
          ensureSurfaceView(act);
          hookWebView(act);
          makeWebViewTransparent(act);
          // A GONE SurfaceView never receives surfaceCreated, so it never owns a
          // Surface, so MediaCodec can never be configured against one. Showing
          // it is therefore part of STARTING the decoder, not part of laying it
          // out — it must not wait on JS.
          //
          // It used to wait: the view was created GONE and only `setBounds` from
          // Control's layout effect made it visible, but that effect returns
          // early until a frame has established the video's natural size. On the
          // native path no frame can arrive before the codec runs, so nothing
          // ever made it visible: no Surface → no codec → no frames → no size →
          // no bounds. The HUD's tell was "active=false" with no codec error.
          //
          // Size/position are still JS's job (setBounds); a 1×1 view here is
          // invisible either way, and surfaceCreated fires regardless.
          SurfaceView sv = surfaceView;
          if (sv != null && sv.getVisibility() != View.VISIBLE) {
            sv.setVisibility(View.VISIBLE);
          }
          // Already had a Surface (re-init after a teardown) — start right now;
          // otherwise surfaceCreated starts us as soon as the view is realised.
          if (surfaceReady.get()) {
            startCodecLocked();
          }
        });
  }

  public static void setBounds(double x, double y, double w, double h, boolean visible) {
    Activity act = activity();
    if (act == null) return;
    act.runOnUiThread(
        () -> {
          SurfaceView sv = surfaceView;
          if (sv == null) return;
          float dpr = act.getResources().getDisplayMetrics().density;
          // JS sends CSS pixels from getBoundingClientRect; layout params are px.
          int ix = Math.round((float) (x * dpr));
          int iy = Math.round((float) (y * dpr));
          int iw = Math.max(1, Math.round((float) (w * dpr)));
          int ih = Math.max(1, Math.round((float) (h * dpr)));
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
          sv.setVisibility(visible ? View.VISIBLE : View.GONE);
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

  public static void teardown() {
    Activity act = activity();
    Runnable stop =
        () -> {
          stopCodecLocked();
          SurfaceView sv = surfaceView;
          if (sv != null) sv.setVisibility(View.GONE);
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
    // slice. Most Android HW decoders REQUIRE this (Moonlight/ALVR/Chiaki all
    // do the same); an inline-only stream silently renders nothing on c2.qti
    // and several MediaTek parts. We re-extract every keyframe — cheap, and
    // it lets a mid-stream resolution change re-prime the decoder.
    boolean needsCsd = key && !csdQueued.get();
    byte[] csd = needsCsd ? extractCsd(data) : null;
    if (csd != null) {
      Integer csdIdx = freeInputs.poll();
      if (csdIdx == null) {
        // No room for the CSD right now — hold the keyframe back. Feeding the
        // slice without a CSD would either throw or render nothing, then arm
        // awaitKey on the next error; better to wait one tick.
        backlog.clear();
        backlog.offer(new PendingFrame(tsUs, true, data, arrived));
        return;
      }
      queueCsd(csdIdx, csd);
    } else if (needsCsd) {
      // We wanted a CSD but couldn't extract one — most likely the host shipped
      // just an IDR without inline SPS/PPS. Fall through and queue the frame
      // anyway; the previous session's CSD (or the codec's defaults) may still
      // decode it. If not, the next keyframe will retry extraction.
    }
    Integer idx = freeInputs.poll();
    if (idx == null) {
      // Latest-wins: drop oldest backlog, keep this frame if key or queue small.
      if (backlog.size() >= 2) backlog.poll();
      backlog.offer(new PendingFrame(tsUs, key, data, arrived));
      return;
    }
    queueInput(idx, tsUs, key, data, arrived);
    drainBacklog();
  }

  private static void drainBacklog() {
    while (true) {
      Integer idx = freeInputs.poll();
      if (idx == null) return;
      PendingFrame pf = backlog.poll();
      if (pf == null) {
        freeInputs.offer(idx);
        return;
      }
      queueInput(idx, pf.tsUs, pf.key, pf.data, pf.arrivedAt);
    }
  }

  /**
   * Pull SPS (NAL type 7) + PPS (NAL type 8) out of an Annex-B buffer and
   * concatenate them into one CSD-0 blob (SPS||PPS, no start codes between).
   * Returns null if either is missing. The slice NAL is left out — the slice
   * is queued as a normal input buffer right after.
   */
  private static byte[] extractCsd(byte[] annexB) {
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
        // Find the next start code (or end).
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
      if (sps == null || pps == null) return null;
      byte[] csd = new byte[sps.length + pps.length];
      System.arraycopy(sps, 0, csd, 0, sps.length);
      System.arraycopy(pps, 0, csd, sps.length, pps.length);
      return csd;
    } catch (Exception e) {
      return null;
    }
  }

  private static void queueCsd(int index, byte[] csd) {
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
      if (buf.remaining() < csd.length) {
        freeInputs.offer(index);
        return;
      }
      buf.put(csd);
      c.queueInputBuffer(index, 0, csd.length, 0, MediaCodec.BUFFER_FLAG_CODEC_CONFIG);
      csdQueued.set(true);
    } catch (Exception e) {
      freeInputs.offer(index);
      lastError.set("csd: " + e.getMessage());
      Log.w(TAG, "queueCsd failed", e);
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
    sv.setZOrderMediaOverlay(false);
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
                if (width.get() > 0 && height.get() > 0) startCodecLocked();
              }

              @Override
              public void surfaceChanged(SurfaceHolder holder, int format, int w, int h) {
                surface = holder.getSurface();
                surfaceReady.set(true);
              }

              @Override
              public void surfaceDestroyed(SurfaceHolder holder) {
                surfaceReady.set(false);
                surface = null;
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

  private static void makeWebViewTransparent(Activity act) {
    ViewGroup content = act.findViewById(android.R.id.content);
    WebView web = content == null ? null : findWebView(content);
    if (web == null) return;
    web.setBackgroundColor(Color.TRANSPARENT);
    // Software layer can break transparency on some OEMs; hardware is fine.
    web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
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
        backlog.clear();
        pendingMeta.clear();
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
        Log.i(
            TAG,
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
        Log.w(TAG, "configure/start attempt " + i + " failed: " + e.getMessage());
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
    Log.e(TAG, "all codec configure attempts failed", lastEx);
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
          Log.w(TAG, "codec error", e);
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
