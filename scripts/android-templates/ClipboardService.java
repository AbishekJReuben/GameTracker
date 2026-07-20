package __PACKAGE__;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
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
import android.net.Uri;
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
import androidx.core.content.FileProvider;
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
  /** Service action: a content URI for an image the user just picked via the
   *  {@code ClipboardPickActivity} proxy (services can't open the photo picker
   *  themselves — no Activity result callback). Reads + syncs the bytes. */
  public static final String ACTION_UPLOAD_IMAGE = "__PACKAGE__.CLIP_UPLOAD_IMAGE";
  private static final String CHANNEL = "gt_clipboard";
  private static final int NOTIF_ID = 0x6C69; // "li"
  // Keep a large backlog so the full history is browsable in the dock (lazy-rendered
  // on scroll — see renderLimit). Text rows are cheap; images are kept as small
  // downscaled thumbnails (see thumbs), so memory stays bounded even at this size.
  private static final int MAX_ITEMS = 300;
  // How many rows to render at once; grows as the user scrolls (see dock scroll
  // listener) so a 300-item history doesn't inflate hundreds of views up front.
  private static final int RENDER_PAGE = 30;
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
    boolean pinned;      // toggled by the pin button / relay pin notices
    boolean pendingDelete; // armed by a first tap on ✕ (two-tap confirm)
    String mime = "image/png"; // for images (used when sharing)
    ClipEntry(String id, String kind, String text, long createdAtMs, String deviceId) {
      this.id = id;
      this.kind = kind;
      this.text = text;
      this.createdAtMs = createdAtMs;
      this.deviceId = deviceId;
    }
  }
  private final ArrayList<ClipEntry> items = new ArrayList<>();

  /** Keep `items` in display order: pinned first, then newest→oldest by timestamp.
   *  Called after every insert so the latest clip is ALWAYS at the top even when
   *  async image thumbnails or catch-up replays arrive out of order (the old code
   *  relied on insertion order, which let a late-decoding image or a racing notice
   *  land mid-list). Caller holds `this`. */
  private void sortItemsLocked() {
    java.util.Collections.sort(items, (a, b) -> {
      if (a.pinned != b.pinned) return a.pinned ? -1 : 1;
      return Long.compare(b.createdAtMs, a.createdAtMs);
    });
  }

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
    // A gallery upload coming in from ClipboardPickActivity — handle it before the
    // usual connect cycle so the bytes are read + sent even if config is unchanged.
    if (ACTION_UPLOAD_IMAGE.equals(action) && intent != null) {
      final Uri uri = (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (uri != null) handleUploadImage(uri);
    }
    startSync();
    return START_STICKY;
  }

  /** Read the picked image's bytes (granting ourselves read access via the
   *  ContentResolver) and forward them through the same encrypt+upload path the
   *  clipboard-paste button uses. Runs on a background thread (ContentResolver
   *  reads + encrypt are blocking). Best-effort. */
  private void handleUploadImage(Uri uri) {
    final ContentResolver cr = getContentResolver();
    try {
      // Hand the URI read permission forward to ourselves (the picker Activity
      // already granted it on start, but re-flagging is harmless + future-safe).
      try {
        cr.takePersistableUriPermission(uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION);
      } catch (SecurityException ignored) {
        // Not persistable — we still have one-shot read access from the intent.
      }
      String mime = cr.getType(uri);
      if (mime == null) mime = "image/*";
      final String fmime = mime.startsWith("image/") ? mime : "image/*";
      new Thread(() -> {
        byte[] raw = readAll(uri);
        if (raw == null || raw.length == 0) {
          main.post(() -> toast("Couldn't read the image"));
          return;
        }
        sendImageItem(raw, fmime);
      }).start();
    } catch (Exception e) {
      toast("Couldn't upload image");
    }
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
      String id = v.optString("itemId", "");
      if (v.optBoolean("deleted", false)) {
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
      // A bare pin update (relay sends {t:item, itemId, pinned} with no content).
      if (!v.has("kind") && v.has("pinned")) {
        boolean pin = v.optBoolean("pinned", false);
        synchronized (this) {
          for (ClipEntry e : items) if (id.equals(e.id)) e.pinned = pin;
          sortItemsLocked();
        }
        main.post(this::refreshPanelIfOpen);
        return;
      }
      // Skip echo of native service's own items.
      String nativeDeviceId = (deviceId == null ? "" : deviceId) + "-native";
      if (nativeDeviceId.equals(v.optString("deviceId"))) return;
      long created = parseIsoMs(v.optString("createdUtc", ""));
      String dev = v.optString("deviceId", "");
      boolean pinned = v.optBoolean("pinned", false);
      if ("image".equals(v.optString("kind"))) {
        // Images render as thumbnails: fetch the ciphertext blob, decrypt, decode a
        // downscaled bitmap on the WS thread. sortItemsLocked keeps ordering right
        // even though the bitmap lands asynchronously.
        if (v.optBoolean("hasBlob", false)) {
          fetchImageThumb(id, created, dev, v.optString("mime", "image/png"), pinned);
        }
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
        ClipEntry e = new ClipEntry(id, "text", plain, created, dev);
        e.pinned = pinned;
        items.add(e);
        sortItemsLocked();
        trimItemsLocked();
      }
      main.post(this::showNewItemAttention);
      main.post(this::refreshPanelIfOpen);
    } catch (Exception ignored) {
    }
  }

  /** Evict past MAX_ITEMS (oldest, unpinned first), dropping the cached thumbnail so
   *  the bitmap cache can't outgrow the list. Pinned items are never evicted. Caller
   *  holds `this`. (items is already sorted pinned-first, newest-first.) */
  private void trimItemsLocked() {
    for (int i = items.size() - 1; i >= 0 && items.size() > MAX_ITEMS; i--) {
      if (items.get(i).pinned) continue;
      ClipEntry gone = items.remove(i);
      Bitmap b = thumbs.remove(gone.id);
      if (b != null) b.recycle();
    }
  }

  /** Download → decrypt → downscale one image blob, then insert its row. Runs on the
   *  OkHttp callback thread (already a background thread). Best-effort. */
  private void fetchImageThumb(String id, long created, String dev, String mime, boolean pinned) {
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
              ClipEntry e = new ClipEntry(id, "image", null, created, dev);
              e.pinned = pinned;
              e.mime = mime == null ? "image/png" : mime;
              items.add(e);
              sortItemsLocked();
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

  /** Parse an RFC3339/ISO-8601 UTC timestamp (e.g. 2026-07-20T10:51:50.565Z) to
   *  epoch ms. Handles the fractional-seconds form the JS/desktop sides emit AND a
   *  plain seconds form, so ordering-by-time is exact (millisecond precision matters
   *  when several clips land in the same second). Falls back to now on failure. */
  private static long parseIsoMs(String s) {
    if (s == null || s.isEmpty()) return System.currentTimeMillis();
    String t = s.replace('T', ' ');
    if (t.endsWith("Z")) t = t.substring(0, t.length() - 1);
    String[] patterns = {"yyyy-MM-dd HH:mm:ss.SSS", "yyyy-MM-dd HH:mm:ss"};
    for (String p : patterns) {
      try {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat(p, java.util.Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        f.setLenient(false);
        return f.parse(t).getTime();
      } catch (Exception ignored) {
        // try next pattern
      }
    }
    return System.currentTimeMillis();
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
              ClipEntry e = new ClipEntry(id, "image", null, parseIsoMs(now), nd);
              e.mime = mime == null ? "image/png" : mime;
              items.add(e);
              sortItemsLocked();
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

  // ---- pin / share (dock row actions) ---------------------------------------

  /** Toggle the pinned flag on a row, broadcast it to other devices, and re-sort so
   *  pinned items rise to the top. Mirrors the JS `sendPin` payload (the relay just
   *  flips + re-broadcasts; it doesn't validate). Called from the dock row's pin
   *  button. */
  private void togglePin(ClipEntry e) {
    if (e == null) return;
    final boolean nowPinned = !e.pinned;
    e.pinned = nowPinned;
    synchronized (this) {
      sortItemsLocked();
    }
    try {
      JSONObject pin = new JSONObject();
      pin.put("t", "pin");
      pin.put("itemId", e.id);
      pin.put("pinned", nowPinned);
      if (socket != null) socket.send(pin.toString());
    } catch (Exception ignored) {
    }
    refreshPanelIfOpen();
    toast(nowPinned ? "Pinned" : "Unpinned");
  }

  /** Share a row through Android's ACTION_SEND sheet. Text rows share directly; image
   *  rows re-fetch the full ciphertext blob, decrypt, write to a cache file, and
   *  share its FileProvider content:// URI (the dock only stores a downscaled
   *  thumbnail, so we have to round-trip to the relay for the full-res bytes). */
  private void shareEntry(ClipEntry e) {
    if (e == null) return;
    if ("text".equals(e.kind) && e.text != null) {
      try {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, e.text);
        send.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(Intent.createChooser(send, "Share clip").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      } catch (Exception ignored) {
        setOsClipboard(e.text);
        toast("Copied instead");
      }
      return;
    }
    if ("image".equals(e.kind)) {
      toast("Preparing image…");
      new Thread(() -> {
        File cached = fetchAndCacheFullImage(e.id, e.mime);
        main.post(() -> {
          if (cached == null) { toast("Couldn't load image"); return; }
          try {
            Uri uri = FileProvider.getUriForFile(this,
                getPackageName() + ".fileprovider", cached);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(e.mime == null ? "image/png" : e.mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(Intent.createChooser(send, "Share image").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
          } catch (Exception ignored) {
            toast("Couldn't share image");
          }
        });
      }).start();
      return;
    }
  }

  /** Fetch the full ciphertext blob for an item, decrypt it, write it to the app
   *  cache dir, and return the File (so {@link #shareEntry} can FileProvider it).
   *  Returns null on any failure. */
  private File fetchAndCacheFullImage(String id, String mime) {
    if (http == null || clipSpace.isEmpty() || httpBase.isEmpty()) return null;
    String ext = ".png";
    if (mime != null) {
      if (mime.contains("jpeg") || mime.contains("jpg")) ext = ".jpg";
      else if (mime.contains("webp")) ext = ".webp";
      else if (mime.contains("gif")) ext = ".gif";
    }
    String url = httpBase + "/clip/blob/" + clipSpace + "/" + id;
    try (Response r = http.newCall(new Request.Builder().url(url).build()).execute()) {
      if (!r.isSuccessful() || r.body() == null) return null;
      byte[] cipher = r.body().bytes();
      byte[] raw = decryptBytes(cipher);
      if (raw == null) return null;
      File out = new File(getCacheDir(), "share-" + id + ext);
      try (java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
        fos.write(raw);
      }
      return out;
    } catch (Exception ignored) {
      return null;
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
  // Filter chip: "" = all, "text", "image". Mirrors the desktop panel's All / Text /
  // Images tabs so the floating dock has the same content-type filtering.
  private String dockFilterKind = "";
  // Lazy render window: only the first N matching rows are inflated as Views; grows
  // by RENDER_PAGE as the user scrolls near the bottom so a 300-item history doesn't
  // inflate hundreds of rows up front. Reset when the filter/search changes.
  private int renderLimit = RENDER_PAGE;
  private ScrollView dockScroll;

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
        renderLimit = RENDER_PAGE; // new filter → restart from the top
        refreshPanelIfOpen();
      }
    });
    LinearLayout.LayoutParams searchLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    searchLp.topMargin = dp(8);
    root.addView(searchField, searchLp);

    // All / Text / Images filter strip — parity with the desktop panel's tabs so
    // the dock can browse by content type. Each chip resets the render window so
    // switching filter shows the top of the new set.
    root.addView(buildFilterStrip());

    // Scrollable history.
    ScrollView scroll = new ScrollView(this);
    scroll.setVerticalScrollBarEnabled(false);
    // Lazy-render: as the user approaches the bottom, grow the render window by
    // RENDER_PAGE so a 300-item history doesn't inflate hundreds of views up front.
    scroll.getViewTreeObserver().addOnScrollChangedListener(() -> {
      if (dockScroll == null || panelList == null) return;
      View child = dockScroll.getChildAt(0);
      if (child == null) return;
      int scrollY = dockScroll.getScrollY();
      int total = child.getHeight() - dockScroll.getHeight();
      // Within ~2 screen heights of the end → fetch the next page of rows.
      if (total - scrollY < dockScroll.getHeight() * 2) {
        int before = renderLimit;
        int totalItems;
        synchronized (this) {
          totalItems = countShownLocked();
        }
        if (renderLimit < totalItems) {
          renderLimit = Math.min(totalItems, renderLimit + RENDER_PAGE);
          if (renderLimit != before) refreshPanelIfOpen();
        }
      }
    });
    dockScroll = scroll;
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

  /** All / Text / Images filter strip — parity with the desktop ClipboardPanel's
   *  All/Text/Images segmented control. A tap clears the search filter too (so
   *  picking "Images" doesn't keep filtering for an unrelated search term). */
  private LinearLayout buildFilterStrip() {
    LinearLayout strip = new LinearLayout(this);
    strip.setOrientation(LinearLayout.HORIZONTAL);
    strip.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams stripLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    stripLp.topMargin = dp(6);
    strip.setLayoutParams(stripLp);
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(0x10FFFFFF);
    bg.setCornerRadius(dp(10));
    strip.setBackground(bg);
    String[] labels = {"All", "Text", "Images"};
    String[] kinds = {"", "text", "image"};
    for (int i = 0; i < labels.length; i++) {
      final String kind = kinds[i];
      Button chip = new Button(this);
      chip.setText(labels[i]);
      chip.setAllCaps(false);
      chip.setStateListAnimator(null);
      chip.setPadding(0, dp(4), 0, dp(4));
      chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
      LinearLayout.LayoutParams chipLp = new LinearLayout.LayoutParams(
          0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
      if (i > 0) chipLp.leftMargin = dp(2);
      strip.addView(chip, chipLp);
      styleFilterChip(chip, kind.equals(dockFilterKind));
      chip.setOnClickListener((v) -> {
        dockFilterKind = kind;
        renderLimit = RENDER_PAGE;
        for (int j = 0; j < strip.getChildCount(); j++) {
          View c = strip.getChildAt(j);
          if (c instanceof Button) {
            styleFilterChip((Button) c, kinds[j].equals(dockFilterKind));
          }
        }
        refreshPanelIfOpen();
      });
    }
    return strip;
  }

  private void styleFilterChip(Button b, boolean active) {
    GradientDrawable bg = new GradientDrawable();
    bg.setCornerRadius(dp(8));
    if (active) {
      bg.setColor(0xFF7C5CFF);
      b.setTextColor(Color.WHITE);
    } else {
      bg.setColor(0x00FFFFFF);
      b.setTextColor(0xFF94A3B8);
    }
    b.setBackground(bg);
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
    // Keyboard image paste (Gboard rich content): on Android 12+ the IME can hand
    // image URIs straight to the focused EditText via OnReceiveContentListener.
    // Without this, pasting an image from the keyboard does nothing in the
    // floating panel (the desktop panel has the same parity via Composer's
    // onPaste handler). Wrapped defensively — some OEM builds ship a broken impl.
    // The contract: return null when we've fully handled the payload (images),
    // or return the payload to let the EditText do its default text insert.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        composer.setOnReceiveContentListener(new String[]{"image/*"},
            (android.view.View view, android.view.ContentInfo payload) -> {
              android.content.ClipData clip = payload.getClip();
              if (clip != null && clip.getItemCount() > 0) {
                android.content.ClipDescription desc = clip.getDescription();
                if (desc != null && desc.hasMimeType("image/*")) {
                  android.content.ClipData.Item it = clip.getItemAt(0);
                  if (it != null && it.getUri() != null) {
                    handleUploadImage(it.getUri());
                    return null; // we consumed it — don't let EditText insert text
                  }
                }
              }
              return payload;
            });
      } catch (NoSuchMethodError ignored) {
        // Older runtime than the compile-time type — silently skip (the gallery +
        // clipboard-paste buttons still work).
      } catch (Throwable ignored) {
        // Some OEM builds ship a broken impl; the other two upload paths still work.
      }
    }
    wrap.addView(composer, new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

    LinearLayout actions = new LinearLayout(this);
    actions.setOrientation(LinearLayout.HORIZONTAL);
    actions.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    actionsLp.topMargin = dp(6);
    actions.setLayoutParams(actionsLp);

    // Paste from the OS clipboard (parity with the desktop composer's "Paste Image"
    // button). Best-effort — toasts guidance if there's no image on the clipboard.
    Button pasteBtn = new Button(this);
    pasteBtn.setText("📋 Paste");
    styleBtn(pasteBtn, false);
    pasteBtn.setOnClickListener((v) -> pasteImageFromClipboard());
    actions.addView(pasteBtn, new LinearLayout.LayoutParams(0, dp(34), 1f));

    // Upload button: opens the photo gallery via a transparent proxy Activity
    // (services can't get an Activity result callback). Picks an image, hands the
    // content:// URI back here via ACTION_UPLOAD_IMAGE. Full-res image sync.
    Button uploadBtn = new Button(this);
    uploadBtn.setText("🖼 Upload");
    styleBtn(uploadBtn, false);
    uploadBtn.setOnClickListener((v) -> launchImagePicker());
    LinearLayout.LayoutParams uploadLp = new LinearLayout.LayoutParams(0, dp(34), 1f);
    uploadLp.leftMargin = dp(6);
    actions.addView(uploadBtn, uploadLp);

    // Mic button (only when a Sarvam key is set — matches the desktop's gating).
    Button mic = new Button(this);
    mic.setText("🎤");
    styleBtn(mic, false);
    dockMic = mic;
    mic.setVisibility(sarvamKey != null && !sarvamKey.trim().isEmpty() ? View.VISIBLE : View.GONE);
    mic.setOnClickListener((v) -> toggleMic((Button) v));
    LinearLayout.LayoutParams micLp = new LinearLayout.LayoutParams(dp(46), dp(34));
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
        ClipEntry e = new ClipEntry(UUID.randomUUID().toString(), "text", t, System.currentTimeMillis(), nd);
        items.add(e);
        sortItemsLocked();
        trimItemsLocked();
      }
      composer.setText("");
      refreshPanelIfOpen();
      toast("Sent");
    });
    LinearLayout.LayoutParams addLp = new LinearLayout.LayoutParams(dp(64), dp(34));
    addLp.leftMargin = dp(6);
    actions.addView(addBtn, addLp);

    wrap.addView(actions);
    return wrap;
  }

  /** Launch the system photo picker (or open the gallery as a fallback on older
   *  devices) via a transparent proxy Activity — services can't receive Activity
   *  results. {@code ClipboardPickActivity} hands the picked URI back to this
   *  service as {@link #ACTION_UPLOAD_IMAGE}. */
  private void launchImagePicker() {
    try {
      Intent launch = new Intent(this, ClipboardPickActivity.class);
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivity(launch);
    } catch (Exception e) {
      toast("Couldn't open gallery");
    }
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
    dockScroll = null;
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

  /** Items that pass BOTH the search text filter and the All/Text/Images kind
   *  filter, in display order (pinned first, then newest). Caller holds `this`. */
  private ArrayList<ClipEntry> filteredLocked() {
    ArrayList<ClipEntry> out = new ArrayList<>();
    for (ClipEntry e : items) {
      if (!dockFilterKind.isEmpty() && !dockFilterKind.equals(e.kind)) continue;
      if (dockFilter.isEmpty()) { out.add(e); continue; }
      if ("text".equals(e.kind) && e.text != null
          && e.text.toLowerCase(Locale.US).contains(dockFilter)) {
        out.add(e);
      }
    }
    return out;
  }

  /** Total matching rows (used by the lazy-render scroll listener to know when to
   *  stop growing renderLimit). Caller holds `this`. */
  private int countShownLocked() {
    return filteredLocked().size();
  }

  /** Populate the list with the matching items (search + kind filter), rendering
   *  only the first {@link #renderLimit} rows so a 300-item history doesn't inflate
   *  hundreds of views up front — the scroll listener grows renderLimit as the user
   *  approaches the bottom. Text rows tap-to-copy; image rows show a thumbnail.
   *  Each row carries a Pin and a Share action (parity with the desktop panel). */
  private void renderList(LinearLayout list) {
    ArrayList<ClipEntry> snapshot;
    synchronized (this) {
      snapshot = filteredLocked();
    }
    if (snapshot.isEmpty()) {
      TextView empty = new TextView(this);
      boolean any;
      synchronized (this) { any = !items.isEmpty(); }
      empty.setText(any
          ? "No matches"
          : "Nothing here yet\nCopy on your PC and it appears here, or add something above.");
      empty.setTextColor(0xFF94A3B8);
      empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
      empty.setLineSpacing(dp(2), 1f);
      empty.setPadding(dp(8), dp(16), dp(8), dp(16));
      list.addView(empty);
      return;
    }
    long now = System.currentTimeMillis();
    final int collapsedLines = 6;
    final int limit = Math.min(renderLimit, snapshot.size());
    boolean pinnedHeaderShown = false;
    boolean dividerShown = false;
    for (int idx = 0; idx < limit; idx++) {
      final ClipEntry e = snapshot.get(idx);
      // Section labels for parity with the desktop panel's "Pinned" header + the
      // divider between pinned and the rest (items is sorted pinned-first).
      if (e.pinned && !pinnedHeaderShown) {
        list.addView(makeSectionLabel("PINNED"));
        pinnedHeaderShown = true;
      } else if (!e.pinned && pinnedHeaderShown && !dividerShown) {
        list.addView(makeSectionDivider());
        dividerShown = true;
      }
      LinearLayout row = new LinearLayout(this);
      row.setOrientation(LinearLayout.VERTICAL);
      GradientDrawable rowBg = new GradientDrawable();
      rowBg.setColor(e.pendingDelete ? 0x33EF4444 : 0x14FFFFFF);
      rowBg.setCornerRadius(dp(12));
      if (e.pinned) {
        // Subtle accent stroke so pinned rows are visibly "kept" (matches the
        // desktop panel's accent border on pinned items).
        rowBg.setStroke(dp(1), 0x557C5CFF);
      }
      if (e.pendingDelete) {
        // Red stroke on an armed delete so the two-tap confirm is visible.
        rowBg.setStroke(dp(1), 0xFFEF4444);
      }
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
        row.addView(buildMetaActionsRow(e, "Image · " + relativeTime(e.createdAtMs, now)));
        row.setOnClickListener((v) -> shareEntry(e));
        row.setOnLongClickListener((v) -> { hidePanel(); openApp(); return true; });
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

      final boolean longText = fullText.length() > 90 || fullText.indexOf('\n') >= 0;
      row.addView(buildMetaActionsRow(e,
          relativeTime(e.createdAtMs, now) + (longText ? "  ·  hold to expand" : "")));

      final boolean[] expanded = {false};
      row.setOnClickListener((v) -> {
        setOsClipboard(fullText);
        toast("Copied");
      });
      row.setOnLongClickListener((v) -> {
        expanded[0] = !expanded[0];
        body.setMaxLines(expanded[0] ? Integer.MAX_VALUE : collapsedLines);
        // Rebuild the meta row so its hint text updates ("hold to collapse" etc.).
        LinearLayout parent = (LinearLayout) v;
        if (parent.getChildCount() >= 2 && parent.getChildAt(1) instanceof LinearLayout) {
          parent.removeViewAt(1);
          parent.addView(buildMetaActionsRow(e,
              relativeTime(e.createdAtMs, now)
                  + (expanded[0] ? "  ·  hold to collapse" : (longText ? "  ·  hold to expand" : ""))),
              1);
        }
        return true;
      });
      list.addView(row, rowLp);
    }
    // Trailing "load more" hint when the window is shorter than the match set.
    if (limit < snapshot.size()) {
      TextView more = new TextView(this);
      more.setText("↓ " + (snapshot.size() - limit) + " more  ·  scroll to load");
      more.setTextColor(0xFF64748B);
      more.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
      more.setPadding(dp(8), dp(8), dp(8), dp(8));
      list.addView(more);
    }
  }

  /** The thin meta + actions row under each clip: relative time on the left, a
   *  pin toggle and a share button on the right (parity with the desktop panel's
   *  per-row Pin / Share buttons). Returns a horizontal LinearLayout. */
  private LinearLayout buildMetaActionsRow(final ClipEntry e, String metaText) {
    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER_VERTICAL);

    TextView meta = new TextView(this);
    meta.setText(metaText);
    meta.setTextColor(0xFF64748B);
    meta.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
    LinearLayout.LayoutParams metaLp = new LinearLayout.LayoutParams(
        0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    metaLp.topMargin = dp(4);
    row.addView(meta, metaLp);

    Button pin = new Button(this);
    pin.setText(e.pinned ? "📌" : "📍");
    pin.setTextColor(e.pinned ? 0xFF7C5CFF : 0xFF94A3B8);
    pin.setBackgroundColor(Color.TRANSPARENT);
    pin.setAllCaps(false);
    pin.setStateListAnimator(null);
    pin.setPadding(dp(6), dp(2), dp(6), dp(2));
    pin.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    pin.setOnClickListener((v) -> togglePin(e));
    LinearLayout.LayoutParams pinLp = new LinearLayout.LayoutParams(dp(40), dp(28));
    pinLp.leftMargin = dp(4);
    row.addView(pin, pinLp);

    Button share = new Button(this);
    share.setText("↗");
    share.setTextColor(0xFF94A3B8);
    share.setBackgroundColor(Color.TRANSPARENT);
    share.setAllCaps(false);
    share.setStateListAnimator(null);
    share.setPadding(dp(6), dp(2), dp(6), dp(2));
    share.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    share.setOnClickListener((v) -> shareEntry(e));
    LinearLayout.LayoutParams shareLp = new LinearLayout.LayoutParams(dp(36), dp(28));
    shareLp.leftMargin = dp(2);
    row.addView(share, shareLp);

    Button del = new Button(this);
    del.setText("✕");
    del.setTextColor(0xFFF87171);
    del.setBackgroundColor(Color.TRANSPARENT);
    del.setAllCaps(false);
    del.setStateListAnimator(null);
    del.setPadding(dp(6), dp(2), dp(6), dp(2));
    del.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    del.setOnClickListener((v) -> confirmDelete(e));
    LinearLayout.LayoutParams delLp = new LinearLayout.LayoutParams(dp(34), dp(28));
    delLp.leftMargin = dp(2);
    row.addView(del, delLp);
    return row;
  }

  /** Delete an item locally + broadcast the deletion to other devices (parity
   *  with the desktop panel's per-row delete). Two-tap confirm: the first tap
   *  marks the row pending (red), the second within 3s removes it. */
  private void confirmDelete(final ClipEntry e) {
    if (e == null) return;
    final boolean[] armed = new boolean[]{e.pendingDelete};
    if (!armed[0]) {
      e.pendingDelete = true;
      toast("Tap ✕ again to delete");
      refreshPanelIfOpen();
      main.postDelayed(() -> {
        if (e.pendingDelete) {
          e.pendingDelete = false;
          refreshPanelIfOpen();
        }
      }, 3000);
      return;
    }
    deleteEntry(e);
  }

  /** Remove an item from the local list + send a relay delete notice. */
  private void deleteEntry(ClipEntry e) {
    synchronized (this) {
      for (int i = items.size() - 1; i >= 0; i--) {
        if (e.id.equals(items.get(i).id)) {
          ClipEntry gone = items.remove(i);
          Bitmap b = thumbs.remove(gone.id);
          if (b != null) b.recycle();
        }
      }
    }
    try {
      JSONObject d = new JSONObject();
      d.put("t", "delete");
      d.put("itemId", e.id);
      if (socket != null) socket.send(d.toString());
    } catch (Exception ignored) {
    }
    refreshPanelIfOpen();
    toast("Deleted");
  }

  /** Small uppercase section label (e.g. "PINNED") — parity with the desktop
   *  panel's pinned-section header. */
  private TextView makeSectionLabel(String text) {
    TextView label = new TextView(this);
    label.setText(text);
    label.setTextColor(0xFF64748B);
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
    label.setTypeface(label.getTypeface(), android.graphics.Typeface.BOLD);
    label.setPadding(dp(4), dp(6), dp(4), dp(2));
    return label;
  }

  /** Thin divider between the pinned section and the rest — parity with the
   *  desktop panel's `h-px bg-white/[0.06]` divider. */
  private View makeSectionDivider() {
    View div = new View(this);
    div.setBackgroundColor(0x14FFFFFF);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, dp(1));
    lp.topMargin = dp(6);
    lp.bottomMargin = dp(4);
    div.setLayoutParams(lp);
    return div;
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
