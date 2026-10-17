# Checkpoint 1 — baseline, preference/display domain and scoped rotation

Baseline remains `main` at `a81b8f25277afd8ed7826ebb338daec9977a98bc`, app 3.9.111. No commit, service restart, update installation, publication or deployment occurred.

## Concrete implementation

- `src/companion/remotePreferences.ts`: independent versioned keys for rotation, controller identity, complete appearance schema/presets/custom state and saved view. Missing rotation remains 1200 ms; Off is explicit zero; legacy valid 400–3000 ms values migrate without quantization. Corrupt current documents use defaults instead of reviving old legacy values. The 28 slider detents are exactly Off plus 400–3000 in 100 ms steps.
- `src/lib/displayLayout.ts`, `src-tauri/src/remote/display.rs`: physical desktop rectangles, stable Windows monitor interface IDs, topology revisions, exact input-coordinate endpoints, letterbox/zoom inversion, gaps, viewport intersection and uniformly bounded output sizes. Native enumeration occurs at initialization, display/device notifications and five-second recovery, not per pointer/frame. Existing monitor DTO/API/mock and input bounds use the snapshot.
- `src/companion/useRemoteRotation.ts`, Control integration, `companion/src-tauri/src/pip.rs`: explicitly scoped Remote activity + delay travel atomically through JNI with monotonic revisions. A stale async setter cannot undo a later unmount or preference.
- `scripts/android-templates/MainActivity.kt`, `RemoteRotationPolicy.java`: MainActivity moved intact from its patcher string before modifications. Native requests execute on the UI thread. Off requests SCREEN_ORIENTATION_LOCKED and remembers the concrete physical orientation for recreation. Leaving Remote restores the captured preceding policy. Candidate clocks are cleared on Off/timed changes, invalid sensor samples and PiP. Transport reconnects do not unmount/relock; PiP retains scope.
- `scripts/patch-android.mjs`: applies both templates, preserves both JNI setters through R8, writes changes atomically. A fresh-manifest test exposed pre-existing shortcut reordering around the boot receiver; ordering now converges on the first run.

## Evidence

| Command / artifact | Result | Boundary |
|---|---|---|
| `npm test` before edits | 33 files, 275 tests passed | Frontend baseline only |
| `npm run build` before edits | Passed | Existing lottie eval and nativeDecoder split warnings |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib remote:: -- --skip nvenc_smoke` | 27 passed, 11 hardware tests ignored | Backend baseline; no device claim |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed | Existing dead-code warnings recorded |
| `cargo run --manifest-path src-tauri/Cargo.toml --example remote_capture_probe` | Real DXGI/GPU/NVENC 3840×2160 → 1920×1080, 8.019 s | Isolated read-only process, dev profile, no live guest |
| `baseline-isolated-capture-summary.json` | Changed capture p50 0.145 ms / p95 0.422 ms; encode p50 1.622 / p95 5.982 ms; composition submission p50 0.015 ms | GPU submission is not completion; no displayed fps/input/network/reconnect proof |
| `npx vitest run src/companion/remotePreferences.test.ts src/lib/displayLayout.test.ts` | 16 passed | Eight shared fixtures: current two 4K, left, above, mixed physical DPI, portrait, gaps, removed and reordered |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib remote::display::tests` | 2 passed | Exact physical endpoints and same fixtures |
| `remote_capture_probe --topology-only` | Both real 4K monitors, origins -3840/0 and 0/0; distinct interface IDs; revision unchanged after six seconds | Native snapshot/recovery poll proof; no hotplug performed |
| `node scripts/test-remote-rotation.mjs` | 54 assertions passed | Executes shipping Java state machine: all four lock orientations, Off/timed cancellation, prior policy restore, recreation, PiP candidate reset |
| `node scripts/test-android-patcher.mjs` | Fresh manifest, 66 files; zero second-run changes | Actual production patcher and shipping templates in isolated tree |
| `npx tsc --noEmit`, `npm run build` after A/B | Passed | Static/frontend build only |
| Android debug aarch64 build | Passed, APK produced | Kotlin daemon hit the existing C:/H: incremental-cache path issue and its automatic non-daemon fallback completed. `evidence/stage-b-android-debug-build.log`, `stage-b-apk-sha256.json`; no install |

## Adversarial review

Reviewed against all 21 numbered plan requirements and A–J gates. Preference validation includes non-finite values and independent resets; appearance is still schema-only until F and is not presented as a delivered UI/renderer. Geometry tests initially found a tiny floating-point seam intersection; the intersection now requires positive area above numerical noise. Name sanitization keeps legitimate Unicode and is separate from auth identity. R8 keep rules and native async revision ordering were checked explicitly. The complete production frontend suite was rerun; see checkpoint log.

Gates are not being silently waived: live guest performance, phone orientation/PiP/other-screen behavior, mixed-DPI/hotplug physical transitions and full native compilation are distinct remaining evidence. No code yet claims all-screens, overlay or new presence capability as implemented. C–J remain incomplete. An Android device is connected (Moto g57 Power); testing a new local build requires coordinating installation/foreground use with the human, so it has not been changed.

## Specific external action later

Once the local test build and parent review pass, physical phone validation needs the human to run the new test build through four orientations, Off/timed changes, PiP/relaunch and return to Notes/Voice/Home. No broad permission or redesign decision is needed. Independent C implementation can proceed while this evidence remains explicit.
