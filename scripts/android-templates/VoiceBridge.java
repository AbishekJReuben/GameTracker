package __PACKAGE__;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Static entry points reached from Rust over JNI (companion/src-tauri/src/voice.rs).
 * The service's state lives on the main thread; these hop there.
 */
public class VoiceBridge {
  private static final Handler MAIN = new Handler(Looper.getMainLooper());

  public static void start(Context ctx, boolean enabled, String secret, String device, String url) {
    VoiceService.start(ctx.getApplicationContext(), enabled, secret, device, url);
  }

  /** The Voice screen's state; `{"ver":n}` alone when nothing changed since `ver`. */
  public static String snapshot(Context ctx, int ver) {
    final VoiceService s = VoiceService.instance;
    if (s == null) return "{\"running\":false}";
    if (Looper.myLooper() == Looper.getMainLooper()) return s.snapshot(ver);
    final String[] out = {"{}"};
    final CountDownLatch done = new CountDownLatch(1);
    MAIN.post(() -> {
      try {
        out[0] = s.snapshot(ver);
      } finally {
        done.countDown();
      }
    });
    try {
      done.await(500, TimeUnit.MILLISECONDS);
    } catch (InterruptedException ignored) {
    }
    return out[0];
  }

  /** pause | play | skip | live | speed <x> | replay <itemId> */
  public static void control(Context ctx, String action, String arg) {
    MAIN.post(() -> {
      VoiceService s = VoiceService.instance;
      if (s == null) return;
      switch (action) {
        case "pause":
          s.setPaused(true);
          break;
        case "play":
          s.setPaused(false);
          break;
        case "skip":
          s.skip();
          break;
        case "live":
          s.catchUp();
          break;
        case "speed":
          try {
            s.setSpeed(Float.parseFloat(arg));
          } catch (Exception ignored) {
          }
          break;
        case "replay":
          if (arg != null && !arg.isEmpty()) s.replay(arg);
          break;
        default:
          break;
      }
    });
  }
}
