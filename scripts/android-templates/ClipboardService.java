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
import android.graphics.drawable.BitmapDrawable;
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
import android.text.method.LinkMovementMethod;
import android.text.util.Linkify;
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
public class ClipboardService extends Service {
  private static final Pattern HTTP_LINK = Pattern.compile("https?://[^\\s<>()]+", Pattern.CASE_INSENSITIVE);
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
  private ScrollView dockScroll;
  // ---- view recycling for the history list -----------------------------------
  // The dock used to removeAllViews() + re-inflate every visible row on every
  // refresh (relay notices, thumbnail decode, pin/delete toggles…) — ~10 Views
  // per row × ~30 rendered rows per refresh, immediately GC'd. That churn was
  // the lag. Rows are now built once and REBOUND: liveRows keeps the row View
  // (and its RowHolder tag) for every id currently on screen; on a refresh we
  // detach survivors, drop the rest into per-kind pools, then re-add survivors
  // in order and pull fresh rows from the pools only for genuinely new ids.
  // listeners are wired once in buildRow and read holder.entry at click time, so
  // a rebind never allocates a lambda.
  private final HashMap<String, View> liveRows = new HashMap<>();
  private final ArrayList<View> poolText = new ArrayList<>();
  private final ArrayList<View> poolImage = new ArrayList<>();
  private static final int ROW_POOL_MAX = 24;
  private TextView panelStatusText; // status label in floating panel header
  private boolean socketConnected;
  private WindowManager.LayoutParams panelLp;
  // Which screen edge the pin/dock lives on. The dock slides in from this side.
  private boolean pinOnRight = true;
  private final Handler main = new Handler(Looper.getMainLooper());
  // Relay history is delivered one item at a time. Coalescing its redraws keeps
  // the floating dock's input responsive while socket and crypto work stay off
  // the main thread.
  private boolean panelRefreshQueued;
  /** Timestamp of the last list gesture; never rebuild rows under an active fling. */
  private long lastDockScrollAt;
  private final Runnable renderPanel = () -> {
    panelRefreshQueued = false;
    if (panel != null && panelList != null) {
      // A render is deferred until a fling settles so the compositor's scroll
      // path stays free even while a relay catch-up or image thumbnail lands in
      // the background. (renderList now recycles rows rather than rebuilding
      // them all, but re-adding/detaching during a fling still costs layout.)
      long sinceScroll = SystemClock.uptimeMillis() - lastDockScrollAt;
      if (sinceScroll < 180) {
        panelRefreshQueued = false;
        main.postDelayed(this::refreshPanelIfOpen, 180 - sinceScroll);
        return;
      }
      int oldY = dockScroll == null ? 0 : dockScroll.getScrollY();
      populateFolderStrip();
      panelList.removeAllViews();
      renderList(panelList);
      if (dockScroll != null && oldY > 0) {
        dockScroll.post(() -> dockScroll.scrollTo(0, oldY));
      }
    }
  };
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
  // The dock rebuilds rows frequently; cache preview metadata and coalesce
  // requests so refreshes cannot create endless loading requests.
  private final HashMap<String, LinkPreviewInfo> linkPreviewCache = new HashMap<>();
  private final HashSet<String> linkPreviewLoading = new HashSet<>();
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
    String text;         // editable (notes) — updated in place by edits
    // A save/edit is a meaningful touch, so it gets a fresh timestamp and moves
    // this entry to the top on every device.
    long createdAtMs;
    final String deviceId;
    boolean pinned;      // toggled by the pin button / relay pin notices
    String folder = "";  // folder/list label ("" = unfiled)
    final ArrayList<String> tags = new ArrayList<>();
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

  /** Cached native link-card metadata. Kept deliberately small: card artwork is
   * fetched separately and may legitimately be unavailable on privacy-focused sites. */
  static final class LinkPreviewInfo {
    final String title;
    final String description;
    final String image;
    final String host;
    LinkPreviewInfo(String title, String description, String image, String host) {
      this.title = title; this.description = description; this.image = image; this.host = host;
    }
  }

  /** Cached handles to a row's child views + the entry it currently shows, plus
   *  the bits bindRow needs to decide whether to touch a child (so a refresh that
   *  didn't change the body text, say, skips setText entirely). Stored as the
   *  row's tag so a pooled row keeps its holder for its whole life. */
  static final class RowHolder {
    String kind;          // "text" | "image" — fixed at build, survives pooling
    ClipEntry entry; // null while pooled
    TextView body;        // text rows only
    ImageView image;      // image rows only
    LinearLayout metaRow;
    TextView meta;        // tags + relative time (left of the action buttons)
    TextView expand;      // text rows only (null when never long)
    View linkCard;        // the preview card, when one is attached
    Button pinBtn;        // rebind updates glyph + colour
    Button folderBtn;     // rebind updates colour
    String linkUrl;       // url the current linkCard shows ("" = none)
    boolean linkPreviewOn;// dockShowLinkPreviews at last bind (card reconciles on change)
    String lastBody;      // body text last bound (skip re-setText/Linkify when unchanged)
    boolean lastHadLink;  // whether lastBody had an http link (drives configureBody)
    String lastMeta;      // meta text last bound (skip re-setText when unchanged)
    boolean expanded;     // current Show more/less state
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

  /** Screen-on = the user is back: snap out of the slow backoff immediately so
   *  the dock is fresh by the time they can tap it. */
  private void registerScreenOnReceiver() {
    if (screenOnReceiver != null) return;
    screenOnReceiver = new android.content.BroadcastReceiver() {
      @Override public void onReceive(Context ctx, Intent intent) {
        if (socket == null) forceReconnect();
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
   *  from the connectivity callback thread — the actual connect hops to `main`. */
  private void forceReconnect() {
    if (stopping) return;
    reconnectMs = 1000;
    reconnectFails = 0;
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
        reconnectFails = 0;
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
    reconnectFails++;
    long cap = reconnectFails <= FAST_ATTEMPTS ? MAX_RECONNECT_FAST_MS : MAX_RECONNECT_SLOW_MS;
    long delay = Math.min(reconnectMs, cap);
    reconnectMs = Math.min(reconnectMs * 2, cap);
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
          e.pinned = pinned;
          e.folder = folder;
          e.tags.addAll(tags);
          e.mime = v.optString("mime", "image/png");
          items.add(e);
          sortItemsLocked();
          trimItemsLocked();
        }
        if (!own && !existed) main.post(this::showNewItemAttention);
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
        e.pinned = pinned;
        e.folder = folder;
        e.tags.addAll(tags);
        items.add(e);
        sortItemsLocked();
        trimItemsLocked();
      }
      if (!own && !existed) main.post(this::showNewItemAttention);
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
    if (http == null || clipSpace.isEmpty() || httpBase.isEmpty()) return;
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
            if (bmp != null) thumbs.put(id, bmp);
          }
          if (bmp != null) main.post(ClipboardService.this::refreshPanelIfOpen);
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
        .setContentText("Tap the edge pin to view and copy it")
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

  private boolean hasSarvamKey() {
    return sarvamKey != null && !sarvamKey.trim().isEmpty();
  }

  /** Toggle voice input. With a Sarvam key: record (m4a) → Sarvam transcribe (the
   *  keyed path, better for long dictation). Without one: the phone's BUILT-IN
   *  SpeechRecognizer, so the mic always works. Needs RECORD_AUDIO — if not
   *  granted, routes the user to the app to grant it. */
  private void toggleMic(Button micBtn) {
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
    if (recording) { stopRecordingAndTranscribe(micBtn); return; }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
        && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
      toast("Grant microphone access in the app, then try again");
      openApp();
      return;
    }
    if (!hasSarvamKey()) {
      startNativeStt(micBtn);
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
      micBtn.setText("■");
      toast("Recording… tap to stop");
    } catch (Exception e) {
      recording = false;
      safeReleaseRecorder();
      toast("Mic unavailable");
    }
  }

  private void stopRecordingAndTranscribe(Button micBtn) {
    recording = false;
    micBtn.setText("…");
    try {
      if (recorder != null) { recorder.stop(); }
    } catch (Exception ignored) {
    }
    safeReleaseRecorder();
    final File f = audioFile;
    final EditText composer = dockComposer;
    if (f == null || !f.exists() || http == null) {
      micBtn.setText("🎤");
      return;
    }
    new Thread(() -> {
      String text = transcribeViaSarvam(f);
      main.post(() -> {
        if (dockMic instanceof Button) ((Button) dockMic).setText("🎤");
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

  /** Built-in (on-device / Google) speech recognition — the keyless voice path.
   *  Appends the final transcript to the composer, same as the Sarvam flow. */
  private void startNativeStt(Button micBtn) {
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
            if (micBtn != null) micBtn.setText("…");
          }
          @Override public void onError(int error) {
            boolean noSpeech = error == android.speech.SpeechRecognizer.ERROR_NO_MATCH
                || error == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
            if (!noSpeech) toast("Speech recognition failed (" + error + ")");
            else toast("Didn't catch that — try again");
            finishNativeStt(micBtn);
          }
          @Override public void onResults(android.os.Bundle results) {
            ArrayList<String> out = results == null ? null
                : results.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
            if (out != null && !out.isEmpty() && dockComposer != null) {
              String cur = dockComposer.getText().toString();
              String t = out.get(0);
              dockComposer.setText(cur.isEmpty() ? t : cur + " " + t);
              dockComposer.setSelection(dockComposer.getText().length());
            }
            finishNativeStt(micBtn);
          }
          @Override public void onPartialResults(android.os.Bundle partialResults) {}
          @Override public void onEvent(int eventType, android.os.Bundle params) {}
        });
        nativeListening = true;
        if (micBtn != null) micBtn.setText("■");
        speechRec.startListening(intent);
        toast("Listening…");
      } catch (Exception e) {
        finishNativeStt(micBtn);
        toast("Mic unavailable");
      }
    });
  }

  private void finishNativeStt(Button micBtn) {
    nativeListening = false;
    if (micBtn != null) micBtn.setText("🎤");
    else if (dockMic instanceof Button) ((Button) dockMic).setText("🎤");
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
      finishNativeStt(dockMic instanceof Button ? (Button) dockMic : null);
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
    PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

    Notification.Builder b =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this);
    return b.setSmallIcon(getApplicationInfo().icon)
        .setContentTitle("Shared notes")
        .setContentText("Tap the edge pin to view recent notes")
        .setContentIntent(pi)
        .setOngoing(true)
        .build();
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

  private void setHiddenForFullscreen(boolean fullscreen) {
    if (hiddenForFullscreen == fullscreen) return;
    hiddenForFullscreen = fullscreen;
    main.post(() -> {
      if (bubble == null) return;
      if (fullscreen) {
        bubble.animate().alpha(0f).setDuration(180)
            .withEndAction(() -> { if (hiddenForFullscreen && bubble != null) bubble.setVisibility(View.GONE); })
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
    private final Runnable armDrag = () -> {
      if (!touchActive || movedBeforeHold || bubble == null) return;
      holding = true;
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
          touchActive = true;
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
          bubbleLp.y = Math.max(0, Math.min(m.heightPixels - dp(PIN_HEIGHT), startY + dy));
          try {
            wm.updateViewLayout(bubble, bubbleLp);
          } catch (Exception ignored) {
          }
          return true;
        }
        case MotionEvent.ACTION_UP:
        case MotionEvent.ACTION_CANCEL:
          touchActive = false;
          main.removeCallbacks(armDrag);
          if (holding) {
            settlePin();
          } else if (!movedBeforeHold && System.currentTimeMillis() - downTime < 420) {
            showPanel();
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
  private View dockMic;          // mic button (Sarvam-keyed or built-in recognizer)
  private Button dockAddBtn;     // flips Add ↔ Save while editing a note
  private String dockFilter = ""; // native search text
  private boolean dockShowLinkPreviews = true;
  // Filter chip: "" = all, "text", "image". Mirrors the desktop panel's All / Text /
  // Images tabs so the floating dock has the same content-type filtering.
  private String dockFilterKind = "";
  // Tag filter: null = All, "" = Untagged, else a tag. New items inherit the
  // selected tag, and each existing item can hold multiple tags.
  private String dockFolderFilter = null;
  private LinearLayout dockFolderStrip; // rebuilt when folders change
  // Note editing: non-null while the composer is editing this entry in place.
  private String dockEditingId = null;
  // Folder chooser: non-null while the list shows "move to folder" options for
  // this entry instead of the history.
  private String folderPickForId = null;
  // Lazy render window: only the first N matching rows are inflated as Views; grows
  // by RENDER_PAGE as the user scrolls near the bottom so a 300-item history doesn't
  // inflate hundreds of rows up front. Reset when the filter/search changes.
  private int renderLimit = RENDER_PAGE;

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
    dockShowLinkPreviews = getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
        .getBoolean("dockShowLinkPreviews", true);

    DisplayMetrics m = getResources().getDisplayMetrics();
    final int widthPx = Math.min(dp(372), m.widthPixels - dp(24));
    final int heightPx = m.heightPixels;

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    GradientDrawable card = new GradientDrawable();
    // Translucent frosted fill (not fully transparent) so text stays readable over
    // whatever app is behind. Rounded only on the inner edge (it hugs a screen side).
    card.setColor(0xF70A0D17);
    float r = dp(22);
    card.setCornerRadii(pinOnRight
        ? new float[] {r, r, 0, 0, 0, 0, r, r}
        : new float[] {0, 0, r, r, r, r, 0, 0});
    card.setStroke(dp(1), 0x557C5CFF);
    root.setBackground(card);
    root.setElevation(dp(16));
    root.setPadding(dp(14), dp(16), dp(14), dp(14));

    root.addView(buildDockHeader());
    root.addView(buildDockComposer());

    // Search box (parity with the app screen's history filter).
    final EditText searchField = new EditText(this);
    searchField.setHint("Search notes, links and tags");
    searchField.setHintTextColor(0xFF64748B);
    searchField.setTextColor(0xFFE2E8F0);
    searchField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
    searchField.setSingleLine(true);
    GradientDrawable sBg = new GradientDrawable();
    sBg.setColor(0x14FFFFFF);
    sBg.setCornerRadius(dp(9));
    searchField.setBackground(sBg);
    searchField.setPadding(dp(9), dp(4), dp(9), dp(4));
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
    searchLp.topMargin = dp(6);
    root.addView(searchField, searchLp);

    // All / Text / Images filter strip — parity with the desktop panel's tabs so
    // the dock can browse by content type. Each chip resets the render window so
    // switching filter shows the top of the new set.
    root.addView(buildFilterStrip());

    // Folder chips (All · Unfiled · one per folder) — the notes "lists" selector,
    // parity with the app screens. Hidden until a folder exists.
    root.addView(buildFolderStrip());

    // Scrollable history.
    ScrollView scroll = new ScrollView(this);
    scroll.setVerticalScrollBarEnabled(false);
    // Lazy-render: as the user approaches the bottom, grow the render window by
    // RENDER_PAGE so a 300-item history doesn't inflate hundreds of views up front.
    scroll.getViewTreeObserver().addOnScrollChangedListener(() -> {
      lastDockScrollAt = SystemClock.uptimeMillis();
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
    // Populate the history BEFORE the window is shown so there's no empty→filled
    // pop-in during the slide.
    renderList(list);
    // Set the slide-in offset + transparent state BEFORE attaching: View transform
    // properties persist while detached, so the very first frame the compositor
    // draws is already off-screen and faded. Setting them AFTER addView (the old
    // order) drew one frame at the final position, then jumped to the offset to
    // animate — that one-frame jump was the open flicker.
    root.setTranslationX(pinOnRight ? widthPx : -widthPx);
    root.setAlpha(0f);
    try {
      wm.addView(root, panelLp);
      root.animate()
          .translationX(0f).alpha(1f)
          .setDuration(220)
          .setInterpolator(new android.view.animation.DecelerateInterpolator(1.6f))
          .start();
    } catch (Exception ignored) {
      panel = null;
    }
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
    title.setText("Notes");
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

    Button previews = new Button(this);
    previews.setText(dockShowLinkPreviews ? "Preview on" : "Preview off");
    previews.setTextColor(dockShowLinkPreviews ? 0xFF67E8F9 : 0xFF64748B);
    previews.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9);
    previews.setAllCaps(false);
    previews.setStateListAnimator(null);
    previews.setBackgroundColor(Color.TRANSPARENT);
    previews.setPadding(0, 0, 0, 0);
    previews.setOnClickListener((v) -> {
      dockShowLinkPreviews = !dockShowLinkPreviews;
      getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE).edit()
          .putBoolean("dockShowLinkPreviews", dockShowLinkPreviews).apply();
      refreshPanelIfOpen();
    });
    header.addView(previews, new LinearLayout.LayoutParams(dp(72), dp(30)));

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
      chip.setPadding(0, dp(2), 0, dp(2));
      chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
      chip.setMinWidth(0);
      chip.setMinimumWidth(0);
      chip.setMinHeight(0);
      chip.setMinimumHeight(0);
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

  /** Horizontally-scrollable folder chips (All · Unfiled · one per folder). */
  private View buildFolderStrip() {
    android.widget.HorizontalScrollView sv = new android.widget.HorizontalScrollView(this);
    sv.setHorizontalScrollBarEnabled(false);
    LinearLayout strip = new LinearLayout(this);
    strip.setOrientation(LinearLayout.HORIZONTAL);
    sv.addView(strip);
    dockFolderStrip = strip;
    populateFolderStrip();
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lp.topMargin = dp(5);
    sv.setLayoutParams(lp);
    return sv;
  }

  /** (Re)build the folder chips to match the current folder set + selection.
   *  Must run on the main thread. */
  private void populateFolderStrip() {
    LinearLayout strip = dockFolderStrip;
    if (strip == null) return;
    strip.removeAllViews();
    ArrayList<String> folders;
    synchronized (this) {
      folders = foldersLocked();
    }
    if (folders.isEmpty() && dockFolderFilter == null) return; // nothing to filter
    addFolderChip(strip, "All", null);
    addFolderChip(strip, "Untagged", "");
    for (String f : folders) addFolderChip(strip, f, f);
  }

  private void addFolderChip(LinearLayout strip, String label, String value) {
    Button chip = new Button(this);
    chip.setText(label);
    chip.setAllCaps(false);
    chip.setStateListAnimator(null);
    chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
    chip.setPadding(dp(8), dp(2), dp(8), dp(2));
    chip.setMinWidth(0);
    chip.setMinimumWidth(0);
    chip.setMinHeight(0);
    chip.setMinimumHeight(0);
    boolean active = value == null ? dockFolderFilter == null : value.equals(dockFolderFilter);
    GradientDrawable bg = new GradientDrawable();
    bg.setCornerRadius(dp(8));
    bg.setColor(active ? 0xFF7C5CFF : 0x10FFFFFF);
    chip.setBackground(bg);
    chip.setTextColor(active ? Color.WHITE : 0xFF94A3B8);
    chip.setOnClickListener((v) -> {
      dockFolderFilter = value;
      renderLimit = RENDER_PAGE;
      populateFolderStrip();
      refreshPanelIfOpen();
    });
    LinearLayout.LayoutParams lp =
        new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(24));
    if (strip.getChildCount() > 0) lp.leftMargin = dp(4);
    strip.addView(chip, lp);
  }

  /** Rebuild the folder chips from any thread. */
  private void rebuildFolderStripIfOpen() {
    main.post(this::populateFolderStrip);
  }

  /** Every distinct non-empty folder across items, alphabetical. Caller holds `this`. */
  private ArrayList<String> foldersLocked() {
    java.util.TreeSet<String> set = new java.util.TreeSet<>(String.CASE_INSENSITIVE_ORDER);
    for (ClipEntry e : items) {
      for (String tag : e.tags) if (!tag.trim().isEmpty()) set.add(tag.trim());
    }
    return new ArrayList<>(set);
  }

  /** Move an entry to a folder ('' = unfiled) locally + broadcast the bare folder
   *  notice (relay flips + rebroadcasts — same shape as pin). */
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
    rebuildFolderStripIfOpen();
    refreshPanelIfOpen();
    toast(removed ? "Tag removed" : "Tag added");
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

  /** Begin editing a text note in the composer (Add becomes Save). */
  private void startEditEntry(ClipEntry e) {
    if (e == null || dockComposer == null || !"text".equals(e.kind)) return;
    dockEditingId = e.id;
    dockComposer.setText(e.text == null ? "" : e.text);
    dockComposer.setSelection(dockComposer.getText().length());
    dockComposer.requestFocus();
    if (dockAddBtn != null) dockAddBtn.setText("Save");
    toast("Editing — Save when done");
  }

  /** Composer keeps text and actions on one row while short, then grows with its
   * content up to five lines without moving the controls out of reach. */
  private LinearLayout buildDockComposer() {
    LinearLayout wrap = new LinearLayout(this);
    wrap.setOrientation(LinearLayout.VERTICAL);
    LinearLayout.LayoutParams wrapLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    wrapLp.topMargin = dp(10);
    wrap.setLayoutParams(wrapLp);

    final EditText composer = new EditText(this);
    dockComposer = composer;
    composer.setHint("Type a note…");
    composer.setHintTextColor(0xFF64748B);
    composer.setTextColor(0xFFE2E8F0);
    composer.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    composer.setSingleLine(false);
    // Overlay windows do not inherit the Activity's usual text-selection setup.
    // Keep the editable field focusable/long-clickable so Android shows Select,
    // Copy, Paste and Share in the native floating context toolbar.
    composer.setTextIsSelectable(true);
    composer.setLongClickable(true);
    composer.setMinLines(1);
    composer.setMaxLines(5);
    composer.setHorizontallyScrolling(false);
    composer.setGravity(Gravity.TOP | Gravity.START);
    GradientDrawable fieldBg = new GradientDrawable();
    fieldBg.setColor(0x14FFFFFF);
    fieldBg.setCornerRadius(dp(10));
    composer.setBackground(fieldBg);
    composer.setPadding(dp(9), dp(6), dp(9), dp(6));
    // Restore the unsent draft (survives dock close / service restart) and keep
    // it persisted on every keystroke. Edits don't touch the draft slot.
    String draft = getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
        .getString("draftText", "");
    if (draft != null && !draft.isEmpty()) {
      composer.setText(draft);
      composer.setSelection(composer.getText().length());
    }
    composer.addTextChangedListener(new android.text.TextWatcher() {
      @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
      @Override public void onTextChanged(CharSequence s, int a, int b, int c) {}
      @Override public void afterTextChanged(android.text.Editable s) {
        if (dockEditingId != null) return; // edits are not drafts
        getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
            .edit().putString("draftText", s.toString()).apply();
      }
    });
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
    final LinearLayout actions = new LinearLayout(this);
    actions.setOrientation(LinearLayout.HORIZONTAL);
    actions.setGravity(Gravity.BOTTOM | Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    actionsLp.topMargin = dp(6);
    actions.setLayoutParams(actionsLp);

    final LinearLayout.LayoutParams composerLp = new LinearLayout.LayoutParams(
        0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    composerLp.rightMargin = dp(4);
    actions.addView(composer, composerLp);

    final LinearLayout controls = new LinearLayout(this);
    controls.setOrientation(LinearLayout.HORIZONTAL);
    controls.setGravity(Gravity.CENTER_VERTICAL);
    final LinearLayout.LayoutParams controlsLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    controlsLp.leftMargin = dp(4);

    // Compact action row: paste (text OR image) · upload · mic · Add/Save.
    Button pasteBtn = new Button(this);
    pasteBtn.setText("📋");
    styleCompactBtn(pasteBtn, false);
    pasteBtn.setOnClickListener((v) -> pasteFromClipboard());
    controls.addView(pasteBtn, new LinearLayout.LayoutParams(dp(38), dp(28)));

    // Upload button: opens the photo gallery via a transparent proxy Activity
    // (services can't get an Activity result callback). Picks an image, hands the
    // content:// URI back here via ACTION_UPLOAD_IMAGE. Full-res image sync.
    Button uploadBtn = new Button(this);
    uploadBtn.setText("🖼");
    styleCompactBtn(uploadBtn, false);
    uploadBtn.setOnClickListener((v) -> launchImagePicker());
    LinearLayout.LayoutParams uploadLp = new LinearLayout.LayoutParams(dp(38), dp(28));
    uploadLp.leftMargin = dp(4);
    controls.addView(uploadBtn, uploadLp);

    // Mic: Sarvam when a key is set; the phone's built-in recognizer otherwise —
    // so voice input always exists.
    Button mic = new Button(this);
    mic.setText("🎤");
    styleCompactBtn(mic, false);
    dockMic = mic;
    mic.setOnClickListener((v) -> toggleMic((Button) v));
    LinearLayout.LayoutParams micLp = new LinearLayout.LayoutParams(dp(38), dp(28));
    micLp.leftMargin = dp(4);
    controls.addView(mic, micLp);

    Button addBtn = new Button(this);
    dockAddBtn = addBtn;
    addBtn.setText(dockEditingId != null ? "Save" : "Add");
    styleCompactBtn(addBtn, true);
    addBtn.setOnClickListener((v) -> {
      String t = composer.getText().toString().trim();
      if (t.isEmpty()) return;
      if (dockEditingId != null) {
        // Save an in-place edit: same id + original timestamp → every device
        // replaces its copy without changing the note's position.
        ClipEntry target = null;
        synchronized (this) {
          for (ClipEntry e : items) {
            if (dockEditingId.equals(e.id)) { target = e; break; }
          }
        }
        if (target != null) {
          target.text = t;
          target.createdAtMs = System.currentTimeMillis();
          synchronized (this) { sortItemsLocked(); }
          sendTextItem(target.id, t, isoFromMs(target.createdAtMs),
              new ArrayList<>(target.tags), target.pinned);
        }
        dockEditingId = null;
        addBtn.setText("Add");
        String saved = getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
            .getString("draftText", "");
        composer.setText(saved == null ? "" : saved);
        refreshPanelIfOpen();
        toast("Saved");
        return;
      }
      addTextLocalAndSend(t);
      composer.setText("");
      getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE)
          .edit().remove("draftText").apply();
      rebuildFolderStripIfOpen();
      toast("Sent");
    });
    LinearLayout.LayoutParams addLp = new LinearLayout.LayoutParams(dp(54), dp(28));
    addLp.leftMargin = dp(4);
    controls.addView(addBtn, addLp);
    actions.addView(controls, controlsLp);

    final boolean[] composerExpanded = {composer.getText().length() > 0};
    final Runnable reflowComposer = () -> {
      boolean expanded = composer.getText().length() > 0;
      if (composerExpanded[0] == expanded) return;
      composerExpanded[0] = expanded;
      actions.setOrientation(expanded ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
      composerLp.width = expanded ? LinearLayout.LayoutParams.MATCH_PARENT : 0;
      composerLp.weight = expanded ? 0f : 1f;
      composerLp.rightMargin = expanded ? 0 : dp(4);
      controlsLp.topMargin = expanded ? dp(5) : 0;
      controlsLp.leftMargin = expanded ? 0 : dp(4);
      composer.setMaxLines(expanded ? 5 : 1);
      actions.requestLayout();
    };
    composer.addTextChangedListener(new android.text.TextWatcher() {
      @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
      @Override public void onTextChanged(CharSequence s, int a, int b, int c) {}
      @Override public void afterTextChanged(android.text.Editable s) { reflowComposer.run(); }
    });
    if (composerExpanded[0]) {
      composerExpanded[0] = false;
      reflowComposer.run();
    } else {
      composer.setMaxLines(1);
    }

    wrap.addView(actions);
    return wrap;
  }

  /** Paste whatever the OS clipboard holds: an image → image note, else text →
   *  text note (deduped against the newest note so re-taps don't spam). */
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
    styleCompactBtn(copyLast, true);
    copyLast.setOnClickListener((v) -> {
      String t = newestText();
      if (t == null) { toast("Nothing to copy yet"); return; }
      setOsClipboard(t);
      toast("Copied");
    });
    footer.addView(copyLast, new LinearLayout.LayoutParams(0, dp(30), 1f));

    Button openApp = new Button(this);
    openApp.setText("Open app");
    styleCompactBtn(openApp, false);
    LinearLayout.LayoutParams openLp = new LinearLayout.LayoutParams(0, dp(30), 1f);
    openLp.leftMargin = dp(6);
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
      bubbleLp.x = pinOnRight ? m.widthPixels - dp(PIN_TOUCH_W) : 0;
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
    dockAddBtn = null;
    dockScroll = null;
    dockFolderStrip = null;
    dockEditingId = null;
    folderPickForId = null;
    panelRefreshQueued = false;
    main.removeCallbacks(renderPanel);
    // Return built rows to their pools (capped) so the next open reuses them
    // instead of rebuilding — the panel View tree is about to leave the WindowManager.
    recycleAllRows();
    final boolean right = pinOnRight;
    // Fall back to the laid-out width if getWidth() is 0 (rapid open→close before
    // a layout pass) — a 0 slide would just alpha-blink instead of sliding out.
    int width = p.getWidth();
    if (width <= 0 && panelLp != null) width = panelLp.width;
    final int w = width;
    // Cancel any in-flight enter animation so the exit starts from the current
    // position instead of fighting it (a visible stutter when you close mid-open).
    p.animate().cancel();
    p.animate()
        .translationX(right ? w : -w).alpha(0f)
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

  /** If the panel is open, batch history refreshes so a cold relay replay never
   * rebuilds the entire view tree once per received item. */
  private void refreshPanelIfOpen() {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post(this::refreshPanelIfOpen);
      return;
    }
    if (panel == null || panelList == null || panelRefreshQueued) return;
    panelRefreshQueued = true;
    main.postDelayed(renderPanel, 48);
  }

  /** No-op hook kept for startSync (mic is always visible now — Sarvam when a key
   *  is set, the built-in recognizer otherwise). */
  private void refreshComposerIfOpen() {}

  /** Items that pass the search text filter, the All/Text/Images kind filter AND
   *  the folder filter, in display order (pinned first, then newest). Caller holds
   *  `this`. */
  private ArrayList<ClipEntry> filteredLocked() {
    ArrayList<ClipEntry> out = new ArrayList<>();
    for (ClipEntry e : items) {
      if (!dockFilterKind.isEmpty() && !dockFilterKind.equals(e.kind)) continue;
      if (dockFolderFilter != null) {
        if (dockFolderFilter.isEmpty()) {
          if (!e.tags.isEmpty()) continue;
        } else if (!hasTag(e, dockFolderFilter)) continue;
      }
      if (dockFilter.isEmpty()) { out.add(e); continue; }
      if ("text".equals(e.kind) && e.text != null
          && e.text.toLowerCase(Locale.US).contains(dockFilter)) {
        out.add(e);
        continue;
      }
      for (String tag : e.tags) if (tag.toLowerCase(Locale.US).contains(dockFilter)) {
        out.add(e);
        break;
      }
    }
    return out;
  }

  /** Total matching rows (used by the lazy-render scroll listener to know when to
   *  stop growing renderLimit). Caller holds `this`. */
  private int countShownLocked() {
    return filteredLocked().size();
  }

  private String firstHttpLink(String text) {
    if (text == null) return null;
    Matcher m = HTTP_LINK.matcher(text);
    return m.find() ? m.group() : null;
  }

  /** Native overlay counterpart to the web link card. OG image wins, then a
   *  Twitter-card image, then the site's favicon. Returns the card View (the
   *  caller inserts it into the row); the card itself opens the URL on tap.
   *  Reuses the link cache + loading guard, so re-adding a card for the same url
   *  (row rebound) is instant and never re-fetches. */
  private View buildLinkCard(final String url) {
    final TextView card = new TextView(this);
    card.setText("Loading link preview…");
    card.setTextColor(0xFFBAE6FD);
    card.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
    card.setMaxLines(3);
    card.setPadding(dp(9), dp(7), dp(9), dp(7));
    GradientDrawable bg = new GradientDrawable(); bg.setColor(0x1638BDF8); bg.setCornerRadius(dp(9)); card.setBackground(bg);
    card.setOnClickListener((v) -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {} });
    LinkPreviewInfo cached;
    synchronized (this) { cached = linkPreviewCache.get(url); }
    if (cached != null) {
      card.setText(cached.title + (cached.description.isEmpty() ? "" : "\n" + cached.description) + "\n" + cached.host);
      fetchLinkArt(cached.image == null ? "https://www.google.com/s2/favicons?domain=" + Uri.encode(cached.host) + "&sz=128" : cached.image, card);
      return card;
    }
    synchronized (this) {
      // A row can be rebound while the same preview is loading. Show a stable
      // domain card instead of starting another request (or showing a stuck spinner).
      if (!linkPreviewLoading.add(url)) { card.setText(hostForLink(url)); return card; }
    }
    new Thread(() -> {
      String title = null, description = null, image = null;
      try (Response response = previewHttp().newCall(new Request.Builder().url(url)
          .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36")
          .header("Accept", "text/html,application/xhtml+xml").build()).execute()) {
        String page = readPreviewHtml(response);
        title = htmlMeta(page, "og:title"); description = htmlMeta(page, "og:description"); image = htmlMeta(page, "og:image");
        if (image == null) image = htmlMeta(page, "twitter:image");
        if (title == null) title = htmlMeta(page, "twitter:title");
        if (description == null) description = htmlMeta(page, "twitter:description");
      } catch (Exception ignored) {}
      final String host; try { host = Uri.parse(url).getHost(); } catch (Exception e) { main.post(() -> { synchronized (this) { linkPreviewLoading.remove(url); } card.setText(url); }); return; }
      final String t = title == null || title.trim().isEmpty() ? (host == null ? hostForLink(url) : host) : title.trim();
      final String d = description == null ? "" : description.trim();
      final String art = image == null ? null : absoluteLink(url, image);
      final LinkPreviewInfo info = new LinkPreviewInfo(t, d, art, host == null ? hostForLink(url) : host);
      main.post(() -> { synchronized (this) { linkPreviewLoading.remove(url); linkPreviewCache.put(url, info); } card.setText(info.title + (info.description.isEmpty() ? "" : "\n" + info.description) + "\n" + info.host); fetchLinkArt(info.image == null ? "https://www.google.com/s2/favicons?domain=" + Uri.encode(info.host) + "&sz=128" : info.image, card); });
    }, "gt-link-preview").start();
    return card;
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

  private void fetchLinkArt(String url, TextView card) {
    if (url == null || url.isEmpty()) return;
    new Thread(() -> {
      Bitmap bmp = null;
      try (Response response = previewHttp().newCall(new Request.Builder().url(url).build()).execute()) {
        if (response.isSuccessful() && response.body() != null) bmp = decodeThumb(response.body().bytes());
      } catch (Exception ignored) {}
      final Bitmap art = bmp;
      if (art != null) main.post(() -> {
        BitmapDrawable d = new BitmapDrawable(getResources(), art);
        d.setBounds(0, 0, dp(52), dp(52));
        card.setCompoundDrawables(d, null, null, null);
        card.setCompoundDrawablePadding(dp(8));
      });
    }, "gt-link-art").start();
  }

  /** Populate the list with the matching items (search + kind filter), rendering
   *  only the first {@link #renderLimit} rows so a 300-item history doesn't inflate
   *  hundreds of views up front — the scroll listener grows renderLimit as the user
   *  approaches the bottom. Text rows tap-to-copy; image rows show a thumbnail.
   *  Each row carries a Pin and a Share action (parity with the desktop panel). */
  private void renderList(LinearLayout list) {
    // Folder-chooser mode: a row's 📁 was tapped — show the move targets instead
    // of the history until a pick or cancel. Rendered directly (small + rare); the
    // shared removeAllViews() below already detached recycled rows, and the
    // liveRows cache is reused when history returns.
    if (folderPickForId != null) {
      ClipEntry target = null;
      synchronized (this) {
        for (ClipEntry e : items) {
          if (folderPickForId.equals(e.id)) { target = e; break; }
        }
      }
      if (target != null) {
        list.removeAllViews();
        recycleAllRows();
        renderFolderChooser(list, target);
        return;
      }
      folderPickForId = null;
    }
    ArrayList<ClipEntry> snapshot;
    synchronized (this) {
      snapshot = filteredLocked();
    }
    final int limit = Math.min(renderLimit, snapshot.size());

    // Build a set of ids we want on screen so survivors stay and the rest recycle.
    final java.util.HashSet<String> keep = new java.util.HashSet<>(limit);
    for (int i = 0; i < limit; i++) keep.add(snapshot.get(i).id);

    // Detach rows that dropped out of the window / filter, returning them to pools.
    // Iterate liveRows' keys (not panelList children) so the order rows were added
    // last frame doesn't matter.
    java.util.Iterator<java.util.Map.Entry<String, View>> it = liveRows.entrySet().iterator();
    while (it.hasNext()) {
      java.util.Map.Entry<String, View> me = it.next();
      if (!keep.contains(me.getKey())) {
        View v = me.getValue();
        if (v.getParent() == list) list.removeView(v);
        RowHolder h = (RowHolder) v.getTag();
        String kind = rowKindOf(v); // capture kind BEFORE nulling entry (rowKindOf reads it)
        if (h != null) h.entry = null;
        poolForKind(kind).add(v);
        it.remove();
      }
    }
    // Cap pools so a one-time huge history can't wedge memory forever.
    trimPool(poolText);
    trimPool(poolImage);

    // removeAllViews drops section labels/dividers AND detaches surviving rows
    // (they're kept alive in liveRows); we re-add them in order below.
    list.removeAllViews();

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
      // Reuse the row we already built for this id, else pull one from the right
      // pool (or build fresh). bindRow then refreshes only the visuals that moved.
      View row = liveRows.get(e.id);
      if (row == null) {
        row = obtainRow(e.kind);
        liveRows.put(e.id, row);
      }
      bindRow(row, e, now);
      LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
      rowLp.bottomMargin = dp(6);
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

  /** Which pool a row belongs to. Read from the holder's fixed kind (NOT the
   *  entry, which may already be nulled during recycling). */
  private static String rowKindOf(View row) {
    RowHolder h = (RowHolder) row.getTag();
    return h != null && h.kind != null ? h.kind : "text";
  }
  private ArrayList<View> poolForKind(String kind) {
    return "image".equals(kind) ? poolImage : poolText;
  }
  private void trimPool(ArrayList<View> pool) {
    while (pool.size() > ROW_POOL_MAX) pool.remove(pool.size() - 1);
  }

  /** Pop a row of this kind from its pool if one is free, else build a fresh one.
   *  A pooled row keeps its built views + wired listeners, but its diff-cache
   *  (lastBody/lastMeta/…) is cleared so the next bindRow fully repopulates it
   *  for the new entry rather than trusting a stale match. */
  private View obtainRow(String kind) {
    ArrayList<View> pool = poolForKind(kind);
    View row;
    if (!pool.isEmpty()) {
      row = pool.remove(pool.size() - 1);
      RowHolder h = (RowHolder) row.getTag();
      resetHolderCache(h);
      // A row pooled via the inline renderList path may still carry its old link
      // card as a child (recycleAllRows detaches it, that path doesn't). Drop it so
      // the first bindRow starts clean — syncLinkCard adds the right card if any.
      if (h != null && h.linkCard != null && h.linkCard.getParent() == row) {
        ((LinearLayout) row).removeView(h.linkCard);
      }
      if (h != null) { h.linkCard = null; }
    } else {
      row = buildRow(kind);
    }
    return row;
  }

  /** Clear a holder's "what did I last show" fields so bindRow treats the next
   *  entry as brand new (forces setText/re-style instead of skipping). */
  private void resetHolderCache(RowHolder h) {
    if (h == null) return;
    h.lastBody = null;
    h.lastHadLink = false;
    h.lastMeta = null;
    h.linkUrl = null;
    h.linkPreviewOn = false;
    h.expanded = false;
  }

  /** Construct a row's View tree ONCE and wire its listeners to a fresh
   *  RowHolder (stored as the row's tag). Listeners read holder.entry at click
   *  time, so they never need rebinding and never capture a stale entry. The
   *  entry is left null here; bindRow sets it. */
  private View buildRow(String kind) {
    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.VERTICAL);
    row.setPadding(dp(11), dp(9), dp(11), dp(9));
    final RowHolder h = new RowHolder();
    h.kind = kind; // fixed for the row's life; survives pooling (entry is nulled)
    row.setTag(h);

    if ("image".equals(kind)) {
      ImageView iv = new ImageView(this);
      iv.setAdjustViewBounds(true);
      iv.setMaxHeight(dp(160));
      iv.setScaleType(ImageView.ScaleType.FIT_START);
      GradientDrawable ph = new GradientDrawable();
      ph.setColor(0x22FFFFFF);
      ph.setCornerRadius(dp(8));
      iv.setBackground(ph);
      iv.setMinimumHeight(dp(72));
      iv.setMinimumWidth(dp(120));
      h.image = iv;
      row.addView(iv, new LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
      h.metaRow = buildMetaActionsRowForHolder(h, "image");
      row.addView(h.metaRow);
      // Tap an image row to share; long-press opens the app (parity with before).
      row.setOnClickListener((v) -> { if (h.entry != null) shareEntry(h.entry); });
      row.setOnLongClickListener((v) -> { hidePanel(); openApp(); return true; });
      return row;
    }

    // Text row.
    final TextView body = new TextView(this);
    body.setTextColor(0xFFF1F5F9);
    body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
    body.setMaxLines(COLLAPSED_LINES);
    body.setEllipsize(android.text.TextUtils.TruncateAt.END);
    body.setLineSpacing(dp(1), 1f);
    body.setTextIsSelectable(true); // default for non-link notes; configureBody flips it off for link notes
    h.body = body;
    row.addView(body);
    h.metaRow = buildMetaActionsRowForHolder(h, "text");
    row.addView(h.metaRow);
    final TextView expand = new TextView(this);
    expand.setTextColor(0xFFA78BFA);
    expand.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
    expand.setTypeface(expand.getTypeface(), android.graphics.Typeface.BOLD);
    expand.setGravity(Gravity.CENTER_VERTICAL);
    expand.setPadding(0, dp(7), 0, dp(2));
    expand.setOnClickListener((v) -> toggleExpand(h));
    h.expand = expand;
    // Selecting or pressing the row never copies. Use the explicit Copy action.
    row.setOnLongClickListener((v) -> { toggleExpand(h); return true; });
    return row;
  }

  private static final int COLLAPSED_LINES = 6;
  private void toggleExpand(RowHolder h) {
    if (h.body == null) return;
    boolean hasExpand = h.expand != null && h.expand.getParent() != null;
    if (!hasExpand) return;
    h.expanded = !h.expanded;
    h.body.setMaxLines(h.expanded ? Integer.MAX_VALUE : COLLAPSED_LINES);
    h.body.setEllipsize(h.expanded ? null : android.text.TextUtils.TruncateAt.END);
    h.expand.setText(h.expanded ? "Show less  ↑" : "Show more  ↓");
  }

  /** Bind an image row: show the cached thumbnail if present, else keep the soft
   *  placeholder and kick the lazy fetch (refreshPanelIfOpen repaints when the
   *  thumb lands). Updates the meta label with "Image · <relative time>". */
  private void bindImageRow(RowHolder h, final ClipEntry e, long now) {
    Bitmap bmp;
    synchronized (this) { bmp = thumbs.get(e.id); }
    if (bmp != null) {
      h.image.setImageBitmap(bmp);
      h.image.setBackground(null);
    } else {
      // Placeholder until refreshPanelIfOpen repaints with the decoded thumb.
      h.image.setImageDrawable(null);
      GradientDrawable ph = new GradientDrawable();
      ph.setColor(0x22FFFFFF);
      ph.setCornerRadius(dp(8));
      h.image.setBackground(ph);
      fetchImageThumb(e.id);
    }
    bindMetaActionsRow(h.metaRow, h, "Image · " + relativeTime(e.createdAtMs, now));
  }

  /** Refresh a row's visuals to match a (possibly different) entry. Allocates
   *  nothing on the steady-state path: background is mutated in place, body text
   *  is only re-set when it changed, the link card is added/removed only when the
   *  url or the preview toggle actually moved. */
  private void bindRow(View row, final ClipEntry e, long now) {
    final RowHolder h = (RowHolder) row.getTag();
    h.entry = e;

    // --- background (pinned stroke / pending-delete tint) ---------------------
    GradientDrawable bg = (GradientDrawable) row.getBackground();
    if (bg == null) { bg = new GradientDrawable(); row.setBackground(bg); }
    bg.setColor(e.pendingDelete ? 0x33EF4444 : 0x14FFFFFF);
    bg.setCornerRadius(dp(12));
    if (e.pendingDelete) {
      bg.setStroke(dp(1), 0xFFEF4444);
    } else if (e.pinned) {
      bg.setStroke(dp(1), 0x557C5CFF);
    } else {
      bg.setStroke(0, 0); // clear any prior stroke (reused row, was pinned/deleted)
    }

    if ("image".equals(e.kind)) {
      bindImageRow(h, e, now);
      return;
    }

    // --- body text ------------------------------------------------------------
    final String fullText = e.text == null ? "" : e.text;
    if (!fullText.equals(h.lastBody)) {
      h.lastBody = fullText;
      h.lastHadLink = firstHttpLink(fullText) != null;
      configureBody(h, fullText);
    } else if (h.linkPreviewOn != dockShowLinkPreviews) {
      // Preview toggle flipped but text is identical: still reconfigure the body's
      // link handling (selectable ↔ tappable) and reconcile the card below.
      configureBody(h, fullText);
    }

    // --- link preview card (only when previews are ON) ------------------------
    syncLinkCard(h, row, fullText);

    // --- meta + actions -------------------------------------------------------
    bindMetaActionsRow(h.metaRow, h, relativeTime(e.createdAtMs, now));

    // --- show more / less -----------------------------------------------------
    final boolean longText = fullText.length() > 90 || fullText.indexOf('\n') >= 0;
    if (longText) {
      if (h.expand.getParent() != row) {
        row.addView(h.expand, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(30)));
      }
      // Reflect the entry's current expanded state.
      h.body.setMaxLines(h.expanded ? Integer.MAX_VALUE : COLLAPSED_LINES);
      h.body.setEllipsize(h.expanded ? null : android.text.TextUtils.TruncateAt.END);
      h.expand.setText(h.expanded ? "Show less  ↑" : "Show more  ↓");
    } else if (h.expand.getParent() == row) {
      row.removeView(h.expand);
      h.expanded = false;
    }
  }

  /** Set the body text and choose its link behaviour for the current preview mode.
   *  - Preview ON, or no link: selectable (handles + Android's selection toolbar),
   *    and the preview card (when on) is the click target.
   *  - Preview OFF and the note HAS a link: the URL itself becomes tappable
   *    (Linkify + LinkMovementMethod) so a single tap opens the browser. Selection
   *    is mutually exclusive with link-clicking, so it's disabled on these rows —
   *    the explicit Copy button still copies. */
  private void configureBody(RowHolder h, String fullText) {
    TextView body = h.body;
    h.linkPreviewOn = dockShowLinkPreviews;
    boolean tapLink = !dockShowLinkPreviews && h.lastHadLink;
    body.setText(fullText);
    if (tapLink) {
      // setText clears prior Linkify spans; re-apply, then make them clickable.
      Linkify.addLinks(body, Linkify.WEB_URLS);
      body.setMovementMethod(LinkMovementMethod.getInstance());
      body.setLinkTextColor(0xFF67E8F9);
      body.setTextIsSelectable(false);
    } else {
      body.setMovementMethod(null);
      body.setTextIsSelectable(true);
    }
  }

  /** Attach/detach the link preview card so it sits between body and meta. Only
   *  adds a card when previews are ON and the note has a link, and only rebuilds
   *  the card when the url or the preview mode actually changed (the link cache
   *  makes a re-add for the same url instant — no re-fetch). */
  private void syncLinkCard(RowHolder h, LinearLayout row, String fullText) {
    String wantUrl = (dockShowLinkPreviews && h.lastHadLink) ? firstHttpLink(fullText) : "";
    String haveUrl = h.linkUrl == null ? "" : h.linkUrl;
    if (wantUrl.equals(haveUrl)) return; // nothing to do
    // Remove the old card if any.
    if (h.linkCard != null && h.linkCard.getParent() == row) {
      row.removeView(h.linkCard);
    }
    h.linkCard = null;
    h.linkUrl = wantUrl;
    if (wantUrl.isEmpty()) return;
    // Insert the new card right after the body (index 1: body=0, then card, then meta).
    View card = buildLinkCard(wantUrl);
    h.linkCard = card;
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lp.topMargin = dp(6);
    // body is always child 0 on a text row; meta may or may not follow yet.
    row.addView(card, Math.min(1, row.getChildCount()), lp);
  }

  /** Return the dock to a clean slate on close: drop every live row into its pool
   *  (capped) so the next open reuses them instead of rebuilding. */
  private void recycleAllRows() {
    for (View v : liveRows.values()) {
      RowHolder h = (RowHolder) v.getTag();
      String kind = rowKindOf(v); // capture kind BEFORE nulling entry (rowKindOf reads it)
      if (h != null) {
        h.entry = null;
        if (h.linkCard != null && h.linkCard.getParent() != null) {
          ((android.view.ViewGroup) h.linkCard.getParent()).removeView(h.linkCard);
        }
        h.linkCard = null;
        h.linkUrl = null;
      }
      poolForKind(kind).add(v);
    }
    liveRows.clear();
    trimPool(poolText);
    trimPool(poolImage);
  }

  /** One borderless glyph action button for a row's meta strip. */
  private Button rowActionBtn(String glyph, int color, View.OnClickListener onClick) {
    Button b = new Button(this);
    b.setText(glyph);
    b.setTextColor(color);
    b.setBackgroundColor(Color.TRANSPARENT);
    b.setAllCaps(false);
    b.setStateListAnimator(null);
    b.setPadding(dp(4), dp(2), dp(4), dp(2));
    b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    b.setMinWidth(0);
    b.setMinimumWidth(0);
    b.setMinHeight(0);
    b.setMinimumHeight(0);
    b.setContentDescription(glyph);
    b.setOnClickListener((v) -> {
      v.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK);
      onClick.onClick(v);
    });
    return b;
  }

  /** Build the meta + actions row ONCE, wiring every listener to the holder (so
   *  the same row can be rebound to many entries without re-allocating lambdas).
   *  kind is "text" or "image" and decides whether Copy/Edit appear. Stores the
   *  refs bindMetaActionsRow needs to touch (meta label, pin, folder) on the holder. */
  private LinearLayout buildMetaActionsRowForHolder(final RowHolder h, String kind) {
    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER_VERTICAL);

    TextView meta = new TextView(this);
    meta.setTextColor(0xFF64748B);
    meta.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
    meta.setSingleLine(true);
    meta.setEllipsize(android.text.TextUtils.TruncateAt.END);
    LinearLayout.LayoutParams metaLp = new LinearLayout.LayoutParams(
        0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    metaLp.topMargin = dp(4);
    row.addView(meta, metaLp);
    h.meta = meta;

    LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(dp(34), dp(30));
    btnLp.leftMargin = dp(2);

    if ("text".equals(kind)) {
      row.addView(rowActionBtn("Copy", 0xFF67E8F9, (v) -> {
        if (h.entry == null) return;
        setOsClipboard(h.entry.text == null ? "" : h.entry.text);
        toast("Copied");
      }), new LinearLayout.LayoutParams(dp(48), dp(30)));
      row.addView(rowActionBtn("✎", 0xFF94A3B8, (v) -> { if (h.entry != null) startEditEntry(h.entry); }),
          new LinearLayout.LayoutParams(dp(34), dp(30)));
    }
    // Folder button: colour reflects whether the entry has tags. Re-coloured on bind.
    Button folderBtn = rowActionBtn("#", 0xFF94A3B8, (v) -> {
      if (h.entry == null) return;
      folderPickForId = h.entry.id;
      refreshPanelIfOpen();
    });
    row.addView(folderBtn, new LinearLayout.LayoutParams(btnLp));
    h.folderBtn = folderBtn;
    // Pin button: glyph + colour flip on bind (📌 accent when pinned, 📍 muted when not).
    Button pin = rowActionBtn("📍", 0xFF94A3B8, (v) -> { if (h.entry != null) togglePin(h.entry); });
    row.addView(pin, new LinearLayout.LayoutParams(btnLp));
    h.pinBtn = pin;
    row.addView(rowActionBtn("↗", 0xFF94A3B8, (v) -> { if (h.entry != null) shareEntry(h.entry); }),
        new LinearLayout.LayoutParams(btnLp));
    row.addView(rowActionBtn("✕", 0xFFF87171, (v) -> { if (h.entry != null) confirmDelete(h.entry); }),
        new LinearLayout.LayoutParams(btnLp));
    return row;
  }

  /** Update only the meta-row visuals that depend on the current entry: the tags
   *  + relative-time label (skipped when unchanged), plus the pin glyph/colour and
   *  the folder button colour (cheap, always applied so a recycled row can't keep
   *  a stale style from a prior entry). */
  private void bindMetaActionsRow(LinearLayout row, final RowHolder h, String metaText) {
    final ClipEntry e = h.entry;
    StringBuilder tagText = new StringBuilder();
    for (int i = 0; i < Math.min(2, e.tags.size()); i++) {
      if (i > 0) tagText.append("  ");
      tagText.append("#").append(e.tags.get(i));
    }
    if (e.tags.size() > 2) tagText.append(" +").append(e.tags.size() - 2);
    if (tagText.length() > 0) tagText.append("  ·  ");
    String meta = tagText.toString() + metaText;
    if (!meta.equals(h.lastMeta)) {
      h.lastMeta = meta;
      h.meta.setText(meta);
    }
    h.pinBtn.setText(e.pinned ? "📌" : "📍");
    h.pinBtn.setTextColor(e.pinned ? 0xFF7C5CFF : 0xFF94A3B8);
    h.folderBtn.setTextColor(e.tags.isEmpty() ? 0xFF94A3B8 : 0xFFA78BFA);
  }

  /** Replace the history with the "move to folder" targets for one entry:
   *  No folder · every existing folder · a new-folder field · Cancel. */
  private void renderFolderChooser(LinearLayout list, final ClipEntry target) {
    TextView title = new TextView(this);
    title.setText("Tags  ·  choose as many as you like");
    title.setTextColor(Color.WHITE);
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
    title.setPadding(dp(4), dp(6), dp(4), dp(8));
    list.addView(title);

    ArrayList<String> folders;
    synchronized (this) {
      folders = foldersLocked();
    }
    for (final String f : folders) {
      addChooserRow(list, (hasTag(target, f) ? "✓  " : "○  ") + f,
          () -> toggleTag(target, f));
    }

    // New-folder row: name + create.
    LinearLayout newRow = new LinearLayout(this);
    newRow.setOrientation(LinearLayout.HORIZONTAL);
    newRow.setGravity(Gravity.CENTER_VERTICAL);
    final EditText name = new EditText(this);
    name.setHint("New tag…");
    name.setHintTextColor(0xFF64748B);
    name.setTextColor(0xFFE2E8F0);
    name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    name.setSingleLine(true);
    GradientDrawable nBg = new GradientDrawable();
    nBg.setColor(0x14FFFFFF);
    nBg.setCornerRadius(dp(9));
    name.setBackground(nBg);
    name.setPadding(dp(9), dp(5), dp(9), dp(5));
    newRow.addView(name, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
    Button create = new Button(this);
    create.setText("Create");
    styleCompactBtn(create, true);
    create.setOnClickListener((v) -> {
      String n = name.getText().toString().trim();
      if (!n.isEmpty()) toggleTag(target, n);
    });
    LinearLayout.LayoutParams createLp = new LinearLayout.LayoutParams(dp(64), dp(28));
    createLp.leftMargin = dp(6);
    newRow.addView(create, createLp);
    LinearLayout.LayoutParams newRowLp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    newRowLp.topMargin = dp(4);
    newRowLp.bottomMargin = dp(4);
    list.addView(newRow, newRowLp);

    addChooserRow(list, "Done", () -> {
      folderPickForId = null;
      refreshPanelIfOpen();
    });
  }

  private void addChooserRow(LinearLayout list, String label, final Runnable onPick) {
    TextView row = new TextView(this);
    row.setText(label);
    row.setTextColor(0xFFE2E8F0);
    row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(0x14FFFFFF);
    bg.setCornerRadius(dp(10));
    row.setBackground(bg);
    row.setPadding(dp(11), dp(9), dp(11), dp(9));
    row.setOnClickListener((v) -> onPick.run());
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lp.bottomMargin = dp(5);
    list.addView(row, lp);
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

  /** Tighter variant for the composer/footer rows — the dock's controls must stay
   *  small so the history owns the space. */
  private void styleCompactBtn(Button b, boolean primary) {
    styleBtn(b, primary);
    GradientDrawable bg = (GradientDrawable) b.getBackground();
    bg.setCornerRadius(dp(8));
    b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
    b.setMinWidth(0);
    b.setMinimumWidth(0);
    b.setMinHeight(0);
    b.setMinimumHeight(0);
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
