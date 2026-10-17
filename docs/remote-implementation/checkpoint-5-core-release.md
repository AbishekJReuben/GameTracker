# Checkpoint 5 — frozen core source, 3.9.112

The saved plan is unchanged. Core Android/desktop/browser source is frozen for parent publication review. Latest user direction defers new immersive Quest VR work/testing; existing Quest source remains unchanged. Fresh signed APK/Windows packaging belongs to authorized sequential release CI. This is local implementation/regression evidence, not physical/live-stream or signed-package proof.

## Implemented integration

All six capabilities are advertised. All/epoch requires actual crypto/rVFC and Android v2 rendered-frame APIs. Old hosts/clients retain their supported existing paths. Immutable producing-frame identity spans native GE, DIRECT/GV,carrier and bounded active-plus-pending RTC video peers; the authorized audio/control peer remains. Equal-size changes require the exact new sink/track frame.

All/Focus/return,selected-display/viewport intersection,saved cameras,selected-monitor PiP/reduced quality/previous-view restoration are connected. Anchors belong to accepted epochs. Pending views reject coordinate-dependent presses, while authorized foreground keyboard/IME/gamepad and owned releases remain available.

Android carries codec/feed/frame/bounds identity through TextureView/Surface render callbacks and reveal traversal. Single-flight retained-picture ownership is separate from unconditional final teardown. Actual new RTC/WebCodecs/native presentation gates handoff. Uniform-size retry/truthful single fallback and rollback use fresh epochs; input/presence wait for fresh displayed acknowledgment.

## Adversarial review

| Findings | Closure/evidence boundary |
|---|---|
| R2/R13 | Ordinary monitor/topology/viewport follow producing identity; fresh rollback rejects preceding-lifetime ack. Native/coordinator models pass; live proof remains open. |
| R14/R16 | Unsent credits survive retired frames; stale received packets are acked; first emitted source forces recovery. Final native models pass. |
| R15/R18/R19/R22 | Canonical actual held keys, scoped releases, epoch anchors, gamepad stop, active-gap drag preservation, revocable foreground input and admitted-only IME advancement. Native/client regressions pass. |
| R17/R20 | Commit reconciliation, exact failed pending-feed retirement/retry, actual-peer telemetry and whole-snapshot topology acceptance. Parent coordinator9/9 and scoped real RTC module evidence retained. |
| R21 | Final stop unconditional; stale init cannot allocate; PixelCopy single-flight across timeout; exact rendered frame/bounds/reveal. Java models/Android compile pass; physical display proof remains open. |

Final compatibility review fixed legacy-host native reveal/RTC handoff and classic callback signatures. Steady legacy RTC without retained picture schedules no transition cleanup. Full existing decoder/carrier/power tests pass.

## Final checks

Logs below are under evidence/. Native builds ran sequentially. Gradle ran from companion/src-tauri/gen/android; other commands from checkout.

| Command | Result/log |
|---|---|
| npx tsc --noEmit | Pass; stage-j-typecheck-final.log |
| npm test |47 files/327 tests pass; stage-j-frontend-tests-final.log |
| npx vite build | Pass7.89s; stage-j-frontend-build-final.log; fresh desktop/APK frontend |
| npx vite build --config vite.quest.config.ts --outDir H:/Works/ChilloutGames/2026/May/GameTracker/.logs/release-web-v3.9.112 | Pass6.15s; stage-j-web-build-final.log |
| cargo check --manifest-path src-tauri/Cargo.toml -j 2 | Pass26.57s; stage-j-native-check-v1.log |
| cargo test --manifest-path tools/remote-probes/Cargo.toml --no-default-features --bin remote-input-model-probe --bin remote-overlay-lifecycle-probe -j 2 |15+30 pass; stage-j-native-model-tests-final.log; no OS input |
| node scripts/patch-android.mjs | Current; stage-j-android-patch.log |
| node scripts/test-android-patcher.mjs | Fresh isolated manifest,86 files/0 second-run changes; stage-j-android-patcher-idempotence.log |
| node scripts/test-remote-rotation.mjs |54 assertions; stage-j-android-rotation-model.log |
| node scripts/test-rendered-frame-proof.mjs | Render23/ownership14 assertions; stage-j-android-render-proof.log |
| gradlew.bat :app:compileArm64DebugJavaWithJavac --no-daemon --max-workers=2 -Pkotlin.incremental=false -Pkotlin.compiler.execution.strategy=in-process | Java/Kotlin BUILD SUCCESSFUL34s; stage-j-android-javac-final.log |
| cargo check --manifest-path companion/src-tauri/Cargo.toml --target aarch64-linux-android -j 2 | Android Rust/JNI pass42.89s; stage-j-android-rust-check.log |

Android env: JAVA_HOME=C:\Program Files\Android\Android Studio\jbr;ANDROID_HOME=C:\Users\abish\AppData\Local\Android\Sdk;ANDROID_NDK_HOME=...\ndk\27.1.12297006. Cross linker/CC: toolchains\llvm\prebuilt\windows-x86_64\bin\aarch64-linux-android24-clang.cmd; AR:llvm-ar.exe. Pure Java models use no Android/display. Android-target Rust checking is separate from Java/Kotlin compilation. Neither is a signed APK. Warnings remain in logs.

Final web is H:\Works\ChilloutGames\2026\May\GameTracker\.logs\release-web-v3.9.112. Every file is hashed in stage-j-web-manifest.json, SHA256 D93C02ECECD5E947A48D3CB2EA2F421687EFC0BDEF4EA5E80D6F017646D4D20A.

- companion.html aa22c2df64bd195bbc32f5bddf13f8be7bbd6e1721a4753cef57903ccb754488
- quest.html d20504468d15c59c7d76d11e4ccef8b859df1446ffbc11e5c4516c3d3a22771c
- share.html 0bd91c75e7c842476e46360d8e94470e53dded9a1398b216bc66093a5741a999

Earlier relative-path output H:\Works\ChilloutGames\2026\docs\remote-implementation\web-3.9.112 is superseded. No build targeted live static.

## Configuration/rollback

Keys:gt.remote.rotation.v1,gt.remote.identity.v1,gt.remote.appearance.v1,gt.remote.view.v1. Missing rotation1200ms,Off0,existing400–3000ms preserved. Default name exactly Remote User; default appearance Subtle. Reset is independent. Legacy rotation migrates only when the current document is absent.

Capabilities:display-geometry-v1,all-screens-v1,view-state-v1,controller-name-v1,desktop-appearance-v1,view-epoch-input-v1. Native stable display IDs/revisions and signed physical coordinates are authoritative. Overlay owns its remote-host thread/windows with native expiry/exclusion/degraded status. Capture leases share each output; cursor-free tiles receive one final cursor pass.

Rotation,appearance and All/view state remain independently configurable. Parent owns scoped Git/tag/static publication and rollback; retain old assets/runtime offroader.json. Child performed no publication,service operation or app installation.

## Explicit limitations

Physical phone orientation/recreation/PiP,live end-to-end transport/input,exact actual SendInput landing,taskbar/fullscreen/mixed DPI/portrait/different physical GPUs and matched static-desktop encoded-work/latency remain unproved. Earlier native click/exclusion/moving combined proofs retain their checkpoint2–4 scope. Busy-workstation off/on/off is not encoder-idle proof; no dirty-region masking was added. New immersive Quest adapter/testing is deferred by user; existing code preserved. Signed APK/installer awaits parent-owned CI.
