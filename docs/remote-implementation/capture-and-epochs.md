# Capture ownership and ordered view identity

G/H design, reviewed against the complete saved plan before production integration.
The E/F scoped checkpoint was accepted in parent-review-3.md. No G/H gate is passed
by this design record.

## Per-output acquisition

A process-local broker leases outputs by stable physical display identity. One
entry owns each DXGI duplicator, retained image and source sequence; primary,
combined and auxiliary consumers share that result with independent seen sequence
numbers. Adapter groups own one compatible D3D11 device/immediate context and a
short exclusive graphics lock. Acquisition uses timeout zero under that lock;
pacing occurs after releasing it. A static output retains its last texture, so
one output never waits for another to change. Last lease release drops output
ownership; topology revisions invalidate old capture layouts.

Same-adapter outputs are sampled directly on that group's device. Cross-adapter
outputs are scaled on their source device to their exact bounded output tile,
read into reused tile-sized transfer buffers, and uploaded to a texture on the
compositor device. Foreign SRVs are never bound directly. The combined target is
the negotiated outgoing dimensions; there is no full-native combined allocation.
Gaps are cleared consistently, rotation is explicit, and the ordinary pointer is
composited once after all cursor-free tiles in combined desktop coordinates. A per-output GDI fallback remains shared
when duplication is unavailable. Encoder/transport/audio ownership remains with
the existing pipeline; single-output fast capture still avoids CPU readback.

Microsoft's [DuplicateOutput contract](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput)
requires the output's adapter and one duplication interface per output/process.
Its outputs have independent timestamps. The
[D3D11 threading contract](https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-render-multi-thread-intro)
requires serialized immediate-context use. These are sourced API constraints;
the broker's lock, lifetime and transfer policy are implementation decisions.

## Ordered frames and atomic input (H)

Every captured layout has an immutable full AppliedView (physical source, output
size, displays, topology revision, selected display, mode, session and epoch).
Local capture packets carry the exact view associated with that encoded image;
an outer asynchronous event cannot assign a newer layout to an old image.
DIRECT/carrier configuration transmits this identity in their ordered per-stream
configuration and decoder generation. A frame from that generation is the commit
proof only after that sink's rendered/visible boundary. Coordinate-dependent input is temporarily rejected at the transition boundary and resumes
only with the acknowledged displayed epoch. Native input checks session, epoch,
current topology and gap membership, retaining the reliable pointer anchor.

For negotiated RTC fallback clients, retain the authorized base control/audio
peer and create at most active + pending video-only epoch peers. Their sole video
track/stream and SDP are bound to immutable AppliedView/session/epoch, with
authenticated offer/answer/ICE on the existing authorized control channel. A
distinct pending video sink must decode/display a frame from that exact peer;
the visible element's old buffered picture is never evidence. Preserve the old
valid frame/audio while setting up. Acknowledgment commits mapping and retires
the old peer/callbacks. Setup/ack failure rolls back capture and mapping together.
Rollback uses a fresh epoch and needs fresh displayed-frame confirmation, so an
acknowledgment from the source's preceding lifetime cannot commit it.
Every await checks session/peer liveness. Quality, keyframe recovery, telemetry,
watchdogs and teardown follow the actual active video peer. Legacy clients retain
their existing supported transport behavior.

Required proof includes same-sized monitor switches, rapid supersession,
topology changes, stale input/frame rejection, real seam drag, RTC↔DIRECT/carrier
during setup, failures/rollback, resource bounds, pop-out coexistence and measured
transition latency. None is inferred from data-channel events plus dimensions.
