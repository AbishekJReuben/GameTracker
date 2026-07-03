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
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("write: {e}"))?;
        received += n as u64;
        emit(app, "downloading", received, total);
    }
    drop(file);

    // Guard against a truncated/HTML error body being handed to the package
    // installer (which would fail with an opaque "parse error"). A real APK is a
    // ZIP, comfortably larger than this floor.
    if received < 1024 {
        return Err(format!(
            "downloaded file is too small ({received} bytes) — the update may not be published yet"
        ));
    }

    emit(app, "installing", received, total);
    launch_installer(apk_path.to_string_lossy().as_ref())?;
    Ok(())
}

/// Hand the downloaded APK to the Android package installer via a FileProvider
/// content:// URI + `ACTION_VIEW` install intent (JNI, no Kotlin plugin needed).
#[cfg(target_os = "android")]
fn launch_installer(apk_path: &str) -> Result<(), String> {
    use jni::objects::JObject;

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // Run the JNI sequence, then ALWAYS clear any pending Java exception before
    // returning. A JNI call that fails because Java threw (e.g. FileProvider misconfig,
    // or startActivity for the installer while "install unknown apps" is off) leaves
    // the exception pending; returning to the JVM / detaching the thread with a pending
    // exception makes ART abort the whole process — which is exactly the "crashes when
    // trying to install" the user saw. Clearing it turns that into a clean error string
    // the UI can show ("Update failed — tap to retry") instead of a native crash.
    let result = do_install(&mut env, &context, apk_path);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe(); // dump to logcat for diagnosis
        let _ = env.exception_clear();
    }
    result
}

#[cfg(target_os = "android")]
fn do_install(
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
