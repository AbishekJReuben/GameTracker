//! In-app updater for the Android companion.
//!
//! Tauri's `updater` plugin does not support Android, so this is a small custom
//! mechanism: the webview checks GitHub for a newer version (see
//! `src/companion/update.ts`) and, when the user taps "Update", calls
//! [`download_and_install_apk`]. That downloads the release APK into the app
//! cache dir and hands it to Android's system package installer (which shows the
//! usual one-tap install confirmation — stock Android never allows a fully
//! silent sideload install).

use std::io::Read;

use tauri::{AppHandle, Emitter, Manager};

/// The companion's applicationId (identifier in `companion/src-tauri/tauri.conf.json`).
/// Used to build the FileProvider authority and the explicit receiver class name.
#[cfg(target_os = "android")]
const PACKAGE_NAME: &str = "com.chilloutgames.gametracker.companion";

/// FileProvider authority — must match `${applicationId}.fileprovider` declared
/// in the generated AndroidManifest (identifier from tauri.conf.json).
#[cfg(target_os = "android")]
const FILE_PROVIDER_AUTHORITY: &str = "com.chilloutgames.gametracker.companion.fileprovider";

/// Download the APK at `url` into the app cache dir, then launch the Android
/// package installer for it. Progress is emitted on `apk-update://progress`
/// (`{ phase, received, total }`) so the UI can show a bar.
#[tauri::command]
pub async fn download_and_install_apk(app: AppHandle, url: String) -> Result<(), String> {
    // Resolve the cache dir on the calling thread (AppHandle::path needs the
    // handle), then do the blocking download + install off the main thread.
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache dir: {e}"))?;

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_update(&app2, &url, &cache_dir))
        .await
        .map_err(|e| format!("update task panicked: {e}"))?
}

/// Fetch the update manifest JSON over HTTP and return it as a string.
///
/// The webview's own `fetch()` is subject to CORS, and GitHub's release-asset host
/// doesn't send `Access-Control-Allow-Origin` for the app's origin, so an in-page
/// fetch fails with "Failed to fetch". Doing it here (ureq, like the APK download)
/// sidesteps CORS entirely — the manifest is tiny, so the round-trip is cheap.
#[tauri::command]
pub async fn fetch_update_manifest(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .set("User-Agent", "GameTrackerRemote-Updater")
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => format!("update server returned HTTP {code}"),
                other => format!("could not reach the update server: {other}"),
            })?;
        resp.into_string()
            .map_err(|e| format!("could not read the update manifest: {e}"))
    })
    .await
    .map_err(|e| format!("manifest fetch task panicked: {e}"))?
}

/// Whether Android currently permits this app to install packages ("install
/// unknown apps"). Checked up front so the UI can prompt the user to grant it
/// BEFORE downloading, instead of failing at the install step. Always `true` on
/// non-Android / pre-API-26 where the concept doesn't exist.
#[tauri::command]
pub async fn install_permission_status() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(check_install_permission)
        .await
        .map_err(|e| format!("permission check panicked: {e}"))?
}

/// Open the system "install unknown apps" settings screen for this app so the
/// user can grant permission in one tap.
#[tauri::command]
pub async fn open_install_settings() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(open_install_settings_impl)
        .await
        .map_err(|e| format!("open settings panicked: {e}"))?
}

#[cfg(target_os = "android")]
fn check_install_permission() -> Result<bool, String> {
    use jni::objects::JObject;
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let allowed = can_request_installs(&mut env, &context).unwrap_or(true);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    Ok(allowed)
}

#[cfg(target_os = "android")]
fn open_install_settings_impl() -> Result<(), String> {
    use jni::objects::JObject;
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let r = open_unknown_sources_settings(&mut env, &context);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    r
}

#[cfg(not(target_os = "android"))]
fn check_install_permission() -> Result<bool, String> {
    Ok(true)
}

#[cfg(not(target_os = "android"))]
fn open_install_settings_impl() -> Result<(), String> {
    Err("Install settings are only available on Android".into())
}

fn emit(app: &AppHandle, phase: &str, received: u64, total: u64) {
    let _ = app.emit(
        "apk-update://progress",
        serde_json::json!({ "phase": phase, "received": received, "total": total }),
    );
}

fn run_update(app: &AppHandle, url: &str, cache_dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("mkdir cache: {e}"))?;
    let apk_path = cache_dir.join("update.apk");

    emit(app, "downloading", 0, 0);
    // GitHub's `releases/latest/download/<asset>` URL answers with a chain of 302
    // redirects to a signed CDN object; ureq follows redirects by default. Send a
    // User-Agent (GitHub can reject blank-UA clients) and surface a clear error if
    // the final response isn't a 2xx so the UI can report *why* it failed.
    let resp = ureq::get(url)
        .set("User-Agent", "GameTrackerRemote-Updater")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => {
                format!("download failed: server returned HTTP {code}")
            }
            other => format!("download failed: {other}"),
        })?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&apk_path).map_err(|e| format!("create apk: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut magic = [0u8; 2]; // first two bytes — a real APK (ZIP) starts with "PK"
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        if received == 0 && n >= 2 {
            magic.copy_from_slice(&buf[..2]);
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("write: {e}"))?;
        received += n as u64;
        emit(app, "downloading", received, total);
    }
    // Flush to disk before handing the path to another process (the installer).
    let _ = file.sync_all();
    drop(file);

    // Guard against a truncated/HTML error body being handed to the package
    // installer (which would fail with an opaque "parse error" — looking to the
    // user like the update just didn't work). A real APK is a ZIP, comfortably
    // larger than this floor and starting with the ZIP magic "PK".
    if received < 1024 {
        return Err(format!(
            "downloaded file is too small ({received} bytes) — the update may not be published yet"
        ));
    }
    if magic != *b"PK" {
        return Err(
            "the downloaded file isn't a valid APK (the release asset may be missing or the \
             link redirected to an error page) — try again shortly"
                .into(),
        );
    }

    emit(app, "installing", received, total);
    launch_installer(apk_path.to_string_lossy().as_ref())?;
    Ok(())
}

/// Hand the downloaded APK to the Android package installer.
///
/// Primary path is the **`PackageInstaller` Session API** (`do_install_session`):
/// on modern Android (this app targets SDK 36 / Android 16) the legacy
/// `ACTION_VIEW` + `application/vnd.android.package-archive` intent is unreliable —
/// the system install-confirmation dialog frequently just never appears (which is
/// exactly "the install prompt never shows up"). PackageInstaller is the API Google
/// documents for this: committing a session makes the *system* drive the
/// confirmation UI via a status callback, so the prompt reliably shows. We keep the
/// old `ACTION_VIEW` path (`do_install_legacy`) as a fallback for the rare device
/// where the session path errors.
#[cfg(target_os = "android")]
fn launch_installer(apk_path: &str) -> Result<(), String> {
    use jni::objects::JObject;

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // Gate up front: without "install unknown apps" the system silently refuses.
    // Bounce the user to the exact settings screen and return a clear message
    // instead of firing an install that quietly does nothing. On API < 26 the check
    // throws NoSuchMethodError → treat as allowed and clear the pending exception.
    let allowed = can_request_installs(&mut env, &context).unwrap_or(true);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    if !allowed {
        let _ = open_unknown_sources_settings(&mut env, &context);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        return Err(
            "Android needs permission to install updates. We opened the setting — enable \
             \"Allow from this source\", then tap Update again."
                .into(),
        );
    }

    // Try the modern PackageInstaller session first. Any pending Java exception is
    // ALWAYS cleared before returning: detaching the thread with an exception pending
    // makes ART abort the whole process (the old "crashes when installing" bug).
    let session_result = do_install_session(&mut env, &context, apk_path);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe(); // dump to logcat for diagnosis
        let _ = env.exception_clear();
    }
    if session_result.is_ok() {
        return Ok(());
    }

    // Fallback: legacy ACTION_VIEW + FileProvider intent.
    let legacy_result = do_install_legacy(&mut env, &context, apk_path);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    // Surface the session error if the legacy path also failed (it's the more
    // informative one on a modern device).
    legacy_result.map_err(|legacy| {
        let session = session_result.err().unwrap_or_default();
        if session.is_empty() { legacy } else { format!("{session}; fallback: {legacy}") }
    })
}

/// Install the APK via `PackageInstaller` (the reliable modern path). Creates a
/// session, streams the APK bytes into it, and commits with a `PendingIntent`
/// targeting our `ApkInstallReceiver` — when the system needs user confirmation it
/// broadcasts `STATUS_PENDING_USER_ACTION` and the receiver launches the install
/// dialog. This is JNI-only (no Kotlin plugin); the receiver is a tiny generated
/// class registered by `scripts/patch-android.mjs`.
#[cfg(target_os = "android")]
fn do_install_session(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
    apk_path: &str,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    // Load the whole APK into memory once (tens of MB — fine) so we can hand it to
    // the session's OutputStream in a single JNI write.
    let bytes = std::fs::read(apk_path).map_err(|e| format!("read apk: {e}"))?;
    let len = bytes.len() as i64;

    // PackageInstaller installer = context.getPackageManager().getPackageInstaller();
    let pm = env
        .call_method(context, "getPackageManager", "()Landroid/content/pm/PackageManager;", &[])
        .map_err(|e| format!("getPackageManager: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    let installer = env
        .call_method(&pm, "getPackageInstaller", "()Landroid/content/pm/PackageInstaller;", &[])
        .map_err(|e| format!("getPackageInstaller: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // SessionParams params = new SessionParams(MODE_FULL_INSTALL); params.setSize(len);
    const MODE_FULL_INSTALL: i32 = 1;
    let params = env
        .new_object(
            "android/content/pm/PackageInstaller$SessionParams",
            "(I)V",
            &[JValue::Int(MODE_FULL_INSTALL)],
        )
        .map_err(|e| format!("SessionParams: {e}"))?;
    let _ = env.call_method(&params, "setSize", "(J)V", &[JValue::Long(len)]);

    // int sessionId = installer.createSession(params);
    let session_id = env
        .call_method(
            &installer,
            "createSession",
            "(Landroid/content/pm/PackageInstaller$SessionParams;)I",
            &[JValue::Object(&params)],
        )
        .map_err(|e| format!("createSession: {e}"))?
        .i()
        .map_err(|e| e.to_string())?;

    // Session session = installer.openSession(sessionId);
    let session = env
        .call_method(
            &installer,
            "openSession",
            "(I)Landroid/content/pm/PackageInstaller$Session;",
            &[JValue::Int(session_id)],
        )
        .map_err(|e| format!("openSession: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // OutputStream out = session.openWrite("base.apk", 0, len);
    let name: JObject = env.new_string("base.apk").map_err(|e| e.to_string())?.into();
    let out = env
        .call_method(
            &session,
            "openWrite",
            "(Ljava/lang/String;JJ)Ljava/io/OutputStream;",
            &[JValue::Object(&name), JValue::Long(0), JValue::Long(len)],
        )
        .map_err(|e| format!("openWrite: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // out.write(bytes); session.fsync(out); out.flush(); out.close();
    let jbytes = env.byte_array_from_slice(&bytes).map_err(|e| e.to_string())?;
    env.call_method(&out, "write", "([B)V", &[JValue::Object(&JObject::from(jbytes))])
        .map_err(|e| format!("write: {e}"))?;
    env.call_method(&session, "fsync", "(Ljava/io/OutputStream;)V", &[JValue::Object(&out)])
        .map_err(|e| format!("fsync: {e}"))?;
    let _ = env.call_method(&out, "flush", "()V", &[]);
    env.call_method(&out, "close", "()V", &[]).map_err(|e| format!("close: {e}"))?;

    // Intent statusIntent = new Intent().setClassName(pkg, "<pkg>.ApkInstallReceiver");
    let pkg_name = env
        .call_method(context, "getPackageName", "()Ljava/lang/String;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let receiver: JObject = env
        .new_string(format!("{PACKAGE_NAME}.ApkInstallReceiver"))
        .map_err(|e| e.to_string())?
        .into();
    let intent = env
        .new_object("android/content/Intent", "()V", &[])
        .map_err(|e| e.to_string())?;
    env.call_method(
        &intent,
        "setClassName",
        "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
        &[JValue::Object(&pkg_name), JValue::Object(&receiver)],
    )
    .map_err(|e| format!("setClassName: {e}"))?;

    // PendingIntent pi = PendingIntent.getBroadcast(ctx, sessionId, intent, MUTABLE|UPDATE_CURRENT);
    // FLAG_MUTABLE (API 31+) is REQUIRED — the system fills the status extras in.
    const FLAG_UPDATE_CURRENT: i32 = 0x0800_0000;
    const FLAG_MUTABLE: i32 = 0x0200_0000;
    let pending = env
        .call_static_method(
            "android/app/PendingIntent",
            "getBroadcast",
            "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;",
            &[
                JValue::Object(context),
                JValue::Int(session_id),
                JValue::Object(&intent),
                JValue::Int(FLAG_UPDATE_CURRENT | FLAG_MUTABLE),
            ],
        )
        .map_err(|e| format!("getBroadcast: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    let sender = env
        .call_method(&pending, "getIntentSender", "()Landroid/content/IntentSender;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // session.commit(sender); session.close();
    env.call_method(&session, "commit", "(Landroid/content/IntentSender;)V", &[JValue::Object(&sender)])
        .map_err(|e| format!("commit: {e}"))?;
    let _ = env.call_method(&session, "close", "()V", &[]);
    Ok(())
}

/// Legacy install path: hand the APK to the installer via a FileProvider
/// content:// URI + `ACTION_VIEW` intent. Kept only as a fallback — on modern
/// Android the confirmation dialog can silently fail to appear (see
/// `do_install_session`, the primary path).
#[cfg(target_os = "android")]
fn do_install_legacy(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
    apk_path: &str,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    // On Android 8+ an app can't launch the package installer unless the user has
    // granted it "install unknown apps". If we don't have it, bounce the user to the
    // exact settings screen for THIS app and return a clear message instead of firing
    // an install intent that the system silently refuses (which looked like a failure).
    // On API < 26 `canRequestPackageInstalls` doesn't exist (throws NoSuchMethodError) —
    // treat any check failure as "allowed" and CLEAR the pending exception so it can't
    // poison the install JNI calls that follow (a pending exception aborts the process).
    let allowed = can_request_installs(env, context).unwrap_or(true);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    if !allowed {
        let _ = open_unknown_sources_settings(env, context);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        return Err(
            "Android needs permission to install updates. We opened the setting — enable \
             \"Allow from this source\", then tap Update again."
                .into(),
        );
    }

    // File file = new File(apk_path);
    let jpath: JObject = env.new_string(apk_path).map_err(|e| e.to_string())?.into();
    let file = env
        .new_object("java/io/File", "(Ljava/lang/String;)V", &[JValue::Object(&jpath)])
        .map_err(|e| e.to_string())?;

    // Uri uri = FileProvider.getUriForFile(context, authority, file);
    let authority: JObject = env
        .new_string(FILE_PROVIDER_AUTHORITY)
        .map_err(|e| e.to_string())?
        .into();
    let uri = env
        .call_static_method(
            "androidx/core/content/FileProvider",
            "getUriForFile",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
            &[
                JValue::Object(context),
                JValue::Object(&authority),
                JValue::Object(&file),
            ],
        )
        .map_err(|e| format!("getUriForFile: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;

    // Intent intent = new Intent(Intent.ACTION_VIEW);
    let action: JObject = env
        .new_string("android.intent.action.VIEW")
        .map_err(|e| e.to_string())?
        .into();
    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )
        .map_err(|e| e.to_string())?;

    // intent.setDataAndType(uri, "application/vnd.android.package-archive");
    let mime: JObject = env
        .new_string("application/vnd.android.package-archive")
        .map_err(|e| e.to_string())?
        .into();
    env.call_method(
        &intent,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[JValue::Object(&uri), JValue::Object(&mime)],
    )
    .map_err(|e| e.to_string())?;

    // intent.addFlags(FLAG_ACTIVITY_NEW_TASK | FLAG_GRANT_READ_URI_PERMISSION);
    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
    const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x0000_0001;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(FLAG_ACTIVITY_NEW_TASK | FLAG_GRANT_READ_URI_PERMISSION)],
    )
    .map_err(|e| e.to_string())?;

    // context.startActivity(intent);
    env.call_method(
        context,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(|e| format!("startActivity: {e}"))?;

    Ok(())
}

/// context.getPackageManager().canRequestPackageInstalls() — whether this app may
/// install packages (Android 8+; older versions always may, so treat errors as `true`).
#[cfg(target_os = "android")]
fn can_request_installs(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
) -> Result<bool, String> {
    let pm = env
        .call_method(context, "getPackageManager", "()Landroid/content/pm/PackageManager;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let allowed = env
        .call_method(&pm, "canRequestPackageInstalls", "()Z", &[])
        .map_err(|e| e.to_string())?
        .z()
        .map_err(|e| e.to_string())?;
    Ok(allowed)
}

/// Open Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES for this package so the user can
/// grant install permission in one tap. Best-effort (errors are ignored by the caller).
#[cfg(target_os = "android")]
fn open_unknown_sources_settings(
    env: &mut jni::AttachGuard,
    context: &jni::objects::JObject,
) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    // String pkg = context.getPackageName();  (kept as a Java String — no Rust round-trip)
    let pkg = env
        .call_method(context, "getPackageName", "()Ljava/lang/String;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // Uri uri = Uri.fromParts("package", pkg, null);  (builds package:<pkg> in Java)
    let scheme: JObject = env.new_string("package").map_err(|e| e.to_string())?.into();
    let null_obj = JObject::null();
    let uri = env
        .call_static_method(
            "android/net/Uri",
            "fromParts",
            "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;",
            &[
                JValue::Object(&scheme),
                JValue::Object(&pkg),
                JValue::Object(&null_obj),
            ],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;

    // Intent intent = new Intent(ACTION_MANAGE_UNKNOWN_APP_SOURCES, uri);
    let action: JObject = env
        .new_string("android.settings.MANAGE_UNKNOWN_APP_SOURCES")
        .map_err(|e| e.to_string())?
        .into();
    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;Landroid/net/Uri;)V",
            &[JValue::Object(&action), JValue::Object(&uri)],
        )
        .map_err(|e| e.to_string())?;

    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
    env.call_method(&intent, "addFlags", "(I)Landroid/content/Intent;", &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)])
        .map_err(|e| e.to_string())?;
    env.call_method(context, "startActivity", "(Landroid/content/Intent;)V", &[JValue::Object(&intent)])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn launch_installer(_apk_path: &str) -> Result<(), String> {
    Err("APK install is only supported on Android".into())
}
