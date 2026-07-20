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
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaRecorder;
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
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
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
  // Keep a healthy backlog so old history is browsable in the dock (was 12, which
  // made "old history can't be viewed"). Text rows are cheap; images are kept as
  // small downscaled thumbnails (see thumbs), so memory stays bounded.
  private static final int MAX_ITEMS = 100;
  // Longest edge (px) of a decoded image thumbnail — keeps the dock light even
  // with many images. Full images are viewed by opening the app.
  private static final int THUMB_MAX_PX = 240;

  /** Process-wide singleton handle so the webview can pull the native service's
   *  state (recent items + connection status) without a round-trip through the
   *  relay. The service sets this on its first onStartCommand and clears it in
   *  onDestroy. Accessed via {@link ClipboardBridge#snapshot(Context)}. */
  private static volatile ClipboardService INSTANCE;

  private WindowManager wm;
  private View bubble; // the flat edge pin (mostly off-screen until swiped in)
  private WindowManager.LayoutParams bubbleLp;
  private View panel;
  private LinearLayout panelList; // the row container inside the panel's ScrollView
  private TextView panelStatusText; // status label in floating panel header
  private boolean socketConnected;
  private WindowManager.LayoutParams panelLp;
  // Which screen edge the pin/dock lives on. The dock slides in from this side.
  private boolean pinOnRight = true;
  private final Handler main = new Handler(Looper.getMainLooper());
  private OkHttpClient http;
  private WebSocket socket;
  private long reconnectMs = 1000;
  private boolean stopping;
  private String deviceId = "";
  private String socketUrl = "";
  private String clipSpace = ""; // clipId derived from the secret (for blob URLs)
  private String httpBase = ""; // https base for /clip/blob fetches
  private String sarvamKey = ""; // voice-to-text key (from prefs; may be empty)
  private ConnectivityManager cm;
  private ConnectivityManager.NetworkCallback netCallback;
  // Decoded image thumbnails, keyed by item id. Bounded by MAX_ITEMS eviction.
  private final HashMap<String, Bitmap> thumbs = new HashMap<>();
  // Native voice capture (dock mic).
  private MediaRecorder recorder;
  private File audioFile;
  private boolean recording;
  // Cap the reconnect backoff low: the user needs near-real-time sync (a dropped
  // link must recover within ~10s), so we never let the exponential backoff grow
  // past this. The connectivity callback also short-circuits it on network return.
  private static final long MAX_RECONNECT_MS = 8_000;

  private String getSyncStatusText() {
    if (cryptoKey == null) return "Set key in app";
    if (!socketConnected) return "Connecting.";
    java.util.HashSet<String> devs = new java.util.HashSet<>();
    synchronized (this) {
      for (ClipEntry e : items) {
        if (e.deviceId != null && !e.deviceId.isEmpty()) devs.add(e.deviceId);
      }
    }
    int count = devs.size();
    if (count > 0) return "Synced \u00B7 " + count + " device" + (count == 1 ? "" : "s");
    return "Synced";
  }

  private int getSyncStatusColor() {
    if (cryptoKey == null) return 0xFF94A3B8;
    if (socketConnected) return 0xFF34D399;
    return 0xFFFBBF24;
  }

  private void refreshStatusIfOpen() {
    if (panelStatusText != null) {
      panelStatusText.setText(getSyncStatusText());
      panelStatusText.setTextColor(getSyncStatusColor());
    }
  }

  /** Decrypted items, newest first. Synced on `this` (touched from the WS thread
   *  and read on the UI thread). `kind` is "text" or "image"; image rows carry a
   *  downscaled thumbnail in {@link #thumbs} keyed by id (text is null for them). */
  static final class ClipEntry {
    final String id;
    final String kind;
    final String text;
    final long createdAtMs;
    final String deviceId;
    ClipEntry(String id, String kind, String text, long createdAtMs, String deviceId) {
      this.id = id;
      this.kind = kind;
      this.text = text;
      this.createdAtMs = createdAtMs;
      this.deviceId = deviceId;
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
    INSTANCE = this;
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
        main.post(this::refreshStatusIfOpen);
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
    main.post(this::refreshStatusIfOpen);
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

  /** Decrypt raw `iv(12) || ciphertext+tag` bytes (image blobs) with AES-256-GCM.
   *  Returns null on any failure. Mirrors clipboardCrypto.ts decryptBytes. */
  private byte[] decryptBytes(byte[] all) {
    if (cryptoKey == null || all == null || all.length < 13) return null;
    try {
      byte[] iv = new byte[12];
      System.arraycopy(all, 0, iv, 0, 12);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, cryptoKey, new GCMParameterSpec(128, iv));
      return c.doFinal(all, 12, all.length - 12);
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
    String nativeDeviceId = (deviceId == null ? "" : deviceId) + "-native";
    try {
      JSONObject item = new JSONObject();
      item.put("itemId", id);
      item.put("deviceId", nativeDeviceId);
      item.put("deviceName", android.os.Build.MODEL + " (Overlay)");
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

  /** Keep one idle push socket alive. History/decryption stays lazy in the UI.
   *  Called from every onStartCommand — the webview re-invokes startService
   *  whenever it learns the secret, so this must APPLY config changes: if the
   *  computed socket URL differs from the live socket's (new secret/relay, or we
   *  started unconfigured and the config just arrived), drop the old socket and
   *  reconnect with the new one instead of silently keeping the stale session. */
  private void startSync() {
    android.content.SharedPreferences p =
        getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE);
    String secret = p.getString("secret", "");
    deviceId = p.getString("deviceId", "");
    String base = p.getString("signalUrl", "");
    sarvamKey = p.getString("sarvamKey", "");
    if (sarvamKey == null) sarvamKey = "";
    main.post(this::refreshComposerIfOpen); // reflect a key change in the mic button
    if (secret == null || secret.isEmpty() || base == null || base.isEmpty()) {
      // Unconfigured (first boot before pairing). Keep the service alive; the
      // webview will call startService again with real prefs and we re-enter here.
      main.post(this::refreshStatusIfOpen);
      return;
    }
    String newUrl;
    try {
      while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
      clipSpace = clipId(secret);
      httpBase = base.replaceFirst("^ws", "http");
      newUrl = base + "/clip/ws?clip=" + clipSpace
          + "&device=" + android.net.Uri.encode(deviceId + "-native");
    } catch (Exception ignored) {
      return;
    }
    stopping = false;
    boolean urlChanged = !newUrl.equals(socketUrl);
    socketUrl = newUrl;
    if (http == null) {
      http = new OkHttpClient.Builder()
          .pingInterval(30, TimeUnit.SECONDS)
          .retryOnConnectionFailure(true)
          .build();
    }
    registerNetworkCallback();
    if (urlChanged && socket != null) {
      // Config changed under a live (or half-open) socket — replace it now.
      forceReconnect();
    } else {
      connectSocket();
    }
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
        socketConnected = true;
        main.post(ClipboardService.this::refreshStatusIfOpen);
        // Request the FULL history (since=0), not just items newer than the last
        // seen rev — otherwise the dock can't show anything copied before this
        // launch ("old history can't be viewed"). We dedupe by id and cap at
        // MAX_ITEMS, so a large history stays memory-bounded.
        ws.send("{\"t\":\"hello\",\"since\":0}");
      }

      @Override public void onMessage(WebSocket ws, String text) {
        handleNotice(text);
      }

      @Override public void onClosed(WebSocket ws, int code, String reason) {
        socket = null;
        socketConnected = false;
        main.post(ClipboardService.this::refreshStatusIfOpen);
        scheduleReconnect();
      }

      @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
        socket = null;
        socketConnected = false;
        main.post(ClipboardService.this::refreshStatusIfOpen);
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
      // Skip echo of native service's own items.
      String nativeDeviceId = (deviceId == null ? "" : deviceId) + "-native";
      if (nativeDeviceId.equals(v.optString("deviceId"))) return;
      String id = v.optString("itemId", "");
      long created = parseIsoMs(v.optString("createdUtc", ""));
      String dev = v.optString("deviceId", "");
      if ("image".equals(v.optString("kind"))) {
        // Images now render as thumbnails in the dock. Fetch the ciphertext blob,
        // decrypt, and decode a downscaled bitmap on the WS thread (already off the
        // UI thread). Insert a placeholder row immediately so ordering/history is
        // right even before the bitmap lands.
        if (v.optBoolean("hasBlob", false)) fetchImageThumb(id, created, dev);
        return;
      }
      String cipher = v.optString("textCipher", "");
      String plain = decryptText(cipher);
      if (plain == null) return;
      synchronized (this) {
        // Dedupe by id (rev-driven re-broadcasts happen).
        for (int i = items.size() - 1; i >= 0; i--) {
          if (id.equals(items.get(i).id)) items.remove(i);
        }
        items.add(0, new ClipEntry(id, "text", plain, created, dev));
        trimItemsLocked();
      }
      main.post(this::showNewItemAttention);
      main.post(this::refreshPanelIfOpen);
    } catch (Exception ignored) {
    }
  }

  /** Evict past MAX_ITEMS, dropping any cached thumbnail for removed image rows so
   *  the bitmap cache can't outgrow the list. Caller holds `this`. */
  private void trimItemsLocked() {
    while (items.size() > MAX_ITEMS) {
      ClipEntry gone = items.remove(items.size() - 1);
      Bitmap b = thumbs.remove(gone.id);
      if (b != null) b.recycle();
    }
  }

  /** Download → decrypt → downscale one image blob, then insert its row. Runs on the
   *  OkHttp callback thread (already a background thread). Best-effort. */
  private void fetchImageThumb(String id, long created, String dev) {
    if (http == null || clipSpace.isEmpty() || httpBase.isEmpty()) return;
    // Already have it? Just make sure the row exists.
    synchronized (this) {
      if (thumbs.containsKey(id)) return;
    }
    String url = httpBase + "/clip/blob/" + clipSpace + "/" + id;
    try {
      http.newCall(new Request.Builder().url(url).build()).enqueue(new okhttp3.Callback() {
        @Override public void onFailure(okhttp3.Call call, java.io.IOException e) { }
        @Override public void onResponse(okhttp3.Call call, Response resp) {
          try (Response r = resp) {
            if (!r.isSuccessful() || r.body() == null) return;
            byte[] cipher = r.body().bytes();
            byte[] raw = decryptBytes(cipher);
            if (raw == null) return;
            Bitmap bmp = decodeThumb(raw);
            if (bmp == null) return;
            synchronized (ClipboardService.this) {
              for (int i = items.size() - 1; i >= 0; i--) {
                if (id.equals(items.get(i).id)) items.remove(i);
              }
              thumbs.put(id, bmp);
              items.add(0, new ClipEntry(id, "image", null, created, dev));
              trimItemsLocked();
            }
            main.post(ClipboardService.this::showNewItemAttention);
            main.post(ClipboardService.this::refreshPanelIfOpen);
          } catch (Exception ignored) {
          }
        }
      });
    } catch (Exception ignored) {
    }
  }

  /** Decode raw image bytes to a thumbnail no larger than THUMB_MAX_PX per edge. */
  private static Bitmap decodeThumb(byte[] raw) {
    try {
      BitmapFactory.Options bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
      int sample = 1;
      int longest = Math.max(bounds.outWidth, bounds.outHeight);
      while (longest / sample > THUMB_MAX_PX) sample *= 2;
      BitmapFactory.Options opts = new BitmapFactory.Options();
      opts.inSampleSize = sample;
      return BitmapFactory.decodeByteArray(raw, 0, raw.length, opts);
    } catch (Exception e) {
      return null;
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

  // ---- images (dock) --------------------------------------------------------

  /** Encrypt raw bytes → `iv(12) || ciphertext+tag`, mirroring clipboardCrypto.ts
   *  encryptBytes. Returns null on failure. */
  private byte[] encryptBytes(byte[] raw) {
    if (cryptoKey == null || raw == null) return null;
    try {
      byte[] iv = new byte[12];
      new SecureRandom().nextBytes(iv);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.ENCRYPT_MODE, cryptoKey, new GCMParameterSpec(128, iv));
      byte[] ct = c.doFinal(raw);
      byte[] out = new byte[12 + ct.length];
      System.arraycopy(iv, 0, out, 0, 12);
      System.arraycopy(ct, 0, out, 12, ct.length);
      return out;
    } catch (Exception ignored) {
      return null;
    }
  }

  /** Read an image the OS clipboard currently holds (Android grants clipboard reads
   *  while an app/overlay of ours is in the foreground) and sync it. Best-effort:
   *  toasts guidance if the clipboard has no image. */
  private void pasteImageFromClipboard() {
    try {
      ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
      if (cm == null || !cm.hasPrimaryClip()) { toast("Copy an image first, then tap ＋ Image"); return; }
      ClipData clip = cm.getPrimaryClip();
      if (clip == null || clip.getItemCount() == 0) { toast("Copy an image first"); return; }
      android.net.Uri uri = clip.getItemAt(0).getUri();
      if (uri == null) { toast("No image on the clipboard"); return; }
      String mime = getContentResolver().getType(uri);
      if (mime == null || !mime.startsWith("image/")) { toast("Clipboard isn't an image"); return; }
      final String fmime = mime;
      byte[] raw = readAll(uri);
      if (raw == null || raw.length == 0) { toast("Couldn't read the image"); return; }
      sendImageItem(raw, fmime);
    } catch (Exception e) {
      toast("Couldn't paste image");
    }
  }

  private byte[] readAll(android.net.Uri uri) {
    try (java.io.InputStream in = getContentResolver().openInputStream(uri)) {
      if (in == null) return null;
      java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[16384];
      int n;
      while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
      return bos.toByteArray();
    } catch (Exception e) {
      return null;
    }
  }

  /** Encrypt + upload an image blob, then broadcast an `add` over the WS. Inserts an
   *  optimistic local thumbnail row so the dock reflects it at once. */
  private void sendImageItem(byte[] raw, String mime) {
    if (socket == null || cryptoKey == null || clipSpace.isEmpty() || httpBase.isEmpty()) {
      toast("Not connected yet"); return;
    }
    final byte[] cipher = encryptBytes(raw);
    if (cipher == null) { toast("Encrypt failed"); return; }
    final String id = UUID.randomUUID().toString();
    final String now = isoNow();
    final String nd = (deviceId == null ? "" : deviceId) + "-native";
    final Bitmap thumb = decodeThumb(raw);
    final int size = raw.length;
    // Upload the blob first (HTTP), then announce it (WS).
    try {
      RequestBody body = RequestBody.create(MediaType.parse("application/octet-stream"), cipher);
      Request put = new Request.Builder()
          .url(httpBase + "/clip/blob/" + clipSpace + "/" + id)
          .put(body).build();
      http.newCall(put).enqueue(new okhttp3.Callback() {
        @Override public void onFailure(okhttp3.Call call, java.io.IOException e) {
          main.post(() -> toast("Image upload failed"));
        }
        @Override public void onResponse(okhttp3.Call call, Response resp) {
          try (Response r = resp) {
            if (!r.isSuccessful()) { main.post(() -> toast("Image upload failed")); return; }
            JSONObject item = new JSONObject();
            item.put("itemId", id);
            item.put("deviceId", nd);
            item.put("deviceName", android.os.Build.MODEL + " (Overlay)");
            item.put("kind", "image");
            item.put("mime", mime);
            item.put("size", size);
            item.put("createdUtc", now);
            item.put("pinned", false);
            item.put("hasBlob", true);
            JSONObject msg = new JSONObject();
            msg.put("t", "add");
            msg.put("item", item);
            if (socket != null) socket.send(msg.toString());
            synchronized (ClipboardService.this) {
              if (thumb != null) thumbs.put(id, thumb);
              items.add(0, new ClipEntry(id, "image", null, parseIsoMs(now), nd));
              trimItemsLocked();
            }
            main.post(() -> { toast("Image sent"); refreshPanelIfOpen(); });
          } catch (Exception ignored) {
          }
        }
      });
    } catch (Exception e) {
      toast("Image upload failed");
    }
  }

  // ---- voice to text (dock mic) ---------------------------------------------

  /** Toggle native recording. First tap records (MediaRecorder → m4a); second tap
   *  stops and transcribes via Sarvam, appending the result to the composer. Needs
   *  RECORD_AUDIO — if not granted, routes the user to the app to grant it. */
  private void toggleMic(Button micBtn) {
    if (recording) { stopRecordingAndTranscribe(micBtn); return; }
    if (sarvamKey == null || sarvamKey.trim().isEmpty()) { toast("Add a Sarvam key in Settings"); return; }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
        && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
      toast("Grant microphone access in the app, then try again");
      openApp();
      return;
    }
    try {
      audioFile = new File(getCacheDir(), "gt-clip-voice.m4a");
      recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
          ? new MediaRecorder(this) : new MediaRecorder();
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
      recorder.setAudioSamplingRate(16000);
      recorder.setOutputFile(audioFile.getAbsolutePath());
      recorder.prepare();
      recorder.start();
      recording = true;
      micBtn.setText("■ Stop");
      toast("Recording… tap to stop");
    } catch (Exception e) {
      recording = false;
      safeReleaseRecorder();
      toast("Mic unavailable");
    }
  }

  private void stopRecordingAndTranscribe(Button micBtn) {
    recording = false;
    micBtn.setText("… transcribing");
    try {
      if (recorder != null) { recorder.stop(); }
    } catch (Exception ignored) {
    }
    safeReleaseRecorder();
    final File f = audioFile;
    final EditText composer = dockComposer;
    if (f == null || !f.exists() || http == null) {
      micBtn.setText("🎤 Speak");
      return;
    }
    new Thread(() -> {
      String text = transcribeViaSarvam(f);
      main.post(() -> {
        if (dockMic instanceof Button) ((Button) dockMic).setText("🎤 Speak");
        if (text != null && !text.isEmpty() && composer != null) {
          String cur = composer.getText().toString();
          composer.setText(cur.isEmpty() ? text : cur + " " + text);
          composer.setSelection(composer.getText().length());
        } else if (text == null) {
          toast("Transcription failed");
        }
      });
    }).start();
  }

  /** POST the recorded clip to Sarvam STT (multipart), returning the transcript
   *  (empty string if none, null on error). Mirrors the desktop/companion path. */
  private String transcribeViaSarvam(File f) {
    try {
      byte[] audio = readAll(android.net.Uri.fromFile(f));
      if (audio == null) return null;
      MultipartBody.Builder mb = new MultipartBody.Builder().setType(MultipartBody.FORM)
          .addFormDataPart("model", "saaras:v3")
          .addFormDataPart("mode", "transcribe")
          .addFormDataPart("file", "audio.m4a",
              RequestBody.create(MediaType.parse("audio/mp4"), audio));
      Request req = new Request.Builder()
          .url("https://api.sarvam.ai/speech-to-text")
          .addHeader("api-subscription-key", sarvamKey.trim())
          .post(mb.build()).build();
      try (Response r = http.newCall(req).execute()) {
        if (!r.isSuccessful() || r.body() == null) return null;
        JSONObject j = new JSONObject(r.body().string());
        return j.optString("transcript", "");
      }
    } catch (Exception e) {
      return null;
    }
  }

  private void safeReleaseRecorder() {
    try {
      if (recorder != null) recorder.release();
    } catch (Exception ignored) {
    }
    recorder = null;
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

  // ---- edge pin -------------------------------------------------------------

  /** The pin is a flat, slim tab hugging a screen edge — deliberately unobtrusive
   *  (a sliver of the app's accent) until you swipe inward from it (or tap it),
   *  which slides the dock in from that edge. Vertical drags reposition it along
   *  the edge; a horizontal drag toward the centre opens the dock. */
  private void showBubble() {
    if (bubble != null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !android.provider.Settings.canDrawOverlays(this)) {
      return; // no overlay permission — the FGS still runs; pin appears once granted
    }
    wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
    if (wm == null) return;
    // Restore the remembered side + vertical position.
    android.content.SharedPreferences p =
        getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE);
    pinOnRight = p.getBoolean("pinRight", true);

    View view = new View(this);
    styleEdgePin(view);

    int type =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
    bubbleLp =
        new WindowManager.LayoutParams(
            dp(14), // slim: only a little of it shows
            dp(72),
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
    bubbleLp.gravity = Gravity.TOP | Gravity.START;
    DisplayMetrics m = getResources().getDisplayMetrics();
    bubbleLp.x = pinOnRight ? m.widthPixels - dp(14) : 0;
    bubbleLp.y = p.getInt("pinY", dp(160));

    view.setOnTouchListener(new DragTap());
    try {
      wm.addView(view, bubbleLp);
      bubble = view;
    } catch (Exception ignored) {
    }
  }

  /** Flat rounded tab, rounded only on the inner side, low-opacity accent. */
  private void styleEdgePin(View view) {
    GradientDrawable bg = new GradientDrawable();
    bg.setColors(new int[] {0xE07C5CFF, 0xE022D3EE});
    bg.setOrientation(GradientDrawable.Orientation.TOP_BOTTOM);
    float r = dp(7);
    // Round the edge facing the screen centre; keep the outer edge flush/square.
    bg.setCornerRadii(pinOnRight
        ? new float[] {r, r, 0, 0, 0, 0, r, r}   // round left side
        : new float[] {0, 0, r, r, r, r, 0, 0}); // round right side
    view.setBackground(bg);
    view.setElevation(dp(4));
    view.setAlpha(0.9f);
  }

  /** Drag the pin along the edge (vertical), or swipe inward to open the dock. A
   *  plain tap also opens it. Crossing to the other half of the screen re-homes the
   *  pin to that edge. */
  private class DragTap implements View.OnTouchListener {
    private int startX, startY;
    private float touchX, touchY;
    private long downTime;
    private boolean moved;
    private boolean opened;

    @Override
    public boolean onTouch(View v, MotionEvent e) {
      DisplayMetrics m = getResources().getDisplayMetrics();
      switch (e.getAction()) {
        case MotionEvent.ACTION_DOWN:
          startX = bubbleLp.x;
          startY = bubbleLp.y;
          touchX = e.getRawX();
          touchY = e.getRawY();
          downTime = System.currentTimeMillis();
          moved = false;
          opened = false;
          v.animate().alpha(1f).scaleX(1.15f).setDuration(120).start();
          return true;
        case MotionEvent.ACTION_MOVE: {
          int dx = (int) (e.getRawX() - touchX);
          int dy = (int) (e.getRawY() - touchY);
          if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved = true;
          // A decisive inward swipe opens the dock (right pin → swipe left, and
          // vice-versa). Only fire once per gesture.
          boolean inward = pinOnRight ? dx < -dp(28) : dx > dp(28);
          if (!opened && inward && Math.abs(dx) > Math.abs(dy)) {
            opened = true;
            showPanel();
            return true;
          }
          // Otherwise slide vertically along the edge (x stays pinned to the side).
          bubbleLp.y = Math.max(0, Math.min(m.heightPixels - dp(72), startY + dy));
          try {
            wm.updateViewLayout(bubble, bubbleLp);
          } catch (Exception ignored) {
          }
          return true;
        }
        case MotionEvent.ACTION_UP:
        case MotionEvent.ACTION_CANCEL:
          v.animate().alpha(0.9f).scaleX(1f).setDuration(160).start();
          if (opened) return true;
          if (!moved && System.currentTimeMillis() - downTime < 400) {
            showPanel();
          } else {
            settlePin();
          }
          return true;
        default:
          return false;
      }
    }
  }

  /** Persist the pin's side + vertical position after a drag. (Side only changes
   *  via the dock's "flip side" affordance; a vertical drag just saves Y.) */
  private void settlePin() {
    try {
      getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
          .edit().putBoolean("pinRight", pinOnRight).putInt("pinY", bubbleLp.y).apply();
    } catch (Exception ignored) {
    }
  }

  // ---- side dock ------------------------------------------------------------

  private EditText dockComposer; // live handle so the mic can append transcripts
  private View dockMic;          // shown only when a Sarvam key is configured
  private String dockFilter = ""; // native search text

  /** Slide the dock in from the pin's edge. Full-height, translucent-frosted, with
   *  the same features as the app screen: compose (text + image + mic), search,
   *  history (text + image thumbnails), copy-last, open-app. Idempotent (toggles). */
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
    final int widthPx = Math.min(dp(340), m.widthPixels - dp(40));
    final int heightPx = m.heightPixels;

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    GradientDrawable card = new GradientDrawable();
    // Translucent frosted fill (not fully transparent) so text stays readable over
    // whatever app is behind. Rounded only on the inner edge (it hugs a screen side).
    card.setColor(0xF00B0E17);
    float r = dp(22);
    card.setCornerRadii(pinOnRight
        ? new float[] {r, r, 0, 0, 0, 0, r, r}
        : new float[] {0, 0, r, r, r, r, 0, 0});
    card.setStroke(dp(1), 0x24FFFFFF);
    root.setBackground(card);
    root.setElevation(dp(16));
    root.setPadding(dp(14), dp(14), dp(14), dp(14));

    root.addView(buildDockHeader());
    root.addView(buildDockComposer());

    // Search box (parity with the app screen's history filter).
    final EditText searchField = new EditText(this);
    searchField.setHint("Search history");
    searchField.setHintTextColor(0xFF64748B);
    searchField.setTextColor(0xFFE2E8F0);
    searchField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    searchField.setSingleLine(true);
    GradientDrawable sBg = new GradientDrawable();
    sBg.setColor(0x14FFFFFF);
    sBg.setCornerRadius(dp(10));
    searchField.setBackground(sBg);
    searchField.setPadding(dp(10), dp(6), dp(10), dp(6));
    searchField.addTextChangedListener(new android.text.TextWatcher() {
      @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
      @Override public void onTextChanged(CharSequence s, int a, int b, int c) {}
      @Override public void afterTextChanged(android.text.Editable s) {
        dockFilter = s.toString().trim().toLowerCase(Locale.US);
        refreshPanelIfOpen();
      }
    });
    LinearLayout.LayoutParams searchLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    searchLp.topMargin = dp(8);
    root.addView(searchField, searchLp);

    // Scrollable history.
    ScrollView scroll = new ScrollView(this);
    scroll.setVerticalScrollBarEnabled(false);
    LinearLayout list = new LinearLayout(this);
    list.setOrientation(LinearLayout.VERTICAL);
    panelList = list;
    LinearLayout.LayoutParams scrollLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
    scrollLp.topMargin = dp(8);
    scroll.addView(list);
    root.addView(scroll, scrollLp);

    root.addView(buildDockFooter());

    int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        : WindowManager.LayoutParams.TYPE_PHONE;
    panelLp = new WindowManager.LayoutParams(
        widthPx,
        heightPx,
        type,
        // Drop NOT_FOCUSABLE so the composer/search EditTexts receive keystrokes;
        // WATCH_OUTSIDE_TOUCH dismisses on an outside tap.
        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT);
    panelLp.gravity = Gravity.TOP | (pinOnRight ? Gravity.END : Gravity.START);
    panelLp.x = 0;
    panelLp.y = 0;

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
      // Slide in from the pinned edge.
      root.setTranslationX(pinOnRight ? widthPx : -widthPx);
      root.setAlpha(0.4f);
      root.animate()
          .translationX(0f).alpha(1f)
          .setDuration(240)
          .setInterpolator(new android.view.animation.DecelerateInterpolator(1.6f))
          .start();
    } catch (Exception ignored) {
      panel = null;
    }
    renderList(list);
  }

  /** Header: app icon, title, live sync status, flip-side + close controls. */
  private LinearLayout buildDockHeader() {
    LinearLayout header = new LinearLayout(this);
    header.setOrientation(LinearLayout.HORIZONTAL);
    header.setGravity(Gravity.CENTER_VERTICAL);

    ImageView icon = new ImageView(this);
    icon.setImageResource(getApplicationInfo().icon);
    icon.setColorFilter(0xFF22D3EE);
    LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(dp(20), dp(20));
    iconLp.rightMargin = dp(8);
    header.addView(icon, iconLp);

    TextView title = new TextView(this);
    title.setText("Clipboard");
    title.setTextColor(Color.WHITE);
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
    title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);

    TextView statusView = new TextView(this);
    statusView.setText(getSyncStatusText());
    statusView.setTextColor(getSyncStatusColor());
    statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
    panelStatusText = statusView;

    LinearLayout titleWrap = new LinearLayout(this);
    titleWrap.setOrientation(LinearLayout.VERTICAL);
    titleWrap.addView(title);
    titleWrap.addView(statusView);
    header.addView(titleWrap, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

    // Flip the dock to the other edge.
    Button flip = new Button(this);
    flip.setText(pinOnRight ? "⇤" : "⇥");
    flip.setTextColor(0xFF94A3B8);
    flip.setBackgroundColor(Color.TRANSPARENT);
    flip.setAllCaps(false);
    flip.setStateListAnimator(null);
    flip.setPadding(0, 0, 0, 0);
    flip.setOnClickListener((v) -> flipSide());
    header.addView(flip, new LinearLayout.LayoutParams(dp(36), dp(30)));

    Button close = new Button(this);
    close.setText("✕");
    close.setTextColor(0xFF94A3B8);
    close.setBackgroundColor(Color.TRANSPARENT);
    close.setAllCaps(false);
    close.setStateListAnimator(null);
    close.setPadding(dp(6), 0, 0, 0);
    close.setOnClickListener((v) -> hidePanel());
    header.addView(close, new LinearLayout.LayoutParams(dp(36), dp(30)));
    return header;
  }

  /** Composer row: text field + image button + mic (key-gated) + Add. */
  private LinearLayout buildDockComposer() {
    LinearLayout wrap = new LinearLayout(this);
    wrap.setOrientation(LinearLayout.VERTICAL);
    LinearLayout.LayoutParams wrapLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    wrapLp.topMargin = dp(10);
    wrap.setLayoutParams(wrapLp);

    final EditText composer = new EditText(this);
    dockComposer = composer;
    composer.setHint("Type or dictate…");
    composer.setHintTextColor(0xFF64748B);
    composer.setTextColor(0xFFE2E8F0);
    composer.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    composer.setMaxLines(3);
    GradientDrawable fieldBg = new GradientDrawable();
    fieldBg.setColor(0x14FFFFFF);
    fieldBg.setCornerRadius(dp(10));
    composer.setBackground(fieldBg);
    composer.setPadding(dp(10), dp(8), dp(10), dp(8));
    wrap.addView(composer, new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

    LinearLayout actions = new LinearLayout(this);
    actions.setOrientation(LinearLayout.HORIZONTAL);
    actions.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    actionsLp.topMargin = dp(6);
    actions.setLayoutParams(actionsLp);

    // Image button: pushes an image the OS clipboard currently holds.
    Button imgBtn = new Button(this);
    imgBtn.setText("＋ Image");
    styleBtn(imgBtn, false);
    imgBtn.setOnClickListener((v) -> pasteImageFromClipboard());
    actions.addView(imgBtn, new LinearLayout.LayoutParams(0, dp(34), 1f));

    // Mic button (only when a Sarvam key is set — matches the desktop's gating).
    Button mic = new Button(this);
    mic.setText("🎤 Speak");
    styleBtn(mic, false);
    dockMic = mic;
    mic.setVisibility(sarvamKey != null && !sarvamKey.trim().isEmpty() ? View.VISIBLE : View.GONE);
    mic.setOnClickListener((v) -> toggleMic((Button) v));
    LinearLayout.LayoutParams micLp = new LinearLayout.LayoutParams(0, dp(34), 1f);
    micLp.leftMargin = dp(6);
    actions.addView(mic, micLp);

    Button addBtn = new Button(this);
    addBtn.setText("Add");
    styleBtn(addBtn, true);
    addBtn.setOnClickListener((v) -> {
      String t = composer.getText().toString().trim();
      if (t.isEmpty()) return;
      sendTextItem(t);
      synchronized (this) {
        String nd = (deviceId == null ? "" : deviceId) + "-native";
        items.add(0, new ClipEntry(UUID.randomUUID().toString(), "text", t, System.currentTimeMillis(), nd));
        trimItemsLocked();
      }
      composer.setText("");
      refreshPanelIfOpen();
      toast("Sent");
    });
    LinearLayout.LayoutParams addLp = new LinearLayout.LayoutParams(dp(72), dp(34));
    addLp.leftMargin = dp(6);
    actions.addView(addBtn, addLp);

    wrap.addView(actions);
    return wrap;
  }

  /** Footer: copy the newest text + open the full app. */
  private LinearLayout buildDockFooter() {
    LinearLayout footer = new LinearLayout(this);
    footer.setOrientation(LinearLayout.HORIZONTAL);
    footer.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams footerLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    footerLp.topMargin = dp(10);
    footer.setLayoutParams(footerLp);

    Button copyLast = new Button(this);
    copyLast.setText("Copy last");
    styleBtn(copyLast, true);
    copyLast.setOnClickListener((v) -> {
      String t = newestText();
      if (t == null) { toast("Nothing to copy yet"); return; }
      setOsClipboard(t);
      toast("Copied");
    });
    footer.addView(copyLast, new LinearLayout.LayoutParams(0, dp(38), 1f));

    Button openApp = new Button(this);
    openApp.setText("Open app");
    styleBtn(openApp, false);
    LinearLayout.LayoutParams openLp = new LinearLayout.LayoutParams(0, dp(38), 1f);
    openLp.leftMargin = dp(8);
    openApp.setOnClickListener((v) -> { hidePanel(); openApp(); });
    footer.addView(openApp, openLp);
    return footer;
  }

  /** Move the dock (and pin) to the opposite edge, remembering the choice. */
  private void flipSide() {
    pinOnRight = !pinOnRight;
    settlePin();
    if (bubble != null && bubbleLp != null) {
      DisplayMetrics m = getResources().getDisplayMetrics();
      styleEdgePin(bubble);
      bubbleLp.x = pinOnRight ? m.widthPixels - dp(14) : 0;
      try { wm.updateViewLayout(bubble, bubbleLp); } catch (Exception ignored) {}
    }
    // Re-open on the new side.
    hidePanel();
    main.postDelayed(this::showPanel, 180);
  }

  private void hidePanel() {
    if (panel == null || wm == null) return;
    final View p = panel;
    panel = null; // clear immediately so a re-tap toggles cleanly
    panelList = null;
    panelStatusText = null;
    dockComposer = null;
    dockMic = null;
    final boolean right = pinOnRight;
    final int w = p.getWidth();
    p.animate()
        .translationX(right ? w : -w).alpha(0.3f)
        .setDuration(160)
        .setInterpolator(new android.view.animation.AccelerateInterpolator())
        .withEndAction(() -> {
          try {
            if (wm != null) wm.removeView(p);
          } catch (Exception ignored) {
          }
        })
        .start();
  }

  /** If the panel is open, rebuild its list to reflect new/deleted/filtered items. */
  private void refreshPanelIfOpen() {
    if (panel == null || panelList == null) return;
    panelList.removeAllViews();
    renderList(panelList);
  }

  /** If the composer is open, reflect a Sarvam-key change (mic visibility). */
  private void refreshComposerIfOpen() {
    if (dockMic != null) {
      dockMic.setVisibility(sarvamKey != null && !sarvamKey.trim().isEmpty() ? View.VISIBLE : View.GONE);
    }
  }

  /** Populate the list with current items (filtered). Text rows tap-to-copy; image
   *  rows show a thumbnail and open the app for full-res copy/view. */
  private void renderList(LinearLayout list) {
    ArrayList<ClipEntry> snapshot;
    synchronized (this) {
      snapshot = new ArrayList<>(items);
    }
    ArrayList<ClipEntry> shown = new ArrayList<>();
    for (ClipEntry e : snapshot) {
      if (dockFilter.isEmpty()) { shown.add(e); continue; }
      if ("text".equals(e.kind) && e.text != null && e.text.toLowerCase(Locale.US).contains(dockFilter)) {
        shown.add(e);
      }
    }
    if (shown.isEmpty()) {
      TextView empty = new TextView(this);
      empty.setText(snapshot.isEmpty()
          ? "Nothing here yet\nCopy on your PC and it appears here, or add something above."
          : "No matches");
      empty.setTextColor(0xFF94A3B8);
      empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
      empty.setLineSpacing(dp(2), 1f);
      empty.setPadding(dp(8), dp(16), dp(8), dp(16));
      list.addView(empty);
      return;
    }
    long now = System.currentTimeMillis();
    final int collapsedLines = 6;
    for (ClipEntry e : shown) {
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

      if ("image".equals(e.kind)) {
        Bitmap bmp;
        synchronized (this) { bmp = thumbs.get(e.id); }
        ImageView iv = new ImageView(this);
        iv.setAdjustViewBounds(true);
        iv.setMaxHeight(dp(160));
        iv.setScaleType(ImageView.ScaleType.FIT_START);
        if (bmp != null) iv.setImageBitmap(bmp);
        row.addView(iv, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        TextView meta = new TextView(this);
        meta.setText("Image · " + relativeTime(e.createdAtMs, now) + "  ·  tap to open");
        meta.setTextColor(0xFF64748B);
        meta.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        LinearLayout.LayoutParams metaLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        metaLp.topMargin = dp(4);
        row.addView(meta, metaLp);
        row.setOnClickListener((v) -> { hidePanel(); openApp(); });
        list.addView(row, rowLp);
        continue;
      }

      final TextView body = new TextView(this);
      final String fullText = e.text == null ? "" : e.text;
      body.setText(fullText);
      body.setTextColor(0xFFF1F5F9);
      body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
      body.setMaxLines(collapsedLines);
      body.setEllipsize(android.text.TextUtils.TruncateAt.END);
      body.setLineSpacing(dp(1), 1f);
      row.addView(body);

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

  /** JSON snapshot of the service state for the webview (and diagnostics).
   *  Shape: { running, connected, hasKey, socketUrl, reconnectMs, items: [{id, text, createdAtMs}] }.
   *  Lets the webview seed its history instantly on open (no relay round-trip)
   *  and surface one unified "is sync working" status. Static so it can be
   *  called from {@link ClipboardBridge#snapshot} even before any instance. */
  public static String snapshot() {
    ClipboardService s = INSTANCE;
    org.json.JSONObject o = new org.json.JSONObject();
    try {
      o.put("running", s != null);
      if (s == null) return o.toString();
      o.put("connected", s.socketConnected);
      o.put("hasKey", s.cryptoKey != null);
      o.put("reconnectMs", s.reconnectMs);
      // Don't leak the full URL (it carries the clip id hash, which is also the
      // relay-space key — exposing it would weaken the E2E story). Host only.
      String url = s.socketUrl == null ? "" : s.socketUrl;
      int q = url.indexOf('?');
      o.put("relayHost", q > 0 ? url.substring(0, q) : url);
      org.json.JSONArray arr = new org.json.JSONArray();
      ArrayList<ClipEntry> snap;
      synchronized (s) {
        snap = new ArrayList<>(s.items);
      }
      for (ClipEntry e : snap) {
        // Only text seeds the webview instantly (images stream from the relay with
        // their blobs); skip image rows so the webview doesn't show empty entries.
        if (!"text".equals(e.kind) || e.text == null) continue;
        org.json.JSONObject it = new org.json.JSONObject();
        it.put("id", e.id);
        it.put("text", e.text);
        it.put("createdAtMs", e.createdAtMs);
        arr.put(it);
      }
      o.put("items", arr);
    } catch (Exception ignored) {
    }
    return o.toString();
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
    INSTANCE = null;
    main.removeCallbacks(reconnect);
    if (cm != null && netCallback != null) {
      try { cm.unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
    }
    netCallback = null;
    if (recording) { try { if (recorder != null) recorder.stop(); } catch (Exception ignored) {} }
    recording = false;
    safeReleaseRecorder();
    synchronized (this) {
      for (Bitmap b : thumbs.values()) { if (b != null) b.recycle(); }
      thumbs.clear();
    }
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
