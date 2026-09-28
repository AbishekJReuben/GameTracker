//! Voice: the JS → Java bridge for the background narration player
//! (`VoiceService`, see scripts/android-templates). Same JNI shape as
//! `clipboard.rs`: resolve app classes through the Context's class loader and
//! always clear a pending Java exception before returning.

#[cfg(target_os = "android")]
const BRIDGE: &str = "com.chilloutgames.gametracker.companion.VoiceBridge";

#[cfg(target_os = "android")]
mod imp {
    use super::BRIDGE;
    use jni::objects::{JClass, JObject, JValue};
    use jni::{JNIEnv, JavaVM};

    fn with_env<T>(f: impl FnOnce(&mut JNIEnv, &JObject) -> Result<T, String>) -> Result<T, String> {
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

    fn load_class<'a>(env: &mut JNIEnv<'a>, context: &JObject) -> Result<JClass<'a>, String> {
        let loader = env
            .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("getClassLoader: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        let jname: JObject = env.new_string(BRIDGE).map_err(|e| e.to_string())?.into();
        let class = env
            .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&jname)])
            .map_err(|e| format!("loadClass: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        Ok(class.into())
    }

    pub fn start(enabled: bool, secret: &str, device: &str, url: &str) -> Result<(), String> {
        with_env(|env, context| {
            let class = load_class(env, context)?;
            let s: JObject = env.new_string(secret).map_err(|e| e.to_string())?.into();
            let d: JObject = env.new_string(device).map_err(|e| e.to_string())?.into();
            let u: JObject = env.new_string(url).map_err(|e| e.to_string())?.into();
            env.call_static_method(
                &class,
                "start",
                "(Landroid/content/Context;ZLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                &[JValue::Object(context), JValue::Bool(u8::from(enabled)), JValue::Object(&s), JValue::Object(&d), JValue::Object(&u)],
            )
            .map_err(|e| format!("start: {e}"))?;
            Ok(())
        })
    }

    pub fn snapshot(ver: i32) -> Result<String, String> {
        with_env(|env, context| {
            let class = load_class(env, context)?;
            let obj = env
                .call_static_method(
                    &class,
                    "snapshot",
                    "(Landroid/content/Context;I)Ljava/lang/String;",
                    &[JValue::Object(context), JValue::Int(ver)],
                )
                .map_err(|e| format!("snapshot: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            if obj.is_null() {
                return Ok("{}".into());
            }
            Ok(env.get_string(&obj.into()).map_err(|e| e.to_string())?.into())
        })
    }

    pub fn control(action: &str, arg: &str) -> Result<(), String> {
        with_env(|env, context| {
            let class = load_class(env, context)?;
            let a: JObject = env.new_string(action).map_err(|e| e.to_string())?.into();
            let g: JObject = env.new_string(arg).map_err(|e| e.to_string())?.into();
            env.call_static_method(
                &class,
                "control",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                &[JValue::Object(context), JValue::Object(&a), JValue::Object(&g)],
            )
            .map_err(|e| format!("control: {e}"))?;
            Ok(())
        })
    }
}

#[tauri::command]
pub async fn voice_service_start(
    enabled: bool,
    secret: String,
    device_id: String,
    signal_url: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::start(enabled, &secret, &device_id, &signal_url))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (enabled, secret, device_id, signal_url);
        Err("Voice plays in the Android app".into())
    }
}

#[tauri::command]
pub async fn voice_snapshot(ver: i32) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::snapshot(ver))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = ver;
        Ok("{\"running\":false}".into())
    }
}

#[tauri::command]
pub async fn voice_control(action: String, arg: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let arg = arg.unwrap_or_default();
        tauri::async_runtime::spawn_blocking(move || imp::control(&action, &arg))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (action, arg);
        Ok(())
    }
}
