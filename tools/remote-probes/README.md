These standalone probes compile the shipping Windows modules directly. They do
not launch the app, open its database, alter discovery/Offroader, or install an
update. Run native commands sequentially.

```powershell
cargo run --manifest-path tools/remote-probes/Cargo.toml --bin remote-capture-probe -- --topology-only
cargo run --manifest-path tools/remote-probes/Cargo.toml --bin remote-overlay-probe -- docs/remote-implementation/evidence
```

The overlay probe temporarily places small owned target patches at the four edge
centers and label position of each monitor. It restores the cursor, never
activates a window, and injects clicks only after immediately checking that an
owned target remains under the actual pointer. Physical keys held at startup
disable injection. Input skipped or missing at any point is incomplete evidence.
Avoid concurrent pointer use during this short probe. It exports the overlay's
own premultiplied GPU surface before flip presentation, and compares underlying
pixels through actual DXGI and xcap/GDI capture. The export is not proof of local
physical visibility; a human still needs to observe the desktop. HWND/GDI counts
are compared after DirectComposition's one-time initialization.
