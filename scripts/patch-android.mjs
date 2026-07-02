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

  save(manifestPath, before, m, "patched AndroidManifest.xml (permission/FileProvider)");
}

// --- 2b: res/xml/file_paths.xml ---------------------------------------------
{
  if (!existsSync(filePathsPath)) {
    mkdirSync(dirname(filePathsPath), { recursive: true });
    writeFileSync(
      filePathsPath,
      `<?xml version="1.0" encoding="utf-8"?>\r\n` +
        `<paths xmlns:android="http://schemas.android.com/apk/res/android">\r\n` +
        `  <external-path name="my_images" path="." />\r\n` +
        `  <cache-path name="my_cache_images" path="." />\r\n` +
        `</paths>\r\n`,
    );
    note("created res/xml/file_paths.xml");
  } else {
    const before = readFileSync(filePathsPath, "utf8");
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    let f = before;
    if (!/<cache-path\b/.test(f)) {
      f = f.replace(
        /([ \t]*<\/paths>)/,
        `  <cache-path name="my_cache_images" path="." />${eol}$1`,
      );
    }
    save(filePathsPath, before, f, "added cache-path to file_paths.xml");
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
    if (!before.includes("WindowInsetsControllerCompat")) {
      const content =
        `package ${pkg}\n\n` +
        `import android.os.Bundle\n` +
        `import androidx.activity.enableEdgeToEdge\n` +
        `import androidx.core.view.WindowInsetsCompat\n` +
        `import androidx.core.view.WindowInsetsControllerCompat\n\n` +
        `class MainActivity : TauriActivity() {\n` +
        `  override fun onCreate(savedInstanceState: Bundle?) {\n` +
        `    enableEdgeToEdge()\n` +
        `    super.onCreate(savedInstanceState)\n` +
        `    hideSystemBars()\n` +
        `  }\n\n` +
        `  override fun onWindowFocusChanged(hasFocus: Boolean) {\n` +
        `    super.onWindowFocusChanged(hasFocus)\n` +
        `    // Re-hide after the bars are transiently shown (keyboard, app resume).\n` +
        `    if (hasFocus) hideSystemBars()\n` +
        `  }\n\n` +
        `  private fun hideSystemBars() {\n` +
        `    val controller = WindowInsetsControllerCompat(window, window.decorView)\n` +
        `    controller.hide(WindowInsetsCompat.Type.systemBars())\n` +
        `    controller.systemBarsBehavior =\n` +
        `      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE\n` +
        `  }\n` +
        `}\n`;
      writeFileSync(mainActivityPath, content);
      note("rewrote MainActivity.kt (immersive full-screen)");
    }
  }
}

console.log(
  changed === 0
    ? "[patch-android] already up to date — no changes."
    : `[patch-android] applied ${changed} change(s).`,
);
