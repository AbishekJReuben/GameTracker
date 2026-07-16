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
    let content =
      `package ${pkg}\n\n` +
      `import android.app.PictureInPictureParams\n` +
      `import android.content.pm.ActivityInfo\n` +
      `import android.content.pm.PackageManager\n` +
      `import android.content.res.Configuration\n` +
      `import android.graphics.Rect\n` +
      `import android.os.Build\n` +
      `import android.os.Bundle\n` +
      `import android.util.Rational\n` +
      `import android.webkit.WebView\n` +
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
      `    // MediaCodec → Surface under the WebView (Moonlight/Chiaki-style\n` +
      `    // low-latency decode). JavascriptInterface + SurfaceView live in\n` +
      `    // WcDecoderBridge; frames arrive from cloud.ts via __GT_DECODER__.\n` +
      `    WcDecoderBridge.attach(this)\n` +
      `    // Follow the physical sensor in all four orientations, IGNORING the\n` +
      `    // system auto-rotate lock — holding the phone sideways for a moment\n` +
      `    // rotates the remote screen even with rotation lock on.\n` +
      `    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR\n` +
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
      `      v.setPadding(0, 0, 0, ime.bottom)\n` +
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
      `    WcDecoderBridge.installJsInterface(webView)\n` +
      `  }\n\n` +
      `  override fun onWindowFocusChanged(hasFocus: Boolean) {\n` +
      `    super.onWindowFocusChanged(hasFocus)\n` +
      `    // Re-hide after the bars are transiently shown (keyboard, app resume).\n` +
      `    if (hasFocus) hideSystemBars()\n` +
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
      `    if (!isInPictureInPictureMode) hideSystemBars()\n` +
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
