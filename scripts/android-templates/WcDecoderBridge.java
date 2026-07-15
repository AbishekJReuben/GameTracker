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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Low-latency H.264 decode for GameTracker Remote (DIRECT path).
 *
 * Patterns borrowed from:
 *  - moonlight-android MediaCodecHelper (FEATURE_LowLatency + vendor keys)
 *  - chiaki-ng video-decoder.c (AMediaCodec → Surface)
 *  - ALVR push_nal / deskstream VideoDecoder.kt (async callback, Annex-B AUs)
 *
 * Hot path: {@link JsApi#feed} via JavascriptInterface (base64 Annex-B).
 * Lifecycle: static methods called from Rust over JNI.
 */
public final class WcDecoderBridge {
  private static final String TAG = "GtWcDecoder";
  private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;

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
  private static final AtomicInteger width = new AtomicInteger(0);
  private static final AtomicInteger height = new AtomicInteger(0);
  private static final AtomicInteger queueDepth = new AtomicInteger(0);
  private static final AtomicLong frames = new AtomicLong(0);
  private static final AtomicReference<String> lastError = new AtomicReference<>("");
  private static final AtomicReference<String> codecName = new AtomicReference<>("");
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

  public static boolean probeAvailable() {
    return pickDecoderName() != null;
  }

  public static boolean probeLowLatency() {
    String name = pickDecoderName();
    if (name == null) return false;
    try {
      MediaCodecInfo info = findInfo(name);
      if (info == null) return false;
      MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(MIME);
      if (Build.VERSION.SDK_INT >= 30) {
        return caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
            || name.toLowerCase().contains("low_latency")
            || name.toLowerCase().contains("low-latency");
      }
      return name.toLowerCase().contains("low_latency") || name.toLowerCase().contains("low-latency");
    } catch (Exception e) {
      return false;
    }
  }

  public static String probeName() {
    String n = pickDecoderName();
    return n == null ? "" : n;
  }

  public static void init(int w, int h) {
    if (w < 16 || h < 16) throw new IllegalArgumentException("bad size " + w + "x" + h);
    width.set(w);
    height.set(h);
    lastError.set("");
    awaitKey.set(true);
    Activity act = activity();
    if (act == null) throw new IllegalStateException("no activity");
    act.runOnUiThread(
        () -> {
          ensureSurfaceView(act);
          hookWebView(act);
          makeWebViewTransparent(act);
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
    pendingMeta.clear();
    backlog.clear();
    queueDepth.set(0);
    MediaCodec c = codec;
    if (c != null) {
      try {
        c.flush();
      } catch (Exception ignored) {
      }
      freeInputs.clear();
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

  private static void hookWebView(Activity act) {
    if (webViewHooked) return;
    ViewGroup content = act.findViewById(android.R.id.content);
    WebView web = content == null ? null : findWebView(content);
    if (web == null) {
      // Tauri may attach the WebView a frame later.
      content.postDelayed(() -> hookWebView(act), 50);
      return;
    }
    try {
      web.addJavascriptInterface(new JsApi(), "__GT_DECODER__");
      webViewHooked = true;
      Log.i(TAG, "JavascriptInterface __GT_DECODER__ installed");
    } catch (Exception e) {
      Log.w(TAG, "addJavascriptInterface failed", e);
    }
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
      return;
    }
    codecName.set(name);
    lowLatency.set(probeLowLatency());

    try {
      if (codecThread == null) {
        codecThread = new HandlerThread("gt-wc-decoder", android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY);
        codecThread.start();
        codecHandler = new Handler(codecThread.getLooper());
      }
      MediaCodec c = MediaCodec.createByCodecName(name);
      MediaFormat format = buildFormat(w, h, name);
      c.setCallback(callback, codecHandler);
      c.configure(format, s, null, 0);
      applyRuntimeLowLatency(c);
      freeInputs.clear();
      backlog.clear();
      pendingMeta.clear();
      c.start();
      codec = c;
      started.set(true);
      awaitKey.set(true);
      Log.i(TAG, "MediaCodec started name=" + name + " " + w + "x" + h + " ll=" + lowLatency.get());
    } catch (Exception e) {
      lastError.set(String.valueOf(e.getMessage()));
      Log.e(TAG, "startCodec failed", e);
      stopCodecLocked();
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
          } catch (Exception e) {
            lastError.set(String.valueOf(e.getMessage()));
          }
        }

        @Override
        public void onError(MediaCodec codec, MediaCodec.CodecException e) {
          lastError.set(String.valueOf(e.getDiagnosticInfo()));
          awaitKey.set(true);
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

  private static MediaFormat buildFormat(int w, int h, String decoderName) {
    MediaFormat format = MediaFormat.createVideoFormat(MIME, w, h);
    format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, Math.max(512_000, w * h));
    // Realtime priority (API 23+) — planning hint for the codec.
    if (Build.VERSION.SDK_INT >= 23) {
      format.setInteger(MediaFormat.KEY_PRIORITY, 0);
    }
    if (Build.VERSION.SDK_INT >= 30) {
      format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
    }
    // Moonlight-style vendor low-latency keys (best-effort; ignored if unknown).
    setVendorInt(format, "vendor.qti-ext-dec-low-latency.enable", 1);
    setVendorInt(format, "vendor.low-latency.enable", 1);
    setVendorInt(format, "vdec-lowlatency", 1);
    setVendorInt(format, "vendor.rtc-ext-dec-low-latency.enable", 1);
    setVendorInt(format, "vendor.hisi-ext-low-latency-video-dec.video-scene-for-low-latency-req", 1);
    setVendorInt(format, "vendor.hisi-ext-low-latency-video-dec.video-scene-for-low-latency-rdy", -1);
    if (decoderName.toLowerCase().contains("mtk") || decoderName.toLowerCase().contains("mediatek")) {
      setVendorInt(format, "vdec-lowlatency", 1);
    }
    return format;
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

  private static String pickDecoderName() {
    MediaCodecList list = new MediaCodecList(MediaCodecList.ALL_CODECS);
    String fallbackHw = null;
    String fallbackAny = null;
    for (MediaCodecInfo info : list.getCodecInfos()) {
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
      if (lower.contains("sw") || lower.contains("google") || lower.contains("android.video.avc")) {
        if (fallbackAny == null) fallbackAny = name;
        continue;
      }
      try {
        MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(MIME);
        boolean ll =
            (Build.VERSION.SDK_INT >= 30
                    && caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency))
                || lower.contains("low_latency")
                || lower.contains("low-latency");
        if (ll) return name;
      } catch (Exception ignored) {
      }
      if (fallbackHw == null) fallbackHw = name;
    }
    if (fallbackHw != null) return fallbackHw;
    // Last resort: framework pick.
    try {
      MediaFormat fmt = MediaFormat.createVideoFormat(MIME, 1280, 720);
      return new MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(fmt);
    } catch (Exception e) {
      return fallbackAny;
    }
  }

  private static MediaCodecInfo findInfo(String name) {
    for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos()) {
      if (info.getName().equals(name)) return info;
    }
    return null;
  }

  private WcDecoderBridge() {}
}
