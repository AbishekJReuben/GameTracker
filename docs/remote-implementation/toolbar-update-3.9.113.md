# Compact Remote toolbar — 3.9.113

Replace All screens, Focus selected, Return to All screens and focused-PC typing text with 16-pixel icons in fixed-size buttons. Move the long selected monitor name into the monitor button's tooltip; retain accessible action names and the All screens pressed state. Compact the connection indicator on phone widths.

The status group keeps its natural width. The action group can shrink to the available space and scroll horizontally, with individual buttons protected from shrinking. This prevents action labels from overlapping the connection/FPS area. Existing action callbacks and view transactions are preserved.

Validation: all 327 frontend tests pass; TypeScript and fresh desktop/companion and isolated discovery production builds pass. The actual Control component's isolated two-monitor browser fixture (including a deliberately long monitor name) has no status/action overlap at 320, 360 or 540 CSS pixels and no page overflow at 320. Its full action group fits at 540. Focus followed by Return restores the corresponding controls while the video sink stays active, with zero sink unmounts or injected input events. Browser evidence is synthetic; no physical-phone result is claimed. Use `browser-control-probe.html?toolbar=1` with the documented local probe server to reproduce it.

The reviewed web update retains old assets and a rollback copy, and the v3.9.113 tag triggers the existing APK-then-desktop release CI.

The reported black screen occurred on the installed 3.9.112 companion: USB observation showed zero video FPS, while the live host reported zero produced capture frames. Restarting the desktop app restored the picture, as confirmed by the user; a subsequent host telemetry sample showed 1,741 produced frames with native zero-copy encoding active. The intermittent startup failure was not reproduced or fixed by this toolbar change.

For further capture diagnosis, `cargo run --manifest-path tools/remote-probes/Cargo.toml --bin remote-stream-probe` runs the shipping capture and view-session registry for four seconds in a separate process. It uses a primary-display JPEG stream, counts epoch-bearing packets, and exits unsuccessfully if none arrive. It does not connect to the app, export pixels, inject input, or touch its database or services. The initial run produced seven packets. This isolates capture availability; it does not prove the live app's startup/reconnect lifecycle or the phone decoder.
