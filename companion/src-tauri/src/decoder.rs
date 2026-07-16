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
    /// Whether the SurfaceView has a live Surface. `active: false` with an empty
    /// `error` is otherwise indistinguishable between "the codec faulted" and
    /// "the codec never started because it had no Surface to render into".
    pub surface_ready: bool,
    /// Bridge still waiting for an IDR / CSD — JS "fed" counts are mostly drops.
    pub await_key: bool,
    /// SPS/PPS were accepted as CODEC_CONFIG for this session.
    pub csd_queued: bool,
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

/// Full diagnostics blob (device, decoder inventory, view hierarchy above the
/// hole punch, lifecycle journal). Attached to the decoder error toast's
/// copy-to-clipboard payload so a black screen on a device we don't own is
/// debuggable from one paste.
#[tauri::command]
pub async fn decoder_dump_diag() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(decoder_dump_diag_impl)
        .await
        .map_err(|e| format!("decoder_dump_diag panicked: {e}"))?
}

#[cfg(target_os = "android")]
mod android {
    use super::{DecoderProbe, DecoderStats};
    use jni::objects::{JClass, JObject, JString, JValue};

    /// If a Java exception is pending, take it (clearing the pending state) and
    /// render `toString()` plus the full stack trace via
    /// `android.util.Log.getStackTraceString`. Without this, the jni crate's
    /// error Display is the famously useless "Java exception was thrown" — the
    /// actual throwable was being silently cleared, so a device-specific probe
    /// failure could never be diagnosed from the phone's error toast.
    fn take_exception_detail(env: &mut jni::JNIEnv) -> Option<String> {
        if !env.exception_check().unwrap_or(false) {
            return None;
        }
        let throwable = env.exception_occurred().ok()?;
        // Must clear BEFORE making further JNI calls on the throwable.
        let _ = env.exception_clear();
        let to_string = |env: &mut jni::JNIEnv, obj: JObject| -> Option<String> {
            if obj.is_null() {
                return None;
            }
            let js: JString = obj.into();
            env.get_string(&js).ok().map(String::from)
        };
        let summary = env
            .call_method(&throwable, "toString", "()Ljava/lang/String;", &[])
            .ok()
            .and_then(|v| v.l().ok())
            .and_then(|o| to_string(env, o))
            .unwrap_or_else(|| "unknown Java exception".into());
        let stack = env
            .call_static_method(
                "android/util/Log",
                "getStackTraceString",
                "(Ljava/lang/Throwable;)Ljava/lang/String;",
                &[JValue::Object(&throwable)],
            )
            .ok()
            .and_then(|v| v.l().ok())
            .and_then(|o| to_string(env, o))
            .unwrap_or_default();
        // A stray exception from the helper calls above must not leak upward.
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        let stack: String = stack.trim().chars().take(1500).collect();
        Some(if stack.is_empty() || stack == summary {
            summary
        } else {
            format!("{summary}\n{stack}")
        })
    }

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

        // A pending Java exception is why most Err results happen — attach its
        // toString() + stack so the error that reaches the phone toast (and the
        // copy-to-clipboard payload) says WHAT threw, not just that something did.
        match take_exception_detail(&mut env) {
            Some(detail) => match result {
                Err(msg) => Err(format!("{msg} — {detail}")),
                ok => ok,
            },
            None => result,
        }
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

    pub fn dump_diag() -> Result<String, String> {
        with_bridge(|env, class| {
            let obj = env
                .call_static_method(&class, "dumpDiagnostics", "()Ljava/lang/String;", &[])
                .map_err(|e| format!("dumpDiagnostics: {e}"))?
                .l()
                .map_err(|e| e.to_string())?;
            if obj.is_null() {
                return Ok(String::new());
            }
            let js: JString = obj.into();
            Ok(env.get_string(&js).map(String::from).unwrap_or_default())
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
            let surface_ready = env
                .call_static_method(&class, "statsSurfaceReady", "()Z", &[])
                .map_err(|e| format!("statsSurfaceReady: {e}"))?
                .z()
                .unwrap_or(false);
            let await_key = env
                .call_static_method(&class, "statsAwaitKey", "()Z", &[])
                .map_err(|e| format!("statsAwaitKey: {e}"))?
                .z()
                .unwrap_or(true);
            let csd_queued = env
                .call_static_method(&class, "statsCsdQueued", "()Z", &[])
                .map_err(|e| format!("statsCsdQueued: {e}"))?
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
                surface_ready,
                await_key,
                csd_queued,
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
#[cfg(target_os = "android")]
fn decoder_dump_diag_impl() -> Result<String, String> {
    android::dump_diag()
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
fn decoder_dump_diag_impl() -> Result<String, String> {
    Ok(String::new())
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
        surface_ready: false,
        await_key: true,
        csd_queued: false,
    })
}
