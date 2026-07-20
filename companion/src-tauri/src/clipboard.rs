//! Shared-clipboard native bridge for the Android companion.
//!
//! The always-on overlay + relay sync live in a native foreground service
//! (`ClipboardService`, drawn over all apps and surviving indefinitely — see
//! `scripts/patch-android.mjs`) because the webview's JS dies when the activity
//! is destroyed. These commands are the JS → Kotlin/Java bridge: start/stop the
//! service, check + request the runtime permissions, and read/write the OS
//! clipboard while the app is foregrounded (the only time Android 10+ allows it).
//!
//! Same JNI shape as `pip.rs`: resolve app classes through the activity's class
//! loader (a native thread's `FindClass` only sees system classes), and always
//! clear any pending Java exception before returning (a pending exception on
//! thread-detach aborts the process).

#[cfg(target_os = "android")]
const BRIDGE: &str = "com.chilloutgames.gametracker.companion.ClipboardBridge";

#[cfg(target_os = "android")]
mod imp {
    use super::BRIDGE;
    use jni::objects::{JClass, JObject, JValue};
    use jni::{JNIEnv, JavaVM};

    /// Run `f` with an attached JNI env + the app Context. Clears exceptions.
    pub fn with_env<T>(
        f: impl FnOnce(&mut JNIEnv, &JObject) -> Result<T, String>,
    ) -> Result<T, String> {
        let ctx = crate::update::tao_android_context()?;
        let vm = unsafe { JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
        let out = f(&mut env, &context);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        out
    }

    /// Load an app class through the Context's class loader.
    pub fn load_class<'a>(
        env: &mut JNIEnv<'a>,
        context: &JObject,
        name: &str,
    ) -> Result<JClass<'a>, String> {
        let loader = env
            .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("getClassLoader: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        let jname: JObject = env.new_string(name).map_err(|e| e.to_string())?.into();
        let class_obj = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&jname)],
            )
            .map_err(|e| format!("loadClass {name}: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        Ok(JClass::from(class_obj))
    }

    /// Call `ClipboardBridge.<method>(Context) -> boolean`.
    pub fn call_bool(method: &str) -> Result<bool, String> {
        with_env(|env, context| {
            let class = load_class(env, context, BRIDGE)?;
            let v = env
                .call_static_method(
                    &class,
                    method,
                    "(Landroid/content/Context;)Z",
                    &[JValue::Object(context)],
                )
                .map_err(|e| format!("{method}: {e}"))?;
            v.z().map_err(|e| e.to_string())
        })
    }

    /// Call `ClipboardBridge.<method>(Context) -> void`.
    pub fn call_void(method: &str) -> Result<(), String> {
        with_env(|env, context| {
            let class = load_class(env, context, BRIDGE)?;
            env.call_static_method(
                &class,
                method,
                "(Landroid/content/Context;)V",
                &[JValue::Object(context)],
            )
            .map_err(|e| format!("{method}: {e}"))?;
            Ok(())
        })
    }

    /// Call `ClipboardBridge.readClipboard(Context) -> String`.
    pub fn read_clipboard() -> Result<String, String> {
        with_env(|env, context| {
            let class = load_class(env, context, BRIDGE)?;
            let obj = env
                .call_static_method(
                    &class,
                    "readClipboard",
                    "(Landroid/content/Context;)Ljava/lang/String;",
                    &[JValue::Object(context)],
                )
                .map_err(|e| format!("readClipboard: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            if obj.is_null() {
                return Ok(String::new());
            }
            let s: String = env
                .get_string(&obj.into())
                .map_err(|e| e.to_string())?
                .into();
            Ok(s)
        })
    }

    /// Call `ClipboardBridge.writeClipboard(Context, String)`.
    pub fn write_clipboard(text: &str) -> Result<(), String> {
        with_env(|env, context| {
            let class = load_class(env, context, BRIDGE)?;
            let jtext: JObject = env.new_string(text).map_err(|e| e.to_string())?.into();
            env.call_static_method(
                &class,
                "writeClipboard",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::Object(context), JValue::Object(&jtext)],
            )
            .map_err(|e| format!("writeClipboard: {e}"))?;
            Ok(())
        })
    }

    /// Call `ClipboardBridge.startService(Context, boolean, String, String, String)`
    /// to (re)start or stop the overlay + sync service with its config.
    pub fn start_service(
        enabled: bool,
        secret: &str,
        device_id: &str,
        signal_url: &str,
    ) -> Result<(), String> {
        with_env(|env, context| {
            let class = load_class(env, context, BRIDGE)?;
            let jsecret: JObject = env.new_string(secret).map_err(|e| e.to_string())?.into();
            let jdev: JObject = env.new_string(device_id).map_err(|e| e.to_string())?.into();
            let jurl: JObject = env
                .new_string(signal_url)
                .map_err(|e| e.to_string())?
                .into();
            env.call_static_method(
                &class,
                "startService",
                "(Landroid/content/Context;ZLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::Object(context),
                    JValue::Bool(u8::from(enabled)),
                    JValue::Object(&jsecret),
                    JValue::Object(&jdev),
                    JValue::Object(&jurl),
                ],
            )
            .map_err(|e| format!("startService: {e}"))?;
            Ok(())
        })
    }

    /// Call `ClipboardBridge.snapshot(Context) -> String`.
    pub fn snapshot() -> Result<String, String> {
        with_env(|env, context| {
            let class = load_class(env, context, BRIDGE)?;
            let obj = env
                .call_static_method(
                    &class,
                    "snapshot",
                    "(Landroid/content/Context;)Ljava/lang/String;",
                    &[JValue::Object(context)],
                )
                .map_err(|e| format!("snapshot: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            if obj.is_null() {
                return Ok(String::new());
            }
            let s: String = env
                .get_string(&obj.into())
                .map_err(|e| e.to_string())?
                .into();
            Ok(s)
        })
    }
}

// ------------------------------- commands -----------------------------------

#[tauri::command]
pub async fn clipboard_service_start(
    enabled: bool,
    secret: String,
    device_id: String,
    signal_url: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            imp::start_service(enabled, &secret, &device_id, &signal_url)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (enabled, secret, device_id, signal_url);
        Ok(())
    }
}

#[tauri::command]
pub async fn clipboard_overlay_status() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(|| imp::call_bool("overlayGranted"))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(true)
}

#[tauri::command]
pub async fn clipboard_request_overlay() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(|| imp::call_void("requestOverlay"))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(())
}

#[tauri::command]
pub async fn clipboard_battery_status() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(|| imp::call_bool("batteryExempt"))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(true)
}

#[tauri::command]
pub async fn clipboard_request_battery() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(|| imp::call_void("requestBattery"))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(())
}

#[tauri::command]
pub async fn clipboard_notif_status() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(|| imp::call_bool("notifGranted"))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(true)
}

#[tauri::command]
pub async fn clipboard_request_notif() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(|| imp::call_void("requestNotif"))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(())
}

#[tauri::command]
pub async fn clipboard_read() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(imp::read_clipboard)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(String::new())
}

#[tauri::command]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::write_clipboard(&text))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = text;
        Ok(())
    }
}

#[tauri::command]
pub async fn clipboard_service_snapshot() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(imp::snapshot)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    Ok(String::from("{}"))
}
