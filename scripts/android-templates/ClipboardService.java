package __PACKAGE__;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/**
 * Always-on shared-clipboard service.
 *
 * Draws a draggable overlay bubble on top of every app (SYSTEM_ALERT_WINDOW) and
 * runs as a `specialUse` foreground service so it survives indefinitely (the
 * `dataSync` type is capped at 6h/24h). Tapping the bubble foregrounds the app —
 * the only state in which Android 10+ lets us read the clipboard — where the
 * webview's Clipboard screen captures and decrypts history. A native, push-only
 * WebSocket remains connected when the Activity/webview is destroyed, so new
 * remote items still update the notification in real time. `START_STICKY` + the
 * ClipboardBootReceiver bring it back after a kill or reboot.
 */
public class ClipboardService extends Service {
  public static final String ACTION_START = "__PACKAGE__.CLIP_START";
  public static final String ACTION_STOP = "__PACKAGE__.CLIP_STOP";
  private static final String CHANNEL = "gt_clipboard";
  private static final int NOTIF_ID = 0x6C69; // "li"

  private WindowManager wm;
  private View bubble;
  private WindowManager.LayoutParams lp;
  private final Handler main = new Handler(Looper.getMainLooper());
  private OkHttpClient http;
  private WebSocket socket;
  private long reconnectMs = 1000;
  private boolean stopping;
  private String deviceId = "";
  private String socketUrl = "";

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String action = intent == null ? ACTION_START : intent.getAction();
    if (ACTION_STOP.equals(action)) {
      stopSelf();
      return START_NOT_STICKY;
    }
    startForegroundNotif();
    showBubble();
    startSync();
    return START_STICKY;
  }

  /** Keep one idle push socket alive. History/decryption stays lazy in the UI. */
  private void startSync() {
    android.content.SharedPreferences p =
        getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE);
    String secret = p.getString("secret", "");
    deviceId = p.getString("deviceId", "");
    String base = p.getString("signalUrl", "");
    if (secret == null || secret.isEmpty() || base == null || base.isEmpty()) return;
    try {
      while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
      socketUrl = base + "/clip/ws?clip=" + clipId(secret)
          + "&device=" + android.net.Uri.encode(deviceId + "-native");
    } catch (Exception ignored) {
      return;
    }
    stopping = false;
    if (http == null) {
      http = new OkHttpClient.Builder()
          .pingInterval(30, TimeUnit.SECONDS)
          .retryOnConnectionFailure(true)
          .build();
    }
    connectSocket();
  }

  private void connectSocket() {
    if (stopping || socketUrl.isEmpty() || socket != null) return;
    socket = http.newWebSocket(new Request.Builder().url(socketUrl).build(), new WebSocketListener() {
      @Override public void onOpen(WebSocket ws, Response response) {
        reconnectMs = 1000;
        long rev = getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
            .getLong("nativeRev", 0);
        ws.send("{\"t\":\"hello\",\"since\":" + rev + "}");
      }

      @Override public void onMessage(WebSocket ws, String text) {
        handleNotice(text);
      }

      @Override public void onClosed(WebSocket ws, int code, String reason) {
        socket = null;
        scheduleReconnect();
      }

      @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
        socket = null;
        scheduleReconnect();
      }
    });
  }

  private void scheduleReconnect() {
    if (stopping) return;
    long delay = reconnectMs;
    reconnectMs = Math.min(reconnectMs * 2, 60_000);
    main.removeCallbacks(reconnect);
    main.postDelayed(reconnect, delay);
  }

  private final Runnable reconnect = this::connectSocket;

  private void handleNotice(String text) {
    try {
      JSONObject v = new JSONObject(text);
      long rev = v.optLong("rev", 0);
      if (rev > 0) {
        getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
            .edit().putLong("nativeRev", rev).apply();
      }
      if (!"item".equals(v.optString("t")) || v.optBoolean("deleted", false)) return;
      if (deviceId.equals(v.optString("deviceId"))) return;
      main.post(this::showNewItemAttention);
    } catch (Exception ignored) {
    }
  }

  private void showNewItemAttention() {
    if (bubble != null) {
      bubble.animate().cancel();
      bubble.setScaleX(0.86f);
      bubble.setScaleY(0.86f);
      bubble.animate().scaleX(1f).scaleY(1f).setDuration(320).start();
    }
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    Notification base = buildNotification();
    Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL)
        : new Notification.Builder(this);
    nm.notify(NOTIF_ID, b.setSmallIcon(base.getSmallIcon())
        .setContentTitle("New shared clipboard item")
        .setContentText("Tap the bubble to view and copy it")
        .setOngoing(true)
        .setOnlyAlertOnce(false)
        .build());
  }

  private static String clipId(String secret) throws Exception {
    byte[] h = MessageDigest.getInstance("SHA-256")
        .digest(secret.getBytes(StandardCharsets.UTF_8));
    StringBuilder out = new StringBuilder(16);
    for (int i = 0; i < 8; i++) out.append(String.format(java.util.Locale.US, "%02x", h[i] & 0xff));
    return out.toString();
  }

  private void startForegroundNotif() {
    createChannel();
    Notification n = buildNotification();
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
      } else {
        startForeground(NOTIF_ID, n);
      }
    } catch (Exception e) {
      try {
        startForeground(NOTIF_ID, n);
      } catch (Exception ignored) {
      }
    }
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    NotificationChannel ch =
        new NotificationChannel(CHANNEL, "Shared clipboard", NotificationManager.IMPORTANCE_MIN);
    ch.setShowBadge(false);
    nm.createNotificationChannel(ch);
  }

  private Notification buildNotification() {
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

    Notification.Builder b =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this);
    return b.setSmallIcon(getApplicationInfo().icon)
        .setContentTitle("Shared clipboard")
        .setContentText("Tap the bubble to open your clipboard")
        .setContentIntent(pi)
        .setOngoing(true)
        .build();
  }

  private int dp(float v) {
    DisplayMetrics m = getResources().getDisplayMetrics();
    return Math.round(v * m.density);
  }

  private void showBubble() {
    if (bubble != null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !android.provider.Settings.canDrawOverlays(this)) {
      return; // no overlay permission — the FGS still runs; bubble appears once granted
    }
    wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
    if (wm == null) return;

    ImageView view = new ImageView(this);
    int size = dp(52);
    int pad = dp(12);
    view.setPadding(pad, pad, pad, pad);
    view.setImageResource(getApplicationInfo().icon);
    GradientDrawable bg = new GradientDrawable();
    bg.setShape(GradientDrawable.OVAL);
    bg.setColors(new int[] {Color.parseColor("#7C5CFF"), Color.parseColor("#22D3EE")});
    bg.setGradientType(GradientDrawable.LINEAR_GRADIENT);
    view.setBackground(bg);
    view.setElevation(dp(6));

    int type =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
    lp =
        new WindowManager.LayoutParams(
            size,
            size,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
    lp.gravity = Gravity.TOP | Gravity.START;
    lp.x = dp(12);
    lp.y = dp(120);

    view.setOnTouchListener(new DragTap());
    try {
      wm.addView(view, lp);
      bubble = view;
    } catch (Exception ignored) {
    }
  }

  /** Drag to move + snap to the nearest side; a tap (little movement) opens the app. */
  private class DragTap implements View.OnTouchListener {
    private int startX, startY;
    private float touchX, touchY;
    private long downTime;
    private boolean moved;

    @Override
    public boolean onTouch(View v, MotionEvent e) {
      switch (e.getAction()) {
        case MotionEvent.ACTION_DOWN:
          startX = lp.x;
          startY = lp.y;
          touchX = e.getRawX();
          touchY = e.getRawY();
          downTime = System.currentTimeMillis();
          moved = false;
          return true;
        case MotionEvent.ACTION_MOVE:
          int dx = (int) (e.getRawX() - touchX);
          int dy = (int) (e.getRawY() - touchY);
          if (Math.abs(dx) > dp(4) || Math.abs(dy) > dp(4)) moved = true;
          lp.x = startX + dx;
          lp.y = startY + dy;
          try {
            wm.updateViewLayout(bubble, lp);
          } catch (Exception ignored) {
          }
          return true;
        case MotionEvent.ACTION_UP:
          if (!moved && System.currentTimeMillis() - downTime < 400) {
            openApp();
          } else {
            snapToEdge();
          }
          return true;
        default:
          return false;
      }
    }
  }

  private void snapToEdge() {
    DisplayMetrics m = getResources().getDisplayMetrics();
    lp.x = (lp.x + bubble.getWidth() / 2 < m.widthPixels / 2) ? dp(12) : m.widthPixels - bubble.getWidth() - dp(12);
    try {
      wm.updateViewLayout(bubble, lp);
    } catch (Exception ignored) {
    }
  }

  private void openApp() {
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (open != null) {
      open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
      open.putExtra("gt_open", "clipboard");
      try {
        startActivity(open);
      } catch (Exception ignored) {
      }
    }
  }

  @Override
  public void onDestroy() {
    super.onDestroy();
    stopping = true;
    main.removeCallbacks(reconnect);
    if (socket != null) socket.cancel();
    socket = null;
    if (http != null) http.dispatcher().executorService().shutdown();
    http = null;
    if (bubble != null && wm != null) {
      try {
        wm.removeView(bubble);
      } catch (Exception ignored) {
      }
      bubble = null;
    }
  }
}
