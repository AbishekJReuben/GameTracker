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
    let resp = ureq::get(url)
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
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

    emit(app, "installing", received, total);
    launch_installer(apk_path.to_string_lossy().as_ref())?;
    Ok(())
}

/// Hand the downloaded APK to the Android package installer via a FileProvider
/// content:// URI + `ACTION_VIEW` install intent (JNI, no Kotlin plugin needed).
#[cfg(target_os = "android")]
fn launch_installer(apk_path: &str) -> Result<(), String> {
    use jni::objects::{JObject, JValue};

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

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
                JValue::Object(&context),
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
        &context,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(|e| format!("startActivity: {e}"))?;

    Ok(())
}

#[cfg(not(target_os = "android"))]
fn launch_installer(_apk_path: &str) -> Result<(), String> {
    Err("APK install is only supported on Android".into())
}
