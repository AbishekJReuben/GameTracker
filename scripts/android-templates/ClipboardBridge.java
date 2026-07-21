package __PACKAGE__;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

/**
 * Static bridge reached from Rust over JNI (companion/src-tauri/src/clipboard.rs).
 * Permission checks/requests, foreground clipboard read/write (Android 10+ only
 * allows this while the app is focused), and starting/stopping the overlay + sync
 * foreground service. Kept minimal and exception-safe; the service does the work.
 */
public class ClipboardBridge {
  static final String PREFS = "gt_clip";

  public static boolean overlayGranted(Context ctx) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
    return Settings.canDrawOverlays(ctx);
  }

  public static void requestOverlay(Context ctx) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
    Intent i = new Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()));
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      ctx.startActivity(i);
    } catch (Exception ignored) {
    }
  }

  public static boolean batteryExempt(Context ctx) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
    PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
    return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
  }

  @SuppressLint("BatteryLife")
  public static void requestBattery(Context ctx) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
    Intent i = new Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:" + ctx.getPackageName()));
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      ctx.startActivity(i);
    } catch (Exception ignored) {
    }
  }

  public static boolean notifGranted(Context ctx) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
    return ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
        == PackageManager.PERMISSION_GRANTED;
  }

  public static void requestNotif(Context ctx) {
    // A runtime request needs an Activity; opening the app's notification settings
    // is the reliable service-context fallback.
    Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
    i.putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      ctx.startActivity(i);
    } catch (Exception ignored) {
    }
  }

  public static String readClipboard(Context ctx) {
    try {
      ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
      if (cm == null || !cm.hasPrimaryClip()) return "";
      ClipData clip = cm.getPrimaryClip();
      if (clip == null || clip.getItemCount() == 0) return "";
      CharSequence t = clip.getItemAt(0).coerceToText(ctx);
      return t == null ? "" : t.toString();
    } catch (Exception e) {
      return "";
    }
  }

  /** Read an IMAGE from the OS clipboard as a data URL ("data:<mime>;base64,…"),
   *  or "" when the clipboard holds no image. Foreground-only, like readClipboard. */
  public static String readClipboardImage(Context ctx) {
    try {
      ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
      if (cm == null || !cm.hasPrimaryClip()) return "";
      ClipData clip = cm.getPrimaryClip();
      if (clip == null || clip.getItemCount() == 0) return "";
      Uri uri = clip.getItemAt(0).getUri();
      if (uri == null) return "";
      String mime = ctx.getContentResolver().getType(uri);
      if (mime == null || !mime.startsWith("image/")) return "";
      try (java.io.InputStream in = ctx.getContentResolver().openInputStream(uri)) {
        if (in == null) return "";
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        if (bos.size() == 0) return "";
        return "data:" + mime + ";base64,"
            + android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
      }
    } catch (Exception e) {
      return "";
    }
  }

  public static void writeClipboard(Context ctx, String text) {
    try {
      ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
      if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("GameTracker", text));
    } catch (Exception ignored) {
    }
  }

  /** Start/stop the overlay + sync service and remember the choice for boot. */
  public static void startService(
      Context ctx, boolean enabled, String secret, String deviceId, String signalUrl,
      String sarvamKey) {
    SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    p.edit()
        .putBoolean("enabled", enabled)
        .putString("secret", secret)
        .putString("deviceId", deviceId)
        .putString("signalUrl", signalUrl)
        .putString("sarvamKey", sarvamKey == null ? "" : sarvamKey)
        .apply();

    Intent i = new Intent(ctx, ClipboardService.class);
    if (!enabled) {
      i.setAction(ClipboardService.ACTION_STOP);
      try {
        ctx.startService(i);
      } catch (Exception ignored) {
      }
      return;
    }
    i.setAction(ClipboardService.ACTION_START);
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
      else ctx.startService(i);
    } catch (Exception ignored) {
    }
  }

  public static String snapshot(Context ctx) {
    return ClipboardService.snapshot();
  }
}
