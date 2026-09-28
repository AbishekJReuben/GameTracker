package __PACKAGE__;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Voice: plays the PC's Claude Code narration, in the background, with the app
 * closed or the screen off.
 *
 * Lightweight by construction: one OkHttp socket (already in the app), the
 * platform MediaPlayer and MediaSession, no WebView and no extra libraries. The
 * PC sends each piece of audio over the socket the moment it's made, so a line
 * is heard about a second after Claude writes it; nothing is polled. Audio focus
 * (which ducks your music) and the wake lock are held only while speaking.
 *
 * Wire format and keys: see src-tauri/src/voice/relay.rs. AES-256-GCM with a key
 * from HKDF-SHA256(permanent key, salt "gt-voice-v1"); `iv(12) || ct || tag`.
 */
public class VoiceService extends Service {
  static final String TAG = "GtVoice";
  static final String PREFS = "gt_voice";
  static final String CHANNEL = "gt_voice";
  static final int NOTIF_ID = 4711;
  static final String ACTION_TOGGLE = "gt.voice.TOGGLE";
  static final String ACTION_SKIP = "gt.voice.SKIP";
  static final String ACTION_LIVE = "gt.voice.LIVE";
  /** Items kept for the feed (the relay keeps the long history). */
  static final int KEEP = 600;

  static volatile VoiceService instance;

  static final class Item {
    String id;
    long order;
    long rev;
    boolean skip;
    int parts;
    long[] durMs = new long[0];
    File[] files = new File[0];
    String kind = "reply";
    String text = "";
    String title = "";
    String project = "";
    long firstSeen = SystemClock.elapsedRealtime();

    boolean partReady(int p) {
      return p < files.length && files[p] != null && files[p].exists();
    }

    boolean partMade(int p) {
      return p < durMs.length && durMs[p] > 0;
    }
  }

  private final Handler main = new Handler(Looper.getMainLooper());
  private final TreeMap<Long, Item> byOrder = new TreeMap<>();
  private final HashMap<String, Item> byId = new HashMap<>();
  private SharedPreferences prefs;
  private OkHttpClient http;
  private WebSocket ws;
  private boolean connected;
  private int backoffMs = 1000;
  private SecretKeySpec key;
  private String space = "";
  private String base = "";
  private String deviceId = "";

  private long head = -1;
  private long lastRev = 0;
  private boolean synced;
  private boolean paused;
  private float speed = 1f;
  private int version = 1;

  private MediaPlayer player;
  private Item playing;
  private int playingPart;
  private String replayId;
  private AudioManager audio;
  private AudioFocusRequest focusRequest;
  private boolean hasFocus;
  private MediaSession session;
  private File cacheDir;
  private final Runnable releaseFocus = this::abandonFocus;
  private final Runnable reconnect = this::connect;

  // ---------------------------------------------------------------- lifecycle

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    head = prefs.getLong("head", -1);
    speed = prefs.getFloat("speed", 1f);
    audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
    cacheDir = new File(getCacheDir(), "voice");
    //noinspection ResultOfMethodCallIgnored
    cacheDir.mkdirs();
    trimCache();
    http = new OkHttpClient.Builder()
        // Cloudflare drops a quiet socket at ~100 s.
        .pingInterval(60, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build();
    createChannel();
    session = new MediaSession(this, "GameTracker Voice");
    session.setCallback(new MediaSession.Callback() {
      @Override public void onPlay() { setPaused(false); }
      @Override public void onPause() { setPaused(true); }
      @Override public void onSkipToNext() { skip(); }
      @Override public void onFastForward() { catchUp(); }
      @Override public void onStop() { setPaused(true); }
    });
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    startFg();
    String action = intent != null ? intent.getAction() : null;
    if (ACTION_TOGGLE.equals(action)) {
      setPaused(!paused);
      return START_STICKY;
    }
    if (ACTION_SKIP.equals(action)) {
      skip();
      return START_STICKY;
    }
    if (ACTION_LIVE.equals(action)) {
      catchUp();
      return START_STICKY;
    }
    if (!prefs.getBoolean("enabled", false)) {
      stopSelf();
      return START_NOT_STICKY;
    }
    configure();
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    instance = null;
    main.removeCallbacksAndMessages(null);
    if (ws != null) ws.close(1000, "bye");
    stopPlayer();
    abandonFocus();
    if (session != null) session.release();
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void configure() {
    String secret = prefs.getString("secret", "");
    String url = prefs.getString("url", "");
    deviceId = prefs.getString("device", "phone");
    if (secret.isEmpty() || url.isEmpty()) return;
    try {
      key = new SecretKeySpec(deriveKey(secret), "AES");
      space = spaceId(secret);
    } catch (Exception e) {
      Log.w(TAG, "key", e);
      return;
    }
    String b = wsBase(url);
    if (!b.equals(base) || ws == null) {
      base = b;
      if (ws != null) ws.close(1000, "reconfigure");
      ws = null;
      connect();
    }
  }

  // ------------------------------------------------------------------ crypto

  static byte[] deriveKey(String secret) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec("gt-voice-v1".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    byte[] prk = mac.doFinal(secret.getBytes(StandardCharsets.UTF_8));
    mac.init(new SecretKeySpec(prk, "HmacSHA256"));
    return mac.doFinal(new byte[] {1});
  }

  static String spaceId(String secret) throws Exception {
    byte[] h = MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8));
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < 8; i++) sb.append(String.format("%02x", h[i]));
    return sb.toString();
  }

  static String wsBase(String url) {
    String u = url.trim();
    while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
    if (u.endsWith("/ws")) u = u.substring(0, u.length() - 3);
    if (u.startsWith("https://")) u = "wss://" + u.substring(8);
    else if (u.startsWith("http://")) u = "ws://" + u.substring(7);
    return u;
  }

  private byte[] open(byte[] blob) {
    if (key == null || blob == null || blob.length < 28) return null;
    try {
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, blob, 0, 12));
      return c.doFinal(blob, 12, blob.length - 12);
    } catch (Exception e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ socket

  private void connect() {
    main.removeCallbacks(reconnect);
    if (base.isEmpty() || space.isEmpty()) return;
    String u = base + "/voice/ws?clip=" + space + "&device=" + deviceId + "&role=phone";
    ws = http.newWebSocket(new Request.Builder().url(u).build(), new WebSocketListener() {
      @Override
      public void onOpen(WebSocket s, Response r) {
        main.post(() -> {
          if (s != ws) return;
          connected = true;
          backoffMs = 1000;
          synced = false;
          // After a service restart the feed is empty: ask for recent history.
          long since = byOrder.isEmpty() ? 0 : lastRev;
          send(s, "{\"t\":\"hello\",\"role\":\"phone\",\"since\":" + since + "}");
          bump();
        });
      }

      @Override
      public void onMessage(WebSocket s, String text) {
        // Decrypt + write audio off the main thread; only bookkeeping hops over.
        handle(s, text);
      }

      @Override
      public void onFailure(WebSocket s, Throwable t, Response r) {
        main.post(() -> dropped(s));
      }

      @Override
      public void onClosed(WebSocket s, int code, String reason) {
        main.post(() -> dropped(s));
      }
    });
  }

  private void dropped(WebSocket s) {
    if (s != ws) return;
    connected = false;
    ws = null;
    bump();
    main.postDelayed(reconnect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }

  private static void send(WebSocket s, String text) {
    if (s != null) s.send(text);
  }

  /** Runs on OkHttp's reader thread. */
  private void handle(WebSocket s, String text) {
    try {
      JSONObject m = new JSONObject(text);
      String t = m.optString("t");
      if ("item".equals(t)) {
        byte[] plain = open(Base64.decode(m.optString("cipher", ""), Base64.DEFAULT));
        JSONObject p = plain != null ? new JSONObject(new String(plain, StandardCharsets.UTF_8)) : null;
        main.post(() -> onItem(m, p));
      } else if ("audio".equals(t)) {
        String id = m.optString("itemId");
        int part = m.optInt("part");
        long dur = m.optLong("durMs");
        long rev = m.optLong("rev");
        byte[] mp3 = open(Base64.decode(m.optString("data", ""), Base64.DEFAULT));
        File f = mp3 != null ? writePart(id, part, mp3) : null;
        main.post(() -> onAudio(id, part, dur, rev, f));
      } else if ("synced".equals(t)) {
        main.post(this::onSynced);
      }
    } catch (Exception e) {
      Log.w(TAG, "bad message", e);
    }
  }

  private File writePart(String id, int part, byte[] mp3) {
    File f = new File(cacheDir, safe(id) + "_" + part + ".mp3");
    try (FileOutputStream o = new FileOutputStream(f)) {
      o.write(mp3);
      return f;
    } catch (Exception e) {
      return null;
    }
  }

  private static String safe(String s) {
    StringBuilder b = new StringBuilder();
    for (char c : s.toCharArray()) if (Character.isLetterOrDigit(c) || c == '-' || c == '_') b.append(c);
    return b.toString();
  }

  // ------------------------------------------------------------------- state

  private void onItem(JSONObject m, JSONObject p) {
    String id = m.optString("itemId");
    if (id.isEmpty()) return;
    Item it = byId.get(id);
    if (it == null) {
      it = new Item();
      it.id = id;
      byId.put(id, it);
    } else {
      byOrder.remove(it.order);
    }
    it.order = m.optLong("order");
    it.rev = m.optLong("rev");
    it.skip = m.optBoolean("skip");
    it.parts = Math.max(0, m.optInt("parts", 1));
    JSONArray a = m.optJSONArray("audio");
    long[] dur = new long[it.parts];
    File[] files = new File[it.parts];
    for (int i = 0; i < it.parts; i++) {
      if (a != null && i < a.length()) dur[i] = a.optLong(i);
      if (i < it.durMs.length && it.durMs[i] > 0) dur[i] = it.durMs[i];
      if (i < it.files.length) files[i] = it.files[i];
    }
    it.durMs = dur;
    it.files = files;
    if (p != null) {
      it.kind = p.optString("kind", "reply");
      it.text = p.optString("text", "");
      it.title = p.optString("title", "");
      it.project = p.optString("project", "");
    }
    byOrder.put(it.order, it);
    lastRev = Math.max(lastRev, it.rev);
    while (byOrder.size() > KEEP) {
      Item old = byOrder.pollFirstEntry().getValue();
      byId.remove(old.id);
    }
    bump();
    pump();
  }

  private void onAudio(String id, int part, long dur, long rev, File f) {
    lastRev = Math.max(lastRev, rev);
    Item it = byId.get(id);
    if (it == null || f == null) return;
    if (part >= it.parts) return;
    it.durMs[part] = Math.max(1, dur);
    it.files[part] = f;
    bump();
    pump();
  }

  /** First sync after the service starts: a brand-new listener starts "now". */
  private void onSynced() {
    synced = true;
    if (head < 0) {
      head = byOrder.isEmpty() ? 0 : byOrder.lastKey();
      saveHead();
    }
    bump();
    pump();
  }

  private void saveHead() {
    prefs.edit().putLong("head", head).apply();
    send(ws, "{\"t\":\"head\",\"order\":" + head + "}");
  }

  // ---------------------------------------------------------------- playback

  /** Play whatever should play next, if nothing is. Cheap; called on any change. */
  private void pump() {
    if (paused || player != null || !synced || head < 0) return;
    Item next = null;
    if (replayId != null) {
      next = byId.get(replayId);
      if (next == null) replayId = null;
    }
    if (next == null) {
      for (Map.Entry<Long, Item> e : byOrder.tailMap(head, false).entrySet()) {
        Item it = e.getValue();
        if (it.skip || it.parts == 0) continue;
        next = it;
        break;
      }
    }
    if (next == null) {
      idle();
      return;
    }
    int part = next == playing ? playingPart : 0;
    if (next != playing) {
      playing = next;
      playingPart = 0;
      part = 0;
    }
    if (part >= next.parts) {
      finishItem(next);
      return;
    }
    if (next.partReady(part)) {
      play(next, part);
      return;
    }
    if (next.partMade(part)) {
      // Made while we were away: fetch it once from the relay.
      fetchPart(next, part);
      return;
    }
    // Not made yet. If the PC gave up on this line (a later one is ready and this
    // one has waited long enough), move on rather than stall the whole queue.
    if (replayId == null && SystemClock.elapsedRealtime() - next.firstSeen > 15_000 && laterReady(next)) {
      finishItem(next);
    }
  }

  private boolean laterReady(Item cur) {
    for (Item it : byOrder.tailMap(cur.order, false).values()) {
      if (!it.skip && it.partReady(0)) return true;
    }
    return false;
  }

  private final java.util.HashSet<String> fetching = new java.util.HashSet<>();

  private void fetchPart(Item it, int part) {
    String name = safe(it.id) + "_" + part;
    if (!fetching.add(name)) return;
    String u = base.replaceFirst("^ws", "http") + "/voice/blob/" + space + "/" + name;
    new Thread(() -> {
      File f = null;
      try (Response r = http.newCall(new Request.Builder().url(u).build()).execute()) {
        if (r.isSuccessful() && r.body() != null) {
          byte[] mp3 = open(r.body().bytes());
          if (mp3 != null) f = writePart(it.id, part, mp3);
        }
      } catch (Exception ignored) {
      }
      final File file = f;
      main.post(() -> {
        fetching.remove(name);
        if (file != null && part < it.files.length) it.files[part] = file;
        else if (part < it.durMs.length) it.durMs[part] = 0; // unrecoverable: treat as never made
        pump();
      });
    }, "voice-fetch").start();
  }

  private void play(Item it, int part) {
    main.removeCallbacks(releaseFocus);
    if (!requestFocus()) {
      // A call or another app holds exclusive focus: try again shortly.
      main.postDelayed(this::pump, 1000);
      return;
    }
    MediaPlayer mp = new MediaPlayer();
    try {
      mp.setAudioAttributes(attrs());
      mp.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
      mp.setDataSource(it.files[part].getAbsolutePath());
      mp.prepare(); // a small local file: a few ms
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && speed != 1f) {
        PlaybackParams pp = new PlaybackParams();
        pp.setSpeed(speed);
        mp.setPlaybackParams(pp);
      }
      mp.setOnCompletionListener(done -> onPartDone(it, part));
      mp.setOnErrorListener((m, w, x) -> {
        onPartDone(it, part);
        return true;
      });
      player = mp;
      playing = it;
      playingPart = part;
      mp.start();
      session.setActive(true);
      updateSession(true);
      if (part == 0) notifyNow();
      bump();
    } catch (Exception e) {
      Log.w(TAG, "play", e);
      mp.release();
      onPartDone(it, part);
    }
  }

  private void onPartDone(Item it, int part) {
    stopPlayer();
    if (part + 1 < it.parts) {
      playing = it;
      playingPart = part + 1;
      pump();
      return;
    }
    finishItem(it);
  }

  private void finishItem(Item it) {
    playing = null;
    playingPart = 0;
    if (it.id.equals(replayId)) {
      replayId = null;
    } else if (it.order > head) {
      head = it.order;
      saveHead();
    }
    bump();
    pump();
  }

  private void stopPlayer() {
    if (player != null) {
      try {
        player.stop();
      } catch (Exception ignored) {
      }
      player.release();
      player = null;
    }
  }

  /** Queue drained: give focus (and your music's volume) back shortly after. */
  private void idle() {
    main.removeCallbacks(releaseFocus);
    main.postDelayed(releaseFocus, 1200);
    updateSession(false);
  }

  private AudioAttributes attrs() {
    return new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();
  }

  private boolean requestFocus() {
    if (hasFocus) return true;
    int r;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (focusRequest == null) {
        focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attrs())
            .setOnAudioFocusChangeListener(this::onFocusChange, main)
            .build();
      }
      r = audio.requestAudioFocus(focusRequest);
    } else {
      r = audio.requestAudioFocus(this::onFocusChange, AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
    }
    hasFocus = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    return hasFocus;
  }

  private void onFocusChange(int change) {
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      // A call or a voice assistant: stop this line; it resumes from the start
      // of the line when focus can be had again.
      hasFocus = false;
      stopPlayer();
      if (playing != null) playingPart = 0;
      main.postDelayed(this::pump, 1500);
    }
  }

  private void abandonFocus() {
    if (!hasFocus) return;
    hasFocus = false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
      audio.abandonAudioFocusRequest(focusRequest);
    } else {
      audio.abandonAudioFocus(this::onFocusChange);
    }
    // Headset buttons go back to your music app when we're not speaking.
    if (session != null) session.setActive(false);
  }

  // ---------------------------------------------------------------- controls

  void setPaused(boolean p) {
    paused = p;
    if (p) {
      stopPlayer();
      if (playing != null) playingPart = 0;
      abandonFocus();
    }
    updateSession(!p && player != null);
    notifyNow();
    bump();
    if (!p) pump();
  }

  void skip() {
    Item it = playing;
    stopPlayer();
    if (it != null) finishItem(it);
    else pump();
  }

  /** Everything so far counts as heard; carry on from the newest line. */
  void catchUp() {
    stopPlayer();
    playing = null;
    replayId = null;
    if (!byOrder.isEmpty()) {
      Item last = byOrder.lastEntry().getValue();
      // Keep the newest line: jump to just before it.
      Long before = byOrder.lowerKey(last.order);
      head = before != null ? before : last.order - 1;
      saveHead();
    }
    bump();
    pump();
  }

  void replay(String id) {
    Item it = byId.get(id);
    if (it == null) return;
    stopPlayer();
    playing = null;
    replayId = id;
    // Never voiced (skipped or before you started listening): ask the PC for it.
    boolean any = false;
    for (int p = 0; p < it.parts; p++) any |= it.partMade(p);
    if (!any) send(ws, "{\"t\":\"want\",\"itemId\":\"" + safe(id) + "\"}");
    it.firstSeen = SystemClock.elapsedRealtime();
    bump();
    pump();
  }

  void setSpeed(float s) {
    speed = Math.max(0.5f, Math.min(3f, s));
    prefs.edit().putFloat("speed", speed).apply();
    if (player != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      try {
        PlaybackParams pp = new PlaybackParams();
        pp.setSpeed(speed);
        player.setPlaybackParams(pp);
      } catch (Exception ignored) {
      }
    }
    bump();
  }

  // ------------------------------------------------------------- UI snapshot

  private void bump() {
    version++;
  }

  /** JSON for the Voice screen. Returns just `{"ver":n}` if nothing changed. */
  String snapshot(int knownVersion) {
    try {
      JSONObject o = new JSONObject();
      o.put("ver", version);
      if (knownVersion == version) return o.toString();
      o.put("connected", connected);
      o.put("paused", paused);
      o.put("speed", speed);
      o.put("head", head);
      o.put("playing", playing != null && player != null ? playing.id : JSONObject.NULL);
      JSONArray arr = new JSONArray();
      int n = 0;
      for (Item it : byOrder.descendingMap().values()) {
        if (n++ >= 200) break;
        JSONObject j = new JSONObject();
        j.put("id", it.id);
        j.put("kind", it.kind);
        j.put("text", it.text);
        j.put("title", it.title);
        j.put("project", it.project);
        j.put("skip", it.skip);
        j.put("played", it.order <= head);
        boolean ready = it.parts > 0;
        for (int p = 0; p < it.parts; p++) ready &= it.partMade(p);
        j.put("ready", ready);
        arr.put(j);
      }
      o.put("items", arr);
      return o.toString();
    } catch (Exception e) {
      return "{}";
    }
  }

  // ------------------------------------------------------------ notification

  private void createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    NotificationChannel ch = new NotificationChannel(CHANNEL, "Claude voice", NotificationManager.IMPORTANCE_LOW);
    ch.setShowBadge(false);
    ch.setSound(null, null);
    nm.createNotificationChannel(ch);
  }

  private PendingIntent action(String a, int code) {
    Intent i = new Intent(this, VoiceService.class).setAction(a);
    int f = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
    return PendingIntent.getService(this, code, i, f);
  }

  private Notification build() {
    Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL)
        : new Notification.Builder(this);
    Item it = playing;
    String line = it != null ? it.text : (paused ? "Paused" : "Listening to Claude Code");
    if (line.length() > 120) line = line.substring(0, 117) + "…";
    b.setSmallIcon(getApplicationInfo().icon)
        .setContentTitle(it != null && !it.project.isEmpty() ? it.project : "GameTracker Voice")
        .setContentText(line)
        .setOngoing(true)
        .setShowWhen(false)
        .setOnlyAlertOnce(true)
        .setVisibility(Notification.VISIBILITY_PUBLIC);
    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (launch != null) {
      int f = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
      b.setContentIntent(PendingIntent.getActivity(this, 1, launch, f));
    }
    b.addAction(new Notification.Action.Builder(null, paused ? "Play" : "Pause", action(ACTION_TOGGLE, 10)).build());
    b.addAction(new Notification.Action.Builder(null, "Skip", action(ACTION_SKIP, 11)).build());
    b.addAction(new Notification.Action.Builder(null, "Live", action(ACTION_LIVE, 12)).build());
    Notification.MediaStyle style = new Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2);
    if (session != null) style.setMediaSession(session.getSessionToken());
    b.setStyle(style);
    return b.build();
  }

  private void startFg() {
    Notification n = build();
    try {
      if (Build.VERSION.SDK_INT >= 34) {
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

  private void notifyNow() {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) {
      try {
        nm.notify(NOTIF_ID, build());
      } catch (Exception ignored) {
      }
    }
  }

  private void updateSession(boolean speaking) {
    if (session == null) return;
    long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
        | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
        | PlaybackState.ACTION_FAST_FORWARD | PlaybackState.ACTION_STOP;
    int state = speaking ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
    session.setPlaybackState(new PlaybackState.Builder().setActions(actions).setState(state, 0, speed).build());
  }

  /** Audio already played goes; keep the cache small. */
  private void trimCache() {
    File[] files = cacheDir.listFiles();
    if (files == null || files.length < 400) return;
    java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
    for (int i = 0; i < files.length - 200; i++) {
      //noinspection ResultOfMethodCallIgnored
      files[i].delete();
    }
  }

  // ------------------------------------------------------------ entry points

  static void start(Context ctx, boolean enabled, String secret, String device, String url) {
    SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
    SharedPreferences.Editor e = p.edit().putBoolean("enabled", enabled);
    if (secret != null && !secret.isEmpty()) e.putString("secret", secret);
    if (device != null && !device.isEmpty()) e.putString("device", device);
    if (url != null && !url.isEmpty()) e.putString("url", url);
    e.apply();
    Intent i = new Intent(ctx, VoiceService.class);
    if (!enabled) {
      ctx.stopService(i);
      return;
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
    else ctx.startService(i);
  }

  /** After a reboot: resume if the user left Voice on. */
  static void startIfEnabled(Context ctx) {
    SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
    if (!p.getBoolean("enabled", false)) return;
    Intent i = new Intent(ctx, VoiceService.class);
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
      else ctx.startService(i);
    } catch (Exception ignored) {
    }
  }
}
