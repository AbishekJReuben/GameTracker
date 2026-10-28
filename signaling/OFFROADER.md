# Offroader shared world

`src/offroader.rs` is an independent, bounded namespace. Normal server builds add
`/offroader/ws` and `/offroader/health` without changing `/ws`, `/clip`, `/voice`,
static discovery clients or existing room semantics.

The live installation deliberately leaves the already-running port 8080 server
and its sessions alone. A separate copy runs with `--offroader-only` on loopback
8081. That mode never opens the clipboard/voice stores. A dedicated quick tunnel
exposes only this sidecar, and the existing static discovery server publishes its
current endpoint at `https://discovery.chilloutgamestudio.com/offroader.json`.
Clients fetch that stable manifest again after a connection failure.

From the GameTracker root:

```powershell
cargo build --release --manifest-path signaling/Cargo.toml --target-dir signaling/target-offroader -j4
./signaling/serve-offroader.ps1 -Action Start
./signaling/serve-offroader.ps1 -Action Status
./signaling/serve-offroader.ps1 -Action Stop
```

Build a replacement before an intentional sidecar restart when possible. Windows
locks a running executable; stop only this sidecar if rebuilding that target.
The launcher owns its child server, child tunnel and supervisor by PID, executable
path and creation time. It refuses an already-occupied port. `Stop` affects only
those recorded owned processes. It does not stop GameTracker, its port 8080 server,
the existing named Cloudflare tunnel, or user game processes.

The supervisor restarts an exited owned child. A new tunnel URL is published only
after its public `/offroader/health` succeeds, using an atomic manifest replacement.
Runtime state and logs are in `signaling/offroader-runtime/` and are ignored by Git,
as are the build target and generated public manifest. The static manifest contains
only a public URL, protocol and generation; no secret or account credential.

The PC and supervisor must remain running for this deployment. No logon task was
installed; use `Start` again after a PC restart. Temporary Cloudflare tunnels have
no continuity guarantee. A named ingress may replace the published endpoint during
a separately planned maintenance window; a second HTTP domain does not eliminate
TCP head-of-line delay or increase this PC's upload bandwidth.

The current clients own their detailed local simulation; the relay validates bounds,
rates, sequences, reset epochs, compatibility and source age, then applies spatial
interest. This is not authoritative race physics or complete anti-cheat. WSS is the
authorized reachable baseline, with no router changes or paid relay dependencies.

The `map-roster-v1` capability adds a separate replaceable one-Hz JSON roster of all
active riders in the same world, regardless of vehicle interest. It carries bounded
24-code-point display names and coarse positions/velocities, at most 64 entries.
Online profile updates change the latest name; reconnecting clients send their saved
name again. Names are public labels, not unique/authenticated identities. The public
health response and generated discovery manifest advertise this capability.

Protocol/research and verified real-client artifacts are in Offroader's
`docs/multiplayer/` and `work/multiplayer/`. The live namespace is independent of the
desktop application's `remote_enabled` setting; it does not add a new desktop app
network feature or bypass an existing GameTracker privacy toggle.
