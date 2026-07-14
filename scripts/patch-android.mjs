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
//
// Usage: node scripts/patch-android.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
      `    </queries>${eol}`;
    m = m.replace(/([ \t]*<application\b)/, `${queries}$1`);
  }

  save(manifestPath, before, m, "patched AndroidManifest.xml (permission/FileProvider/receiver/queries)");
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

// --- 3: cleartext in the release build --------------------------------------
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
  save(gradlePath, before, g, "set usesCleartextTraffic in defaultConfig");
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
    const content =
      `package ${pkg}\n\n` +
      `import android.app.PictureInPictureParams\n` +
      `import android.content.pm.ActivityInfo\n` +
      `import android.content.res.Configuration\n` +
      `import android.os.Build\n` +
      `import android.os.Bundle\n` +
      `import android.util.Rational\n` +
      `import androidx.activity.enableEdgeToEdge\n` +
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
      `  }\n\n` +
      `  override fun onCreate(savedInstanceState: Bundle?) {\n` +
      `    enableEdgeToEdge()\n` +
      `    super.onCreate(savedInstanceState)\n` +
      `    current = WeakReference(this)\n` +
      `    // Follow the physical sensor in all four orientations, IGNORING the\n` +
      `    // system auto-rotate lock — holding the phone sideways for a moment\n` +
      `    // rotates the remote screen even with rotation lock on.\n` +
      `    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR\n` +
      `    hideSystemBars()\n` +
      `    updatePipParams()\n` +
      `  }\n\n` +
      `  override fun onWindowFocusChanged(hasFocus: Boolean) {\n` +
      `    super.onWindowFocusChanged(hasFocus)\n` +
      `    // Re-hide after the bars are transiently shown (keyboard, app resume).\n` +
      `    if (hasFocus) hideSystemBars()\n` +
      `  }\n\n` +
      `  /** Android 12+: auto-enter PiP is armed via params (the OS runs the smooth\n` +
      `   *  shrink animation itself when the user swipes home — no flicker, exactly\n` +
      `   *  like YouTube). Re-applied whenever the session-live gate flips. */\n` +
      `  fun updatePipParams() {\n` +
      `    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return\n` +
      `    try {\n` +
      `      setPictureInPictureParams(\n` +
      `        PictureInPictureParams.Builder()\n` +
      `          .setAspectRatio(Rational(16, 9))\n` +
      `          .setAutoEnterEnabled(pipWanted)\n` +
      `          .setSeamlessResizeEnabled(false)\n` +
      `          .build()\n` +
      `      )\n` +
      `    } catch (_: Exception) {\n` +
      `      // PiP unavailable (device/settings) — plain backgrounding is fine.\n` +
      `    }\n` +
      `  }\n\n` +
      `  // Home / recents while connected → floating 16:9 mini window. Legacy path\n` +
      `  // for Android 8–11 (S+ uses the auto-enter params above; entering again\n` +
      `  // here would double-trigger, so it's gated to pre-S).\n` +
      `  override fun onUserLeaveHint() {\n` +
      `    super.onUserLeaveHint()\n` +
      `    if (\n` +
      `      pipWanted &&\n` +
      `      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&\n` +
      `      Build.VERSION.SDK_INT < Build.VERSION_CODES.S\n` +
      `    ) {\n` +
      `      try {\n` +
      `        enterPictureInPictureMode(\n` +
      `          PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build()\n` +
      `        )\n` +
      `      } catch (_: Exception) {\n` +
      `        // PiP unavailable (device/settings) — plain backgrounding is fine.\n` +
      `      }\n` +
      `    }\n` +
      `  }\n\n` +
      `  override fun onPictureInPictureModeChanged(\n` +
      `    isInPictureInPictureMode: Boolean,\n` +
      `    newConfig: Configuration\n` +
      `  ) {\n` +
      `    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)\n` +
      `    if (!isInPictureInPictureMode) hideSystemBars()\n` +
      `  }\n\n` +
      `  private fun hideSystemBars() {\n` +
      `    val controller = WindowInsetsControllerCompat(window, window.decorView)\n` +
      `    controller.hide(WindowInsetsCompat.Type.systemBars())\n` +
      `    controller.systemBarsBehavior =\n` +
      `      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE\n` +
      `  }\n` +
      `}\n`;
    save(mainActivityPath, before, content, "rewrote MainActivity.kt (immersive + sensor rotate + auto-enter PiP)");
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

console.log(
  changed === 0
    ? "[patch-android] already up to date — no changes."
    : `[patch-android] applied ${changed} change(s).`,
);
