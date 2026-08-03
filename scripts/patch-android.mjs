// Idempotent patcher for the companion's generated Android project
// (companion/src-tauri/gen/android).
//
// `tauri android init` regenerates gen/android from a template, so any
// customization the app needs must be re-applied after init — this script is
// the single source of truth for those, used by CI (fresh init) AND local
// builds (Build-Apk.ps1). Every edit is a no-op if already present, so it is
// safe to run repeatedly against an already-customized tree. It is also
// line-ending agnostic (the generated files use CRLF on Windows, LF on CI).
//
// It ensures:
//   1. REQUEST_INSTALL_PACKAGES permission (so the in-app updater can hand the
//      downloaded APK to the system package installer).
//   2. A FileProvider <provider> + res/xml/file_paths.xml with a cache-path
//      (the updater downloads the APK into the app cache dir and shares it via
//      content:// URI — required on modern Android).
//   3. Cleartext traffic in the release build (the companion always talks to the
//      desktop over plain http/ws on the LAN/Tailscale).
//   4. Immersive full-screen MainActivity (hide the status/navigation bars) so the
//      remote screen gets the whole display and the notification panel stays out.
//   5. WcDecoderBridge — native MediaCodec → Surface under the WebView for the
//      DIRECT path (Moonlight/Chiaki-style low-latency decode).
//
// Usage: node scripts/patch-android.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = join(root, "companion", "src-tauri", "gen", "android");
const manifestPath = join(androidDir, "app", "src", "main", "AndroidManifest.xml");
const filePathsPath = join(androidDir, "app", "src", "main", "res", "xml", "file_paths.xml");
const gradlePath = join(androidDir, "app", "build.gradle.kts");

if (!existsSync(androidDir)) {
  console.error(
    `[patch-android] ${androidDir} not found. Run \`tauri android init\` (or npm run companion:init) first.`,
  );
  process.exit(1);
}

let changed = 0;
const note = (msg) => {
  changed++;
  console.log(`[patch-android] ${msg}`);
};

// Write only if content actually changed; preserve the file's EOL style.
const save = (path, before, after, msg) => {
  if (after !== before) {
    writeFileSync(path, after);
    note(msg);
    return true;
  }
  return false;
};

// --- 1 & 2: AndroidManifest.xml ---------------------------------------------
{
  const before = readFileSync(manifestPath, "utf8");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  let m = before;

  // REQUEST_INSTALL_PACKAGES permission (place next to INTERNET).
  if (!m.includes("android.permission.REQUEST_INSTALL_PACKAGES")) {
    const perm = `    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />${eol}`;
    if (/android\.permission\.INTERNET/.test(m)) {
      m = m.replace(
        /([ \t]*<uses-permission android:name="android\.permission\.INTERNET"[ \t]*\/>[ \t]*\r?\n)/,
        `$1${perm}`,
      );
    } else {
      m = m.replace(/(<manifest\b[^>]*>[ \t]*\r?\n)/, `$1${perm}`);
    }
  }

  // Wi-Fi low-latency lock while a remote session streams (WcDecoderBridge
  // .setStreamActive): WifiLock.acquire needs WAKE_LOCK; creating the lock off
  // WifiManager wants ACCESS_WIFI_STATE. Both are normal-level (no prompt).
  for (const p of [
    "android.permission.WAKE_LOCK",
    "android.permission.ACCESS_WIFI_STATE",
    // Shared clipboard: overlay bubble, indefinite foreground service (specialUse
    // has no 6h cap), notifications, boot restart, Doze exemption, connectivity.
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    "android.permission.ACCESS_NETWORK_STATE",
    // Voice-to-text: the floating dock's mic records a short clip and sends it to
    // Sarvam STT. Runtime-prompted (dangerous perm); the dock guides the grant.
    "android.permission.RECORD_AUDIO",
  ]) {
    if (!m.includes(p)) {
      const perm = `    <uses-permission android:name="${p}" />${eol}`;
      if (/android\.permission\.INTERNET/.test(m)) {
        m = m.replace(
          /([ \t]*<uses-permission android:name="android\.permission\.INTERNET"[ \t]*\/>[ \t]*\r?\n)/,
          `$1${perm}`,
        );
      } else {
        m = m.replace(/(<manifest\b[^>]*>[ \t]*\r?\n)/, `$1${perm}`);
      }
    }
  }

  // FileProvider (needed to share the downloaded APK with the installer).
  if (!m.includes("androidx.core.content.FileProvider")) {
    const provider =
      `        <provider${eol}` +
      `          android:name="androidx.core.content.FileProvider"${eol}` +
      `          android:authorities="\${applicationId}.fileprovider"${eol}` +
      `          android:exported="false"${eol}` +
      `          android:grantUriPermissions="true">${eol}` +
      `          <meta-data${eol}` +
      `            android:name="android.support.FILE_PROVIDER_PATHS"${eol}` +
      `            android:resource="@xml/file_paths" />${eol}` +
      `        </provider>${eol}`;
    m = m.replace(/([ \t]*<\/application>)/, `${provider}$1`);
  }

  // Shizuku provider. It is harmless when Shizuku is not installed and is
  // required for the optional 4G/5G launcher toggle to receive Shizuku's
  // binder. The provider permission prevents ordinary apps from using it.
  if (!m.includes("rikka.shizuku.ShizukuProvider")) {
    const provider =
      `        <provider${eol}` +
      `          android:name="rikka.shizuku.ShizukuProvider"${eol}` +
      `          android:authorities="\${applicationId}.shizuku"${eol}` +
      `          android:enabled="true"${eol}` +
      `          android:exported="true"${eol}` +
      `          android:multiprocess="false"${eol}` +
      `          android:permission="android.permission.INTERACT_ACROSS_USERS_FULL" />${eol}`;
    m = m.replace(/([ \t]*<\/application>)/, `${provider}$1`);
  }

  // ApkInstallReceiver — the PackageInstaller status callback target. Without this
  // registered receiver, committing an install session has nowhere to deliver
  // STATUS_PENDING_USER_ACTION, so the confirmation dialog never launches (this is
  // the "install prompt never shows up" bug on modern Android). Explicitly targeted
  // (exported=false is fine — the PendingIntent names the class directly).
  if (!m.includes(".ApkInstallReceiver")) {
    const receiver =
      `        <receiver${eol}` +
      `          android:name=".ApkInstallReceiver"${eol}` +
      `          android:exported="false" />${eol}`;
    m = m.replace(/([ \t]*<\/application>)/, `${receiver}$1`);
  }

  // Picture-in-picture support on the main activity: leaving the app while a
  // remote session is live shrinks it into a floating 16:9 mini window (see
  // MainActivity.onUserLeaveHint below). resizeableActivity default stays on.
  {
    const act = m.match(/<activity\b[^>]*?android:name="[^"]*MainActivity"[^>]*?>/);
    if (act && !act[0].includes("supportsPictureInPicture")) {
      const patched = act[0].replace(
        "<activity",
        `<activity${eol}            android:supportsPictureInPicture="true"`,
      );
      m = m.replace(act[0], patched);
    }
  }

  // <queries> so the legacy ACTION_VIEW fallback can resolve the system package
  // installer on Android 11+ (package-visibility restrictions otherwise hide it).
  if (!m.includes("vnd.android.package-archive")) {
    const queries =
      `    <queries>${eol}` +
      `        <intent>${eol}` +
      `            <action android:name="android.intent.action.VIEW" />${eol}` +
      `            <data android:mimeType="application/vnd.android.package-archive" />${eol}` +
      `        </intent>${eol}` +
      `        <intent>${eol}` +
      `            <action android:name="android.speech.RecognitionService" />${eol}` +
      `        </intent>${eol}` +
      `    </queries>${eol}`;
    m = m.replace(/([ \t]*<application\b)/, `${queries}$1`);
  }
  // Package-visibility for the built-in speech recognizer (Android 11+): without
  // this <queries> entry, SpeechRecognizer.isRecognitionAvailable() is false and
  // the dock's keyless voice input can never bind to Google's service. Additive
  // for manifests generated before this block existed.
  if (!m.includes("android.speech.RecognitionService")) {
    m = m.replace(
      /(<queries>)/,
      `$1${eol}        <intent>${eol}            <action android:name="android.speech.RecognitionService" />${eol}        </intent>`,
    );
  }

  // Shared-clipboard overlay + sync foreground service. `specialUse` avoids the
  // 6h/24h dataSync cap so it can run indefinitely.
  if (!m.includes(".ClipboardService")) {
    const svc =
      `        <service${eol}` +
      `          android:name=".ClipboardService"${eol}` +
      `          android:exported="false"${eol}` +
      `          android:foregroundServiceType="specialUse">${eol}` +
      `          <property${eol}` +
      `            android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"${eol}` +
      `            android:value="shared clipboard overlay and sync" />${eol}` +
      `        </service>${eol}`;
    m = m.replace(/([ \t]*<\/application>)/, `${svc}$1`);
  }

  // ClipboardPickActivity — transparent proxy that lets the foreground
  // ClipboardService pick an image from the gallery (services can't receive an
  // Activity-result callback). Translucent.NoTitleBar keeps it invisible; it
  // finishes immediately after handing the URI back to the service.
  if (!m.includes(".ClipboardPickActivity")) {
    const act =
      `        <activity${eol}` +
      `          android:name=".ClipboardPickActivity"${eol}` +
      `          android:exported="false"${eol}` +
      `          android:theme="@android:style/Theme.Translucent.NoTitleBar" />${eol}`;
    m = m.replace(/([ \t]*<\/application>)/, `${act}$1`);
  }

  // Older revisions briefly shipped a RemoteViews widget. The current phone
  // shortcut does not read telephony state, so remove this permission from an
  // already-generated tree as well as omitting it from fresh manifests.
  m = m.replace(
    /[ \t]*<uses-permission android:name="android\.permission\.READ_BASIC_PHONE_STATE"[ \t]*\/>[ \t]*\r?\n?/g,
    "",
  );

  // Remove the old widget entries from trees generated by the previous
  // implementation. Keeping a stale provider in the manifest is what leaves
  // Motorola Launcher showing "Can't load widget" after an app update.
  m = m.replace(
    /[ \t]*<receiver\b[^>]*android:name="\.PhoneSettingsWidgetProvider"[^>]*>[\s\S]*?<\/receiver>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity\b[^>]*android:name="\.WidgetSettingsActivity"[^>]*\/>[ \t]*\r?\n?/g,
    "",
  );

  // A normal launcher entry is more reliable than a RemoteViews widget for
  // this device. Keep the real activity private and expose the home-screen
  // entry through an explicit alias. Without the alias, launchers can collapse
  // two MAIN activities in one package onto the app's primary MainActivity,
  // which makes the shortcut icon open GameTracker instead of Settings.
  m = m.replace(
    /[ \t]*<activity\b[^>]*android:name="\.NetworkSettingsShortcutActivity"[^>]*>[\s\S]*?<\/activity>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity\b[^>]*android:name="\.NetworkSettingsShortcutActivity"[^>]*\/>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity-alias\b[^>]*android:name="\.NetworkSettingsShortcut"[^>]*>[\s\S]*?<\/activity-alias>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity\b[^>]*android:name="\.NetworkToggleShortcutActivity"[^>]*>[\s\S]*?<\/activity>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity\b[^>]*android:name="\.NetworkToggleShortcutActivity"[^>]*\/>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity-alias\b[^>]*android:name="\.NetworkToggleShortcut"[^>]*>[\s\S]*?<\/activity-alias>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity\b[^>]*android:name="\.VoLteToggleShortcutActivity"[^>]*>[\s\S]*?<\/activity>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity\b[^>]*android:name="\.VoLteToggleShortcutActivity"[^>]*\/>[ \t]*\r?\n?/g,
    "",
  );
  m = m.replace(
    /[ \t]*<activity-alias\b[^>]*android:name="\.VoLteToggleShortcut"[^>]*>[\s\S]*?<\/activity-alias>[ \t]*\r?\n?/g,
    "",
  );
  const shortcut =
    `        <activity${eol}` +
    `          android:name=".NetworkSettingsShortcutActivity"${eol}` +
    `          android:excludeFromRecents="true"${eol}` +
    `          android:exported="false"${eol}` +
    `          android:noHistory="true"${eol}` +
    `          android:theme="@android:style/Theme.Translucent.NoTitleBar" />${eol}` +
    `        <activity-alias${eol}` +
    `          android:name=".NetworkSettingsShortcut"${eol}` +
    `          android:exported="true"${eol}` +
    `          android:icon="@drawable/ic_network_shortcut"${eol}` +
    `          android:label="@string/network_settings_shortcut_name"${eol}` +
    `          android:targetActivity=".NetworkSettingsShortcutActivity">${eol}` +
    `          <intent-filter>${eol}` +
    `            <action android:name="android.intent.action.MAIN" />${eol}` +
    `            <category android:name="android.intent.category.LAUNCHER" />${eol}` +
    `          </intent-filter>${eol}` +
    `        </activity-alias>${eol}`;
  m = m.replace(/([ \t]*<\/application>)/, `${shortcut}$1`);

  const toggleShortcut =
    `        <activity${eol}` +
    `          android:name=".NetworkToggleShortcutActivity"${eol}` +
    `          android:excludeFromRecents="true"${eol}` +
    `          android:exported="false"${eol}` +
    `          android:noHistory="true"${eol}` +
    `          android:theme="@android:style/Theme.Translucent.NoTitleBar" />${eol}` +
    `        <activity-alias${eol}` +
    `          android:name=".NetworkToggleShortcut"${eol}` +
    `          android:exported="true"${eol}` +
    `          android:icon="@drawable/ic_network_toggle"${eol}` +
    `          android:label="@string/network_toggle_shortcut_name"${eol}` +
    `          android:targetActivity=".NetworkToggleShortcutActivity">${eol}` +
    `          <intent-filter>${eol}` +
    `            <action android:name="android.intent.action.MAIN" />${eol}` +
    `            <category android:name="android.intent.category.LAUNCHER" />${eol}` +
    `          </intent-filter>${eol}` +
    `        </activity-alias>${eol}`;
  m = m.replace(/([ \t]*<\/application>)/, `${toggleShortcut}$1`);

  const volteShortcut =
    `        <activity${eol}` +
    `          android:name=".VoLteToggleShortcutActivity"${eol}` +
    `          android:excludeFromRecents="true"${eol}` +
    `          android:exported="false"${eol}` +
    `          android:noHistory="true"${eol}` +
    `          android:theme="@android:style/Theme.Translucent.NoTitleBar" />${eol}` +
    `        <activity-alias${eol}` +
    `          android:name=".VoLteToggleShortcut"${eol}` +
    `          android:exported="true"${eol}` +
    `          android:icon="@drawable/ic_volte_toggle"${eol}` +
    `          android:label="@string/volte_toggle_shortcut_name"${eol}` +
    `          android:targetActivity=".VoLteToggleShortcutActivity">${eol}` +
    `          <intent-filter>${eol}` +
    `            <action android:name="android.intent.action.MAIN" />${eol}` +
    `            <category android:name="android.intent.category.LAUNCHER" />${eol}` +
    `          </intent-filter>${eol}` +
    `        </activity-alias>${eol}`;
  m = m.replace(/([ \t]*<\/application>)/, `${volteShortcut}$1`);

  // Boot receiver — restart the service after a reboot / app update.
  if (!m.includes(".ClipboardBootReceiver")) {
    const rec =
      `        <receiver${eol}` +
      `          android:name=".ClipboardBootReceiver"${eol}` +
      `          android:exported="true">${eol}` +
      `          <intent-filter>${eol}` +
      `            <action android:name="android.intent.action.BOOT_COMPLETED" />${eol}` +
      `            <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />${eol}` +
      `          </intent-filter>${eol}` +
      `        </receiver>${eol}`;
    m = m.replace(/([ \t]*<\/application>)/, `${rec}$1`);
  }

  // Share-sheet target: "Share → GameTracker" adds text/images to the clipboard.
  if (!m.includes("android.intent.action.SEND")) {
    const filter =
      `${eol}            <intent-filter>${eol}` +
      `                <action android:name="android.intent.action.SEND" />${eol}` +
      `                <category android:name="android.intent.category.DEFAULT" />${eol}` +
      `                <data android:mimeType="text/plain" />${eol}` +
      `                <data android:mimeType="image/*" />${eol}` +
      `            </intent-filter>${eol}        `;
    const act = m.match(/(<activity\b[^>]*?MainActivity[\s\S]*?)(<\/activity>)/);
    if (act) {
      m = m.replace(act[0], `${act[1]}${filter}${act[2]}`);
    }
  }

  save(manifestPath, before, m, "patched AndroidManifest.xml (permission/FileProvider/receiver/queries/clipboard)");
}

// --- 2b: res/xml/file_paths.xml ---------------------------------------------
// The updater downloads the APK into the app cache dir and shares it with the
// system package installer via a FileProvider content:// URI. Tauri's
// `app_cache_dir()` can resolve to the INTERNAL cache (`<cache-path>`) or the
// EXTERNAL cache (`<external-cache-path>`) depending on device/OS; if the file's
// dir isn't covered by a declared root, `FileProvider.getUriForFile` throws
// IllegalArgumentException — which historically crashed the app right before the
// install prompt. Declare every standard root so the URI always resolves.
{
  const roots = [
    ['files-path', 'my_files'],
    ['cache-path', 'my_cache_images'],
    ['external-path', 'my_images'],
    ['external-files-path', 'my_ext_files'],
    ['external-cache-path', 'my_ext_cache'],
  ];
  if (!existsSync(filePathsPath)) {
    mkdirSync(dirname(filePathsPath), { recursive: true });
    writeFileSync(
      filePathsPath,
      `<?xml version="1.0" encoding="utf-8"?>\r\n` +
        `<paths xmlns:android="http://schemas.android.com/apk/res/android">\r\n` +
        roots.map(([tag, name]) => `  <${tag} name="${name}" path="." />\r\n`).join('') +
        `</paths>\r\n`,
    );
    note("created res/xml/file_paths.xml");
  } else {
    const before = readFileSync(filePathsPath, "utf8");
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    let f = before;
    for (const [tag, name] of roots) {
      if (!new RegExp(`<${tag}\\b`).test(f)) {
        f = f.replace(/([ \t]*<\/paths>)/, `  <${tag} name="${name}" path="." />${eol}$1`);
      }
    }
    save(filePathsPath, before, f, "ensured all FileProvider roots in file_paths.xml");
  }
}

// --- 3: cleartext in the release build + clipboard WebSocket ----------------
{
  const before = readFileSync(gradlePath, "utf8");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  let g = before;
  // Ensure defaultConfig sets the usesCleartextTraffic placeholder (the stock
  // template only sets it in the debug buildType, so release builds would block
  // the http/ws link to the PC). Brace-count to stay inside defaultConfig.
  const dcMatch = g.match(/defaultConfig\s*\{/);
  if (dcMatch) {
    const start = dcMatch.index + dcMatch[0].length;
    let depth = 1;
    let i = start;
    for (; i < g.length && depth > 0; i++) {
      if (g[i] === "{") depth++;
      else if (g[i] === "}") depth--;
    }
    const block = g.slice(start, i);
    if (!block.includes("usesCleartextTraffic")) {
      const inject = `${eol}        manifestPlaceholders["usesCleartextTraffic"] = "true"`;
      g = g.slice(0, start) + inject + g.slice(start);
    }
  }
  // The native foreground service owns the always-on receive socket. OkHttp's
  // WebSocket runs callbacks off the main thread and does not poll or hold a
  // wakelock while idle.
  if (!g.includes("com.squareup.okhttp3:okhttp")) {
    g = g.replace(
      /dependencies\s*\{\r?\n/,
      `$&    implementation("com.squareup.okhttp3:okhttp:4.12.0")${eol}`,
    );
  }
  // Optional privileged network toggle. Shizuku is not bundled as an app; the
  // dependency only lets GameTracker talk to a separately installed Shizuku
  // service when the user explicitly authorizes it.
  if (!g.includes("dev.rikka.shizuku:api")) {
    g = g.replace(
      /dependencies\s*\{\r?\n/,
      `$&    implementation("dev.rikka.shizuku:api:13.1.5")${eol}` +
        `    implementation("dev.rikka.shizuku:provider:13.1.5")${eol}`,
    );
  }
  // The toggle uses a hand-written Binder so Windows AIDL path comments cannot
  // produce illegal Java unicode escapes in the generated source tree.
  g = g.replace(/^[ \t]*aidl = true[ \t]*\r?\n/m, "");
  save(gradlePath, before, g, "set release networking and native clipboard WebSocket dependency");
}

// --- 4: MainActivity.kt — immersive full-screen ------------------------------
// `tauri android init` regenerates a stock MainActivity that shows the system bars,
// so the immersive customization is re-applied here (otherwise CI/fresh builds ship
// with the notification panel visible). Package path derives from the identifier.
{
  const conf = JSON.parse(
    readFileSync(join(root, "companion", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const pkg = String(conf.identifier || "");
  const mainActivityPath = join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    ...pkg.split("."),
    "MainActivity.kt",
  );
  if (!pkg) {
    console.warn("[patch-android] no identifier in tauri.conf.json — skipping MainActivity patch.");
  } else if (!existsSync(mainActivityPath)) {
    console.warn(`[patch-android] ${mainActivityPath} not found — skipping MainActivity patch.`);
  } else {
    const before = readFileSync(mainActivityPath, "utf8");
    let content =
      `package ${pkg}\n\n` +
      `import android.app.PictureInPictureParams\n` +
      `import android.content.pm.ActivityInfo\n` +
      `import android.content.pm.PackageManager\n` +
      `import android.content.res.Configuration\n` +
      `import android.graphics.Rect\n` +
      `import android.os.Build\n` +
      `import android.os.Bundle\n` +
      `import android.os.SystemClock\n` +
      `import android.util.Rational\n` +
      `import android.webkit.WebView\n` +
      `import android.view.OrientationEventListener\n` +
      `import android.view.WindowManager\n` +
      `import androidx.activity.enableEdgeToEdge\n` +
      `import androidx.annotation.RequiresApi\n` +
      `import androidx.core.view.ViewCompat\n` +
      `import androidx.core.view.WindowInsetsCompat\n` +
      `import androidx.core.view.WindowInsetsControllerCompat\n` +
      `import java.lang.ref.WeakReference\n\n` +
      `class MainActivity : TauriActivity() {\n` +
      `  companion object {\n` +
      `    /** True while the webview has a live remote session (set over JNI by the\n` +
      `     *  Rust \`set_pip_enabled\` command via [setPipWanted]) — leaving the app\n` +
      `     *  then shrinks it into a floating 16:9 mini window (YouTube/AnyDesk\n` +
      `     *  style) instead of plain backgrounding. */\n` +
      `    @JvmField var pipWanted = false\n` +
      `    @JvmField var rotationHoldMs = 1200L\n` +
      `    private var current: WeakReference<MainActivity>? = null\n\n` +
      `    /** JNI entry point: flips the gate AND refreshes the live activity's PiP\n` +
      `     *  params, so Android 12+'s auto-enter (the SEAMLESS system-animated\n` +
      `     *  transition on the home gesture) engages/disengages immediately. */\n` +
      `    @JvmStatic\n` +
      `    fun setPipWanted(enabled: Boolean) {\n` +
      `      pipWanted = enabled\n` +
      `      val act = current?.get() ?: return\n` +
      `      act.runOnUiThread { act.updatePipParams() }\n` +
      `    }\n` +
      `    @JvmStatic\n` +
      `    fun setRotationHoldMs(value: Long) {\n` +
      `      rotationHoldMs = value.coerceIn(400L, 3000L)\n` +
      `    }\n` +
      `  }\n\n` +
      `  private var appWebView: WebView? = null\n` +
      `  private var imeVisible = false\n` +
      `  private var lastImeBottom = -1\n` +
      `  private var rotationCandidate = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED\n` +
      `  private var rotationCandidateSince = 0L\n` +
      `  private lateinit var orientationListener: OrientationEventListener\n\n` +
      `  override fun onCreate(savedInstanceState: Bundle?) {\n` +
      `    enableEdgeToEdge()\n` +
      `    super.onCreate(savedInstanceState)\n` +
      `    current = WeakReference(this)\n` +
      `    // MediaCodec → Surface under the WebView (Moonlight/Chiaki-style\n` +
      `    // low-latency decode). JavascriptInterface + SurfaceView live in\n` +
      `    // WcDecoderBridge; frames arrive from cloud.ts via __GT_DECODER__.\n` +
      `    WcDecoderBridge.attach(this)\n` +
      `    // Follow the physical sensor in all four orientations, IGNORING the\n` +
      `    // system auto-rotate lock — holding the phone sideways for a moment\n` +
      `    // rotates the remote screen even with rotation lock on.\n` +
      `    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED\n` +
      `    orientationListener = object : OrientationEventListener(this) {\n` +
      `      override fun onOrientationChanged(angle: Int) {\n` +
      `        if (angle == ORIENTATION_UNKNOWN || isInPictureInPictureMode) return\n` +
      `        // A narrow 25-degree cardinal window rejects shaky transition angles.\n` +
      `        val next = when {\n` +
      `          angle >= 335 || angle <= 25 -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT\n` +
      `          angle in 65..115 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE\n` +
      `          angle in 155..205 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT\n` +
      `          angle in 245..295 -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE\n` +
      `          else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED\n` +
      `        }\n` +
      `        if (next == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) {\n` +
      `          rotationCandidate = next\n` +
      `          return\n` +
      `        }\n` +
      `        val now = SystemClock.elapsedRealtime()\n` +
      `        if (next != rotationCandidate) {\n` +
      `          rotationCandidate = next\n` +
      `          rotationCandidateSince = now\n` +
      `        } else if (requestedOrientation != next && now - rotationCandidateSince >= rotationHoldMs) {\n` +
      `          requestedOrientation = next\n` +
      `        }\n` +
      `      }\n` +
      `    }\n` +
      `    if (orientationListener.canDetectOrientation()) orientationListener.enable()\n` +
      `    hideSystemBars()\n` +
      `    updatePipParams()\n` +
      `    // Keyboard must SHRINK the webview, never pan the window. With\n` +
      `    // enableEdgeToEdge + hidden system bars the IME default degrades to\n` +
      `    // adjustPan (fullscreen windows are exempt from adjustResize), which\n` +
      `    // slides the whole surface up — the top of the remote viewport leaves\n` +
      `    // the screen and JS cannot even see it (visualViewport doesn't change\n` +
      `    // when the WINDOW moves). Requesting ADJUST_RESIZE plus applying the\n` +
      `    // ime inset as bottom padding makes the content view physically\n` +
      `    // shrink, so the page lays out inside the visible band like any\n` +
      `    // normal resize.\n` +
      `    @Suppress("DEPRECATION")\n` +
      `    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)\n` +
      `    val content = findViewById<android.view.View>(android.R.id.content)\n` +
      `    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->\n` +
      `      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())\n` +
      `      imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())\n` +
      `      if (ime.bottom != lastImeBottom) {\n` +
      `        lastImeBottom = ime.bottom\n` +
      `        v.setPadding(0, 0, 0, ime.bottom)\n` +
      `      }\n` +
      `      insets\n` +
      `    }\n` +
      `  }\n\n` +
      `  /** Tauri fires this when the WebView is constructed, BEFORE it loads the\n` +
      `   *  app URL — the only correct moment to inject a JavascriptInterface.\n` +
      `   *  Android exposes injected objects to JS only on the NEXT page load, so\n` +
      `   *  binding __GT_DECODER__ any later (it used to happen in the bridge's\n` +
      `   *  init(), when a DIRECT session starts) leaves it undefined for the whole\n` +
      `   *  session: MediaCodec is never fed and the screen stays blank while the\n` +
      `   *  phone re-requests keyframes forever. */\n` +
      `  override fun onWebViewCreate(webView: WebView) {\n` +
      `    super.onWebViewCreate(webView)\n` +
      `    appWebView = webView\n` +
      `    WcDecoderBridge.installJsInterface(webView)\n` +
      `  }\n\n` +
      `  override fun onWindowFocusChanged(hasFocus: Boolean) {\n` +
      `    super.onWindowFocusChanged(hasFocus)\n` +
      `    // Re-hide after the bars are transiently shown (keyboard, app resume).\n` +
      `    if (hasFocus && !imeVisible) hideSystemBars()\n` +
      `  }\n\n` +
      `  /** Does this device actually have PiP? (Go/TV/OEM builds may not.) NOTE: no\n` +
      `   *  SDK_INT check in here — lint can't see version guards through a helper,\n` +
      `   *  so every caller does its own inline check and minSdk 24 stays buildable. */\n` +
      `  private fun hasPipFeature(): Boolean =\n` +
      `    packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)\n\n` +
      `  /** Shared 16:9 params. \`sourceRectHint\` tells the OS which on-screen rect\n` +
      `   *  morphs into the mini window — without it the system falls back to a\n` +
      `   *  content overlay and the shrink looks like a cross-fade rather than the\n` +
      `   *  seamless YouTube move. */\n` +
      `  @RequiresApi(Build.VERSION_CODES.O)\n` +
      `  private fun pipParams(autoEnter: Boolean): PictureInPictureParams {\n` +
      `    val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))\n` +
      `    try {\n` +
      `      val rect = Rect()\n` +
      `      window.decorView.getGlobalVisibleRect(rect)\n` +
      `      if (!rect.isEmpty) b.setSourceRectHint(rect)\n` +
      `    } catch (_: Exception) {\n` +
      `      // No layout yet — the OS just uses its default animation.\n` +
      `    }\n` +
      `    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {\n` +
      `      b.setAutoEnterEnabled(autoEnter)\n` +
      `      b.setSeamlessResizeEnabled(false)\n` +
      `    }\n` +
      `    return b.build()\n` +
      `  }\n\n` +
      `  /** Android 12+: arm auto-enter so the OS runs the shrink itself on the home\n` +
      `   *  gesture. Params must be FRESH when the user leaves (the OS reads the last\n` +
      `   *  snapshot), so this is re-applied when the gate flips and on resume. */\n` +
      `  fun updatePipParams() {\n` +
      `    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return\n` +
      `    if (!hasPipFeature()) return\n` +
      `    try {\n` +
      `      setPictureInPictureParams(pipParams(pipWanted))\n` +
      `    } catch (_: Exception) {\n` +
      `      // PiP unavailable (device/settings) — the leave-hint path below still tries.\n` +
      `    }\n` +
      `  }\n\n` +
      `  override fun onResume() {\n` +
      `    super.onResume()\n` +
      `    // Re-arm on every resume: auto-enter reads the most recent params, and a\n` +
      `    // stale snapshot (set once at onCreate, before the session went live) is a\n` +
      `    // documented way for auto-enter to quietly do nothing.\n` +
      `    updatePipParams()\n` +
      `  }\n\n` +
      `  // Home / recents while connected → floating 16:9 mini window.\n` +
      `  //\n` +
      `  // This runs on ALL API >= O, including 12+ where setAutoEnterEnabled is\n` +
      `  // supposed to make it unnecessary. That is deliberate: auto-enter silently\n` +
      `  // no-ops on a number of OEM builds (b/245392106 \"Inconsistent\n` +
      `  // setAutoEnterEnabled behavior\"), and gating this to pre-S left those devices\n` +
      `  // with NO picture-in-picture at all and no fallback. Google's wording is that\n` +
      `  // with auto-enter you \"don't need to\" call this — not that you must not.\n` +
      `  // The isInPictureInPictureMode guard makes the redundant call a no-op when\n` +
      `  // auto-enter did fire first.\n` +
      `  override fun onUserLeaveHint() {\n` +
      `    super.onUserLeaveHint()\n` +
      `    // Inline SDK check (not folded into hasPipFeature) so lint's NewApi can\n` +
      `    // see it — minSdk is 24 and the PiP APIs below are 26.\n` +
      `    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return\n` +
      `    if (!pipWanted || !hasPipFeature()) return\n` +
      `    if (isInPictureInPictureMode) return\n` +
      `    try {\n` +
      `      enterPictureInPictureMode(pipParams(pipWanted))\n` +
      `    } catch (_: Exception) {\n` +
      `      // PiP unavailable (device/settings) — plain backgrounding is fine.\n` +
      `    }\n` +
      `  }\n\n` +
      `  override fun onPictureInPictureModeChanged(\n` +
      `    isInPictureInPictureMode: Boolean,\n` +
      `    newConfig: Configuration\n` +
      `  ) {\n` +
      `    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)\n` +
      `    val active = if (isInPictureInPictureMode) "true" else "false"\n` +
      `    appWebView?.evaluateJavascript("window.__GT_PIP_ACTIVE__=" + active + ";window.dispatchEvent(new CustomEvent('gt:pip',{detail:{active:" + active + "}}));", null)\n` +
      `    if (!isInPictureInPictureMode) hideSystemBars()\n` +
      `  }\n\n` +
      `  override fun onDestroy() {\n` +
      `    if (::orientationListener.isInitialized) orientationListener.disable()\n` +
      `    appWebView = null\n` +
      `    super.onDestroy()\n` +
      `  }\n\n` +
      `  private fun hideSystemBars() {\n` +
      `    val controller = WindowInsetsControllerCompat(window, window.decorView)\n` +
      `    controller.hide(WindowInsetsCompat.Type.systemBars())\n` +
      `    controller.systemBarsBehavior =\n` +
      `      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE\n` +
      `  }\n` +
      `}\n`;
    save(mainActivityPath, before, content, "rewrote MainActivity.kt (immersive + sensor rotate + auto-enter PiP + MediaCodec attach)");
  }
}

// --- 4b: WcDecoderBridge.java — native H.264 MediaCodec → Surface ----------
// Copied from scripts/android-templates/WcDecoderBridge.java with the app
// package substituted. Idempotent: rewritten whenever the template changes.
//
// The bridge owns the entire Android-side decode story: decoder selection
// (Moonlight-style — prefers a *.low_latency variant, then FEATURE_LowLatency,
// then any HW decoder, then SW as last resort), a progressive configure ladder
// (full vendor keys → KEY_LOW_LATENCY only → plain format) so a driver that
// rejects an unknown vendor key in configure() still starts, CSD-0/SPS+PPS
// extraction from the first IDR (required by many HW decoders), and a
// `probeDetail` JNI method that surfaces why the probe returned its answer so
// "MediaCodec unavailable" is diagnosable without logcat.
{
  const conf = JSON.parse(
    readFileSync(join(root, "companion", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const pkg = String(conf.identifier || "");
  const templatePath = join(root, "scripts", "android-templates", "WcDecoderBridge.java");
  if (!pkg) {
    console.warn("[patch-android] no identifier — skipping WcDecoderBridge.");
  } else if (!existsSync(templatePath)) {
    console.warn(`[patch-android] ${templatePath} missing — skipping WcDecoderBridge.`);
  } else {
    const bridgePath = join(
      androidDir,
      "app",
      "src",
      "main",
      "java",
      ...pkg.split("."),
      "WcDecoderBridge.java",
    );
    const template = readFileSync(templatePath, "utf8");
    const content = template.replace(/__PACKAGE__/g, pkg);
    const exists = existsSync(bridgePath);
    const before = exists ? readFileSync(bridgePath, "utf8") : "";
    if (!exists) {
      mkdirSync(dirname(bridgePath), { recursive: true });
      writeFileSync(bridgePath, content);
      note("created WcDecoderBridge.java");
    } else {
      save(bridgePath, before, content, "updated WcDecoderBridge.java");
    }
  }
}

// --- 4c: proguard-gametracker.pro — keep JNI-facing symbols -----------------
// The release build type enables R8 minification and pulls in every *.pro under
// app/ (fileTree include "**/*.pro"), so dropping this file next to the stock
// proguard-rules.pro is enough — no gradle edit needed.
//
// WHY: WcDecoderBridge's methods and MainActivity.setPipWanted are reached ONLY
// via JNI reflection from Rust (companion/src-tauri/src/{decoder,pip}.rs) and
// via addJavascriptInterface. R8 sees no Java-side references, so a minified
// release APK strips (or renames) them. The on-device symptom is a
// java.lang.NoSuchMethodError coming out of JNI — e.g. "no static method
// probeAvailable()Z" — and the phone silently losing native MediaCodec decode
// (DIRECT falls back to WebCodecs at a fraction of the fps).
{
  const conf = JSON.parse(
    readFileSync(join(root, "companion", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const pkg = String(conf.identifier || "");
  if (!pkg) {
    console.warn("[patch-android] no identifier — skipping proguard-gametracker.pro.");
  } else {
    const rulesPath = join(androidDir, "app", "proguard-gametracker.pro");
    const content =
      `# THIS FILE IS MANAGED BY scripts/patch-android.mjs - DO NOT EDIT.\n` +
      `#\n` +
      `# Keep every symbol that is reached ONLY through JNI reflection or\n` +
      `# addJavascriptInterface. R8 sees no Java-side references to these, so a\n` +
      `# minified release build strips or renames them; the on-device symptom is\n` +
      `# java.lang.NoSuchMethodError out of JNI (e.g. "no static method\n` +
      `# probeAvailable()Z") and the phone silently losing native MediaCodec\n` +
      `# decode (DIRECT falls back to WebCodecs).\n` +
      `\n` +
      `# Rust decoder.rs loads this class by name and calls its static methods.\n` +
      `-keep class ${pkg}.WcDecoderBridge { *; }\n` +
      `# Inner classes: JsApi (the window.__GT_DECODER__ JavascriptInterface),\n` +
      `# PendingFrame, and any future helpers.\n` +
      `-keep class ${pkg}.WcDecoderBridge$* { *; }\n` +
      `\n` +
      `# Rust pip.rs resolves MainActivity by name and uses these members for the\n` +
      `# PiP gate (the class itself is kept by the manifest; its members are not).\n` +
      `-keepclassmembers class ${pkg}.MainActivity {\n` +
      `    public static void setPipWanted(boolean);\n` +
      `    public static boolean pipWanted;\n` +
      `}\n` +
      `\n` +
      `# Shared clipboard: ClipboardBridge statics are called from Rust over JNI;\n` +
      `# the service + boot receiver + pick-activity are referenced only via the manifest.\n` +
      `-keep class ${pkg}.ClipboardBridge { *; }\n` +
      `-keep class ${pkg}.ClipboardService { *; }\n` +
      `-keep class ${pkg}.ClipboardBootReceiver { *; }\n` +
      `-keep class ${pkg}.ClipboardPickActivity { *; }\n` +
      `\n` +
      `# The mobile-network icon is reached only through the launcher manifest.\n` +
      `# Keep the activity stable in release R8.\n` +
      `-keep class ${pkg}.NetworkSettingsShortcutActivity { *; }\n` +
      `# The optional Shizuku network toggle is reached through a launcher alias\n` +
      `# and a UserService class name, not ordinary Java references.\n` +
      `-keep class ${pkg}.NetworkToggleShortcutActivity { *; }\n` +
      `-keep class ${pkg}.VoLteToggleShortcutActivity { *; }\n` +
      `-keep class ${pkg}.NetworkToggleUserService { *; }\n` +
      `\n` +
      `# Belt-and-braces: never strip @JavascriptInterface methods anywhere.\n` +
      `-keepclassmembers class * {\n` +
      `    @android.webkit.JavascriptInterface <methods>;\n` +
      `}\n`;
    const exists = existsSync(rulesPath);
    const before = exists ? readFileSync(rulesPath, "utf8") : "";
    if (!exists) {
      writeFileSync(rulesPath, content);
      note("created proguard-gametracker.pro (JNI keep rules)");
    } else {
      save(rulesPath, before, content, "updated proguard-gametracker.pro (JNI keep rules)");
    }
  }
}

// --- 7: direct mobile-network launcher shortcut -----------------------------
// The shortcut source/string are copied from templates because gen/android is
// regenerated by `tauri android init` and is intentionally not committed.
{
  const conf = JSON.parse(
    readFileSync(join(root, "companion", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const pkg = String(conf.identifier || "");
  if (pkg) {
    const name = "NetworkSettingsShortcutActivity.java";
    {
      const templatePath = join(root, "scripts", "android-templates", name);
      if (!existsSync(templatePath)) {
        console.warn(`[patch-android] ${templatePath} missing — skipping shortcut Java source.`);
      } else {
        const dest = join(androidDir, "app", "src", "main", "java", ...pkg.split("."), name);
        const content = readFileSync(templatePath, "utf8").replace(/__PACKAGE__/g, pkg);
        const exists = existsSync(dest);
        const before = exists ? readFileSync(dest, "utf8") : "";
        if (!exists) {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, content);
          note(`created ${name} (mobile-network launcher shortcut)`);
        } else {
          save(dest, before, content, `updated ${name} (mobile-network launcher shortcut)`);
        }
      }
    }
  } else {
    console.warn("[patch-android] no identifier — skipping shortcut Java source.");
  }

  // Optional Shizuku-backed toggle. These classes are loaded by class name in
  // Shizuku's shell/root process, so copy the Java implementation into every
  // generated Android tree.
  if (pkg) {
    for (const name of ["NetworkToggleShortcutActivity.java", "NetworkToggleUserService.java"]) {
      const templatePath = join(root, "scripts", "android-templates", name);
      const dest = join(androidDir, "app", "src", "main", "java", ...pkg.split("."), name);
      if (!existsSync(templatePath)) {
        console.warn(`[patch-android] ${templatePath} missing - skipping ${name}.`);
        continue;
      }
      const content = readFileSync(templatePath, "utf8").replace(/__PACKAGE__/g, pkg);
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note(`created ${name} (Shizuku network toggle)`);
      } else {
        save(dest, before, content, `updated ${name} (Shizuku network toggle)`);
      }
    }

    const name = "VoLteToggleShortcutActivity.java";
    const templatePath = join(root, "scripts", "android-templates", name);
    const dest = join(androidDir, "app", "src", "main", "java", ...pkg.split("."), name);
    if (!existsSync(templatePath)) {
      console.warn(`[patch-android] ${templatePath} missing - skipping VoLTE shortcut Java source.`);
    } else {
      const content = readFileSync(templatePath, "utf8").replace(/__PACKAGE__/g, pkg);
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note(`created ${name} (Shizuku VoLTE toggle)`);
      } else {
        save(dest, before, content, `updated ${name} (Shizuku VoLTE toggle)`);
      }
    }

  }

  const stringsName = "network_settings_shortcut_strings.xml";
  {
    const resDir = "values";
    const name = stringsName;
    const sourcePath = join(root, "scripts", "android-templates", name);
    if (!existsSync(sourcePath)) {
      console.warn(`[patch-android] ${sourcePath} missing — skipping shortcut string.`);
    } else {
      const dest = join(androidDir, "app", "src", "main", "res", resDir, name);
      const content = readFileSync(sourcePath, "utf8");
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note(`created ${resDir}/${name} (mobile-network launcher shortcut)`);
      } else {
        save(dest, before, content, `updated ${resDir}/${name} (mobile-network launcher shortcut)`);
      }
    }
  }

  const toggleStringsName = "network_toggle_shortcut_strings.xml";
  {
    const resDir = "values";
    const sourcePath = join(root, "scripts", "android-templates", toggleStringsName);
    if (!existsSync(sourcePath)) {
      console.warn(`[patch-android] ${sourcePath} missing - skipping toggle shortcut string.`);
    } else {
      const dest = join(androidDir, "app", "src", "main", "res", resDir, toggleStringsName);
      const content = readFileSync(sourcePath, "utf8");
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note(`created ${resDir}/${toggleStringsName} (Shizuku network toggle)`);
      } else {
        save(dest, before, content, `updated ${resDir}/${toggleStringsName} (Shizuku network toggle)`);
      }
    }
  }

  const volteStringsName = "volte_toggle_shortcut_strings.xml";
  {
    const resDir = "values";
    const sourcePath = join(root, "scripts", "android-templates", volteStringsName);
    const dest = join(androidDir, "app", "src", "main", "res", resDir, volteStringsName);
    if (!existsSync(sourcePath)) {
      console.warn(`[patch-android] ${sourcePath} missing - skipping VoLTE shortcut string.`);
    } else {
      const content = readFileSync(sourcePath, "utf8");
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note(`created ${resDir}/${volteStringsName} (Shizuku VoLTE toggle)`);
      } else {
        save(dest, before, content, `updated ${resDir}/${volteStringsName} (Shizuku VoLTE toggle)`);
      }
    }
  }

  const iconName = "network_settings_shortcut_icon.png";
  {
    const sourcePath = join(root, "scripts", "android-templates", iconName);
    if (!existsSync(sourcePath)) {
      console.warn(`[patch-android] ${sourcePath} missing - skipping shortcut icon.`);
    } else {
      const dest = join(
        androidDir,
        "app",
        "src",
        "main",
        "res",
        "drawable-nodpi",
        "ic_network_shortcut.png",
      );
      const content = readFileSync(sourcePath);
      const before = existsSync(dest) ? readFileSync(dest) : null;
      if (!before || !before.equals(content)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note("updated drawable-nodpi/ic_network_shortcut.png (mobile-network launcher icon)");
      }
    }
  }

  const toggleIconName = "network_toggle_icon.xml";
  {
    const sourcePath = join(root, "scripts", "android-templates", toggleIconName);
    const dest = join(androidDir, "app", "src", "main", "res", "drawable", "ic_network_toggle.xml");
    if (!existsSync(sourcePath)) {
      console.warn(`[patch-android] ${sourcePath} missing - skipping toggle shortcut icon.`);
    } else {
      const content = readFileSync(sourcePath, "utf8");
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note("created drawable/ic_network_toggle.xml (Shizuku network toggle icon)");
      } else {
        save(dest, before, content, "updated drawable/ic_network_toggle.xml (Shizuku network toggle icon)");
      }
    }
  }

  const volteIconName = "volte_toggle_icon.xml";
  {
    const sourcePath = join(root, "scripts", "android-templates", volteIconName);
    const dest = join(androidDir, "app", "src", "main", "res", "drawable", "ic_volte_toggle.xml");
    if (!existsSync(sourcePath)) {
      console.warn(`[patch-android] ${sourcePath} missing - skipping VoLTE shortcut icon.`);
    } else {
      const content = readFileSync(sourcePath, "utf8");
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note("created drawable/ic_volte_toggle.xml (Shizuku VoLTE toggle icon)");
      } else {
        save(dest, before, content, "updated drawable/ic_volte_toggle.xml (Shizuku VoLTE toggle icon)");
      }
    }
  }

  // Delete files left behind by the widget implementation in an existing
  // generated tree. These paths are all inside gen/android and are ignored by
  // Git; fresh Android scaffolds simply do not contain them.
  const staleAidl = join(
    androidDir,
    "app",
    "src",
    "main",
    "aidl",
    ...pkg.split("."),
    "INetworkToggleService.aidl",
  );
  if (existsSync(staleAidl)) {
    unlinkSync(staleAidl);
    note("removed aidl/INetworkToggleService.aidl (obsolete Windows AIDL bridge)");
  }
  const staleJava = ["PhoneSettingsWidgetProvider.java", "WidgetSettingsActivity.java"];
  for (const name of staleJava) {
    const stale = join(androidDir, "app", "src", "main", "java", ...pkg.split("."), name);
    if (existsSync(stale)) {
      unlinkSync(stale);
      note(`removed ${name} (obsolete phone settings widget)`);
    }
  }
  const staleResources = [
    ["layout", "widget_phone_settings.xml"],
    ["xml", "widget_phone_settings_info.xml"],
    ["drawable", "widget_phone_settings_background.xml"],
    ["drawable", "widget_phone_settings_row.xml"],
    ["drawable", "widget_phone_settings_pill.xml"],
    ["values", "widget_phone_settings_strings.xml"],
  ];
  for (const [resDir, name] of staleResources) {
    const stale = join(androidDir, "app", "src", "main", "res", resDir, name);
    if (existsSync(stale)) {
      unlinkSync(stale);
      note(`removed ${resDir}/${name} (obsolete phone settings widget)`);
    }
  }
}

// --- 5: ApkInstallReceiver.kt — PackageInstaller status callback -------------
// Handles the install session's status broadcast; on STATUS_PENDING_USER_ACTION it
// launches the system's install-confirmation dialog. Required for the in-app
// updater's PackageInstaller path (companion/src-tauri/src/update.rs) to show a
// prompt on modern Android. Package path derives from the identifier.
{
  const conf = JSON.parse(
    readFileSync(join(root, "companion", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const pkg = String(conf.identifier || "");
  if (!pkg) {
    console.warn("[patch-android] no identifier in tauri.conf.json — skipping ApkInstallReceiver.");
  } else {
    const receiverPath = join(
      androidDir,
      "app",
      "src",
      "main",
      "java",
      ...pkg.split("."),
      "ApkInstallReceiver.kt",
    );
    const content =
      `package ${pkg}\n\n` +
      `import android.content.BroadcastReceiver\n` +
      `import android.content.Context\n` +
      `import android.content.Intent\n` +
      `import android.content.pm.PackageInstaller\n\n` +
      `/**\n` +
      ` * Receives PackageInstaller session status callbacks from the in-app updater.\n` +
      ` * When the system asks for user confirmation it hands us a ready-made intent —\n` +
      ` * launching it is what makes the install prompt reliably appear (the legacy\n` +
      ` * ACTION_VIEW intent silently no-ops on modern Android).\n` +
      ` */\n` +
      `class ApkInstallReceiver : BroadcastReceiver() {\n` +
      `  override fun onReceive(context: Context, intent: Intent) {\n` +
      `    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)\n` +
      `    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {\n` +
      `      @Suppress("DEPRECATION")\n` +
      `      val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)\n` +
      `      if (confirm != null) {\n` +
      `        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)\n` +
      `        context.startActivity(confirm)\n` +
      `      }\n` +
      `    }\n` +
      `  }\n` +
      `}\n`;
    const exists = existsSync(receiverPath);
    const before = exists ? readFileSync(receiverPath, "utf8") : "";
    if (!exists) {
      mkdirSync(dirname(receiverPath), { recursive: true });
      writeFileSync(receiverPath, content);
      note("created ApkInstallReceiver.kt");
    } else {
      save(receiverPath, before, content, "updated ApkInstallReceiver.kt");
    }
  }
}

// --- 6: shared-clipboard native components -----------------------------------
// ClipboardBridge (JNI-reached statics), ClipboardService (overlay + FGS), and
// ClipboardBootReceiver, written from scripts/android-templates with the app
// package substituted. Idempotent.
{
  const conf = JSON.parse(
    readFileSync(join(root, "companion", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const pkg = String(conf.identifier || "");
  if (!pkg) {
    console.warn("[patch-android] no identifier — skipping clipboard components.");
  } else {
    for (const name of ["ClipboardBridge", "ClipboardService", "ClipboardBootReceiver", "ClipboardPickActivity"]) {
      const templatePath = join(root, "scripts", "android-templates", `${name}.java`);
      if (!existsSync(templatePath)) {
        console.warn(`[patch-android] ${templatePath} missing — skipping ${name}.`);
        continue;
      }
      const dest = join(androidDir, "app", "src", "main", "java", ...pkg.split("."), `${name}.java`);
      const content = readFileSync(templatePath, "utf8").replace(/__PACKAGE__/g, pkg);
      const exists = existsSync(dest);
      const before = exists ? readFileSync(dest, "utf8") : "";
      if (!exists) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        note(`created ${name}.java`);
      } else {
        save(dest, before, content, `updated ${name}.java`);
      }
    }
  }
}

console.log(
  changed === 0
    ? "[patch-android] already up to date — no changes."
    : `[patch-android] applied ${changed} change(s).`,
);
