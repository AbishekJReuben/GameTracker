//! Picture-in-picture gate for the Android shell.
//!
//! The webview calls `MainActivity.setPipWanted(bool)` (a static Kotlin method,
//! see `scripts/patch-android.mjs`) over JNI while a remote session is live.
//! On Android 12+ that arms `PictureInPictureParams.setAutoEnterEnabled`, so
//! the OS itself runs the seamless YouTube-style shrink animation on the home
//! gesture / app switch; Android 8–11 falls back to `onUserLeaveHint`. Gated so
//! an unconnected app (dashboard, pairing) backgrounds normally. If the method
//! is missing (older generated activity), the raw `pipWanted` field is set
//! instead so the legacy leave-hint path still works.

#[tauri::command]
pub async fn set_pip_enabled(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_pip_impl(enabled))
        .await
        .map_err(|e| format!("pip task panicked: {e}"))?
}

#[tauri::command]
pub async fn set_rotation_hold_ms(value: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_rotation_hold_impl(value))
        .await
        .map_err(|e| format!("rotation task panicked: {e}"))?
}

#[tauri::command]
pub async fn set_remote_rotation(active: bool, value: u64, revision: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_remote_rotation_impl(active,value,revision))
        .await.map_err(|e| format!("rotation task panicked: {e}"))?
}

fn valid_rotation_ms(value: u64) -> i64 { if value == 0 || (400..=3000).contains(&value) { value as i64 } else { 1200 } }

#[cfg(target_os = "android")]
fn set_rotation_hold_impl(value: u64) -> Result<(), String> {
    use jni::objects::{JClass, JObject, JValue};
    let ctx = crate::update::tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
    let result = (|| -> Result<(), String> {
        let loader = env.call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("getClassLoader: {e}"))?.l().map_err(|e| e.to_string())?;
        let name: JObject = env.new_string("com.chilloutgames.gametracker.companion.MainActivity")
            .map_err(|e| e.to_string())?.into();
        let class_obj = env.call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])
            .map_err(|e| format!("loadClass: {e}"))?.l().map_err(|e| e.to_string())?;
        let class = JClass::from(class_obj);
        env.call_static_method(&class, "setRotationHoldMs", "(J)V", &[JValue::Long(valid_rotation_ms(value))])
            .map_err(|e| format!("setRotationHoldMs: {e}"))?;
        Ok(())
    })();
    if env.exception_check().unwrap_or(false) { let _ = env.exception_clear(); }
    result
}

#[cfg(not(target_os = "android"))]
fn set_rotation_hold_impl(_value: u64) -> Result<(), String> { Ok(()) }

#[cfg(target_os = "android")]
fn set_remote_rotation_impl(active: bool, value: u64, revision: u64) -> Result<(), String> {
    use jni::objects::{JClass,JObject,JValue};
    let ctx = crate::update::tao_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
    let result = (|| -> Result<(),String> {
        let loader = env.call_method(&context,"getClassLoader","()Ljava/lang/ClassLoader;",&[]).map_err(|e|e.to_string())?.l().map_err(|e|e.to_string())?;
        let name: JObject = env.new_string("com.chilloutgames.gametracker.companion.MainActivity").map_err(|e|e.to_string())?.into();
        let class = JClass::from(env.call_method(&loader,"loadClass","(Ljava/lang/String;)Ljava/lang/Class;",&[JValue::Object(&name)]).map_err(|e|e.to_string())?.l().map_err(|e|e.to_string())?);
        env.call_static_method(&class,"setRemoteRotation","(ZJJ)V",&[JValue::Bool(u8::from(active)),JValue::Long(valid_rotation_ms(value)),JValue::Long(revision.min(i64::MAX as u64) as i64)]).map_err(|e|format!("setRemoteRotation: {e}"))?;
        Ok(())
    })();
    if env.exception_check().unwrap_or(false) { let _ = env.exception_clear(); }
    result
}
#[cfg(not(target_os = "android"))]
fn set_remote_rotation_impl(_active: bool, _value: u64, _revision: u64) -> Result<(), String> { Ok(()) }

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
        // Preferred: the static method — it also refreshes the live activity's
        // PiP params so Android 12+ auto-enter engages without a restart.
        let called = env
            .call_static_method(&class, "setPipWanted", "(Z)V", &[JValue::Bool(u8::from(enabled))])
            .is_ok();
        if !called {
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
            }
            let fid = env
                .get_static_field_id(&class, "pipWanted", "Z")
                .map_err(|e| format!("pipWanted field: {e}"))?;
            env.set_static_field(&class, fid, JValue::Bool(u8::from(enabled)))
                .map_err(|e| format!("set pipWanted: {e}"))?;
        }
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
