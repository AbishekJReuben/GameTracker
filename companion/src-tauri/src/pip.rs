//! Picture-in-picture gate for the Android shell.
//!
//! The webview flips `MainActivity.pipWanted` (a static Java field, see
//! `scripts/patch-android.mjs`) over JNI while a remote session is live; the
//! activity's `onUserLeaveHint` then shrinks the app into a floating 16:9 mini
//! window (YouTube/AnyDesk style) instead of plain backgrounding. Gated so an
//! unconnected app (dashboard, pairing) backgrounds normally.

#[tauri::command]
pub async fn set_pip_enabled(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_pip_impl(enabled))
        .await
        .map_err(|e| format!("pip task panicked: {e}"))?
}

#[cfg(target_os = "android")]
fn set_pip_impl(enabled: bool) -> Result<(), String> {
    use jni::objects::{JClass, JObject, JValue};

    let ctx = crate::update::tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };

    let result = (|| -> Result<(), String> {
        // Resolve MainActivity through the app's class loader — `FindClass` from a
        // native (non-main) thread only sees system classes, so it can't load app
        // classes directly.
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("getClassLoader: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        let name: JObject = env
            .new_string("com.chilloutgames.gametracker.companion.MainActivity")
            .map_err(|e| e.to_string())?
            .into();
        let class_obj = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )
            .map_err(|e| format!("loadClass: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        let class = JClass::from(class_obj);
        let fid = env
            .get_static_field_id(&class, "pipWanted", "Z")
            .map_err(|e| format!("pipWanted field: {e}"))?;
        env.set_static_field(&class, fid, JValue::Bool(u8::from(enabled)))
            .map_err(|e| format!("set pipWanted: {e}"))?;
        Ok(())
    })();

    // Never leave a pending Java exception on the thread (aborts the process).
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    result
}

#[cfg(not(target_os = "android"))]
fn set_pip_impl(_enabled: bool) -> Result<(), String> {
    Ok(())
}
