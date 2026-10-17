1. **Fix the approved behavior before implementation.**

   The implementation will follow this specification:

   | Area | Approved behavior |
   |---|---|
   | Rotation | Add **Off** to the existing rotation timer. Off locks the phone’s current orientation while the Remote control screen is active. |
   | Rotation persistence | Remember the selection across app restarts. Preserve existing timed settings and the current default for users who have not changed them. |
   | Desktop indicator | A thin aurora border with flowing ribbons, a soft mist-like fringe, and a very translucent tint that fades almost completely toward the center. |
   | Motion | Slow continuous flow with gentle reactions to remote cursor movement and clicks. |
   | Multiple displays | Each viewed monitor receives its own border; colors and motion remain coordinated across monitors. |
   | Cursor | Preserve the normal Windows arrow, text, resize, and other cursor shapes. Add a fluid halo and small click ripples. |
   | Capture | All desktop decoration, including the cursor halo and identity label, remains absent from the remote video. |
   | Identity | Editable controller name, defaulting to **Remote User**. Display **“Controlled remotely by [Username]”**. |
   | Arrival | A larger top-center notice appears for approximately three seconds, then contracts into a small persistent top-center label. |
   | Visibility | Show the indicator only for an authorized session whose Control screen or PiP is visible. |
   | All screens | Display monitors together in their Windows arrangement, preserving relative position, aspect ratio, and gaps. |
   | Input | Preserve direct-touch and trackpad modes, including continuous movement and dragging between monitors. |
   | Focus | Provide an explicit control to enlarge the selected monitor and return to the previous all-screens view. |
   | PiP | Show the selected monitor. Restore the preceding layout and viewport when PiP closes. |
   | Clients | Support Android, browser, and Quest flat mode. Preserve the existing immersive-VR workflow and controls. |
   | Customization | Include Subtle, Balanced, and Expressive presets, plus full individual appearance controls. |
   | Default appearance | Start with **Subtle**. |
   | Existing behavior | Keep single-monitor viewing, pop-outs, streaming fallbacks, sound, keyboard, gamepad, Notes, Voice, and authentication working. |

   All timings, opacity values, and performance budgets below are proposed starting values. They will be checked against rendered output and measured behavior.

2. **Establish a reproducible baseline and preserve the checkout.**

   Before changing production code:

   - Record the exact branch, commit, package versions, build configuration, and existing working-tree changes.
   - Preserve the current unrelated changes in `.gitignore`, discovery scripts, signaling, and Offroader files.
   - Keep the port 8080 discovery/Notes/Voice service and the separate Offroader service outside this change.
   - Record the existing frontend test and production-build results.
   - Record targeted Rust test and compile results.
   - Capture a short baseline of single-monitor streaming: output dimensions, capture/encode time, displayed frame rate, latency, reconnect behavior, and idle activity.
   - Document any pre-existing failures separately from failures introduced by this work.

   The current observed desktop layout is:

   | Display | Desktop origin | Native dimensions | Role |
   |---|---:|---:|---|
   | Left display | `(-3840, 0)` | `3840 × 2160` | Secondary |
   | Right display | `(0, 0)` | `3840 × 2160` | Primary |

   This is the first real-machine fixture, not a hardcoded assumption. The combined source desktop is currently `7680 × 2160`.

   Implementation will proceed in sequential stages with a verification gate after each stage. Builds, installation, and release activities will remain separate from this planning pass.

3. **Use a single shared model for display layout, viewing state, and selection.**

   Introduce a small shared domain model rather than adding independent monitor calculations throughout the application.

   The model will distinguish:

   | Concept | Meaning |
   |---|---|
   | Display identity | The Windows output being referenced. |
   | Layout revision | The current monitor arrangement and geometry. |
   | Capture mode | A single display or the combined desktop. |
   | Selected display | The display used by Focus, PiP, and selection indicators. |
   | Visible displays | Displays actually intersecting the remote viewport. |
   | View epoch | A particular applied capture layout and its input-coordinate mapping. |
   | Session identity | The authorized peer responsible for the view and input. |

   This separation is essential: moving the cursor onto another display in All screens mode must not restart capture or switch the entire stream.

   Extend the existing monitor DTO with:

   - Stable output identity.
   - Physical desktop `x`, `y`, `width`, and `height`.
   - Display rotation where required.
   - Primary-display status.
   - A layout revision.
   - Existing index/name/selected fields for compatibility.

   Maintain one authoritative display snapshot in Rust. Capture, input mapping, overlay placement, and client layout must all refer to that snapshot.

   Re-enumerate on display topology changes, with a low-frequency recovery check if Windows notifications are missed. Avoid monitor enumeration on every pointer event or video frame.

   Update the Rust DTO, TypeScript interface, mock backend, and remote endpoint together.

4. **Add a backward-compatible remote capability handshake.**

   New clients and hosts must negotiate support before using new behavior.

   Add versioned capabilities for:

   - Display geometry and layout revisions.
   - All-screens capture.
   - View-state reporting.
   - Controller display names.
   - Desktop appearance settings.
   - View-epoch-aware input.

   Compatibility behavior:

   - A new client connected to an older host continues to use the existing single-monitor path.
   - Unsupported controls explain that the host needs updating.
   - An older client connected to a new host keeps its existing behavior.
   - Missing visibility information must not be interpreted as “the user is viewing the screen.”
   - New display-name information must remain separate from the existing device identity and authorization grant.
   - Existing video, audio, heartbeat, and input messages retain their current meaning.
   - Unknown optional fields remain harmless.

   Changes to the capture layout will use an explicit request/applied-state exchange. The client must know which layout belongs to the frame being displayed before using it for absolute input.

   Layout announcements must travel through the stream’s ordered configuration mechanism. A data-channel event arriving before or after video is not sufficient by itself.

5. **Centralize the new preferences without disturbing existing stream tuning.**

   Create versioned preference helpers with parsing, defaults, validation, and migration.

   Separate these categories:

   - Rotation preference.
   - Controller identity.
   - Desktop appearance.
   - Preferred display-view mode and viewport state.

   Keep the existing stream-quality and control-chrome preferences independent.

   Required persistence rules:

   - Preserve every valid existing rotation delay.
   - Distinguish “no saved value” from the new Off value.
   - Recover malformed or out-of-range values to documented defaults.
   - Save the username per client installation/browser origin.
   - Use **Remote User** for empty or invalid names.
   - Store appearance settings independently from authentication credentials.
   - Preserve custom appearance values across reconnects and upgrades.
   - Resetting appearance must not reset resolution, bitrate, keyboard behavior, pins, or credentials.

   Validate settings in both the client and host. Rendering code must never receive unchecked sizes, durations, colors, or non-finite numbers.

6. **Implement rotation Off through the complete Android lifecycle.**

   The current implementation crosses three layers:

   - [Control.tsx](H:/Works/ChilloutGames/2026/May/GameTracker/src/companion/screens/Control.tsx)
   - [pip.rs](H:/Works/ChilloutGames/2026/May/GameTracker/companion/src-tauri/src/pip.rs)
   - [patch-android.mjs](H:/Works/ChilloutGames/2026/May/GameTracker/scripts/patch-android.mjs)

   The change must cover all three.

   **Slider behavior:**

   - Add a distinct Off detent before `0.4s`.
   - Retain the existing `0.4–3.0s` choices.
   - Use an explicit detent-to-value mapping so intermediate positions cannot accidentally mean `0.1s`, `0.2s`, or `0.3s`.
   - Show a clear description: Off keeps the current orientation while controlling the PC.
   - Preserve the existing default delay for untouched installations.

   **Native behavior:**

   - Add explicit Remote-control-active state to the rotation bridge.
   - When Off becomes active, lock the current orientation rather than forcing portrait or landscape.
   - Clear any pending sensor candidate so an old timer cannot rotate the screen afterward.
   - Apply native orientation changes on the Android UI thread.
   - When timed rotation resumes, restart the candidate timer cleanly.
   - Scope the new lock to Remote and restore the preceding orientation policy when leaving it.
   - Preserve the current orientation through activity recreation and PiP transitions.
   - Avoid changing the device-wide Android rotation setting.

   Android provides `SCREEN_ORIENTATION_LOCKED`; its use must be tested with the app’s current activity and PiP behavior. Android 16 can override orientation restrictions on large displays, so tablet/foldable behavior must be reported separately from ordinary-phone validation. [Android orientation constants](https://developer.android.com/reference/android/content/pm/ActivityInfo#SCREEN_ORIENTATION_LOCKED), [Android adaptive behavior](https://developer.android.com/develop/adaptive-apps/guides/app-orientation-aspect-ratio-resizability).

   Keep the source of truth in the patcher/templates. Regenerate the Android project and verify that a second patcher run makes no unintended changes.

   **Gate:** rotation works in all four orientations, survives reconnect/relaunch, and does not leave Notes, Voice, or the home screen locked by Remote’s setting.

7. **Add controller identity and truthful session presence.**

   Add a **Controller name** field to Remote settings on Android, browser, and Quest flat mode.

   Name handling:

   - Default to **Remote User**.
   - Trim surrounding whitespace.
   - Preserve legitimate Unicode names.
   - Bound the displayed length.
   - Remove line breaks and control characters that could disrupt the status label.
   - Render the value as text.
   - Update the label during an active session without reconnecting.
   - Keep the approval dialog’s device identity distinct from the chosen display name.

   Add a host-owned presence registry keyed by authorized session identity.

   Each entry will contain:

   - Session and device identity.
   - Display name.
   - Authorization state.
   - Current view mode and view epoch.
   - Selected display.
   - Visible display IDs.
   - Control/PiP/immersive visibility state.
   - Appearance settings.
   - Last valid presence update.
   - Session-ending state.

   The existing connected-client count must not drive the overlay because it can become nonzero before authorization completes.

   Required lifecycle behavior:

   | Event | Overlay action |
   |---|---|
   | Device awaiting approval | Remain absent |
   | Approved Control screen becomes visible | Show on its viewed displays |
   | User opens another companion screen | Remove that session’s indicator |
   | Phone enters PiP | Retain only the selected display |
   | Phone backgrounds without PiP | Remove after the existing visibility-transition grace |
   | Explicit disconnect | Remove promptly |
   | Session superseded or denied | Remove the retired session |
   | Main desktop UI crashes | Continue with the separate remote host |
   | Host page stops reporting | Expire stale presence through a native watchdog |
   | Remote host exits | Destroy its overlay windows |

   Reuse the existing PiP/background grace logic rather than introducing a competing interpretation of visibility.

   Session expiry must operate outside the host WebView’s JavaScript timers so a crashed renderer cannot leave a permanent indicator.

8. **Prove the Windows overlay window behavior before adding visual complexity.**

   Place ownership in the separate remote-host process.

   The preferred implementation is a small native overlay subsystem with:

   - One top-level window per viewed display.
   - Transparent composition.
   - No activation or keyboard focus.
   - No taskbar or Alt-Tab presence.
   - Click-through behavior across the entire window.
   - GPU-rendered decoration.
   - Native text rendering for the identity label.
   - A dedicated rendering/message thread with bounded communication from session state.

   Start with a plain static border and label.

   Verify:

   - Clicking through every edge and the label reaches the application underneath.
   - The overlay never changes the foreground window.
   - Taskbar hover previews, menus, drag operations, and text selection remain normal.
   - Negative desktop coordinates and per-monitor DPI are handled correctly.
   - Windows are destroyed on every termination path.
   - Repeated show/hide cycles do not leak windows or GPU resources.

   Apply `WDA_EXCLUDEFROMCAPTURE` before making a window visible. It requires an owned top-level window and DWM composition; proper exclusion is supported from Windows 10 version 2004. Older behavior can leave an empty rectangle, which would violate the requested result. [Microsoft capture-exclusion documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity).

   Test exclusion against the actual GameTracker capture paths. API success alone is not completion evidence.

   **Gate:** the local indicator is visible, the remote picture is unobstructed, and mouse/keyboard behavior is unchanged. If this fails, resolve it before implementing the animated effect.

9. **Build the aurora visual system from the approved skill direction.**

   Apply the relevant guidance from:

   - [Lyric-film shader cookbook](C:/Users/abish/.agents/skills/lyric-film-handbook/references/shaders-cookbook.md): layered noise, domain warping, glow profiles, premultiplied transparency, and banding control.
   - [Anime FX color guidance](C:/Users/abish/.agents/skills/anime-arpg-fx/references/03-color-gradients.md): dominant/support/accent colors and restrained brightness hierarchy.
   - [UI motion guidance](C:/Users/abish/.agents/skills/gamedev-handbook/references/ui-motion-transitions.md): interruptible transitions, readable state changes, and reduced motion.
   - [Performance guidance](C:/Users/abish/.agents/skills/gamedev-handbook/references/rendering-performance.md): measured budgets and before/after comparison.

   The shader will have three coordinated layers:

   | Layer | Purpose |
   |---|---|
   | Thin boundary | Makes remote ownership immediately recognizable |
   | Flowing aurora ribbons | Supplies slow, irregular motion and color variation |
   | Soft fringe/tint | Blends the boundary naturally into the desktop |

   Design rules:

   - Teal/cyan carries most of the effect, blue supports it, and violet appears sparingly.
   - Use irregular, slowly changing flow rather than a conspicuous repeated sweep.
   - Fade inward smoothly to an effectively transparent center.
   - Keep the desktop’s content readable on bright and dark backgrounds.
   - Maintain separate control of line brightness, glow, and tint.
   - Keep motion continuous when parameters change.
   - Coordinate time and spatial color fields across displays while preserving each display’s own border.
   - Avoid visible seams, square noise patterns, and abrupt time wrapping.
   - Make cursor reactions local to the nearby edge and halo.
   - Use bounded click ripples that dissipate naturally.

   Optimize drawing around the edges, label, and cursor region. Avoid expensive shading over the transparent center where possible.

   The overlay renderer must use its own rendering resources. Its animation must not run inside the capture/encode loop.

10. **Implement the identity-notice transition as a small state machine.**

   Use explicit states:

   `hidden → arriving → announcement → settling → compact → leaving`

   Proposed initial timing:

   | Transition | Starting value |
   |---|---:|
   | Arrival | Approximately 450 ms |
   | Announcement dwell | 3 seconds |
   | Settle into compact label | Approximately 400 ms |
   | Departure | Approximately 200 ms |

   Behavior:

   - Anchor the notice at top-center.
   - Use the exact text **“Controlled remotely by [Username]”**.
   - Provide sufficient contrast through a restrained translucent backing.
   - Contract the existing notice into the compact label rather than swapping unrelated elements.
   - Allow username changes without replaying the entrance.
   - Avoid replaying the announcement during brief reconnects, PiP transitions, layout changes, or settings adjustments.
   - Handle interruption at any point: disconnect during arrival must start a clean departure.
   - Track announcement history separately from the transport’s short-lived peer object so a routine peer rebuild does not look like a new user arrival.

   In reduced-motion mode, retain the text and border while replacing movement with a short, restrained transition.

11. **Add the cursor halo and click reactions without replacing Windows cursors.**

   Keep the Windows cursor and the existing streamed cursor representation intact.

   The new subsystem will:

   - Track the actual cursor position in physical desktop coordinates.
   - Draw a halo around the cursor’s true hotspot.
   - Preserve the arrow, text beam, resize, hand, busy, and application-specific cursor shapes.
   - Generate ripples from accepted remote button events.
   - Keep cursor-position updates independent of React rendering.
   - Avoid adding any delay to the actual input path.
   - Limit active ripple count and discard expired effects.
   - Show effects only on displays with active remote presence.
   - Clear queued reactions when their owning session ends.

   The halo may deform or brighten gently with movement, but its center must remain aligned with the real cursor. Decorative lag must not resemble input latency.

   All halo/ripple rendering belongs to capture-excluded overlay windows. No decorative pixels will be added to the encoded cursor texture.

   **Gate:** arrow/text/resize cursors retain their shapes, remote clicks remain accurate, and the phone receives the normal cursor without the new decoration.

12. **Provide presets and complete individual controls.**

   Add a dedicated **Desktop appearance** area within Remote settings.

   Keep the primary interface compact:

   - Subtle / Balanced / Expressive.
   - Overall intensity.
   - Motion speed.
   - Expandable individual controls.
   - Reset controls with clear scope.

   Individual controls will include:

   | Group | Controls |
   |---|---|
   | Border | Thickness, opacity, glow strength, inward fade distance, corner softness |
   | Aurora | Motion speed, ribbon strength, softness, movement reaction strength |
   | Palette | Primary, secondary, and accent colors |
   | Tint | Strength and inward reach |
   | Cursor halo | Enabled, radius, opacity, softness, movement response |
   | Click ripples | Enabled, size, strength, thickness, duration |
   | Identity label | Size, placement, backing opacity, announcement duration |
   | Motion comfort | Follow system preference or explicitly reduce motion |

   Keep low-level shader implementation details out of the product settings.

   Preference behavior:

   - Selecting a preset applies a complete consistent configuration.
   - Editing an individual property changes the preset label to Custom.
   - Preserve the last custom configuration.
   - Reset a group independently.
   - Reset appearance without affecting stream settings.
   - Apply changes live without restarting capture.
   - Coalesce slider updates so dragging a control cannot flood the remote protocol.
   - Clamp the settings again in Rust.
   - Keep the controller identity readable when decorative effect intensity is reduced to zero.

   Include a small preview surface for appearance tuning. Clearly distinguish that preview from the live desktop indicator.

13. **Implement All screens as one combined video stream.**

   Android currently has a single native decoder surface. The selected architecture will produce one combined desktop image on the host and deliver it through the existing video pipeline.

   The flow will be:

   ```mermaid
   flowchart LR
       A[Windows display layout] --> B[Per-output capture]
       B --> C[Combined desktop compositor]
       C --> D[Existing encoder and transport]
       D --> E[Existing client decoder]
       E --> F[All screens or focused viewport]

       G[Authorized session state] --> H[Desktop overlay renderer]
       G --> I[Input coordinate mapping]
       I --> J[Existing input controller]
   ```

   The overlay renderer has no path into the video compositor.

   **Capture rules:**

   - Preserve the current single-display fast path.
   - Add an explicit All screens mode.
   - Capture each required output at most once per process and share its result with any additional consumers.
   - Retain the latest image for a display that has not changed.
   - Do not wait serially for every monitor to produce a new frame.
   - Composite updated outputs into one output-sized texture.
   - Preserve Windows’ relative positions and aspect ratios.
   - Represent gaps between displays consistently.
   - Render the normal cursor once in the combined desktop.

   Desktop Duplication requires a device created on the output’s adapter and rejects duplicate acquisition of the same output by the calling application. The implementation must therefore handle output ownership and device compatibility explicitly, including coexistence with existing pop-outs. [Microsoft DuplicateOutput documentation](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput).

   **Adapter handling:**

   - Use a compatible shared device for outputs on the same adapter.
   - Never sample another device’s texture as though it belonged to the compositor.
   - For displays on different adapters, use an explicit bounded transfer path.
   - Reuse transfer buffers.
   - Scale transferred images to their required output size.
   - Preserve a working fallback if a particular output cannot use the fast path.

   Avoid allocating a full native-resolution combined desktop when the outgoing stream is much smaller.

   **Resolution semantics:**

   - In All screens mode, the resolution setting applies to the total outgoing image.
   - Preserve aspect ratio while respecting encoder and decoder width, height, and pixel limits.
   - Do not promise native 8K-wide delivery from two 4K monitors.
   - Focus mode returns to the selected monitor’s normal single-display quality.
   - Keep audio as one desktop-audio stream.
   - Preserve the current bitrate adaptation, transport negotiation, codec fallback, keyframe recovery, and queue limits.

   **Gate:** both displays remain live in one stream, the single-monitor path remains stable, and pop-outs do not cause output-duplication conflicts.

14. **Make layout transitions and input mapping atomic.**

   Absolute input must be interpreted against the same layout that produced the visible frame.

   Add a view epoch to the negotiated view state.

   On a layout change:

   1. Validate the requested display/view mode.
   2. Create the new capture layout.
   3. Publish its dimensions, display rectangles, and epoch through the ordered stream configuration.
   4. Start the new layout with a valid recovery frame.
   5. Discard retired decoder callbacks and frames.
   6. Apply the client’s new coordinate transform when that layout becomes displayable.
   7. Resume coordinate-dependent interaction against the applied epoch.

   Never change coordinate mapping solely because the user pressed the view-mode button.

   During a pending transition:

   - Continue showing a valid frame.
   - Preserve audio.
   - Prevent new coordinate-dependent presses from targeting the wrong layout.
   - Always allow necessary button/key releases.
   - Keep transition feedback compact.
   - Time out cleanly and restore the last working mode if the new layout cannot start.

   Input mapping will follow:

   `client point → video content rectangle → zoom/pan inverse → source desktop point → Windows physical coordinates`

   Required handling:

   - Negative desktop origins.
   - Unequal display sizes.
   - Mixed DPI.
   - Portrait displays.
   - Monitors above or below the primary.
   - Gaps between displays.
   - Letterboxing.
   - Zoom and pan.
   - Topology changes during a session.

   Direct taps in non-display gaps must not click an arbitrary application. Trackpad movement should follow normal Windows cursor behavior across the real desktop.

   Preserve the existing reliable pointer anchor before click/down/up events. Continue using the lossy channel only for suitable absolute movement.

   Cross-monitor dragging must retain its pressed-button state. Selection changes during a drag must not emit an unintended mouse-up or restart capture.

   Track remote-held buttons and modifiers by session so cleanup releases remote input without issuing blanket resets of unrelated system keys.

15. **Build the All screens, Focus, and PiP interface around existing gestures.**

   Extend the existing monitor control with:

   - Single display.
   - All screens.
   - Selected-display indicator.
   - Focus selected display.
   - Return to All screens.

   Interaction rules:

   - Preserve the existing direct-touch and trackpad modes.
   - Preserve double-click, right-click, two-finger scrolling, pinch zoom, pinned keys, and drag controls.
   - Do not reuse an established gesture for opening Focus mode.
   - Use an explicit Focus button.
   - Let direct interaction identify the selected display naturally.
   - In trackpad mode, update selection when the cursor enters a display.
   - Keep keyboard input directed to the real Windows foreground application.
   - Save the all-screens zoom/pan state before focusing a display.
   - Restore that state when returning.

   Recalculate which monitors intersect the actual remote viewport. A monitor completely outside a zoomed/panned view should not remain decorated merely because it is included in the larger combined capture.

   **PiP entry:**

   - Save the current view mode, selection, zoom, and pan.
   - Select the current monitor for the PiP view.
   - Fit that monitor into PiP.
   - Remove the indicator from other displays.
   - Retain the existing reduced PiP stream-quality behavior.

   **PiP exit:**

   - Restore the preceding view mode and viewport.
   - Restore the appropriate viewed-display set.
   - Keep the three-second arrival notice suppressed.
   - Preserve the existing visibility grace to avoid pause/resume flicker.

   Validate portrait-monitor PiP carefully; the current native shell assumes a `16:9` PiP shape. Use a supported aspect-ratio strategy and letterbox where necessary.

16. **Define failure recovery before integrating the features.**

   | Condition | Required behavior |
   |---|---|
   | Overlay renderer fails | Remove decoration and keep remote control functioning |
   | Capture exclusion fails | Keep the affected overlay hidden; report its unavailable state |
   | All-screens initialization fails | Restore the last working single-display view |
   | One display disconnects | Update topology, remove its overlay, choose a valid selection |
   | Display arrangement changes | Rebuild the layout and coordinate mapping together |
   | Encoder/decoder rejects combined dimensions | Retry a supported uniformly scaled size |
   | Host renderer restarts | Rebuild authorized session state; retire stale overlay state |
   | Main app restarts | Existing remote-host ownership continues |
   | Temporary connection loss | Preserve appropriate recovery state without replaying the arrival animation |
   | Explicit disconnect or denial | End presence and release remote-held input |
   | Invalid preferences | Use validated defaults |
   | Older peer | Keep the supported existing feature set |
   | Reduced motion enabled | Retain static ownership cues and readable identity |

   Session cleanup must be idempotent. Repeated close, timeout, supersession, and process-exit notifications must not destroy another session’s state.

   Fullscreen, secure-desktop, and display-driver transitions will be tested within existing Windows behavior. This work will not alter UAC policy or authentication to make decoration appear.

17. **Keep the implementation divided into bounded modules.**

   Proposed file responsibilities:

   | Area | Existing integration points | Proposed additions |
   |---|---|---|
   | Preferences | [Control.tsx](H:/Works/ChilloutGames/2026/May/GameTracker/src/companion/screens/Control.tsx), [Settings.tsx](H:/Works/ChilloutGames/2026/May/GameTracker/src/companion/screens/Settings.tsx) | Validated remote-preference helpers and appearance settings components |
   | Client protocol | [cloud.ts](H:/Works/ChilloutGames/2026/May/GameTracker/src/companion/cloud.ts), [links.ts](H:/Works/ChilloutGames/2026/May/GameTracker/src/companion/links.ts) | Capability negotiation, presence reporting, view epochs |
   | Host session | [rtcHost.ts](H:/Works/ChilloutGames/2026/May/GameTracker/src/lib/rtcHost.ts), [RemoteHostManager.tsx](H:/Works/ChilloutGames/2026/May/GameTracker/src/components/RemoteHostManager.tsx) | Session-presence and view-state adapters |
   | Shared geometry | [api.ts](H:/Works/ChilloutGames/2026/May/GameTracker/src/lib/api.ts) | Pure display-layout and coordinate-transform helpers |
   | Native commands | [commands.rs](H:/Works/ChilloutGames/2026/May/GameTracker/src-tauri/src/commands.rs), [lib.rs](H:/Works/ChilloutGames/2026/May/GameTracker/src-tauri/src/lib.rs) | Small validated commands and registrations |
   | Display capture | [capture.rs](H:/Works/ChilloutGames/2026/May/GameTracker/src-tauri/src/remote/capture.rs), [dxdupe.rs](H:/Works/ChilloutGames/2026/May/GameTracker/src-tauri/src/remote/dxdupe.rs), [gpu.rs](H:/Works/ChilloutGames/2026/May/GameTracker/src-tauri/src/remote/gpu.rs) | Display-layout snapshot, output ownership, combined compositor |
   | Input | [input.rs](H:/Works/ChilloutGames/2026/May/GameTracker/src-tauri/src/remote/input.rs), [pipe.rs](H:/Works/ChilloutGames/2026/May/GameTracker/src-tauri/src/remote/pipe.rs) | Session/view-aware mapping and cleanup |
   | Desktop decoration | Remote-host process | Native window manager, renderer, shader, text, and effect-state modules |
   | Android | [pip.rs](H:/Works/ChilloutGames/2026/May/GameTracker/companion/src-tauri/src/pip.rs), [patch-android.mjs](H:/Works/ChilloutGames/2026/May/GameTracker/scripts/patch-android.mjs) | Scoped rotation policy and PiP/view coordination |
   | Verification | Existing frontend/Rust/Android test infrastructure | Layout fixtures, lifecycle tests, overlay/capture probes |

   Keep substantial new logic out of the already-large `Control.tsx`, `rtcHost.ts`, and `capture.rs` files. Those files should primarily connect the new bounded modules to existing behavior.

   Retain camelCase DTO compatibility and the existing blocking-work conventions. Overlay construction and GPU work must not run inside synchronous UI-thread commands.

18. **Execute and verify in this order.**

   | Stage | Work | Exit condition |
   |---|---|---|
   | A | Baseline, preference schema, geometry model | Existing checks pass; migrations and layout fixtures are tested |
   | B | Rotation Off | Android lifecycle and timer behavior verified |
   | C | Username, capabilities, session presence | No pre-authorization indicator; visibility and cleanup tests pass |
   | D | Static native overlay | Click-through and capture exclusion proven |
   | E | Aurora, label transition, cursor effects | Visual review and initial performance checks pass |
   | F | Presets and individual settings | Persistence, validation, live updates, and reset behavior pass |
   | G | Combined capture | Two displays stream correctly; single display and pop-outs remain stable |
   | H | All-screens input and interface | Mapping, cross-monitor drag, focus, and viewport restoration pass |
   | I | PiP and cross-client integration | Correct monitor and visibility behavior across clients |
   | J | Full regression and packaging | Evidence recorded; remaining limits explicitly identified |

   Do not combine unfinished overlay ownership work with unfinished capture-layout work. Their integration depends on stable session and display models.

19. **Use meaningful tests for the failure-prone behavior.**

   **Preference and rotation tests**

   - Existing saved delay survives migration.
   - Missing setting retains the existing default.
   - Off is not mistaken for missing data.
   - Corrupt settings recover safely.
   - Rapid Off/timed changes cancel stale candidates.
   - Remote unmount restores the previous orientation policy.
   - PiP transition does not unlock or relock unexpectedly.

   **Geometry and input tests**

   Use fixtures for:

   - Current two-display 4K layout.
   - A secondary display left of the primary.
   - A display above the primary.
   - Unequal dimensions and mixed DPI.
   - Portrait plus landscape.
   - Three displays with gaps.
   - Display removal and reordered enumeration.

   Test exact corners, seams, center points, zoom/pan inversion, gap handling, and stale layout revisions.

   Exercise real input sequences: pointer move followed by click, held drag crossing a seam, modifier chords, right-click, scrolling, and release during a transition.

   **Session and protocol tests**

   - Pending authorization never creates presence.
   - Duplicate auth messages do not create duplicate overlays.
   - A retired session cannot update or remove the current session’s indicator.
   - Presence expires after a stalled host page.
   - PiP/background ordering does not cause flicker.
   - Settings updates do not restart capture.
   - New and old peer combinations remain compatible.
   - Layout announcements remain correct through DIRECT, RTC fallback, and carrier transport changes.

   **Capture tests**

   - Each display shows distinct moving content.
   - Static and moving monitors coexist without blocking each other.
   - Cursor is drawn once.
   - Rotation and output dimensions are correct.
   - No old-layout frame is accepted after a view switch.
   - Pop-outs coexist with combined capture.
   - Output acquisition does not leak across reconnects.
   - Capture-excluded decoration causes no colored artifacts or black rectangles.

   **Real UI/device checks**

   - Android phone rotation and PiP.
   - Browser direct-touch and mouse operation.
   - Quest flat-mode interaction.
   - Existing immersive-VR entry/exit and controller controls.
   - Soft keyboard, IME, dock controls, pinned keys, and drag lock.
   - Desktop taskbar, menus, text selection, focus, and fullscreen transitions.

   Test results will distinguish unit-test evidence, local Windows evidence, browser evidence, and physical-device evidence.

20. **Measure performance and inspect the actual visual output.**

   Compare matched scenarios with decoration disabled and enabled:

   - Static desktop.
   - Continuous pointer motion.
   - Text scrolling.
   - Video playback.
   - A busy game/application.
   - Single display.
   - All screens.
   - PiP.
   - Backgrounded client.

   Record:

   - Capture, composition, and encode time.
   - Displayed frame rate and frame-time tails.
   - Input latency indicators.
   - Host/client CPU and GPU load.
   - Decoder queue and memory.
   - Bitrate and transport backlog.
   - Native window/resource counts.
   - Idle work after the client leaves Control.

   Particular attention is required for one subtle regression: an animated, capture-excluded overlay may still cause desktop-compositor activity. Verify that it does not turn a static remote desktop into a needlessly busy encoder.

   Do not solve that by blindly ignoring dirty regions under the overlay; real application changes there must still be captured.

   Initial engineering targets:

   - No sustained overlay work when no qualifying session exists.
   - Bounded cursor/ripple state and stable memory.
   - No new waits on the pointer-input path.
   - Single-monitor performance within normal measured run-to-run variation.
   - Combined-view work bounded by its negotiated output dimensions.
   - Decorative quality reduced before allowing decoration to impair streaming.

   For visual QA, use a renderer preview/export plus physical desktop observation. An excluded screen capture cannot prove that the local overlay is visible.

   Review the effect on light and dark applications, text-heavy screens, both 4K displays, and different scaling settings.

21. **Build, package, document, and retain a rollback route.**

   After the preceding gates pass:

   - Run the complete relevant frontend suite.
   - Run the frontend production build.
   - Run targeted Rust tests, then the broader applicable backend checks.
   - Regenerate Android sources and verify patcher idempotence.
   - Compile the Android native sources.
   - Build the APK from freshly built frontend assets.
   - Build the Windows installer.
   - Build the browser/Quest bundle separately without automatically replacing the live discovery deployment.
   - Keep native builds sequential to avoid shared-output and toolchain contention.

   Document:

   - Preference keys, defaults, and migrations.
   - Protocol capabilities and compatibility behavior.
   - Display identity, layout revisions, and coordinate conventions.
   - Overlay lifecycle and capture exclusion.
   - Combined capture ownership.
   - Android rotation/PiP lifecycle.
   - Reproduction commands and evidence locations.
   - Verified platforms and unresolved device-specific limitations.

   Preserve independently reversible feature boundaries:

   - Rotation Off.
   - Desktop decoration.
   - All-screens capture/viewing.

   Disabling or reverting one should not require reverting the others or deleting user preferences.

   Completion requires that the approved behavior is implemented, regression gates pass, and the remaining limitations are stated accurately. Source review or a successful build alone will not be treated as proof of Android rotation, desktop capture exclusion, cross-monitor input, or PiP correctness.