package __PACKAGE__;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
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
 * `dataSync` type is capped at 6h/24h). Tapping the bubble opens a SMALL FLOATING
 * PANEL over whatever app you're in — recent items, decrypted natively, each tap
 * copies that item to the system clipboard (no app switch). "Open app" is the
 * secondary footer action and lands you on the in-app Clipboard screen.
 *
 * A native, push-only WebSocket stays connected when the Activity/webview is
 * destroyed, so new remote items still arrive, decrypt, and surface in the panel
 * (and in a low-priority notification). `START_STICKY` + the ClipboardBootReceiver
 * bring the service back after a kill or reboot.
 *
 * Crypto mirrors the JS (`clipboardCrypto.ts`) and desktop exactly so any device
 * can decrypt any other's items: AES-256-GCM with a key derived from the PC's
 * `remote_secret_code` via HKDF-SHA256 (salt = "gt-clipboard-v1"). Wire format is
 * `iv(12) || ciphertext+tag(16)`; text payloads are base64-encoded on the wire.
 */
public class ClipboardService extends Service {
  public static final String ACTION_START = "__PACKAGE__.CLIP_START";
  public static final String ACTION_STOP = "__PACKAGE__.CLIP_STOP";
  private static final String CHANNEL = "gt_clipboard";
  private static final int NOTIF_ID = 0x6C69; // "li"
  private static final int MAX_ITEMS = 12; // panel caps at ~8 visible; keep a few spare

  private WindowManager wm;
  private View bubble;
  private WindowManager.LayoutParams bubbleLp;
  private View panel;
  private LinearLayout panelList; // the row container inside the panel's ScrollView
  private WindowManager.LayoutParams panelLp;
  private final Handler main = new Handler(Looper.getMainLooper());
  private OkHttpClient http;
  private WebSocket socket;
  private long reconnectMs = 1000;
  private boolean stopping;
  private String deviceId = "";
  private String socketUrl = "";
  private ConnectivityManager cm;
  private ConnectivityManager.NetworkCallback netCallback;
  // Cap the reconnect backoff low: the user needs near-real-time sync (a dropped
  // link must recover within ~10s), so we never let the exponential backoff grow
  // past this. The connectivity callback also short-circuits it on network return.
  private static final long MAX_RECONNECT_MS = 8_000;

  /** Decrypted items, newest first. Synced on `this` (touched from the WS thread
   *  and read on the UI thread). Text only — image blobs are skipped in the panel
   *  (open the app to view/copy images). */
  static final class ClipEntry {
    final String id;
    final String text;
    final long createdAtMs;
    ClipEntry(String id, String text, long createdAtMs) {
      this.id = id;
      this.text = text;
      this.createdAtMs = createdAtMs;
    }
  }
  private final ArrayList<ClipEntry> items = new ArrayList<>();

  // Crypto — derived once per service start from the persisted secret.
  private SecretKey cryptoKey;

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
    deriveCryptoKey();
    showBubble();
    startSync();
    return START_STICKY;
  }

  /** Derive the AES key from the persisted secret. Mirrors clipboardCrypto.ts
   *  (HKDF-SHA256, salt = "gt-clipboard-v1", info = empty). Best-effort — if the
   *  secret is missing/invalid the panel still shows but items stay undecrypted
   *  (shown as "• Encrypted •" until the secret arrives). */
  private void deriveCryptoKey() {
    try {
      android.content.SharedPreferences p =
          getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE);
      String secret = p.getString("secret", "");
      if (secret == null || secret.isEmpty()) {
        cryptoKey = null;
        return;
      }
      byte[] ikm = secret.getBytes(StandardCharsets.UTF_8);
      byte[] salt = "gt-clipboard-v1".getBytes(StandardCharsets.UTF_8);
      byte[] prk = hmacSha256(salt, ikm);
      // HKDF-Expand: T(1) = HMAC(prk, info || 0x01) with empty info, L=32 (one block).
      byte[] info = new byte[0];
      byte[] input = new byte[info.length + 1];
      System.arraycopy(info, 0, input, 0, info.length);
      input[info.length] = 0x01;
      byte[] okm = hmacSha256(prk, input);
      cryptoKey = new SecretKeySpec(okm, 0, 32, "AES");
    } catch (Exception ignored) {
      cryptoKey = null;
    }
  }

  private static byte[] hmacSha256(byte[] key, byte[] msg) throws Exception {
    javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(msg);
  }

  /** Decrypt `iv(12) || ciphertext+tag` with AES-256-GCM. Returns null on any
   *  failure (the panel row shows a placeholder instead). */
  private String decryptText(String b64Cipher) {
    if (cryptoKey == null || b64Cipher == null) return null;
    try {
      byte[] all = android.util.Base64.decode(b64Cipher, android.util.Base64.DEFAULT);
      if (all == null || all.length < 13) return null;
      byte[] iv = new byte[12];
      System.arraycopy(all, 0, iv, 0, 12);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, cryptoKey, new GCMParameterSpec(128, iv));
      byte[] pt = c.doFinal(all, 12, all.length - 12);
      return new String(pt, StandardCharsets.UTF_8);
    } catch (Exception ignored) {
      return null;
    }
  }

  /** Encrypt text → base64(`iv(12) || ciphertext+tag`), mirroring clipboardCrypto.ts.
   *  Returns null on any failure. */
  private String encryptText(String plain) {
    if (cryptoKey == null || plain == null) return null;
    try {
      byte[] iv = new byte[12];
      new SecureRandom().nextBytes(iv);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.ENCRYPT_MODE, cryptoKey, new GCMParameterSpec(128, iv));
      byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
      byte[] out = new byte[12 + ct.length];
      System.arraycopy(iv, 0, out, 0, 12);
      System.arraycopy(ct, 0, out, 12, ct.length);
      return android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP);
    } catch (Exception ignored) {
      return null;
    }
  }

  /** Send a text item to the relay over the open WebSocket. Mirrors the JS add
   *  payload exactly (the relay upserts + broadcasts to other devices). No-op if
   *  the socket isn't open or encryption failed. */
  private void sendTextItem(String text) {
    if (socket == null || text == null || text.isEmpty()) return;
    String cipher = encryptText(text);
    if (cipher == null) return;
    String id = UUID.randomUUID().toString();
    String now = isoNow();
    try {
      JSONObject item = new JSONObject();
      item.put("itemId", id);
      item.put("deviceId", deviceId);
      item.put("deviceName", android.os.Build.MODEL);
      item.put("kind", "text");
      item.put("mime", "text/plain");
      item.put("size", text.length());
      item.put("createdUtc", now);
      item.put("pinned", false);
      item.put("textCipher", cipher);
      item.put("hasBlob", false);
      JSONObject msg = new JSONObject();
      msg.put("t", "add");
      msg.put("item", item);
      socket.send(msg.toString());
    } catch (Exception ignored) {
    }
  }

  private static String isoNow() {
    return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(new Date());
  }

  // ---- sync socket ----------------------------------------------------------

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
    registerNetworkCallback();
    connectSocket();
  }

  /** Reconnect the instant the network comes back (WiFi⇄cellular switch, tunnel
   *  re-established, airplane-mode off) instead of waiting out the backoff timer.
   *  This is what keeps background sync feeling real-time across network changes. */
  private void registerNetworkCallback() {
    if (netCallback != null) return;
    cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    if (cm == null) return;
    netCallback = new ConnectivityManager.NetworkCallback() {
      @Override public void onAvailable(Network network) {
        forceReconnect();
      }
      @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
        if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
          forceReconnect();
        }
      }
    };
    try {
      NetworkRequest req = new NetworkRequest.Builder()
          .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
          .build();
      cm.registerNetworkCallback(req, netCallback);
    } catch (Exception ignored) {
      netCallback = null;
    }
  }

  /** Drop any stale socket and reconnect now, resetting the backoff. Safe to call
   *  from the connectivity callback thread — the actual connect hops to `main`. */
  private void forceReconnect() {
    if (stopping) return;
    reconnectMs = 1000;
    main.removeCallbacks(reconnect);
    main.post(() -> {
      if (stopping) return;
      WebSocket s = socket;
      socket = null;
      if (s != null) {
        try { s.cancel(); } catch (Exception ignored) {}
      }
      connectSocket();
    });
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
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
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
      if (!"item".equals(v.optString("t"))) return;
      if (v.optBoolean("deleted", false)) {
        String id = v.optString("itemId", "");
        if (!id.isEmpty()) {
          synchronized (this) {
            for (int i = items.size() - 1; i >= 0; i--) {
              if (id.equals(items.get(i).id)) items.remove(i);
            }
          }
          main.post(this::refreshPanelIfOpen);
        }
        return;
      }
      // Skip our own items (the webview already added them locally).
      if (deviceId.equals(v.optString("deviceId"))) return;
      // Skip images (no preview in the native panel; the app shows them).
      if ("image".equals(v.optString("kind"))) {
        main.post(this::showNewItemAttention);
        return;
      }
      String cipher = v.optString("textCipher", "");
      String plain = decryptText(cipher);
      if (plain == null) return;
      String id = v.optString("itemId", "");
      long created = parseIsoMs(v.optString("createdUtc", ""));
      synchronized (this) {
        // Dedupe by id (rev-driven re-broadcasts happen).
        for (int i = items.size() - 1; i >= 0; i--) {
          if (id.equals(items.get(i).id)) items.remove(i);
        }
        items.add(0, new ClipEntry(id, plain, created));
        while (items.size() > MAX_ITEMS) items.remove(items.size() - 1);
      }
      main.post(this::showNewItemAttention);
      main.post(this::refreshPanelIfOpen);
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

  /** Parse an RFC3339/ISO-8601 timestamp to epoch ms (best-effort; 0 on failure). */
  private static long parseIsoMs(String s) {
    if (s == null || s.isEmpty()) return System.currentTimeMillis();
    try {
      // T => space; trim trailing Z so java.text ISO parsing is optional.
      String t = s.replace('T', ' ');
      if (t.endsWith("Z")) t = t.substring(0, t.length() - 1);
      java.text.SimpleDateFormat f = new java.text.SimpleDateFormat(
          "yyyy-MM-dd HH:mm:ss", java.util.Locale.US);
      f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
      return f.parse(t).getTime();
    } catch (Exception ignored) {
      return System.currentTimeMillis();
    }
  }

  // ---- foreground service / notification ------------------------------------

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
        .setContentText("Tap the bubble to view recent clips")
        .setContentIntent(pi)
        .setOngoing(true)
        .build();
  }

  private int dp(float v) {
    DisplayMetrics m = getResources().getDisplayMetrics();
    return Math.round(v * m.density);
  }

  // ---- bubble ---------------------------------------------------------------

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
    bubbleLp =
        new WindowManager.LayoutParams(
            size,
            size,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
    bubbleLp.gravity = Gravity.TOP | Gravity.START;
    bubbleLp.x = dp(12);
    bubbleLp.y = dp(120);

    view.setOnTouchListener(new DragTap());
    try {
      wm.addView(view, bubbleLp);
      bubble = view;
    } catch (Exception ignored) {
    }
  }

  /** Drag the bubble + snap to the nearest side; a tap (little movement) opens
   *  the floating mini-panel instead of launching the app. */
  private class DragTap implements View.OnTouchListener {
    private int startX, startY;
    private float touchX, touchY;
    private long downTime;
    private boolean moved;

    @Override
    public boolean onTouch(View v, MotionEvent e) {
      switch (e.getAction()) {
        case MotionEvent.ACTION_DOWN:
          startX = bubbleLp.x;
          startY = bubbleLp.y;
          touchX = e.getRawX();
          touchY = e.getRawY();
          downTime = System.currentTimeMillis();
          moved = false;
          return true;
        case MotionEvent.ACTION_MOVE:
          int dx = (int) (e.getRawX() - touchX);
          int dy = (int) (e.getRawY() - touchY);
          if (Math.abs(dx) > dp(4) || Math.abs(dy) > dp(4)) moved = true;
          bubbleLp.x = startX + dx;
          bubbleLp.y = startY + dy;
          try {
            wm.updateViewLayout(bubble, bubbleLp);
          } catch (Exception ignored) {
          }
          return true;
        case MotionEvent.ACTION_UP:
          if (!moved && System.currentTimeMillis() - downTime < 400) {
            showPanel();
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
    bubbleLp.x = (bubbleLp.x + bubble.getWidth() / 2 < m.widthPixels / 2)
        ? dp(12) : m.widthPixels - bubble.getWidth() - dp(12);
    try {
      wm.updateViewLayout(bubble, bubbleLp);
    } catch (Exception ignored) {
    }
  }

  // ---- floating mini-panel --------------------------------------------------

  /** Inflate the floating panel near the bubble. Idempotent — a tap while open
   *  just dismisses it (toggle behavior). */
  private void showPanel() {
    if (panel != null) {
      hidePanel();
      return;
    }
    if (wm == null) wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
    if (wm == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !android.provider.Settings.canDrawOverlays(this)) {
      return;
    }

    DisplayMetrics m = getResources().getDisplayMetrics();
    int widthPx = Math.min(dp(300), m.widthPixels - dp(24));
    int heightPx = Math.min(dp(420), m.heightPixels - dp(96));

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    GradientDrawable card = new GradientDrawable();
    card.setColor(0xF012151F);
    card.setCornerRadius(dp(18));
    card.setStroke(dp(1), 0x33FFFFFF);
    root.setBackground(card);
    root.setElevation(dp(10));
    root.setPadding(dp(12), dp(10), dp(12), dp(12));

    // Header.
    LinearLayout header = new LinearLayout(this);
    header.setOrientation(LinearLayout.HORIZONTAL);
    header.setGravity(Gravity.CENTER_VERTICAL);
    TextView title = new TextView(this);
    title.setText("Clipboard");
    title.setTextColor(Color.WHITE);
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
    title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
    LinearLayout titleWrap = new LinearLayout(this);
    titleWrap.setOrientation(LinearLayout.HORIZONTAL);
    titleWrap.setGravity(Gravity.CENTER_VERTICAL);
    ImageView icon = new ImageView(this);
    icon.setImageResource(getApplicationInfo().icon);
    icon.setColorFilter(0xFF22D3EE);
    LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(dp(18), dp(18));
    iconLp.rightMargin = dp(6);
    titleWrap.addView(icon, iconLp);
    titleWrap.addView(title);
    header.addView(titleWrap, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
    Button close = new Button(this);
    close.setText("✕");
    close.setTextColor(0xFF94A3B8);
    close.setBackgroundColor(Color.TRANSPARENT);
    close.setPadding(dp(8), 0, dp(2), 0);
    close.setOnClickListener((v) -> hidePanel());
    header.addView(close, new LinearLayout.LayoutParams(dp(40), dp(28)));
    root.addView(header);

    // Composer: type-to-sync. Lets you push a clip from the bubble without
    // switching apps — text is encrypted natively and sent over the WS.
    final EditText composer = new EditText(this);
    composer.setHint("Type to sync to your PC…");
    composer.setHintTextColor(0xFF64748B);
    composer.setTextColor(0xFFE2E8F0);
    composer.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    composer.setMaxLines(3);
    GradientDrawable fieldBg = new GradientDrawable();
    fieldBg.setColor(0x14FFFFFF);
    fieldBg.setCornerRadius(dp(10));
    composer.setBackground(fieldBg);
    composer.setPadding(dp(10), dp(7), dp(10), dp(7));
    LinearLayout.LayoutParams composerLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    composerLp.topMargin = dp(8);
    root.addView(composer, composerLp);

    // Send button row.
    LinearLayout sendRow = new LinearLayout(this);
    sendRow.setOrientation(LinearLayout.HORIZONTAL);
    sendRow.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams sendRowLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    sendRowLp.topMargin = dp(4);
    final Button sendBtn = new Button(this);
    sendBtn.setText("Send");
    styleBtn(sendBtn, true);
    LinearLayout.LayoutParams sendBtnLp = new LinearLayout.LayoutParams(dp(84), dp(32));
    sendBtn.setOnClickListener((v) -> {
      String t = composer.getText().toString().trim();
      if (t.isEmpty()) return;
      sendTextItem(t);
      // Optimistic local insert so the panel reflects it immediately (the
      // relay broadcasts it back to other devices; our own deviceId filter
      // prevents the webview from double-adding).
      synchronized (this) {
        items.add(0, new ClipEntry(UUID.randomUUID().toString(), t, System.currentTimeMillis()));
        while (items.size() > MAX_ITEMS) items.remove(items.size() - 1);
      }
      composer.setText("");
      refreshPanelIfOpen();
      toast("Sent");
    });
    sendRow.addView(sendBtn, sendBtnLp);
    root.addView(sendRow, sendRowLp);

    // Scrollable list of recent items.
    ScrollView scroll = new ScrollView(this);
    scroll.setVerticalScrollBarEnabled(false);
    LinearLayout list = new LinearLayout(this);
    list.setOrientation(LinearLayout.VERTICAL);
    panelList = list;
    LinearLayout.LayoutParams scrollLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
    scrollLp.topMargin = dp(6);
    scroll.addView(list);
    root.addView(scroll, scrollLp);

    // Footer: Copy last + Open app.
    LinearLayout footer = new LinearLayout(this);
    footer.setOrientation(LinearLayout.HORIZONTAL);
    footer.setGravity(Gravity.CENTER_VERTICAL);
    int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        : WindowManager.LayoutParams.TYPE_PHONE;
    panelLp = new WindowManager.LayoutParams(
        widthPx,
        heightPx,
        type,
        // NOT_FOCUSABLE would prevent the EditText from receiving keystrokes, so
        // we drop it here. WATCH_OUTSIDE_TOUCH still dismisses the panel on tap
        // outside, and NOT_TOUCH_MODAL lets the rest of the screen work.
        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT);
    panelLp.gravity = Gravity.TOP | Gravity.START;
    // Anchor next to the bubble (clamped on-screen).
    int panelX = bubbleLp.x + dp(52);
    if (panelX + widthPx > m.widthPixels - dp(8)) panelX = Math.max(dp(8), bubbleLp.x - widthPx - dp(8));
    int panelY = bubbleLp.y;
    if (panelY + heightPx > m.heightPixels - dp(8)) panelY = Math.max(dp(8), m.heightPixels - heightPx - dp(8));
    panelLp.x = panelX;
    panelLp.y = panelY;

    Button copyLast = new Button(this);
    copyLast.setText("Copy last");
    styleBtn(copyLast, true);
    copyLast.setOnClickListener((v) -> {
      String t = newestText();
      if (t == null) {
        toast("Nothing to copy yet");
        return;
      }
      setOsClipboard(t);
      toast("Copied");
    });
    footer.addView(copyLast, new LinearLayout.LayoutParams(0, dp(38), 1f));

    Button openApp = new Button(this);
    openApp.setText("Open app");
    styleBtn(openApp, false);
    LinearLayout.LayoutParams openLp = new LinearLayout.LayoutParams(0, dp(38), 1f);
    openLp.leftMargin = dp(8);
    openApp.setOnClickListener((v) -> {
      hidePanel();
      openApp();
    });
    footer.addView(openApp, openLp);

    LinearLayout.LayoutParams footerLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    footerLp.topMargin = dp(8);
    root.addView(footer, footerLp);

    // Outside-touch handler at the root: ACTION_OUTSIDE / back press dismisses.
    root.setOnTouchListener((v, ev) -> {
      if (ev.getAction() == MotionEvent.ACTION_OUTSIDE) {
        hidePanel();
        return true;
      }
      return false;
    });

    panel = root;
    try {
      wm.addView(root, panelLp);
      // Grow the panel out of the bubble's corner: pivot toward the bubble side
      // so it visually unfolds from the pin rather than popping in flat.
      final boolean panelRightOfBubble = panelX >= bubbleLp.x;
      root.setPivotX(panelRightOfBubble ? 0f : widthPx);
      root.setPivotY(dp(24));
      root.setScaleX(0.82f);
      root.setScaleY(0.82f);
      root.setAlpha(0f);
      root.animate()
          .scaleX(1f).scaleY(1f).alpha(1f)
          .setDuration(210)
          .setInterpolator(new android.view.animation.OvershootInterpolator(0.9f))
          .start();
    } catch (Exception ignored) {
      panel = null;
    }
    renderList(list);
  }

  private void hidePanel() {
    if (panel == null || wm == null) return;
    final View p = panel;
    panel = null; // clear immediately so a re-tap toggles cleanly
    panelList = null;
    p.animate()
        .scaleX(0.85f).scaleY(0.85f).alpha(0f)
        .setDuration(140)
        .setInterpolator(new android.view.animation.AccelerateInterpolator())
        .withEndAction(() -> {
          try {
            if (wm != null) wm.removeView(p);
          } catch (Exception ignored) {
          }
        })
        .start();
  }

  /** If the panel is open, rebuild its list to reflect new/deleted items. */
  private void refreshPanelIfOpen() {
    if (panel == null || panelList == null) return;
    panelList.removeAllViews();
    renderList(panelList);
  }

  /** Populate the list with the current items. Each row taps to copy. */
  private void renderList(LinearLayout list) {
    ArrayList<ClipEntry> snapshot;
    synchronized (this) {
      snapshot = new ArrayList<>(items);
    }
    if (snapshot.isEmpty()) {
      TextView empty = new TextView(this);
      empty.setText("Nothing here yet.\nCopy something on your PC and it appears here.");
      empty.setTextColor(0xFF94A3B8);
      empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
      empty.setLineSpacing(dp(2), 1f);
      empty.setPadding(dp(8), dp(16), dp(8), dp(16));
      list.addView(empty);
      return;
    }
    long now = System.currentTimeMillis();
    final int collapsedLines = 6;
    for (ClipEntry e : snapshot) {
      LinearLayout row = new LinearLayout(this);
      row.setOrientation(LinearLayout.VERTICAL);
      GradientDrawable rowBg = new GradientDrawable();
      rowBg.setColor(0x14FFFFFF);
      rowBg.setCornerRadius(dp(12));
      row.setBackground(rowBg);
      row.setPadding(dp(11), dp(9), dp(11), dp(9));
      LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
      rowLp.bottomMargin = dp(6);

      // The content is the primary element: larger, brighter, up to 6 lines.
      // The full text is always kept on the view (via a tag) so a long-press can
      // reveal it in full — nothing is lost to truncation.
      final TextView body = new TextView(this);
      final String fullText = e.text == null ? "" : e.text;
      body.setText(fullText);
      body.setTextColor(0xFFF1F5F9);
      body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
      body.setMaxLines(collapsedLines);
      body.setEllipsize(android.text.TextUtils.TruncateAt.END);
      body.setLineSpacing(dp(1), 1f);
      row.addView(body);

      // Footer: muted meta + a "long-press to expand" hint (only when clamped).
      final TextView meta = new TextView(this);
      final boolean longText = fullText.length() > 90 || fullText.indexOf('\n') >= 0;
      meta.setText(relativeTime(e.createdAtMs, now) + (longText ? "  ·  hold to expand" : ""));
      meta.setTextColor(0xFF64748B);
      meta.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
      LinearLayout.LayoutParams metaLp = new LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
      metaLp.topMargin = dp(4);
      row.addView(meta, metaLp);

      final boolean[] expanded = {false};
      row.setOnClickListener((v) -> {
        setOsClipboard(fullText);
        toast("Copied");
      });
      // Long-press toggles full content in place (no truncation), so even long
      // pastes are fully viewable without opening the app.
      row.setOnLongClickListener((v) -> {
        expanded[0] = !expanded[0];
        body.setMaxLines(expanded[0] ? Integer.MAX_VALUE : collapsedLines);
        meta.setText(relativeTime(e.createdAtMs, now)
            + (expanded[0] ? "  ·  hold to collapse" : (longText ? "  ·  hold to expand" : "")));
        return true;
      });
      list.addView(row, rowLp);
    }
  }

  private void styleBtn(Button b, boolean primary) {
    GradientDrawable bg = new GradientDrawable();
    bg.setCornerRadius(dp(10));
    if (primary) {
      bg.setColor(0xFF7C5CFF);
      b.setTextColor(Color.WHITE);
    } else {
      bg.setColor(0x1FFFFFFF);
      b.setTextColor(0xFFE2E8F0);
    }
    b.setBackground(bg);
    b.setPadding(0, 0, 0, 0);
    b.setAllCaps(false);
    b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    b.setStateListAnimator(null);
  }

  private String newestText() {
    synchronized (this) {
      for (ClipEntry e : items) {
        if (e.text != null && !e.text.isEmpty()) return e.text;
      }
    }
    return null;
  }

  private void setOsClipboard(String text) {
    try {
      ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
      if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("GameTracker", text));
    } catch (Exception ignored) {
    }
  }

  private void toast(String msg) {
    try {
      Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    } catch (Exception ignored) {
    }
  }


  private static String relativeTime(long then, long now) {
    long sec = Math.max(0, (now - then) / 1000);
    if (sec < 45) return "just now";
    if (sec < 90) return "a minute ago";
    long min = sec / 60;
    if (min < 45) return min + " minutes ago";
    if (min < 90) return "an hour ago";
    long hr = min / 60;
    if (hr < 24) return hr + " hours ago";
    long day = hr / 24;
    if (day == 1) return "yesterday";
    if (day < 7) return day + " days ago";
    return day / 7 + (day / 7 == 1 ? " week ago" : " weeks ago");
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

  /** Swiping the app out of Recents kills the task; without this the background
   *  sync would silently die after the very first pairing. Schedule a near-term
   *  restart so the service (and its socket) comes back on its own. */
  @Override
  public void onTaskRemoved(Intent rootIntent) {
    super.onTaskRemoved(rootIntent);
    if (stopping) return;
    try {
      Intent restart = new Intent(getApplicationContext(), ClipboardService.class);
      restart.setAction(ACTION_START);
      int flags = PendingIntent.FLAG_ONE_SHOT
          | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
      // getForegroundService uses startForegroundService semantics so the restart
      // is allowed to call startForeground() — plain startService would throw when
      // launched from the background on Android 8+.
      PendingIntent pi = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
          ? PendingIntent.getForegroundService(this, 42, restart, flags)
          : PendingIntent.getService(this, 42, restart, flags);
      AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
      if (am != null) {
        am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + 1500, pi);
      }
    } catch (Exception ignored) {
    }
  }

  @Override
  public void onDestroy() {
    super.onDestroy();
    stopping = true;
    main.removeCallbacks(reconnect);
    if (cm != null && netCallback != null) {
      try { cm.unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
    }
    netCallback = null;
    if (socket != null) socket.cancel();
    socket = null;
    if (http != null) http.dispatcher().executorService().shutdown();
    http = null;
    if (panel != null && wm != null) {
      try {
        wm.removeView(panel);
      } catch (Exception ignored) {
      }
      panel = null;
    }
    if (bubble != null && wm != null) {
      try {
        wm.removeView(bubble);
      } catch (Exception ignored) {
      }
      bubble = null;
    }
  }
}
