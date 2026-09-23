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
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.BitmapDrawable;
import android.media.MediaRecorder;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.IBinder;
import android.os.SystemClock;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.method.LinkMovementMethod;
import android.text.style.BackgroundColorSpan;
import android.text.style.ClickableSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.text.style.UnderlineSpan;
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
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
public class ClipboardService extends Service implements NotesDockHost {
  private static final Pattern HTTP_LINK = Pattern.compile("https?://[^\\s<>()]+", Pattern.CASE_INSENSITIVE);
  /** Recognized TLDs, so a bare host (amazon.in/dp/…) previews but a file name
   *  (main.rs) or a version (3.9.81) does not. Mirrors the web client's list. */
  private static final String TLDS =
      "com|in|org|net|io|gg|dev|app|co|me|ai|tv|xyz|uk|us|edu|gov|info|biz|online|site|shop|store|cloud|page|link|live|news|blog|game|games|gl|ly|be|to|sh|fm|so|it|de|fr|jp|au|ca|nl|se|no|es|br|ru|cn|pl|ch|at|dk|fi|ie|nz|za|kr|tw|hk|sg|ae|id|my|ph|th|vn|pk|bd|lk|np";
  private static final Pattern BARE_LINK = Pattern.compile(
      "(?<![\\w@./-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:" + TLDS + "))(?![a-z])(?:[:/?#][^\\s<>()]*)?",
      Pattern.CASE_INSENSITIVE);
  public static final String ACTION_START = "__PACKAGE__.CLIP_START";
  public static final String ACTION_STOP = "__PACKAGE__.CLIP_STOP";
  /** Service action: a content URI for an image the user just picked via the
   *  {@code ClipboardPickActivity} proxy (services can't open the photo picker
   *  themselves — no Activity result callback). Reads + syncs the bytes. */
  public static final String ACTION_UPLOAD_IMAGE = "__PACKAGE__.CLIP_UPLOAD_IMAGE";
  /** Open the Notes dock over whatever is on screen (Quick Settings tile, the
   *  notification). Routed through NotesDockActivity so the shade collapses. */
  public static final String ACTION_SHOW_DOCK = "__PACKAGE__.CLIP_SHOW_DOCK";
  /** Re-read the edge-handle preference (the tile was just added). */
  public static final String ACTION_EDGE_HANDLE = "__PACKAGE__.CLIP_EDGE_HANDLE";
  /** Pref: draw the always-on edge handle. Unset = on; adding the Quick Settings
   *  tile switches it off (the tile is the screenshot-free way in). */
  public static final String PREF_EDGE_HANDLE = "edgeHandle";
  private static final String CHANNEL = "gt_clipboard";
  private static final int NOTIF_ID = 0x6C69; // "li"
  // Keep a large backlog so the full history is browsable in the dock (lazy-rendered
  // lazily by the Compose list). Text rows are cheap; images are kept as small
  // downscaled thumbnails (see thumbs), so memory stays bounded even at this size.
  private static final int MAX_ITEMS = 300;
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
  /** The Compose dock (NotesDock.kt). Created on first open, kept for the
   *  service's life so reopening is an addView, not a rebuild. */
  private NotesDock dock;
  private volatile boolean socketConnected;
  // Which screen edge the pin/dock lives on. The dock slides in from this side.
  private boolean pinOnRight = true;
  private final Handler main = new Handler(Looper.getMainLooper());
  private OkHttpClient http;
  private volatile WebSocket socket;
  private final java.util.concurrent.ExecutorService syncWorker =
      java.util.concurrent.Executors.newSingleThreadExecutor();
  private final java.util.concurrent.ExecutorService contentWorker =
      java.util.concurrent.Executors.newSingleThreadExecutor();
  private long lastRevision; // memory cursor only: a fresh process still loads full history
  private long replayRevision;
  private boolean replaying;
  private long reconnectMs = 1000;
  private volatile boolean stopping;
  private String deviceId = "";
  private String socketUrl = "";
  private String clipSpace = ""; // clipId derived from the secret (for blob URLs)
  private String httpBase = ""; // https base for /clip/blob fetches
  private String sarvamKey = ""; // voice-to-text key (from prefs; may be empty)
  private ConnectivityManager cm;
  private ConnectivityManager.NetworkCallback netCallback;
  private final ClipboardNetworkState networkState = new ClipboardNetworkState();
  // Decoded image thumbnails, keyed by item id. Bounded by MAX_ITEMS eviction.
  private final HashMap<String, Bitmap> thumbs = new HashMap<>();
  // The dock rebuilds rows frequently; cache preview metadata and coalesce
  // requests so refreshes cannot create endless loading requests.
  private final HashMap<String, LinkPreviewInfo> linkPreviewCache = new HashMap<>();
  private final HashSet<String> linkPreviewLoading = new HashSet<>();
  /** Decoded card artwork by image URL, so re-binding a row never re-downloads. */
  private final HashMap<String, Bitmap> linkArtCache = new HashMap<>();
  // Native voice capture (dock mic).
  private MediaRecorder recorder;
  private File audioFile;
  private boolean recording;
  // Reconnect backoff: fast (≤8s) for the first few attempts so a blip recovers
  // near-instantly, then escalating to 5 min for a host that stays unreachable
  // (PC asleep / tunnel down). The old flat 8s cap woke the radio ~7×/min forever
  // — the single biggest battery cost while backgrounded. The connectivity
  // callback and the screen-on receiver reset to fast the moment either fires.
  private static final long MAX_RECONNECT_FAST_MS = 8_000;
  private static final long MAX_RECONNECT_SLOW_MS = 300_000;
  private static final int FAST_ATTEMPTS = 6;
  private int reconnectFails;
  private android.content.BroadcastReceiver screenOnReceiver;

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

  private boolean lastTileConnected;

  private void refreshStatusIfOpen() {
    refreshPanelIfOpen();
    // The Quick Settings tile shows the sync state as its subtitle; nudge it only
    // when that state actually flips (requestListeningState is a binder call).
    boolean connected = socketConnected && cryptoKey != null;
    if (connected != lastTileConnected) {
      lastTileConnected = connected;
      try {
        android.service.quicksettings.TileService.requestListeningState(this,
            new android.content.ComponentName(this, NotesTileService.class));
      } catch (Exception ignored) {
      }
    }
  }

  /** Tile subtitle / state, readable without an instance. */
  static boolean isRunning() {
    return INSTANCE != null;
  }

  static String tileSubtitle() {
    ClipboardService s = INSTANCE;
    return s == null ? "Off" : s.getSyncStatusText();
  }

  /** Decrypted items, newest first. Synced on `this` (touched from the WS thread
   *  and read on the UI thread). `kind` is "text" or "image"; image rows carry a
   *  downscaled thumbnail in {@link #thumbs} keyed by id (text is null for them). */
  static final class ClipEntry {
    final String id;
    final String kind;
    String text;         // editable (notes) — updated in place by edits
    volatile Content content = PLAIN;
    volatile String classifiedText;
    String classifyingText;
    // A save/edit is a meaningful touch, so it gets a fresh timestamp and moves
    // this entry to the top on every device.
    long createdAtMs;
    final String deviceId;
    boolean pinned;      // toggled by the pin button / relay pin notices
    String folder = "";  // folder/list label ("" = unfiled)
    final ArrayList<String> tags = new ArrayList<>();
    String mime = "image/png"; // for images (used when sharing)
    String deviceName = "";    // relay's deviceName ("SENGALPC", "Pixel 8 (Overlay)")
    ClipEntry(String id, String kind, String text, long createdAtMs, String deviceId) {
      this.id = id;
      this.kind = kind;
      this.text = text;
      this.createdAtMs = createdAtMs;
      this.deviceId = deviceId;
    }
  }

  /** Cached native link-card metadata. Kept deliberately small: card artwork is
   * fetched separately and may legitimately be unavailable on privacy-focused sites. */
  static final class LinkPreviewInfo {
    final String title;
    final String description;
    final String image;
    final String host;
    /** True when {@link #image} came from og:image/twitter:image (or a known
     *  provider thumbnail) and therefore deserves the full-width hero slot. A
     *  favicon is not artwork — it goes in the small slot beside the title. */
    final boolean hero;
    LinkPreviewInfo(String title, String description, String image, String host, boolean hero) {
      this.title = title; this.description = description; this.image = image; this.host = host; this.hero = hero;
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
    if (ACTION_STOP.equals(action) || !ClipboardBridge.backgroundEnabled(this)) {
      stopping = true;
      stopSelf();
      return START_NOT_STICKY;
    }
    INSTANCE = this;
    startForegroundNotif();
    trackOwnForeground();
    if (ACTION_EDGE_HANDLE.equals(action) && !edgeHandleEnabled()) removeBubble();
    showBubble();
    if (ACTION_SHOW_DOCK.equals(action)) main.post(this::showDock);
    // A gallery upload coming in from ClipboardPickActivity — handle it before the
    // usual connect cycle so the bytes are read + sent even if config is unchanged.
    final Uri upload = ACTION_UPLOAD_IMAGE.equals(action) && intent != null
        ? (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM) : null;
    runSync(() -> {
      deriveCryptoKey();
      startSync();
      if (upload != null && !stopping) handleUploadImage(upload);
    });
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

  /** Send a text item (new or edited) to the relay over the open WebSocket.
   *  Mirrors the JS add payload exactly (the relay upserts by id + broadcasts to
   *  other devices; created_utc is preserved server-side on an edit). The caller
   *  supplies the id/timestamp so the LOCAL entry and the wire item are the same
   *  element on every device. No-op if the socket isn't open or encryption failed. */
  private void sendTextItem(String id, String text, String createdUtc, ArrayList<String> tags,
      boolean pinned) {
    if (socket == null || text == null || text.isEmpty()) return;
    String cipher = encryptText(text);
    if (cipher == null) return;
    String nativeDeviceId = (deviceId == null ? "" : deviceId) + "-native";
    try {
      JSONObject item = new JSONObject();
      item.put("itemId", id);
      item.put("deviceId", nativeDeviceId);
      item.put("deviceName", android.os.Build.MODEL + " (Overlay)");
      item.put("kind", "text");
      item.put("mime", "text/plain");
      item.put("size", text.length());
      item.put("createdUtc", createdUtc);
      item.put("pinned", pinned);
      item.put("tags", new org.json.JSONArray(tags == null ? new ArrayList<>() : tags));
      item.put("folder", tags == null || tags.isEmpty() ? "" : tags.get(0));
      item.put("textCipher", cipher);
      item.put("hasBlob", false);
      JSONObject msg = new JSONObject();
      msg.put("t", "add");
      msg.put("item", item);
      socket.send(msg.toString());
    } catch (Exception ignored) {
    }
  }

  private static ArrayList<String> tagsFrom(JSONObject value) {
    ArrayList<String> out = new ArrayList<>();
    org.json.JSONArray arr = value.optJSONArray("tags");
    if (arr != null) {
      for (int i = 0; i < arr.length(); i++) {
        String tag = arr.optString(i, "").trim();
        boolean duplicate = false;
        for (String existing : out) if (existing.equalsIgnoreCase(tag)) duplicate = true;
        if (!tag.isEmpty() && !duplicate) out.add(tag);
      }
    }
    String legacy = value.optString("folder", "").trim();
    if (out.isEmpty() && !legacy.isEmpty()) out.add(legacy);
    return out;
  }

  private static boolean hasTag(ClipEntry entry, String tag) {
    if (entry == null || tag == null) return false;
    for (String value : entry.tags) if (value.equalsIgnoreCase(tag)) return true;
    return false;
  }

  /** RFC3339 UTC with millisecond precision + literal Z — the ONE wire shape all
   *  clients emit. The old version formatted in LOCAL time but appended 'Z',
   *  which put every dock-sent item hours off and broke cross-device ordering. */
  private static String isoNow() {
    return isoFromMs(System.currentTimeMillis());
  }

  private static String isoFromMs(long ms) {
    SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    return f.format(new Date(ms));
  }

  // ---- sync socket ----------------------------------------------------------

  private void runSync(Runnable work) {
    if (stopping) return;
    try { syncWorker.execute(() -> { if (!stopping) work.run(); }); }
    catch (java.util.concurrent.RejectedExecutionException ignored) { }
  }

  /** Keep one idle push socket alive. History/decryption stays lazy in the UI.
   *  Called from every onStartCommand — the webview re-invokes startService
   *  whenever it learns the secret, so this must APPLY config changes: if the
   *  computed socket URL differs from the live socket's (new secret/relay, or we
   *  started unconfigured and the config just arrived), drop the old socket and
   *  reconnect with the new one instead of silently keeping the stale session. */
  private void startSync() {
    if (stopping) return;
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
    boolean urlChanged = !newUrl.equals(socketUrl);
    if (urlChanged) {
      lastRevision = 0;
      synchronized (this) { items.clear(); thumbs.clear(); }
    }
    socketUrl = newUrl;
    if (http == null) {
      // 90s pings: Cloudflare drops idle WS at ~100s, so this is the least-
      // frequent keep-alive that still holds the tunnel — 3× fewer radio wakes
      // than the old 30s.
      http = new OkHttpClient.Builder()
          .pingInterval(90, TimeUnit.SECONDS)
          .retryOnConnectionFailure(true)
          .build();
    }
    registerNetworkCallback();
    registerScreenOnReceiver();
    if (urlChanged && socket != null) {
      // Config changed under a live (or half-open) socket — replace it now.
      reconnectNow();
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
      @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
        // Capabilities also change for bandwidth/signal strength. Only a newly
        // validated DEFAULT network should replace a working socket.
        final boolean validated = caps != null
            && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        runSync(() -> {
          if (networkState.update(network, validated, socket == null)) reconnectNow();
        });
      }
      @Override public void onLost(Network network) {
        runSync(() -> networkState.lost(network));
      }
    };
    try {
      cm.registerDefaultNetworkCallback(netCallback);
    } catch (Exception ignored) {
      netCallback = null;
    }
  }

  /** Screen-on = the user is back: snap out of the slow backoff immediately so
   *  the dock is fresh by the time they can tap it. */
  private void registerScreenOnReceiver() {
    if (screenOnReceiver != null) return;
    screenOnReceiver = new android.content.BroadcastReceiver() {
      @Override public void onReceive(Context ctx, Intent intent) {
        if (socket == null) {
          forceReconnect();
        }
      }
    };
    try {
      android.content.IntentFilter f = new android.content.IntentFilter();
      f.addAction(Intent.ACTION_SCREEN_ON);
      f.addAction(Intent.ACTION_USER_PRESENT);
      registerReceiver(screenOnReceiver, f);
    } catch (Exception ignored) {
      screenOnReceiver = null;
    }
  }

  /** Drop any stale socket and reconnect now, resetting the backoff. Safe to call
   *  from any callback thread — socket lifecycle is serialized on syncWorker. */
  private void forceReconnect() {
    runSync(this::reconnectNow);
  }

  private void reconnectNow() {
    if (stopping) return;
    reconnectMs = 1000;
    reconnectFails = 0;
    main.removeCallbacks(reconnect);
    WebSocket s = socket;
    socket = null;
    socketConnected = false;
    if (s != null) {
      try { s.cancel(); } catch (Exception ignored) {}
    }
    connectSocket();
  }

  private void connectSocket() {
    if (stopping || http == null || socketUrl.isEmpty() || socket != null) return;
    socket = http.newWebSocket(new Request.Builder().url(socketUrl).build(), new WebSocketListener() {
      @Override public void onOpen(WebSocket ws, Response response) {
        runSync(() -> {
          if (ws != socket) return;
          reconnectMs = 1000;
          reconnectFails = 0;
          socketConnected = true;
          main.post(ClipboardService.this::refreshStatusIfOpen);
          replaying = true;
          replayRevision = lastRevision;
          ws.send("{\"t\":\"hello\",\"since\":" + lastRevision + "}");
        });
      }

      @Override public void onMessage(WebSocket ws, String text) {
        runSync(() -> {
          if (ws != socket) return;
          handleNotice(text);
          try {
            JSONObject v = new JSONObject(text);
            replayRevision = Math.max(replayRevision, v.optLong("rev", 0));
            if ("synced".equals(v.optString("t"))) replaying = false;
            if (!replaying) lastRevision = Math.max(lastRevision, replayRevision);
          } catch (Exception ignored) { }
        });
      }

      @Override public void onClosed(WebSocket ws, int code, String reason) {
        runSync(() -> {
          if (ws != socket) return;
          socket = null;
          socketConnected = false;
          main.post(ClipboardService.this::refreshStatusIfOpen);
          scheduleReconnect();
        });
      }

      @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
        runSync(() -> {
          if (ws != socket) return;
          socket = null;
          socketConnected = false;
          main.post(ClipboardService.this::refreshStatusIfOpen);
          scheduleReconnect();
        });
      }
    });
  }

  private void scheduleReconnect() {
    if (stopping) return;
    reconnectFails++;
    long cap = reconnectFails <= FAST_ATTEMPTS ? MAX_RECONNECT_FAST_MS : MAX_RECONNECT_SLOW_MS;
    long delay = Math.min(reconnectMs, cap);
    reconnectMs = Math.min(reconnectMs * 2, cap);
    main.removeCallbacks(reconnect);
    main.postDelayed(reconnect, delay);
  }

  private final Runnable reconnect = () -> runSync(this::connectSocket);

  private void handleNotice(String text) {
    try {
      JSONObject v = new JSONObject(text);
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
      // A bare multi-tag update. The legacy folder mirror remains accepted below
      // so older installed companions can still interoperate during rollout.
      if (!v.has("kind") && v.has("tags")) {
        ArrayList<String> tags = tagsFrom(v);
        synchronized (this) {
          for (ClipEntry e : items) if (id.equals(e.id)) {
            e.tags.clear();
            e.tags.addAll(tags);
            e.folder = tags.isEmpty() ? "" : tags.get(0);
          }
        }
        main.post(this::refreshPanelIfOpen);
        return;
      }
      // A bare folder move ({t:item, itemId, folder} with no content).
      if (!v.has("kind") && v.has("folder")) {
        String folder = v.optString("folder", "");
        synchronized (this) {
          for (ClipEntry e : items) if (id.equals(e.id)) {
            e.folder = folder;
            e.tags.clear();
            if (!folder.isEmpty()) e.tags.add(folder);
          }
        }
        main.post(this::refreshPanelIfOpen);
        return;
      }
      // Our own items come back on every since=0 catch-up. They are NOT noise:
      // after a service restart the in-memory list is empty, and skipping them
      // meant everything ever sent from this dock vanished from it. Apply them
      // like any other item (dedupe by id keeps live echoes harmless) — just
      // don't fire the "new item" attention for our own content.
      String nativeDeviceId = (deviceId == null ? "" : deviceId) + "-native";
      boolean own = nativeDeviceId.equals(v.optString("deviceId"));
      long created = parseIsoMs(v.optString("createdUtc", ""));
      String dev = v.optString("deviceId", "");
      String devName = v.optString("deviceName", "");
      boolean pinned = v.optBoolean("pinned", false);
      String folder = v.optString("folder", "");
      ArrayList<String> tags = tagsFrom(v);
      if ("image".equals(v.optString("kind"))) {
        if (!v.optBoolean("hasBlob", false)) return;
        // Insert the row IMMEDIATELY (correct position in the list); the bitmap
        // is fetched lazily — only when the dock actually renders the row. This
        // stops every background reconnect from re-downloading image blobs
        // (the old behavior burned battery + data on each catch-up).
        boolean existed;
        synchronized (this) {
          existed = removeByIdLocked(id);
          ClipEntry e = new ClipEntry(id, "image", null, created, dev);
          e.deviceName = devName;
          e.pinned = pinned;
          e.folder = folder;
          e.tags.addAll(tags);
          e.mime = v.optString("mime", "image/png");
          items.add(e);
          sortItemsLocked();
          trimItemsLocked();
        }
        if (!replaying && !own && !existed) main.post(this::showNewItemAttention);
        main.post(this::refreshPanelIfOpen);
        return;
      }
      String cipher = v.optString("textCipher", "");
      String plain = decryptText(cipher);
      if (plain == null) return;
      boolean existed;
      synchronized (this) {
        // Dedupe by id (rev-driven re-broadcasts + edits happen).
        existed = removeByIdLocked(id);
        ClipEntry e = new ClipEntry(id, "text", plain, created, dev);
        e.deviceName = devName;
        e.pinned = pinned;
        e.folder = folder;
        e.tags.addAll(tags);
        items.add(e);
        sortItemsLocked();
        trimItemsLocked();
      }
      if (!replaying && !own && !existed) main.post(this::showNewItemAttention);
      main.post(this::refreshPanelIfOpen);
    } catch (Exception ignored) {
    }
  }

  /** Remove any entry with this id (and its cached thumb is kept — same image).
   *  Returns true when one existed. Caller holds `this`. */
  private boolean removeByIdLocked(String id) {
    boolean existed = false;
    for (int i = items.size() - 1; i >= 0; i--) {
      if (id.equals(items.get(i).id)) {
        items.remove(i);
        existed = true;
      }
    }
    return existed;
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

  /** Thumb downloads currently in flight (dedupe). Guarded by `this`. */
  private final java.util.HashSet<String> thumbFetching = new java.util.HashSet<>();

  /** LAZY: download → decrypt → downscale one image blob into {@link #thumbs}.
   *  Called only when the dock actually renders the row, so background catch-ups
   *  never re-download blobs. Best-effort; refreshes the panel when done. */
  private void fetchImageThumb(String id) {
    if (stopping || dock == null || !dock.isOpen() || http == null || clipSpace.isEmpty() || httpBase.isEmpty()) return;
    final String space = clipSpace;
    synchronized (this) {
      if (thumbs.containsKey(id) || !thumbFetching.add(id)) return;
    }
    String url = httpBase + "/clip/blob/" + clipSpace + "/" + id;
    try {
      http.newCall(new Request.Builder().url(url).build()).enqueue(new okhttp3.Callback() {
        @Override public void onFailure(okhttp3.Call call, java.io.IOException e) {
          synchronized (ClipboardService.this) { thumbFetching.remove(id); }
        }
        @Override public void onResponse(okhttp3.Call call, Response resp) {
          Bitmap bmp = null;
          try (Response r = resp) {
            if (r.isSuccessful() && r.body() != null) {
              byte[] raw = decryptBytes(r.body().bytes());
              if (raw != null) bmp = decodeThumb(raw);
            }
          } catch (Exception ignored) {
          }
          synchronized (ClipboardService.this) {
            thumbFetching.remove(id);
            if (bmp != null && !stopping && space.equals(clipSpace)) thumbs.put(id, bmp);
          }
          if (bmp != null && !stopping) main.post(ClipboardService.this::refreshPanelIfOpen);
        }
      });
    } catch (Exception ignored) {
      synchronized (this) { thumbFetching.remove(id); }
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
        .setContentTitle("New shared note")
        .setContentText("Open Notes to view and copy it")
        .setContentIntent(dockPendingIntent())
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

  /** Parse an RFC3339/ISO-8601 timestamp to epoch ms. Handles EVERY shape the
   *  fleet has ever emitted: 'Z' or '±HH:MM'/'±HHMM' offsets (chrono's
   *  to_rfc3339 ends in "+00:00" — the old parser rejected those, every desktop
   *  item fell back to "now", and the dock's ordering scrambled on each replay),
   *  plus any fractional-second precision (0–9 digits, normalized to millis).
   *  Falls back to now only when nothing parses. */
  private static long parseIsoMs(String s) {
    if (s == null || s.isEmpty()) return System.currentTimeMillis();
    try {
      String t = s.trim().replace('T', ' ');
      long offsetMs = 0;
      if (t.endsWith("Z") || t.endsWith("z")) {
        t = t.substring(0, t.length() - 1);
      } else {
        // A '+'/'-' past the date part is a zone offset (date dashes sit at 4 & 7).
        int idx = Math.max(t.lastIndexOf('+'), t.lastIndexOf('-'));
        if (idx > 10) {
          String z = t.substring(idx).replace(":", "");
          t = t.substring(0, idx);
          if (z.length() >= 5) {
            int sign = z.charAt(0) == '-' ? -1 : 1;
            int hh = Integer.parseInt(z.substring(1, 3));
            int mm = Integer.parseInt(z.substring(3, 5));
            offsetMs = sign * (hh * 3600000L + mm * 60000L);
          }
        }
      }
      // Normalize fractional seconds to exactly 3 digits.
      String frac = "000";
      int dot = t.indexOf('.');
      if (dot >= 0) {
        String f = t.substring(dot + 1).replaceAll("[^0-9]", "");
        t = t.substring(0, dot);
        frac = (f + "000").substring(0, 3);
      }
      java.text.SimpleDateFormat fmt =
          new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", java.util.Locale.US);
      fmt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
      fmt.setLenient(false);
      return fmt.parse(t + "." + frac).getTime() - offsetMs;
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

  /** The folder new items adopt: the folder currently being viewed (All → unfiled). */
  private ArrayList<String> currentComposeTags() {
    ArrayList<String> tags = new ArrayList<>();
    if (dockFolderFilter != null && !dockFolderFilter.isEmpty()) tags.add(dockFolderFilter);
    return tags;
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
    final ArrayList<String> tags = currentComposeTags();
    final String folder = tags.isEmpty() ? "" : tags.get(0);
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
            item.put("folder", folder);
            item.put("tags", new org.json.JSONArray(tags));
            item.put("hasBlob", true);
            JSONObject msg = new JSONObject();
            msg.put("t", "add");
            msg.put("item", item);
            if (socket != null) socket.send(msg.toString());
            synchronized (ClipboardService.this) {
              if (thumb != null) thumbs.put(id, thumb);
              ClipEntry e = new ClipEntry(id, "image", null, parseIsoMs(now), nd);
              e.mime = mime == null ? "image/png" : mime;
              e.folder = folder;
              e.tags.addAll(tags);
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

  /** Live built-in recognition session (keyless path). Main-thread only. */
  private android.speech.SpeechRecognizer speechRec;
  private boolean nativeListening;
  /** What the dock's mic button shows: 0 idle, 1 listening/recording, 2 transcribing. */
  private volatile int micState;

  private void setMicState(int state) {
    micState = state;
    refreshPanelIfOpen();
  }

  /** A finished transcript goes to the end of the dock's composer. */
  private void appendTranscript(String text) {
    if (text == null || text.isEmpty()) return;
    NotesDock d = dock;
    if (d != null) d.appendToComposer(text);
  }

  private boolean hasSarvamKey() {
    return sarvamKey != null && !sarvamKey.trim().isEmpty();
  }

  /** Toggle voice input. With a Sarvam key: record (m4a) → Sarvam transcribe (the
   *  keyed path, better for long dictation). Without one: the phone's BUILT-IN
   *  SpeechRecognizer, so the mic always works. Needs RECORD_AUDIO — if not
   *  granted, routes the user to the app to grant it. */
  private void toggleMic() {
    if (nativeListening) {
      // Gentle stop: let onResults/onError deliver the transcript, then clean up.
      main.post(() -> {
        try {
          if (speechRec != null) speechRec.stopListening();
        } catch (Exception ignored) {
        }
      });
      return;
    }
    if (recording) { stopRecordingAndTranscribe(); return; }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
        && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
      toast("Grant microphone access in the app, then try again");
      openApp();
      return;
    }
    if (!hasSarvamKey()) {
      startNativeStt();
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
      setMicState(1);
      toast("Recording… tap to stop");
    } catch (Exception e) {
      recording = false;
      safeReleaseRecorder();
      setMicState(0);
      toast("Mic unavailable");
    }
  }

  private void stopRecordingAndTranscribe() {
    recording = false;
    setMicState(2);
    try {
      if (recorder != null) { recorder.stop(); }
    } catch (Exception ignored) {
    }
    safeReleaseRecorder();
    final File f = audioFile;
    if (f == null || !f.exists() || http == null) {
      setMicState(0);
      return;
    }
    new Thread(() -> {
      String text = transcribeViaSarvam(f);
      main.post(() -> {
        setMicState(0);
        if (text != null && !text.isEmpty()) {
          appendTranscript(text);
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

  /** Built-in (on-device / Google) speech recognition — the keyless voice path.
   *  Appends the final transcript to the composer, same as the Sarvam flow. */
  private void startNativeStt() {
    main.post(() -> {
      try {
        if (!android.speech.SpeechRecognizer.isRecognitionAvailable(this)) {
          toast("No speech engine on this phone — add a Sarvam key in Settings");
          return;
        }
        // Inline cleanup of any stale session (must NOT go through stopNativeStt —
        // its posted runnable would land after this one and undo the fresh state).
        try {
          if (speechRec != null) speechRec.destroy();
        } catch (Exception ignored) {
        }
        speechRec = null;
        speechRec = android.speech.SpeechRecognizer.createSpeechRecognizer(this);
        Intent intent = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(android.speech.RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        speechRec.setRecognitionListener(new android.speech.RecognitionListener() {
          @Override public void onReadyForSpeech(android.os.Bundle params) {}
          @Override public void onBeginningOfSpeech() {}
          @Override public void onRmsChanged(float rmsdB) {}
          @Override public void onBufferReceived(byte[] buffer) {}
          @Override public void onEndOfSpeech() {
            setMicState(2);
          }
          @Override public void onError(int error) {
            boolean noSpeech = error == android.speech.SpeechRecognizer.ERROR_NO_MATCH
                || error == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
            if (!noSpeech) toast("Speech recognition failed (" + error + ")");
            else toast("Didn't catch that — try again");
            finishNativeStt();
          }
          @Override public void onResults(android.os.Bundle results) {
            ArrayList<String> out = results == null ? null
                : results.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
            if (out != null && !out.isEmpty()) appendTranscript(out.get(0));
            finishNativeStt();
          }
          @Override public void onPartialResults(android.os.Bundle partialResults) {}
          @Override public void onEvent(int eventType, android.os.Bundle params) {}
        });
        nativeListening = true;
        setMicState(1);
        speechRec.startListening(intent);
        toast("Listening…");
      } catch (Exception e) {
        finishNativeStt();
        toast("Mic unavailable");
      }
    });
  }

  private void finishNativeStt() {
    nativeListening = false;
    setMicState(0);
    try {
      if (speechRec != null) speechRec.destroy();
    } catch (Exception ignored) {
    }
    speechRec = null;
  }

  /** Hard-stop + tear down the built-in recognizer (service destroy / restart). */
  private void stopNativeStt() {
    main.post(() -> {
      try {
        if (speechRec != null) speechRec.cancel();
      } catch (Exception ignored) {
      }
      finishNativeStt();
    });
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
        new NotificationChannel(CHANNEL, "Shared notes", NotificationManager.IMPORTANCE_MIN);
    ch.setShowBadge(false);
    nm.createNotificationChannel(ch);
  }

  private Notification buildNotification() {
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent appPi = open == null ? null : PendingIntent.getActivity(this, 0, open, piFlags);

    Notification.Builder b =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this);
    b.setSmallIcon(getApplicationInfo().icon)
        .setContentTitle("Shared notes")
        .setContentText("Tap to open Notes — or use the Quick Settings tile")
        // Tapping the notification opens the dock itself (via the trampoline, so
        // the shade collapses) rather than the whole app.
        .setContentIntent(dockPendingIntent())
        .setOngoing(true);
    if (appPi != null) {
      b.addAction(new Notification.Action.Builder(
          android.graphics.drawable.Icon.createWithResource(this, getApplicationInfo().icon),
          "Open app", appPi).build());
    }
    return b.build();
  }

  /** Opens the dock over the current app and collapses the notification shade
   *  (an Activity PendingIntent does; a Service one leaves the shade covering
   *  the dock). */
  private PendingIntent dockPendingIntent() {
    Intent i = new Intent(this, NotesDockActivity.class);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION
        | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT
        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
    return PendingIntent.getActivity(this, 7, i, flags);
  }

  // Density captured once at first use; getResources().getDisplayMetrics() is a
  // lookup the dock called ~100x per render. Density never changes for a live
  // service (we don't support config changes on the overlay), so cache it.
  private float density = -1f;
  private int dp(float v) {
    if (density < 0f) density = getResources().getDisplayMetrics().density;
    return Math.round(v * density);
  }

  // ---- edge pin -------------------------------------------------------------

  // The pin's touchable View is wide (PIN_TOUCH_W) but only paints a slim outer
  // sliver (PIN_VISIBLE_W) — bigger hit area, same unobtrusive look. Taller than
  // before too, so it's easier to grab.
  private static final int PIN_TOUCH_W = 32;
  private static final int PIN_VISIBLE_W = 13;
  private static final int PIN_HEIGHT = 112;

  /** The pin is a flat, slim tab hugging a screen edge — deliberately unobtrusive
   *  (a sliver of the app's accent) until you swipe inward from it (or tap it),
   *  which slides the dock in from that edge. Vertical drags reposition it along
   *  the edge; a horizontal drag toward the centre opens the dock. */
  private void showBubble() {
    if (bubble != null) return;
    if (!edgeHandleEnabled()) return; // Quick Settings tile / notification only
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
            dp(PIN_TOUCH_W), // wide touch target; only a slim sliver is painted
            dp(PIN_HEIGHT),
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
    bubbleLp.gravity = Gravity.TOP | Gravity.START;
    DisplayMetrics m = getResources().getDisplayMetrics();
    bubbleLp.x = pinOnRight ? m.widthPixels - dp(PIN_TOUCH_W) : 0;
    bubbleLp.y = p.getInt("pinY", dp(160));

    view.setOnTouchListener(new DragTap());
    try {
      wm.addView(view, bubbleLp);
      bubble = view;
    } catch (Exception ignored) {
    }
    addFullscreenProbe();
  }

  // ---- fullscreen detection (hide the pin over games / fullscreen video) -----

  /** Invisible 1px overlay whose window insets track the system bars: when the
   *  foreground app goes immersive-fullscreen (game, video player) the status
   *  bar hides, this probe's insets go to zero, and we hide the pin so nothing
   *  floats over the content. It returns the moment the bars come back. */
  private View fsProbe;
  private boolean hiddenForFullscreen;

  private void addFullscreenProbe() {
    if (fsProbe != null || wm == null) return;
    try {
      View probe = new View(this);
      int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
          ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
          : WindowManager.LayoutParams.TYPE_PHONE;
      WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
          1,
          WindowManager.LayoutParams.MATCH_PARENT,
          type,
          WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
              | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
              | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
          PixelFormat.TRANSLUCENT);
      lp.gravity = Gravity.TOP | Gravity.START;
      probe.setOnApplyWindowInsetsListener((v, insets) -> {
        boolean fullscreen;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          fullscreen = !insets.isVisible(android.view.WindowInsets.Type.statusBars());
        } else {
          fullscreen = insets.getSystemWindowInsetTop() == 0;
        }
        setHiddenForFullscreen(fullscreen);
        return insets;
      });
      wm.addView(probe, lp);
      fsProbe = probe;
    } catch (Exception ignored) {
      fsProbe = null;
    }
  }

  /** Our own Activity is on screen right now (see {@link #trackOwnForeground}). */
  private int ownActivitiesResumed;
  /** Last visibility actually applied to the pin — the two inputs (fullscreen
   *  probe, own-app foreground) change independently, so the decision has to be
   *  recomputed rather than toggled. */
  private boolean pinHidden;
  private boolean fullscreenNow;

  /**
   * Watch our OWN activities so the pin can stay up over our own app.
   *
   * The fullscreen probe alone cannot express this: the companion's Control
   * screen hides the system bars, so the probe correctly reports "immersive" and
   * the pin vanished exactly when the user was most likely to want to paste
   * something into it. Activity lifecycle callbacks are exact and event-driven —
   * no polling, no `getRunningTasks` (removed on modern Android anyway).
   */
  private boolean ownForegroundHooked;

  private void trackOwnForeground() {
    if (ownForegroundHooked) return;
    ownForegroundHooked = true;
    try {
      getApplication().registerActivityLifecycleCallbacks(
          new android.app.Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityCreated(android.app.Activity a, android.os.Bundle b) {}
            @Override public void onActivityStarted(android.app.Activity a) {}
            @Override public void onActivityResumed(android.app.Activity a) {
              ownActivitiesResumed++;
              applyPinVisibility();
            }
            @Override public void onActivityPaused(android.app.Activity a) {
              if (ownActivitiesResumed > 0) ownActivitiesResumed--;
              applyPinVisibility();
            }
            @Override public void onActivityStopped(android.app.Activity a) {}
            @Override public void onActivitySaveInstanceState(android.app.Activity a, android.os.Bundle b) {}
            @Override public void onActivityDestroyed(android.app.Activity a) {}
          });
    } catch (Exception ignored) {
      // Without the hook we simply fall back to the old fullscreen-only rule.
    }
  }

  private void setHiddenForFullscreen(boolean fullscreen) {
    fullscreenNow = fullscreen;
    applyPinVisibility();
  }

  /** Hide the pin only over SOMEONE ELSE'S fullscreen content. */
  private void applyPinVisibility() {
    final boolean hide = fullscreenNow && ownActivitiesResumed <= 0;
    if (hide == pinHidden) return;
    pinHidden = hide;
    hiddenForFullscreen = hide;
    main.post(() -> {
      if (bubble == null) return;
      if (hide) {
        bubble.animate().alpha(0f).setDuration(180)
            .withEndAction(() -> { if (pinHidden && bubble != null) bubble.setVisibility(View.GONE); })
            .start();
      } else {
        bubble.setVisibility(View.VISIBLE);
        bubble.animate().alpha(0.9f).setDuration(180).start();
      }
    });
  }

  /** Flat rounded tab, rounded only on the inner side, low-opacity accent. The
   *  VIEW is {@link #PIN_TOUCH_W}dp wide for an easy hit target, but only the
   *  outer {@link #PIN_VISIBLE_W}dp sliver is painted — the rest is transparent,
   *  touchable space toward the screen centre, so the pin is easy to grab/swipe
   *  without looking bulky. */
  private void styleEdgePin(View view) {
    GradientDrawable bg = new GradientDrawable();
    bg.setColors(new int[] {0xE07C5CFF, 0xE022D3EE});
    bg.setOrientation(GradientDrawable.Orientation.TOP_BOTTOM);
    float r = dp(7);
    // Round the edge facing the screen centre; keep the outer edge flush/square.
    bg.setCornerRadii(pinOnRight
        ? new float[] {r, r, 0, 0, 0, 0, r, r}   // round left side
        : new float[] {0, 0, r, r, r, r, 0, 0}); // round right side
    int pad = dp(PIN_TOUCH_W - PIN_VISIBLE_W);
    android.graphics.drawable.InsetDrawable inset = pinOnRight
        ? new android.graphics.drawable.InsetDrawable(bg, pad, 0, 0, 0)  // gradient hugs the RIGHT edge
        : new android.graphics.drawable.InsetDrawable(bg, 0, 0, pad, 0); // gradient hugs the LEFT edge
    view.setBackground(inset);
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
    private boolean movedBeforeHold;
    private boolean holding;
    private boolean touchActive;
    /** True once a hold-drag has actually MOVED the pin. A hold that never moves
     *  is still a tap on release — the old code only opened the panel for taps
     *  released inside 420ms, so a deliberate press (or any tap on a busy phone
     *  where the frame took a moment) armed the drag and then did nothing at
     *  all on release. That is the "I have to tap the pin several times". */
    private boolean draggedAny;
    private final Runnable armDrag = () -> {
      if (!touchActive || movedBeforeHold || bubble == null) return;
      holding = true;
      draggedAny = false;
      bubble.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
    };

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
          movedBeforeHold = false;
          holding = false;
          draggedAny = false;
          touchActive = true;
          // Warm the panel while the finger is still down. Building it takes a
          // few ms of view inflation; doing that during the touch instead of
          // after the release is the difference between "opens" and "opens in a
          // moment". Idempotent and thrown away if the gesture turns into a drag.
          prewarmPanel();
          main.postDelayed(armDrag, 420);
          return true;
        case MotionEvent.ACTION_MOVE: {
          int dx = (int) (e.getRawX() - touchX);
          int dy = (int) (e.getRawY() - touchY);
          if (!holding) {
            if (Math.abs(dx) > dp(8) || Math.abs(dy) > dp(8)) {
              movedBeforeHold = true;
              main.removeCallbacks(armDrag);
            }
            return true;
          }
          // After the haptic-confirmed hold, drag vertically while staying pinned
          // to the edge. There is intentionally no swipe-to-open gesture here.
          if (Math.abs(dy) > dp(4)) draggedAny = true;
          bubbleLp.y = Math.max(0, Math.min(m.heightPixels - dp(PIN_HEIGHT), startY + dy));
          try {
            wm.updateViewLayout(bubble, bubbleLp);
          } catch (Exception ignored) {
          }
          return true;
        }
        case MotionEvent.ACTION_UP:
          touchActive = false;
          main.removeCallbacks(armDrag);
          if (holding && draggedAny) {
            settlePin();
          } else if (!movedBeforeHold) {
            // Any press that didn't move the pin opens the panel, however long
            // it was held. A hold that armed but never dragged still settles its
            // (unchanged) position so the two paths stay symmetric.
            if (holding) settlePin();
            showPanel();
          }
          return true;
        case MotionEvent.ACTION_CANCEL:
          touchActive = false;
          main.removeCallbacks(armDrag);
          if (holding && draggedAny) settlePin();
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

  // ---- dock (Compose UI in NotesDock.kt; this is its host) ------------------

  // Filters that the service itself needs: the tag new items adopt (the one
  // being viewed) and whether link cards are drawn. Everything else — search,
  // All/Text/Images, type chips, editing, the tag picker — is UI state and
  // lives in NotesDock.kt.
  private String dockFolderFilter = null;
  private boolean dockShowLinkPreviews = true;
  private boolean dockPrefsLoaded;
  /** Link artwork / favicon downloads in flight (dedupe). Guarded by `this`. */
  private final HashSet<String> bitmapLoading = new HashSet<>();

  private boolean canOverlay() {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || android.provider.Settings.canDrawOverlays(this);
  }

  private NotesDock dock() {
    if (dock == null) {
      if (!dockPrefsLoaded) {
        dockPrefsLoaded = true;
        dockShowLinkPreviews = getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
            .getBoolean("dockShowLinkPreviews", true);
      }
      dock = new NotesDock(this, this);
    }
    return dock;
  }

  /** Edge handle tap: toggle the dock. */
  private void showPanel() {
    if (!canOverlay()) return;
    NotesDock d = dock();
    if (d.isOpen()) d.hide();
    else d.show();
  }

  /** Quick Settings tile / notification: always open (never toggle closed). */
  private void showDock() {
    if (!canOverlay()) {
      openApp();
      return;
    }
    dock().show();
  }

  private void hidePanel() {
    NotesDock d = dock;
    if (d != null) d.hide();
  }

  /** Called on the edge handle's ACTION_DOWN, while the finger is still down. */
  private void prewarmPanel() {
    if (canOverlay()) dock().prewarm();
  }

  /** Any thread; NotesDock coalesces the recompositions. */
  private void refreshPanelIfOpen() {
    NotesDock d = dock;
    if (d != null) d.invalidate();
  }

  /** No-op hook kept for startSync (the mic is always shown). */
  private void refreshComposerIfOpen() {}

  /** Move the dock (and handle) to the opposite edge, remembering the choice. */
  private void flipSide() {
    pinOnRight = !pinOnRight;
    settlePin();
    if (bubble != null && bubbleLp != null) {
      DisplayMetrics m = getResources().getDisplayMetrics();
      styleEdgePin(bubble);
      bubbleLp.x = pinOnRight ? m.widthPixels - dp(PIN_TOUCH_W) : 0;
      try { wm.updateViewLayout(bubble, bubbleLp); } catch (Exception ignored) {}
    }
    refreshPanelIfOpen();
  }

  /** Every distinct non-empty folder across items, alphabetical. Caller holds `this`. */
  private ArrayList<String> foldersLocked() {
    java.util.TreeSet<String> set = new java.util.TreeSet<>(String.CASE_INSENSITIVE_ORDER);
    for (ClipEntry e : items) {
      for (String tag : e.tags) if (!tag.trim().isEmpty()) set.add(tag.trim());
    }
    return new ArrayList<>(set);
  }

  /** Add or remove one tag on an entry locally + broadcast the new tag set (the
   *  relay flips + rebroadcasts — same shape as pin). */
  private void toggleTag(ClipEntry e, String tag) {
    if (e == null) return;
    String clean = tag == null ? "" : tag.trim();
    if (clean.isEmpty()) return;
    boolean removed = false;
    for (int i = e.tags.size() - 1; i >= 0; i--) {
      if (e.tags.get(i).equalsIgnoreCase(clean)) {
        e.tags.remove(i);
        removed = true;
      }
    }
    if (!removed) e.tags.add(clean);
    e.folder = e.tags.isEmpty() ? "" : e.tags.get(0);
    try {
      JSONObject m = new JSONObject();
      m.put("t", "tags");
      m.put("itemId", e.id);
      m.put("tags", new org.json.JSONArray(e.tags));
      m.put("folder", e.folder);
      if (socket != null) socket.send(m.toString());
    } catch (Exception ignored) {
    }
    refreshPanelIfOpen();
  }

  /** Insert + send a brand-new text note (composer Add, paste, share). The LOCAL
   *  entry and the wire item share ONE id + timestamp, so every device holds the
   *  exact same element and ordering matches everywhere. */
  private void addTextLocalAndSend(String t) {
    String id = UUID.randomUUID().toString();
    long nowMs = System.currentTimeMillis();
    ArrayList<String> tags = currentComposeTags();
    String folder = tags.isEmpty() ? "" : tags.get(0);
    sendTextItem(id, t, isoFromMs(nowMs), tags, false);
    synchronized (this) {
      ClipEntry e = new ClipEntry(id, "text", t, nowMs,
          (deviceId == null ? "" : deviceId) + "-native");
      e.folder = folder;
      e.tags.addAll(tags);
      items.add(e);
      sortItemsLocked();
      trimItemsLocked();
    }
    refreshPanelIfOpen();
  }

  /** Paste whatever the OS clipboard holds: an image → image note, else text →
   *  text note (deduped against the newest note so re-taps don't spam). Works
   *  from a Service only while the dock's window has input focus (Android 10+
   *  clipboard rule) — which it does whenever the dock is open. */
  private void pasteFromClipboard() {
    try {
      ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
      if (cm == null || !cm.hasPrimaryClip()) { toast("Clipboard is empty"); return; }
      ClipData clip = cm.getPrimaryClip();
      if (clip == null || clip.getItemCount() == 0) { toast("Clipboard is empty"); return; }
      ClipData.Item it = clip.getItemAt(0);
      android.net.Uri uri = it.getUri();
      if (uri != null) {
        String mime = getContentResolver().getType(uri);
        if (mime != null && mime.startsWith("image/")) {
          byte[] raw = readAll(uri);
          if (raw != null && raw.length > 0) { sendImageItem(raw, mime); return; }
        }
      }
      CharSequence cs = it.coerceToText(this);
      String text = cs == null ? "" : cs.toString().trim();
      if (text.isEmpty()) { toast("Nothing to paste"); return; }
      synchronized (this) {
        for (ClipEntry e : items) {
          if ("text".equals(e.kind)) {
            if (text.equals(e.text)) { toast("Already the latest note"); return; }
            break; // only compare against the newest text note
          }
        }
      }
      addTextLocalAndSend(text);
      toast("Pasted");
    } catch (Exception e) {
      toast("Couldn't paste");
    }
  }

  /** Launch the system photo picker via a transparent proxy Activity — services
   *  can't receive Activity results. {@code ClipboardPickActivity} hands the
   *  picked URI back to this service as {@link #ACTION_UPLOAD_IMAGE}. */
  private void launchImagePicker() {
    try {
      Intent launch = new Intent(this, ClipboardPickActivity.class);
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivity(launch);
    } catch (Exception e) {
      toast("Couldn't open gallery");
    }
  }

  /** Remove an item from the local list + send a relay delete notice. */
  private void deleteEntry(ClipEntry e) {
    if (e == null) return;
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

  private ClipEntry findEntry(String id) {
    if (id == null) return null;
    synchronized (this) {
      for (ClipEntry e : items) if (id.equals(e.id)) return e;
    }
    return null;
  }

  // ---- edge handle preference -------------------------------------------------

  boolean edgeHandleEnabled() {
    return getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
        .getBoolean(PREF_EDGE_HANDLE, true);
  }

  private void setEdgeHandle(boolean on) {
    getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(PREF_EDGE_HANDLE, on).apply();
    if (on) showBubble();
    else removeBubble();
    refreshPanelIfOpen();
  }

  /** Take the edge handle (and its fullscreen probe) off screen. */
  private void removeBubble() {
    if (wm == null) return;
    if (bubble != null) {
      try { wm.removeView(bubble); } catch (Exception ignored) {}
      bubble = null;
    }
    if (fsProbe != null) {
      try { wm.removeView(fsProbe); } catch (Exception ignored) {}
      fsProbe = null;
    }
    pinHidden = false;
  }

  // ---- NotesDockHost ----------------------------------------------------------
  // Main-thread, cheap reads for the Compose dock. Slow work is always a
  // dockRequest… that answers later through refreshPanelIfOpen().

  @Override
  public java.util.List<NoteUi> dockNotes() {
    ArrayList<ClipEntry> snap;
    synchronized (this) {
      snap = new ArrayList<>(items);
    }
    ArrayList<NoteUi> out = new ArrayList<>(snap.size());
    for (ClipEntry e : snap) {
      Content c = "text".equals(e.kind) ? contentFor(e) : PLAIN;
      ArrayList<String> tags;
      synchronized (this) {
        tags = new ArrayList<>(e.tags);
      }
      out.add(new NoteUi(e.id, e.kind, e.text == null ? "" : e.text, e.createdAtMs, e.pinned,
          tags, c.kind, c.label, c.mono, deviceLabel(e)));
    }
    return out;
  }

  /** Where a note came from, as the desktop panel shows it ("SENGALPC"). This
   *  phone's own notes say so instead of repeating the model name. */
  private String deviceLabel(ClipEntry e) {
    // Same phone = this dock ("<id>-native") or this phone's webview ("<id>").
    if (deviceId != null && !deviceId.isEmpty() && e.deviceId != null
        && (e.deviceId.equals(deviceId + "-native") || e.deviceId.equals(deviceId))) {
      return "This phone";
    }
    String n = e.deviceName == null ? "" : e.deviceName.trim();
    if (n.endsWith("(Overlay)")) n = n.substring(0, n.length() - "(Overlay)".length()).trim();
    return n;
  }

  @Override public String dockStatusText() { return getSyncStatusText(); }

  @Override public int dockStatusTone() {
    if (cryptoKey == null) return 0;
    return socketConnected ? 1 : 2;
  }

  @Override public Bitmap dockThumb(String id) {
    synchronized (this) {
      return thumbs.get(id);
    }
  }

  @Override public void dockRequestThumb(String id) { fetchImageThumb(id); }

  /** The note body, styled as whatever it is. Bounded: a multi-MB log must not
   *  reach the text layout — Copy / Share / Edit still use the full entry. */
  @Override public CharSequence dockBody(String text, String kind) {
    String t = text == null ? "" : text;
    if (t.length() > 8192) {
      t = t.substring(0, 8192) + "\n[Preview shortened — Copy, Share or Edit for the full note]";
    }
    if ("command".equals(kind)) return buildCommand(t);
    if ("log".equals(kind)) return buildLog(t);
    if ("code".equals(kind) || "json".equals(kind)) return buildCode(t);
    if ("path".equals(kind)) return t;
    return buildProse(t);
  }

  @Override public String dockLinkFor(String text) { return firstHttpLink(text); }

  @Override public LinkPreviewUi dockLinkPreview(String url) {
    LinkPreviewInfo i;
    synchronized (this) {
      i = linkPreviewCache.get(url);
    }
    return i == null ? null : new LinkPreviewUi(i.title, i.description, i.image, i.host, i.hero);
  }

  @Override public void dockRequestLinkPreview(String url) {
    if (url == null) return;
    synchronized (this) {
      if (linkPreviewCache.containsKey(url) || !linkPreviewLoading.add(url)) return;
    }
    new Thread(() -> {
      LinkPreviewInfo resolved = resolvePreview(url);
      synchronized (this) {
        linkPreviewLoading.remove(url);
        linkPreviewCache.put(url, resolved);
      }
      refreshPanelIfOpen();
    }, "gt-link-preview").start();
  }

  @Override public Bitmap dockBitmap(String url) {
    synchronized (this) {
      return linkArtCache.get(url);
    }
  }

  /** Card artwork or favicon. YouTube's maxresdefault 404s on older uploads, so a
   *  miss silently retries hqdefault, which every video has. */
  @Override public void dockRequestBitmap(String url) {
    if (url == null || url.isEmpty()) return;
    synchronized (this) {
      if (linkArtCache.containsKey(url) || !bitmapLoading.add(url)) return;
    }
    new Thread(() -> {
      Bitmap bmp = loadPreviewBitmap(url);
      if (bmp == null && url.endsWith("/maxresdefault.jpg")) {
        bmp = loadPreviewBitmap(url.replace("/maxresdefault.jpg", "/hqdefault.jpg"));
      }
      synchronized (this) {
        bitmapLoading.remove(url);
      }
      if (bmp != null) {
        cacheLinkArt(url, bmp);
        refreshPanelIfOpen();
      }
    }, "gt-link-art").start();
  }

  @Override public int dockMicState() { return micState; }

  @Override public boolean dockPreviewsOn() { return dockShowLinkPreviews; }

  @Override public void dockSetPreviews(boolean on) {
    dockShowLinkPreviews = on;
    getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE).edit()
        .putBoolean("dockShowLinkPreviews", on).apply();
    refreshPanelIfOpen();
  }

  @Override public boolean dockEdgeHandleOn() { return edgeHandleEnabled(); }

  @Override public void dockSetEdgeHandle(boolean on) { setEdgeHandle(on); }

  @Override public boolean dockPinOnRight() { return pinOnRight; }

  @Override public void dockFlipSide() { flipSide(); }

  @Override public String dockDraft() {
    String d = getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE).getString("draftText", "");
    return d == null ? "" : d;
  }

  @Override public void dockSetDraft(String text) {
    android.content.SharedPreferences.Editor ed =
        getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE).edit();
    if (text == null || text.isEmpty()) ed.remove("draftText");
    else ed.putString("draftText", text);
    ed.apply();
  }

  @Override public void dockSetTagFilter(String tag) { dockFolderFilter = tag; }

  @Override public void dockAdd(String text) {
    if (text == null || text.trim().isEmpty()) return;
    addTextLocalAndSend(text.trim());
  }

  /** Save an in-place edit: same id → every device replaces its copy. A save is
   *  a meaningful touch, so it takes a fresh timestamp and moves to the top. */
  @Override public void dockSaveEdit(String id, String text) {
    ClipEntry target = findEntry(id);
    if (target == null || text == null) return;
    target.text = text;
    target.createdAtMs = System.currentTimeMillis();
    ArrayList<String> tags;
    synchronized (this) {
      sortItemsLocked();
      tags = new ArrayList<>(target.tags);
    }
    sendTextItem(target.id, text, isoFromMs(target.createdAtMs), tags, target.pinned);
    refreshPanelIfOpen();
  }

  @Override public void dockCopy(String id) {
    ClipEntry e = findEntry(id);
    if (e == null || e.text == null) return;
    setOsClipboard(e.text);
  }

  @Override public void dockCopyLatest() {
    String t = newestText();
    if (t == null) { toast("Nothing to copy yet"); return; }
    setOsClipboard(t);
    toast("Copied the latest note");
  }

  @Override public void dockTogglePin(String id) { togglePin(findEntry(id)); }

  /** The share sheet is an Activity: close the dock first or it opens UNDER the
   *  overlay window. */
  @Override public void dockShare(String id) {
    ClipEntry e = findEntry(id);
    if (e == null) return;
    hidePanel();
    shareEntry(e);
  }

  @Override public void dockDelete(String id) { deleteEntry(findEntry(id)); }

  @Override public void dockToggleTag(String id, String tag) { toggleTag(findEntry(id), tag); }

  @Override public void dockPaste() { pasteFromClipboard(); }

  @Override public void dockPickImage() {
    hidePanel();
    launchImagePicker();
  }

  @Override public void dockReceiveImage(Uri uri) { handleUploadImage(uri); }

  @Override public void dockToggleMic() { toggleMic(); }

  @Override public void dockOpenApp() {
    hidePanel();
    openApp();
  }

  @Override public void dockOpenUrl(String url) {
    hidePanel();
    openUrl(url);
  }

  // --- content classification -------------------------------------------------
  // The Java mirror of the web client's classifier (src/lib/clipContent.ts). Both
  // must agree: a note filtered as "Code" in the app has to be a code block in the
  // dock too, or the type chips lie. Kept in the same order as the TS so a change
  // there is easy to port.

  private static final Pattern CMD_LINE = Pattern.compile(
      "^(?:sudo\\s+)?(?:npm|npx|pnpm|yarn|bun|git|cargo|rustup|python3?|pip3?|node|deno|go|docker|kubectl|adb|gradlew|\\./gradlew|mvn|curl|wget|ssh|scp|cd|ls|dir|cat|echo|mkdir|rm|cp|mv|touch|chmod|winget|choco|brew|apt|apt-get|dotnet|java|javac|tsc|vite|make|cmake|ffmpeg|tar|zip|unzip|powershell|pwsh|bash|sh)\\b");
  private static final Pattern PATH_LINE = Pattern.compile(
      "^(?:[A-Za-z]:[\\\\/][^\\n:*?\"<>|]*|\\\\\\\\[^\\n]+|(?:~|\\.{0,2})/[^\\s\\n:*?\"<>|]+)$");
  private static final Pattern DIFF_LINE = Pattern.compile(
      "^(?:diff --git |@@ -\\d+(?:,\\d+)? \\+\\d+(?:,\\d+)? @@|(?:---|\\+\\+\\+) )", Pattern.MULTILINE);
  private static final Pattern[] LOG_MARKERS = {
      Pattern.compile("^\\s*at\\s+[\\w$.<>]+\\s*\\(", Pattern.MULTILINE),
      Pattern.compile("^\\s*File\\s+\"[^\"]+\",\\s+line\\s+\\d+", Pattern.MULTILINE),
      Pattern.compile("^Traceback \\(most recent call last\\)", Pattern.MULTILINE),
      Pattern.compile("^\\s*Caused by:", Pattern.MULTILINE),
      Pattern.compile("\\b[A-Z]\\w*(?:Error|Exception)\\b\\s*:"),
      Pattern.compile("^error\\[E\\d{2,4}\\]", Pattern.MULTILINE),
      Pattern.compile("^error TS\\d{4}", Pattern.MULTILINE),
      Pattern.compile("panicked at"),
      Pattern.compile("^(?:FAILURE|BUILD FAILED|FAILED|\\* What went wrong:)", Pattern.MULTILINE),
      Pattern.compile("^\\s*\\[?\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}", Pattern.MULTILINE),
      Pattern.compile("^\\s*===.*===\\s*$", Pattern.MULTILINE),
      Pattern.compile("^\\s*(?:Failed to |Uncaught |Unhandled |Warning: |ERROR|FATAL)", Pattern.MULTILINE),
      Pattern.compile("^\\s*\\d{1,3}\\s*\\|\\s", Pattern.MULTILINE), // rustc/vite code frame gutter
      Pattern.compile("\\bException in thread\\b"),
      Pattern.compile("^[^\\n]{0,80}\\bdiagnostics\\b[^\\n]{0,40}$", Pattern.MULTILINE | Pattern.CASE_INSENSITIVE),
  };
  private static final Pattern FAILED_WORD =
      Pattern.compile("\\b\\w*(?:error|exception)\\b|\\b(?:failed|failure|panicked|fatal)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern CODE_WORD = Pattern.compile(
      "\\b(?:function|const|let|var|def|fn|class|struct|impl|public|private|import|export|return|if|else|for|while)\\b");

  /** What a note actually is: the kind drives the type chips and the block chrome,
   *  the label is the badge, mono decides prose-vs-block rendering. */
  static final class Content {
    final String kind;  // link | command | code | json | log | path | text
    final String label; // badge text; null for plain prose
    final boolean mono;
    Content(String kind, String label, boolean mono) {
      this.kind = kind; this.label = label; this.mono = mono;
    }
  }
  private static final Content PLAIN = new Content("text", null, false);

  /** Rendering/type-chip counts must never classify a history batch on the UI
   * thread or under the service lock. Use a cheap fallback until prepared. */
  private Content contentFor(ClipEntry entry) {
    if (entry == null || entry.text == null) return PLAIN;
    String text = entry.text;
    if (text.equals(entry.classifiedText)) return entry.content;
    synchronized (entry) {
      if (!text.equals(entry.classifyingText) && !stopping) {
        entry.classifyingText = text;
        try {
          contentWorker.execute(() -> {
            Content result = classify(text);
            main.post(() -> {
              if (stopping || !text.equals(entry.text)) return;
              entry.content = result;
              entry.classifiedText = text;
              refreshPanelIfOpen();
            });
          });
        } catch (java.util.concurrent.RejectedExecutionException ignored) { }
      }
    }
    return PLAIN;
  }

  // Classification is pure and runs from render paths (every row, every refresh,
  // plus the per-kind chip counts), so it is memoized by text. Bounded, because
  // note bodies can be very large pasted logs or webpages and classification must
  // never be able to stall the floating panel's main thread.
  private static final LinkedHashMap<String, Content> CLASSIFY_CACHE = new LinkedHashMap<>();
  private static final int CLASSIFY_CACHE_MAX = 400;
  private static final int CLASSIFY_MAX_CHARS = 32 * 1024;

  /** Decide how a note should be presented. Never throws. */
  static Content classify(String text) {
    // Bound the cache KEY too; otherwise it retains entire multi-MB pastes.
    String key = text == null ? "" : text.substring(0, Math.min(text.length(), CLASSIFY_MAX_CHARS));
    synchronized (CLASSIFY_CACHE) {
      Content hit = CLASSIFY_CACHE.get(key);
      if (hit != null) return hit;
    }
    Content out;
    try {
      out = classifyUncached(key);
    } catch (Exception ignored) {
      out = PLAIN;
    }
    synchronized (CLASSIFY_CACHE) {
      if (CLASSIFY_CACHE.size() >= CLASSIFY_CACHE_MAX) {
        java.util.Iterator<String> it = CLASSIFY_CACHE.keySet().iterator();
        if (it.hasNext()) { it.next(); it.remove(); }
      }
      CLASSIFY_CACHE.put(key, out);
    }
    return out;
  }

  private static Content classifyUncached(String text) {
    String raw = text.trim();
    if (raw.isEmpty()) return PLAIN;
    if (raw.length() > CLASSIFY_MAX_CHARS) {
      // Preserve complete lines when possible, but never scan an unbounded paste
      // from the UI thread. The beginning contains the useful type/log markers.
      int limit = CLASSIFY_MAX_CHARS;
      int lineEnd = raw.lastIndexOf('\n', limit - 1);
      if (lineEnd >= CLASSIFY_MAX_CHARS / 2) limit = lineEnd;
      raw = raw.substring(0, limit);
    }
    String[] lines = raw.split("\n", -1);
    boolean single = lines.length == 1;

    // A note that is *only* a link is a link, whatever else it looks like.
    String url = firstHttpLink(raw);
    if (single && url != null) {
      String bare = raw.replaceFirst("(?i)^https?://", "").replaceAll("/$", "");
      String target = url.replaceFirst("(?i)^https?://", "").replaceAll("/$", "");
      if (bare.equals(target)) return new Content("link", null, false);
    }

    if (single && PATH_LINE.matcher(raw).matches()) return new Content("path", "Path", true);
    if (single && raw.length() < 400 && CMD_LINE.matcher(raw).find()) {
      return new Content("command", "Shell", true);
    }
    if (isJson(raw)) return new Content("json", "JSON", true);

    boolean failed = FAILED_WORD.matcher(raw).find();
    double prose = proseRatio(lines);

    // Machine output is checked before code: a stack trace is full of code-ish
    // punctuation and would otherwise be labelled with whatever language it names.
    for (Pattern p : LOG_MARKERS) {
      if (p.matcher(raw).find()) {
        if (prose <= 0.6 || machineRatio(lines) > 0.2) {
          return new Content("log", failed ? "Error" : "Log", true);
        }
        break;
      }
    }
    if (DIFF_LINE.matcher(raw).find()) return new Content("code", "Diff", true);
    // A block of `key: value` lines is a diagnostics dump, not source.
    if (!single && keyValueRatio(lines) > 0.5) {
      return new Content("log", failed ? "Error" : "Log", true);
    }
    // Everything below can be confused with writing, so prose wins ties.
    if (prose > 0.45) return PLAIN;
    if (!single && codeScore(raw, lines) >= 3) return new Content("code", guessLanguage(raw), true);
    if (!single && failed) return new Content("log", "Error", true);
    // Single-line code is real, but the evidence bar is higher — most single-line
    // notes are just text.
    if (single && raw.length() > 24 && codeScore(raw, lines) >= 4) {
      return new Content("code", guessLanguage(raw), true);
    }
    return PLAIN;
  }

  /** Badge for a note that should render monospaced, or null for ordinary text. */
  private static String monoLabel(String text) {
    Content c = classify(text);
    return c.mono ? c.label : null;
  }

  private static boolean isJson(String raw) {
    String s = raw.trim();
    if (s.isEmpty() || (s.charAt(0) != '{' && s.charAt(0) != '[')) return false;
    if (parsesAsJson(s)) return true;
    // JSON-lines (one object per line) is what most structured logs actually are.
    String[] ls = s.split("\n");
    int total = 0, ok = 0;
    for (String l : ls) {
      if (l.trim().isEmpty()) continue;
      total++;
      if (parsesAsJson(l.trim())) ok++;
    }
    return total >= 2 && (double) ok / total > 0.8;
  }

  private static boolean parsesAsJson(String s) {
    try {
      if (s.startsWith("{")) { new JSONObject(s); return true; }
      if (s.startsWith("[")) { new org.json.JSONArray(s); return true; }
    } catch (Exception ignored) { }
    return false;
  }

  private static final Pattern KV_LINE = Pattern.compile("^\\s*[\\w.$-]+\\s*[:=]\\s*\\S");
  private static final Pattern KV_TERMINATED = Pattern.compile("[;{},]\\s*$");
  private static final Pattern KV_CALLISH = Pattern.compile("=>|\\(\\)|\\[\\]|\\breturn\\b");
  private static final Pattern KV_SENTENCE = Pattern.compile("[.!?]\\s*$");

  /** Fraction of non-empty lines that read as `key: value` / `key=value`. The
   *  exclusions matter more than the rule: a TypeScript interface body and a
   *  YAML-ish diagnostics dump look identical until you notice that code lines
   *  terminate (`;` `,` `{`) and carry call/arrow syntax. */
  private static double keyValueRatio(String[] lines) {
    int total = 0, kv = 0;
    for (String l : lines) {
      if (l.trim().isEmpty()) continue;
      total++;
      if (KV_LINE.matcher(l).find()
          && !KV_TERMINATED.matcher(l).find()
          && !KV_CALLISH.matcher(l).find()
          && !KV_SENTENCE.matcher(l).find()) kv++;
    }
    return total == 0 ? 0 : (double) kv / total;
  }

  /** Language markers, scored highlight.js-style: most distinctive hits win.
   *  Mirrors LANGUAGES in clipContent.ts. */
  private static final class Lang {
    final String label; final Pattern[] hints;
    Lang(String label, String... regexes) {
      this.label = label;
      this.hints = new Pattern[regexes.length];
      for (int i = 0; i < regexes.length; i++) {
        this.hints[i] = Pattern.compile(regexes[i], Pattern.MULTILINE | Pattern.CASE_INSENSITIVE);
      }
    }
  }
  private static final Lang[] LANGUAGES = {
      new Lang("TypeScript", "\\binterface\\s+\\w+\\s*\\{", ":\\s*(?:string|number|boolean|void|unknown|any)\\b",
          "\\bexport\\s+(?:type|interface)\\b", "\\bas\\s+const\\b", "<[A-Z]\\w*(?:,\\s*\\w+)*>\\("),
      new Lang("JavaScript", "\\b(?:const|let)\\s+\\w+\\s*=", "=>\\s*[{(]", "\\bfunction\\s*\\w*\\s*\\(",
          "\\brequire\\(['\"]", "\\bconsole\\.\\w+\\(", "\\bexport\\s+default\\b"),
      new Lang("Rust", "\\bfn\\s+\\w+\\s*[(<]", "\\blet\\s+mut\\b", "\\bimpl\\b[^\\n]*\\bfor\\b", "::\\w+",
          "\\bpub\\s+(?:fn|struct|enum|mod)\\b", "\\bmatch\\s+\\w+\\s*\\{"),
      new Lang("Java", "\\b(?:public|private|protected)\\s+(?:static\\s+)?(?:final\\s+)?[\\w<>\\[\\]]+\\s+\\w+\\s*\\(",
          "\\bnew\\s+[A-Z]\\w*\\s*\\(", "\\bimport\\s+(?:java|android|androidx)\\.", "@Override\\b"),
      new Lang("Kotlin", "\\bfun\\s+\\w+\\s*\\(", "\\bval\\s+\\w+\\s*[:=]", "\\bvar\\s+\\w+\\s*:\\s*\\w+",
          "\\bcompanion\\s+object\\b"),
      new Lang("Python", "^\\s*def\\s+\\w+\\s*\\(", "^\\s*from\\s+[\\w.]+\\s+import\\b", "^\\s*import\\s+\\w+$",
          "\\bself\\.", "\\belif\\b", ":\\s*$"),
      new Lang("C#", "\\busing\\s+System(?:\\.\\w+)*\\s*;", "\\bnamespace\\s+[\\w.]+", "\\bvar\\s+\\w+\\s*=\\s*new\\b",
          "\\b(?:public|private|internal|protected)\\s+(?:static\\s+|sealed\\s+|partial\\s+|abstract\\s+)*(?:class|record|struct|interface)\\b",
          "\\[(?:Serializable|Obsolete|TestMethod|HttpGet|HttpPost|Fact|Theory)\\]",
          "\\bpublic\\s+[\\w<>\\[\\]?]+\\s+\\w+\\s*\\{\\s*get;\\s*(?:set;|init;)?",
          "\\bstring\\[\\]\\s+args\\b", "\\basync\\s+Task(?:<[^>]+>)?\\s+\\w+\\s*\\(",
          "\\bConsole\\.(?:WriteLine|Write|ReadLine)\\s*\\(",
          "\\?\\?=|=>\\s*\\w+\\s*;|\\bnameof\\s*\\(|\\bIEnumerable<|\\bList<\\w+>\\s+\\w+\\s*="),
      new Lang("Go", "\\bfunc\\s+\\w*\\s*\\(", "\\bpackage\\s+main\\b", ":=", "\\bimport\\s+\\("),
      new Lang("SQL", "\\bselect\\b[\\s\\S]*\\bfrom\\b", "\\binsert\\s+into\\b", "\\bcreate\\s+table\\b",
          "\\bwhere\\b.*\\band\\b"),
      new Lang("HTML", "</(?:div|span|p|a|body|html|section|button)>", "<!DOCTYPE html>", "<[a-z]+\\s+[\\w-]+=[\"']"),
      new Lang("CSS", "[.#]?[\\w-]+\\s*\\{[^}]*:[^}]*;[\\s\\S]*\\}", "@media\\b", "--[\\w-]+\\s*:"),
      new Lang("Shell", "^\\s*#!", "\\$\\{?\\w+\\}?", "\\|\\s*(?:grep|awk|sed|head|tail)\\b",
          "^\\s*(?:export|source)\\s+\\w+"),
      new Lang("XML", "<\\?xml\\b", "<manifest\\b", "xmlns:"),
  };

  /** Highest-scoring language, but only when it wins outright — sibling languages
   *  share most of their syntax, so a tie falls back to a plain "Code" badge
   *  rather than naming the wrong language. */
  private static String guessLanguage(String text) {
    String bestLabel = null;
    int best = 0, next = 0;
    for (Lang lang : LANGUAGES) {
      int score = 0;
      for (Pattern p : lang.hints) if (p.matcher(text).find()) score++;
      if (score > best) { next = best; best = score; bestLabel = lang.label; }
      else if (score > next) { next = score; }
    }
    if (bestLabel == null || best < 2 || next == best) return "Code";
    return bestLabel;
  }

  private static final Pattern PROSE_END = Pattern.compile("[.!?,;:]\\s*$");

  /** How much this reads like someone writing to another person. Prose is the
   *  default for a reason: the history is mostly notes-to-self and pasted chat,
   *  and a stray "ERROR" or a semicolon must not turn a paragraph into code. */
  private static double proseRatio(String[] lines) {
    int total = 0, prosey = 0;
    for (String l : lines) {
      if (l.trim().isEmpty()) continue;
      total++;
      int alpha = asciiWordCount(l, 1);
      // Either a full sentence, or simply a long run of ordinary words.
      if ((alpha >= 4 && PROSE_END.matcher(l).find()) || alpha >= 6) prosey++;
    }
    return total == 0 ? 0 : (double) prosey / total;
  }

  /** Count whitespace-delimited ASCII words without regex allocation. This runs
   *  during panel opening, so String.split + String.matches here can turn one
   *  large pasted note into an Android input-dispatch ANR. */
  private static int asciiWordCount(String text, int minimumLength) {
    int count = 0;
    int start = -1;
    for (int i = 0; i <= text.length(); i++) {
      boolean boundary = i == text.length() || Character.isWhitespace(text.charAt(i));
      if (!boundary) {
        if (start < 0) start = i;
        continue;
      }
      if (start >= 0 && isAsciiWord(text, start, i, minimumLength)) count++;
      start = -1;
    }
    return count;
  }

  private static boolean isAsciiWord(String text, int start, int end, int minimumLength) {
    if (end - start < minimumLength || !isAsciiLetter(text.charAt(start))) return false;
    for (int i = start + 1; i < end; i++) {
      char c = text.charAt(i);
      if (!isAsciiLetter(c) && c != '\'') return false;
    }
    return true;
  }

  private static boolean isAsciiLetter(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  }

  private static double machineRatio(String[] lines) {
    int total = 0, hits = 0;
    for (String l : lines) {
      if (l.trim().isEmpty()) continue;
      total++;
      for (Pattern p : LOG_MARKERS) if (p.matcher(l).find()) { hits++; break; }
    }
    return total == 0 ? 0 : (double) hits / total;
  }

  private static final Pattern DENSE_LINE = Pattern.compile("[{};()\\[\\]=<>]");
  private static final Pattern INDENTED_LINE = Pattern.compile("^(?:\\s{2,}|\\t)");

  /** Structural evidence that a block is code rather than prose. The denominator
   *  is every line, blank ones included — same as codeScore in clipContent.ts, and
   *  the two must agree or a note is a block in one client and prose in the other. */
  private static int codeScore(String raw, String[] lines) {
    int dense = 0, indented = 0;
    for (String l : lines) {
      if (DENSE_LINE.matcher(l).find()) dense++;
      if (INDENTED_LINE.matcher(l).find()) indented++;
    }
    int total = Math.max(1, lines.length);
    double d = (double) dense / total, i = (double) indented / total;
    int score = 0;
    if (d > 0.45) score += 2;
    if (d > 0.7) score += 1;
    if (i > 0.25) score += 1;
    if (Pattern.compile(";\\s*$", Pattern.MULTILINE).matcher(raw).find()) score += 1;
    if (Pattern.compile("^\\s*(?://|#|/\\*|\\*)", Pattern.MULTILINE).matcher(raw).find()) score += 1;
    if (CODE_WORD.matcher(raw).find()) score += 1;
    int words = 0, alpha = 0;
    for (String w : raw.split("\\s+")) {
      if (w.isEmpty()) continue;
      words++;
      if (w.length() >= 2 && isAsciiWord(w, 0, w.length(), 2)) alpha++;
    }
    if (words > 0 && (double) alpha / words > 0.8) score -= 3;
    return score;
  }

  /** First link in the note, accepting scheme-less hosts (which is how most
   *  links arrive from share sheets and pasted product pages). Returns an
   *  absolute URL, or null when there is nothing link-shaped. */
  private static String firstHttpLink(String text) {
    if (text == null) return null;
    if (text.length() > 8192) text = text.substring(0, 8192);
    Matcher m = HTTP_LINK.matcher(text);
    if (m.find()) {
      String url = trimLinkTail(m.group());
      if (!looksLikePackageId(url)) return url;
    }
    Matcher bare = BARE_LINK.matcher(text);
    while (bare.find()) {
      String url = "https://" + trimLinkTail(bare.group());
      if (!looksLikePackageId(url)) return url;
    }
    return null;
  }

  /** Reverse-DNS app ids (com.graceandtech.app) are shaped like hosts and end in
   *  a real TLD. Nothing that starts with a TLD label and carries no path is a
   *  site worth previewing. Mirrors looksLikePackageId in clipContent.ts. */
  private static boolean looksLikePackageId(String url) {
    // Split by hand rather than through Uri: this runs on strings that are only
    // link-shaped, and it keeps the rule verifiable off-device.
    String rest = url.replaceFirst("(?i)^https?://", "");
    int cut = rest.length();
    for (char c : new char[] {'/', '?', '#'}) {
      int at = rest.indexOf(c);
      if (at >= 0 && at < cut) cut = at;
    }
    String host = rest.substring(0, cut);
    String path = rest.substring(cut);
    if (!path.replaceAll("[/?#]+$", "").isEmpty()) return false;
    int colon = host.indexOf(':');
    if (colon >= 0) host = host.substring(0, colon);
    String[] labels = host.toLowerCase(Locale.US).split("\\.");
    if (labels.length < 3) return false;
    return labels[0].matches("(?:" + TLDS + ")");
  }

  /** Sentence punctuation is almost never part of the link. */
  private static String trimLinkTail(String url) {
    String out = url;
    while (out.length() > 1 && ".,;:!?'\"".indexOf(out.charAt(out.length() - 1)) >= 0) {
      out = out.substring(0, out.length() - 1);
    }
    while (out.endsWith(")") && count(out, '(') < count(out, ')')) out = out.substring(0, out.length() - 1);
    return out;
  }

  private static int count(String s, char c) {
    int n = 0;
    for (int i = 0; i < s.length(); i++) if (s.charAt(i) == c) n++;
    return n;
  }

  // --- rich text --------------------------------------------------------------
  // The dock's answer to ClipBody.tsx: prose gets its inline marks and blue
  // underlined links, code gets tokens coloured, logs get coloured by severity.
  // Everything is spans on the one body TextView — no nested views, so pooling,
  // clamping and "Show more" keep working exactly as before.

  private static final int MARK_NONE = 0, MARK_BOLD = 1, MARK_ITALIC = 2, MARK_STRIKE = 3,
      MARK_CODE = 4, MARK_BULLET = 5, MARK_QUOTE = 6, MARK_LINK = 7;

  // Pasted copy — marketing blurbs, chat exports, meeting notes — carries the
  // markup people actually type in messaging apps. Rendering `*this*` as literal
  // asterisks is the difference between a note that reads and one that doesn't.
  private static final Pattern P_INLINE_CODE = Pattern.compile("`([^`\n]+)`");
  private static final Pattern P_BOLD = Pattern.compile("(?<![\\w*])\\*(?!\\s)([^*\n]+?)(?<!\\s)\\*(?![\\w*])");
  private static final Pattern P_ITALIC = Pattern.compile("(?<![\\w_])_(?!\\s)([^_\n]+?)(?<!\\s)_(?![\\w_])");
  private static final Pattern P_STRIKE = Pattern.compile("(?<![\\w~])~(?!\\s)([^~\n]+?)(?<!\\s)~(?![\\w~])");
  private static final Pattern P_BULLET = Pattern.compile("^[ \t]*[-*•·][ \t]+", Pattern.MULTILINE);
  private static final Pattern P_QUOTE = Pattern.compile("^[ \t]*>[ \t]?", Pattern.MULTILINE);

  /** One resolved run of prose: the source span it replaces, plus how to paint it. */
  private static final class Hit {
    int start, end, mark;
    String text, url;
  }

  /** Prose split into styled runs: links, bold, italic, strike, inline code,
   *  bullet and quote markers. Deliberately a small fixed set — this is a notes
   *  dock, not a Markdown renderer, and anything unrecognized stays plain. */
  private CharSequence buildProse(String text) {
    ArrayList<Hit> hits = new ArrayList<>();
    // Code first: whatever is inside backticks is literal, markers included.
    addMarkHits(hits, text, P_INLINE_CODE, MARK_CODE);
    addLinkHits(hits, text, HTTP_LINK, false);
    addLinkHits(hits, text, BARE_LINK, true);
    addMarkHits(hits, text, P_BOLD, MARK_BOLD);
    addMarkHits(hits, text, P_ITALIC, MARK_ITALIC);
    addMarkHits(hits, text, P_STRIKE, MARK_STRIKE);
    // Markers are normalized so a mixed list of "-", "*" and "•" looks like one
    // list rather than three, while keeping the original indentation.
    addMarkerHits(hits, text, P_BULLET, MARK_BULLET, "[-*•·][ \t]+$", "• ");
    addMarkerHits(hits, text, P_QUOTE, MARK_QUOTE, ">[ \t]?$", "▎ ");
    if (hits.isEmpty()) return text;
    java.util.Collections.sort(hits, (a, b) -> a.start - b.start);

    SpannableStringBuilder out = new SpannableStringBuilder();
    int at = 0;
    for (Hit h : hits) {
      if (h.start > at) out.append(text, at, h.start);
      int from = out.length();
      out.append(h.text);
      paintMark(out, from, out.length(), h.mark, h.url);
      at = h.end;
    }
    if (at < text.length()) out.append(text, at, text.length());
    return out;
  }

  private static void addMarkHits(ArrayList<Hit> hits, String text, Pattern p, int mark) {
    Matcher m = p.matcher(text);
    while (m.find()) {
      if (m.end() == m.start()) continue;
      if (overlaps(hits, m.start(), m.end())) continue;
      Hit h = new Hit();
      h.start = m.start(); h.end = m.end(); h.mark = mark; h.text = m.group(1);
      hits.add(h);
    }
  }

  /** Line-leading markers: the marker itself is replaced by a normalized glyph. */
  private static void addMarkerHits(ArrayList<Hit> hits, String text, Pattern p, int mark,
                                    String tail, String glyph) {
    Matcher m = p.matcher(text);
    while (m.find()) {
      if (m.end() == m.start()) continue;
      if (overlaps(hits, m.start(), m.end())) continue;
      Hit h = new Hit();
      h.start = m.start(); h.end = m.end(); h.mark = mark;
      h.text = m.group().replaceAll(tail, glyph);
      hits.add(h);
    }
  }

  /** Links claim less than they matched: the sentence's full stop stays plain. */
  private static void addLinkHits(ArrayList<Hit> hits, String text, Pattern p, boolean bare) {
    Matcher m = p.matcher(text);
    while (m.find()) {
      String shown = trimLinkTail(m.group());
      if (shown.isEmpty()) continue;
      String url = bare ? "https://" + shown : shown;
      if (looksLikePackageId(url)) continue;
      int end = m.start() + shown.length();
      if (overlaps(hits, m.start(), end)) continue;
      Hit h = new Hit();
      h.start = m.start(); h.end = end; h.mark = MARK_LINK; h.text = shown; h.url = url;
      hits.add(h);
    }
  }

  private static boolean overlaps(ArrayList<Hit> hits, int start, int end) {
    for (Hit h : hits) if (start < h.end && end > h.start) return true;
    return false;
  }

  private void paintMark(SpannableStringBuilder out, int from, int to, int mark, final String url) {
    int flags = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE;
    switch (mark) {
      case MARK_BOLD:
        out.setSpan(new StyleSpan(Typeface.BOLD), from, to, flags);
        out.setSpan(new ForegroundColorSpan(0xFFF8FAFC), from, to, flags);
        break;
      case MARK_ITALIC:
        out.setSpan(new StyleSpan(Typeface.ITALIC), from, to, flags);
        break;
      case MARK_STRIKE:
        out.setSpan(new StrikethroughSpan(), from, to, flags);
        out.setSpan(new ForegroundColorSpan(0xFF94A3B8), from, to, flags);
        break;
      case MARK_CODE:
        out.setSpan(new TypefaceSpan("monospace"), from, to, flags);
        out.setSpan(new BackgroundColorSpan(0x1FFFFFFF), from, to, flags);
        out.setSpan(new ForegroundColorSpan(0xFFA5F3FC), from, to, flags);
        break;
      case MARK_BULLET:
        out.setSpan(new ForegroundColorSpan(0xFF7C5CFF), from, to, flags);
        out.setSpan(new StyleSpan(Typeface.BOLD), from, to, flags);
        break;
      case MARK_QUOTE:
        out.setSpan(new ForegroundColorSpan(0x66FFFFFF), from, to, flags);
        break;
      case MARK_LINK:
        out.setSpan(new ForegroundColorSpan(0xFF38BDF8), from, to, flags);
        out.setSpan(new UnderlineSpan(), from, to, flags);
        out.setSpan(new UrlSpan(url), from, to, flags);
        break;
      default:
        break;
    }
  }

  /** A link inside a note. Named (not anonymous) so the Compose dock can read the
   *  target and turn it into a LinkAnnotation. */
  static final class UrlSpan extends ClickableSpan {
    final String url;
    UrlSpan(String url) { this.url = url; }
    @Override public void onClick(View widget) {
      try {
        widget.getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      } catch (Exception ignored) { }
    }
    @Override public void updateDrawState(android.text.TextPaint ds) {
      ds.setColor(0xFF38BDF8);
      ds.setUnderlineText(true);
    }
  }

  private void openUrl(String url) {
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    } catch (Exception ignored) { }
  }

  // Minimal multi-language tokenizer, mirroring tokenizeCode in clipContent.ts. A
  // real highlighter is far too much weight for a dock; comments / strings /
  // numbers / keywords cover every language that actually turns up here, and
  // unknown syntax simply falls through as plain text.
  private static final Pattern TOKENIZER = Pattern.compile(
      "(?<comment>//[^\n]*|#[^\n]*|/\\*[\\s\\S]*?\\*/|<!--[\\s\\S]*?-->)"
      + "|(?<string>\"(?:[^\"\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)"
      + "|(?<number>\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?\\b)"
      + "|(?<meta>@[A-Za-z_]\\w*|#\\[[^\\]]*\\])"
      + "|(?<word>[A-Za-z_$][\\w$]*)"
      + "|(?<punct>[{}()\\[\\];:,.<>=+\\-*/%!&|^~?]+)");
  private static final Pattern KEYWORDS = Pattern.compile(
      "^(?:abstract|any|as|async|await|base|bool|boolean|break|case|catch|char|class|const|constructor|continue|crate"
      + "|decimal|def|default|delete|do|double|elif|else|enum|event|except|export|extends|extern|false|final|finally"
      + "|float|fn|for|foreach|from|func|function|get|goto|if|impl|implements|import|in|init|instanceof|int|interface"
      + "|internal|is|let|lambda|lock|long|match|mod|module|mut|namespace|new|None|not|null|nullptr|number|object"
      + "|operator|or|out|override|package|params|partial|pass|private|protected|pub|public|raise|readonly|record|ref"
      + "|return|sealed|self|set|short|static|str|string|struct|super|switch|this|throw|throws|trait|true|try|type"
      + "|typeof|union|unsafe|use|using|val|var|virtual|void|when|where|while|with|yield)$");

  private static final int TOK_COMMENT = 0x736EE7B7, TOK_STRING = 0xD9FDE68A, TOK_NUMBER = 0xD9FDBA74,
      TOK_KEYWORD = 0xFFC4B5FD, TOK_PUNCT = 0xFF94A3B8, TOK_META = 0xCC67E8F9;

  /** Source with its tokens coloured. */
  private static CharSequence buildCode(String text) {
    SpannableStringBuilder out = new SpannableStringBuilder(text);
    Matcher m = TOKENIZER.matcher(text);
    while (m.find()) {
      int colour;
      if (m.group("comment") != null) colour = TOK_COMMENT;
      else if (m.group("string") != null) colour = TOK_STRING;
      else if (m.group("number") != null) colour = TOK_NUMBER;
      else if (m.group("meta") != null) colour = TOK_META;
      else if (m.group("word") != null) {
        if (!KEYWORDS.matcher(m.group()).matches()) continue;
        colour = TOK_KEYWORD;
      } else colour = TOK_PUNCT;
      out.setSpan(new ForegroundColorSpan(colour), m.start(), m.end(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }
    return out;
  }

  private static final Pattern SEV_ERROR =
      Pattern.compile("\\b\\w*(?:error|exception)\\b|\\b(?:failed|failure|fatal|panicked)\\b|^E/", Pattern.CASE_INSENSITIVE);
  private static final Pattern SEV_WARN =
      Pattern.compile("\\b(?:warn|warning|deprecated|W/)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern SEV_INFO = Pattern.compile("^\\s*(?:at\\s|File\\s\"|Caused by:|\\d+\\s*\\|)");

  /** Log lines carry severity rather than syntax; colour by what went wrong. */
  private static CharSequence buildLog(String text) {
    SpannableStringBuilder out = new SpannableStringBuilder(text);
    int at = 0;
    while (at <= text.length()) {
      int nl = text.indexOf('\n', at);
      int end = nl < 0 ? text.length() : nl;
      String line = text.substring(at, end);
      int colour = 0;
      if (SEV_ERROR.matcher(line).find()) colour = 0xFFFDA4AF;
      else if (SEV_WARN.matcher(line).find()) colour = 0xE6FCD34D;
      else if (SEV_INFO.matcher(line).find()) colour = 0xFF94A3B8;
      if (colour != 0 && end > at) {
        out.setSpan(new ForegroundColorSpan(colour), at, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
      }
      if (nl < 0) break;
      at = nl + 1;
    }
    return out;
  }

  /** A shell command is one line by definition — give it the prompt treatment
   *  rather than a block, so it reads as something you run. */
  private static CharSequence buildCommand(String text) {
    SpannableStringBuilder out = new SpannableStringBuilder("$  ");
    out.setSpan(new ForegroundColorSpan(0xB334D399), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    out.append(text);
    return out;
  }

  /** Resolve a URL's card metadata off the main thread. YouTube is special-cased
   *  through oEmbed: the watch page serves a consent stub to non-browser clients,
   *  and the thumbnail is derivable from the video id with no request at all. */
  private LinkPreviewInfo resolvePreview(String url) {
    String host = hostForLink(url);
    String videoId = youTubeId(url);
    if (videoId != null) {
      LinkPreviewInfo yt = youTubePreview(url, videoId);
      if (yt != null) return yt;
    }
    String title = null, description = null, image = null;
    try (Response response = previewHttp().newCall(new Request.Builder().url(url)
        .header("User-Agent", PREVIEW_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept", "text/html,application/xhtml+xml").build()).execute()) {
      String page = readPreviewHtml(response);
      title = htmlMeta(page, "og:title"); description = htmlMeta(page, "og:description"); image = htmlMeta(page, "og:image");
      if (image == null) image = htmlMeta(page, "og:image:url");
      if (image == null) image = htmlMeta(page, "twitter:image");
      if (title == null) title = htmlMeta(page, "twitter:title");
      if (title == null) title = htmlTitleTag(page);
      if (description == null) description = htmlMeta(page, "twitter:description");
      if (description == null) description = htmlMeta(page, "description");
    } catch (Exception ignored) {}
    try { String h = Uri.parse(url).getHost(); if (h != null && !h.isEmpty()) host = h.startsWith("www.") ? h.substring(4) : h; } catch (Exception ignored) {}
    String t = title == null || title.trim().isEmpty() ? host : title.trim();
    String d = description == null ? "" : description.trim();
    String art = image == null ? null : absoluteLink(url, image);
    return new LinkPreviewInfo(clampPreviewText(t, 120), clampPreviewText(d, 200), art, host, art != null);
  }

  private static final String PREVIEW_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  private static String clampPreviewText(String value, int max) {
    if (value == null) return "";
    String flat = value.replace('\n', ' ').replace('\r', ' ').trim();
    return flat.length() <= max ? flat : flat.substring(0, max - 1).trim() + "…";
  }

  /** Video id for a watch/shorts/embed/youtu.be URL, else null. */
  private static String youTubeId(String url) {
    try {
      Uri uri = Uri.parse(url);
      String host = uri.getHost();
      if (host == null) return null;
      host = host.toLowerCase(Locale.US);
      if (host.equals("youtu.be")) {
        String path = uri.getPath();
        String id = path == null ? "" : path.replace("/", "");
        return id.isEmpty() ? null : id;
      }
      if (!host.endsWith("youtube.com") && !host.endsWith("youtube-nocookie.com")) return null;
      String v = uri.getQueryParameter("v");
      if (v != null && !v.isEmpty()) return v;
      String path = uri.getPath();
      if (path == null) return null;
      Matcher m = Pattern.compile("/(?:shorts|embed|live|v)/([A-Za-z0-9_-]{6,})").matcher(path);
      return m.find() ? m.group(1) : null;
    } catch (Exception ignored) { return null; }
  }

  /** Title + channel from oEmbed (no API key, no quota); artwork from the id. */
  private LinkPreviewInfo youTubePreview(String url, String videoId) {
    String art = "https://i.ytimg.com/vi/" + videoId + "/maxresdefault.jpg";
    try (Response response = previewHttp().newCall(new Request.Builder()
        .url("https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=" + Uri.encode(videoId))
        .header("User-Agent", PREVIEW_UA).build()).execute()) {
      if (response.isSuccessful() && response.body() != null) {
        String json = response.body().string();
        String title = jsonString(json, "title");
        String author = jsonString(json, "author_name");
        if (title != null && !title.isEmpty()) {
          return new LinkPreviewInfo(clampPreviewText(title, 120), author == null ? "" : author, art, "YouTube", true);
        }
      }
    } catch (Exception ignored) {}
    // oEmbed unreachable (offline, or the video is private): the thumbnail URL is
    // still derivable, so show artwork rather than falling all the way back.
    return new LinkPreviewInfo(hostForLink(url), "", art, "YouTube", true);
  }

  /** Minimal string-field reader for the flat oEmbed payload. */
  private static String jsonString(String json, String key) {
    if (json == null) return null;
    Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
    if (!m.find()) return null;
    return m.group(1).replace("\\\"", "\"").replace("\\/", "/").replace("\\n", " ").replace("\\\\", "\\");
  }

  private OkHttpClient previewHttp() { return http.newBuilder().callTimeout(8, TimeUnit.SECONDS).connectTimeout(5, TimeUnit.SECONDS).readTimeout(6, TimeUnit.SECONDS).followRedirects(true).followSslRedirects(true).build(); }
  private static String hostForLink(String url) { try { String host = Uri.parse(url).getHost(); return host == null || host.isEmpty() ? url : host; } catch (Exception ignored) { return url; } }
  private static String readPreviewHtml(Response response) throws java.io.IOException { if (!response.isSuccessful() || response.body() == null) return ""; java.io.InputStream in = response.body().byteStream(); java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(); byte[] buf = new byte[8192]; int remaining = 384 * 1024, count; while (remaining > 0 && (count = in.read(buf, 0, Math.min(buf.length, remaining))) != -1) { out.write(buf, 0, count); remaining -= count; } return new String(out.toByteArray(), StandardCharsets.UTF_8); }
  private static String absoluteLink(String base, String value) { try { String resolved = new java.net.URI(base).resolve(value.trim()).toString(); return resolved.startsWith("https://") || resolved.startsWith("http://") ? resolved : null; } catch (Exception ignored) { return null; } }

  private static String htmlMeta(String html, String key) {
    if (html == null) return null;
    Matcher tags = Pattern.compile("<meta\\b[^>]*>", Pattern.CASE_INSENSITIVE).matcher(html);
    while (tags.find()) {
      String tag = tags.group();
      String name = htmlAttr(tag, "property"); if (name == null) name = htmlAttr(tag, "name");
      if (name != null && key.equalsIgnoreCase(name)) {
        String content = htmlAttr(tag, "content");
        if (content != null && !content.trim().isEmpty()) return content.trim().replace("&amp;", "&");
      }
    }
    return null;
  }

  private static String htmlAttr(String tag, String name) {
    Matcher m = Pattern.compile("\\b" + Pattern.quote(name) + "\\s*=\\s*(['\\\"])(.*?)\\1", Pattern.CASE_INSENSITIVE).matcher(tag);
    return m.find() ? m.group(2) : null;
  }

  /** Card artwork spans the row's full width, so it needs more resolution than a
   *  list thumbnail — decoding it at THUMB_MAX_PX would visibly blur the hero. */
  private static final int CARD_ART_MAX_PX = 640;
  private static final int LINK_ART_CACHE_MAX = 12;

  private static Bitmap decodeCardArt(byte[] raw) {
    try {
      BitmapFactory.Options bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
      int sample = 1;
      int longest = Math.max(bounds.outWidth, bounds.outHeight);
      while (longest / sample > CARD_ART_MAX_PX) sample *= 2;
      BitmapFactory.Options opts = new BitmapFactory.Options();
      opts.inSampleSize = sample;
      return BitmapFactory.decodeByteArray(raw, 0, raw.length, opts);
    } catch (Exception e) {
      return null;
    }
  }

  /** Bounded insert — full-size artwork is far heavier than a row thumbnail, so
   *  the cache drops its oldest entry rather than growing with history length. */
  private synchronized void cacheLinkArt(String url, Bitmap art) {
    if (linkArtCache.size() >= LINK_ART_CACHE_MAX && !linkArtCache.containsKey(url)) {
      java.util.Iterator<String> it = linkArtCache.keySet().iterator();
      if (it.hasNext()) { it.next(); it.remove(); }
    }
    linkArtCache.put(url, art);
  }

  private Bitmap loadPreviewBitmap(String url) {
    try (Response response = previewHttp().newCall(new Request.Builder().url(url)
        .header("User-Agent", PREVIEW_UA).build()).execute()) {
      if (response.isSuccessful() && response.body() != null) return decodeCardArt(response.body().bytes());
    } catch (Exception ignored) {}
    return null;
  }

  /** Last-resort title when a page publishes no card metadata at all. */
  private static String htmlTitleTag(String html) {
    if (html == null) return null;
    Matcher m = Pattern.compile("<title[^>]*>(.*?)</title>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(html);
    if (!m.find()) return null;
    String value = m.group(1).replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", "\"").trim();
    return value.isEmpty() ? null : value;
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

  /** Feedback line: the dock's own snackbar while it is open (a system toast
   *  would pop up behind/over the sheet), a plain Toast otherwise. */
  private void toast(String msg) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post(() -> toast(msg));
      return;
    }
    NotesDock d = dock;
    if (d != null && d.isOpen()) {
      d.snack(msg);
      return;
    }
    try {
      Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    } catch (Exception ignored) {
    }
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
        it.put("pinned", e.pinned);
        it.put("folder", e.folder == null ? "" : e.folder);
        it.put("tags", new org.json.JSONArray(e.tags));
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
    if (stopping || !ClipboardBridge.backgroundEnabled(this)) return;
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
    syncWorker.shutdownNow();
    contentWorker.shutdownNow();
    main.removeCallbacks(reconnect);
    if (cm != null && netCallback != null) {
      try { cm.unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
    }
    netCallback = null;
    if (screenOnReceiver != null) {
      try { unregisterReceiver(screenOnReceiver); } catch (Exception ignored) {}
      screenOnReceiver = null;
    }
    if (recording) { try { if (recorder != null) recorder.stop(); } catch (Exception ignored) {} }
    recording = false;
    safeReleaseRecorder();
    synchronized (this) {
      for (Bitmap b : thumbs.values()) { if (b != null) b.recycle(); }
      thumbs.clear();
    }
    if (socket != null) socket.cancel();
    socket = null;
    if (http != null) {
      http.dispatcher().cancelAll();
      http.dispatcher().executorService().shutdown();
    }
    http = null;
    if (dock != null) {
      dock.destroy();
      dock = null;
    }
    if (bubble != null && wm != null) {
      try {
        wm.removeView(bubble);
      } catch (Exception ignored) {
      }
      bubble = null;
    }
    if (fsProbe != null && wm != null) {
      try {
        wm.removeView(fsProbe);
      } catch (Exception ignored) {
      }
      fsProbe = null;
    }
    stopNativeStt();
  }
}
