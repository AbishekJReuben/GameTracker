//! Native H.264 decode bridge for the Android companion (MediaCodec → Surface).
//!
//! Lifecycle + bounds + stats cross JNI into `WcDecoderBridge` (patched into
//! `gen/android` by `scripts/patch-android.mjs`). Annex-B frames ride a
//! `JavascriptInterface` hot path (`window.__GT_DECODER__.feed`) so we don't
//! pay per-frame Tauri IPC — same shape as Moonlight `submitDecodeUnit` /
//! Chiaki `video_sample` / ALVR `push_nal`.
//!
//! Web / Quest keep WebCodecs; this module is a no-op off Android.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderProbe {
    pub available: bool,
    pub name: String,
    pub low_latency: bool,
    /// Human-readable reason the probe returned its answer — surfaces the bridge's
    /// internal state (which decoder was picked, why none was, or which configure
    /// attempt failed) so "MediaCodec unavailable" is diagnosable without logcat.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderStats {
    pub decode_ms: f64,
    pub queue: i32,
    pub frames: i64,
    pub active: bool,
    pub width: i32,
    pub height: i32,
    pub error: String,
}

#[tauri::command]
pub async fn decoder_probe() -> Result<DecoderProbe, String> {
    tauri::async_runtime::spawn_blocking(decoder_probe_impl)
        .await
        .map_err(|e| format!("decoder_probe panicked: {e}"))?
}

#[tauri::command]
pub async fn decoder_init(width: i32, height: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || decoder_init_impl(width, height))
        .await
        .map_err(|e| format!("decoder_init panicked: {e}"))?
}

#[tauri::command]
pub async fn decoder_set_bounds(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || decoder_set_bounds_impl(x, y, w, h, visible))
        .await
        .map_err(|e| format!("decoder_set_bounds panicked: {e}"))?
}

#[tauri::command]
pub async fn decoder_reset() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(decoder_reset_impl)
        .await
        .map_err(|e| format!("decoder_reset panicked: {e}"))?
}

#[tauri::command]
pub async fn decoder_teardown() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(decoder_teardown_impl)
        .await
        .map_err(|e| format!("decoder_teardown panicked: {e}"))?
}

#[tauri::command]
pub async fn decoder_get_stats() -> Result<DecoderStats, String> {
    tauri::async_runtime::spawn_blocking(decoder_get_stats_impl)
        .await
        .map_err(|e| format!("decoder_get_stats panicked: {e}"))?
}

#[cfg(target_os = "android")]
mod android {
    use super::{DecoderProbe, DecoderStats};
    use jni::objects::{JClass, JObject, JString, JValue};

    fn with_bridge<F, T>(f: F) -> Result<T, String>
    where
        F: FnOnce(&mut jni::JNIEnv, JClass) -> Result<T, String>,
    {
        let ctx = crate::update::tao_android_context()?;
        let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };

        let result = (|| -> Result<T, String> {
            let loader = env
                .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
                .map_err(|e| format!("getClassLoader: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            let name: JObject = env
                .new_string("com.chilloutgames.gametracker.companion.WcDecoderBridge")
                .map_err(|e| e.to_string())?
                .into();
            let class_obj = env
                .call_method(
                    &loader,
                    "loadClass",
                    "(Ljava/lang/String;)Ljava/lang/Class;",
                    &[JValue::Object(&name)],
                )
                .map_err(|e| format!("loadClass WcDecoderBridge: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            f(&mut env, JClass::from(class_obj))
        })();

        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        result
    }

    pub fn probe() -> Result<DecoderProbe, String> {
        with_bridge(|env, class| {
            let available = env
                .call_static_method(&class, "probeAvailable", "()Z", &[])
                .map_err(|e| format!("probeAvailable: {e}"))?
                .z()
                .unwrap_or(false);
            let low_latency = env
                .call_static_method(&class, "probeLowLatency", "()Z", &[])
                .map_err(|e| format!("probeLowLatency: {e}"))?
                .z()
                .unwrap_or(false);
            let name_obj = env
                .call_static_method(&class, "probeName", "()Ljava/lang/String;", &[])
                .map_err(|e| format!("probeName: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            let name = if name_obj.is_null() {
                String::new()
            } else {
                let js: JString = name_obj.into();
                env.get_string(&js).map(|s| s.into()).unwrap_or_default()
            };
            let detail_obj = env
                .call_static_method(&class, "probeDetail", "()Ljava/lang/String;", &[])
                .map(|v| v.l().unwrap_or_default())
                .unwrap_or_default();
            let detail = if detail_obj.is_null() {
                String::new()
            } else {
                let js: JString = detail_obj.into();
                env.get_string(&js).map(|s| s.into()).unwrap_or_default()
            };
            Ok(DecoderProbe {
                available,
                name,
                low_latency,
                detail,
            })
        })
    }

    pub fn init(width: i32, height: i32) -> Result<(), String> {
        with_bridge(|env, class| {
            env.call_static_method(
                &class,
                "init",
                "(II)V",
                &[JValue::Int(width), JValue::Int(height)],
            )
            .map_err(|e| format!("init: {e}"))?;
            Ok(())
        })
    }

    pub fn set_bounds(x: f64, y: f64, w: f64, h: f64, visible: bool) -> Result<(), String> {
        with_bridge(|env, class| {
            env.call_static_method(
                &class,
                "setBounds",
                "(DDDDZ)V",
                &[
                    JValue::Double(x),
                    JValue::Double(y),
                    JValue::Double(w),
                    JValue::Double(h),
                    JValue::Bool(u8::from(visible)),
                ],
            )
            .map_err(|e| format!("setBounds: {e}"))?;
            Ok(())
        })
    }

    pub fn reset() -> Result<(), String> {
        with_bridge(|env, class| {
            env.call_static_method(&class, "reset", "()V", &[])
                .map_err(|e| format!("reset: {e}"))?;
            Ok(())
        })
    }

    pub fn teardown() -> Result<(), String> {
        with_bridge(|env, class| {
            env.call_static_method(&class, "teardown", "()V", &[])
                .map_err(|e| format!("teardown: {e}"))?;
            Ok(())
        })
    }

    pub fn stats() -> Result<DecoderStats, String> {
        with_bridge(|env, class| {
            let decode_ms = env
                .call_static_method(&class, "statsDecodeMs", "()D", &[])
                .map_err(|e| format!("statsDecodeMs: {e}"))?
                .d()
                .unwrap_or(0.0);
            let queue = env
                .call_static_method(&class, "statsQueue", "()I", &[])
                .map_err(|e| format!("statsQueue: {e}"))?
                .i()
                .unwrap_or(0);
            let frames = env
                .call_static_method(&class, "statsFrames", "()J", &[])
                .map_err(|e| format!("statsFrames: {e}"))?
                .j()
                .unwrap_or(0);
            let active = env
                .call_static_method(&class, "statsActive", "()Z", &[])
                .map_err(|e| format!("statsActive: {e}"))?
                .z()
                .unwrap_or(false);
            let width = env
                .call_static_method(&class, "statsWidth", "()I", &[])
                .map_err(|e| format!("statsWidth: {e}"))?
                .i()
                .unwrap_or(0);
            let height = env
                .call_static_method(&class, "statsHeight", "()I", &[])
                .map_err(|e| format!("statsHeight: {e}"))?
                .i()
                .unwrap_or(0);
            let err_obj = env
                .call_static_method(&class, "statsError", "()Ljava/lang/String;", &[])
                .map_err(|e| format!("statsError: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            let error = if err_obj.is_null() {
                String::new()
            } else {
                let js: JString = err_obj.into();
                env.get_string(&js).map(|s| s.into()).unwrap_or_default()
            };
            Ok(DecoderStats {
                decode_ms,
                queue,
                frames,
                active,
                width,
                height,
                error,
            })
        })
    }
}

#[cfg(target_os = "android")]
fn decoder_probe_impl() -> Result<DecoderProbe, String> {
    android::probe()
}
#[cfg(target_os = "android")]
fn decoder_init_impl(width: i32, height: i32) -> Result<(), String> {
    android::init(width, height)
}
#[cfg(target_os = "android")]
fn decoder_set_bounds_impl(x: f64, y: f64, w: f64, h: f64, visible: bool) -> Result<(), String> {
    android::set_bounds(x, y, w, h, visible)
}
#[cfg(target_os = "android")]
fn decoder_reset_impl() -> Result<(), String> {
    android::reset()
}
#[cfg(target_os = "android")]
fn decoder_teardown_impl() -> Result<(), String> {
    android::teardown()
}
#[cfg(target_os = "android")]
fn decoder_get_stats_impl() -> Result<DecoderStats, String> {
    android::stats()
}

#[cfg(not(target_os = "android"))]
fn decoder_probe_impl() -> Result<DecoderProbe, String> {
    Ok(DecoderProbe {
        available: false,
        name: String::new(),
        low_latency: false,
        detail: String::new(),
    })
}
#[cfg(not(target_os = "android"))]
fn decoder_init_impl(_width: i32, _height: i32) -> Result<(), String> {
    Err("native MediaCodec is Android-only".into())
}
#[cfg(not(target_os = "android"))]
fn decoder_set_bounds_impl(
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
    _visible: bool,
) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
fn decoder_reset_impl() -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
fn decoder_teardown_impl() -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "android"))]
fn decoder_get_stats_impl() -> Result<DecoderStats, String> {
    Ok(DecoderStats {
        decode_ms: 0.0,
        queue: 0,
        frames: 0,
        active: false,
        width: 0,
        height: 0,
        error: String::new(),
    })
}
