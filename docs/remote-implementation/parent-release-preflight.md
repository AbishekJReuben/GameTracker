# Final publishing authorization and preflight

The user's latest instruction authorizes publishing after implementation and final parent review: push to their personal Git remote so APK/desktop CI starts, and update the session-discovery web deployment. This supersedes the earlier no-publication boundary for that final gate. It does not authorize premature publication during development or unrelated source changes.

## Verified current repository and CI

- Checkout: `H:\Works\ChilloutGames\2026\May\GameTracker`, current branch `main`, upstream `personal/main`.
- Exact requested remote: `personal`, `https://github.com/AbishekJReuben/GameTracker.git`. `origin` is the separate ChilloutGameStudio repository.
- Local baseline and remote main are both `a81b8f25277afd8ed7826ebb338daec9977a98bc` at this preflight. Recheck before publication.
- Latest release is `v3.9.111`; its release workflow run `37321418977` succeeded. `v3.9.112` is currently absent and is the tentative next version; verify again before reserving/pushing it.
- `.github/workflows/release.yml` runs on `v*` tag pushes. Jobs run in sequence: create release, Android APK/signing/manifest, then Windows desktop installer/updater artifacts. Pushing only main will not start this release workflow.
- Bump all eight desktop/companion version sources before the final fresh build. Coordinate this with the implementation agent to avoid changing manifests during native builds.

## Scoped source publication

`scripts/Ship-Release.ps1` defaults to `git add -A`, which would include unrelated original dirty files and generated artifacts. Use an explicit reviewed file list. Preserve the original nine protected file contents and keep unrelated discovery/signaling/Offroader edits out of this feature commit. The unchanged approved implementation plan may be included as documentation.

The configured `.githooks/pre-commit.ps1` automatically builds into the live `signaling/static` directory and stages it. Its documented `GT_SKIP_WEB_BUILD=1` escape hatch allows using separately built and verified final web assets at commit time. Do not let a hook clear the live static directory before the final deployment gate.

Retain raw local capture evidence, APKs/installers, build caches and machine-specific diagnostic dumps locally. Review publication paths for private desktop captures, credentials and oversized generated binaries before staging. Include source probes, fixtures and reproduction instructions needed to rerun checks.

Recheck the staged diff, version agreement, current remote main/tag state, and final validation before creating the release commit/tag and pushing to `personal`. Do not force-push or publish to `origin`. Verify the resulting remote commit/tag and exact APK/desktop workflow run afterward.

## Discovery web deployment

Current source configuration serves the companion, Quest and Share clients from the static directory selected by `quest_static_dir()`. The local port 8080 companion HTML currently references the same main asset as this checkout's `signaling/static/companion.html`: `/assets/companion-BPAZfTdn.js`. Public companion, Quest and Share routes return HTTP 200 at `https://discovery.chilloutgamestudio.com`. Public HTML includes Cloudflare's injected beacon, so complete HTML byte equality is not a valid comparison; verify the application's own asset references and asset contents.

The server's existing `.logs/discovery-signal.log` names this checkout's `signaling/static` as its served root. Parent also verified that the loopback companion response equals the repository file byte-for-byte as decoded UTF-8 (1494 characters at preflight). No server executable inspection, process restart or deployment was needed for that verification.

Build the final web bundle into a separate directory first. At the authorized final gate, retain a rollback copy and copy new assets before replacing entry HTML. Keep previous hashed assets available for already-open browser sessions. Preserve dynamic runtime files such as ignored `signaling/static/offroader.json`, and avoid rebuilding/restarting signaling or either supervisor. The original port 8080 process is PID 32348 at preflight.

Verify all new entry points and referenced assets through both loopback and the public HTTPS deployment, with application asset hashes/version identity matching the reviewed build. Confirm discovery health, unchanged service ownership and preserved runtime files. Source/CI publication and successful local builds alone do not establish the deployed web result.

## Prepared deployment helper (not yet used on the live deployment)

Parent-owned `deploy-reviewed-web.ps1` defaults to dry-run. An explicit `-Deploy` requires a new workspace-local rollback directory. The helper validates the three entry points and their local references, checks source/destination/backup containment and reparse points, rejects a build containing `offroader.json` or a conflicting existing immutable asset, backs up overwritten files, copies dependencies before switching HTML via same-volume atomic replacement, and verifies destination/runtime hashes. Existing hashed assets and unrelated runtime files are retained. It does not operate services or processes.

`powershell -NoProfile -ExecutionPolicy Bypass -File docs/remote-implementation/test-reviewed-web-deploy.ps1` passed 23 checks against disposable source/destination/rollback fixtures only. It verifies dry-run isolation, rejection before mutation, rollback entries, old asset/runtime preservation, entry deployment and immutable-name collision rejection. A first fixture run exposed Windows PowerShell's null-to-empty-string binding for File.Replace's backup parameter; the helper uses the explicit NullString sentinel, and the fresh final self-test passes. No live file was changed by either fixture run.

At the final gate, invoke the helper once without `-Deploy` against the reviewed separate final build, inspect its manifest, then deploy with an explicitly named fresh rollback folder. Use the recorded backup manifest for reversal if needed; restoring old entries and overwritten mutable assets can leave the new hashed assets in place so already-open clients remain supported. Verify HTTP assets and runtime/service state afterward as specified above.

## PC restart recovery

The user reported a PC crash and requested continuation. Windows reports boot at 2026-10-17 14:57:40 local time. The source edits and review/evidence files survived; branch and HEAD remain main / a81b8f2, and parent independently rechecked all nine protected hashes with no mismatch. The existing discovery autostart restored its service at approximately 14:59:07 without an agent restart operation. The recovered port 8080 owner is PID 34652, replacing the pre-crash PID 32348. Remote port 47800 belongs to the existing GameTracker PID 24500. Public companion, Quest and Share routes returned 200 after recovery. Preserve these recovered services during final static deployment and recheck their ownership at that time. Pre-crash in-memory browser sessions/process IDs are no longer current evidence.

## Finish-fast scope and packaging adjustment

The user explicitly deferred immersive Quest VR and asked to finish quickly; Android, Windows desktop and the existing browser route on Quest remain in scope. Parent confirmed `personal/main` still at a81b8f2 and no remote v3.9.112 tag, then authorized the implementation agent to bump the eight version sources to 3.9.112 without committing/tagging/pushing. Avoid duplicate full local APK/NSIS packaging: run the essential full frontend build/tests, native Rust checks/model tests, Android source regeneration/idempotence and native compilation locally, then let the immediately triggered signed release workflow produce the final fresh APK and desktop installer. Record CI status and local/device boundaries precisely. Publishing still requires final parent review, scoped staging and separate atomic web deployment.

The final live preflight supersedes earlier process IDs: Windows now reports boot at 15:07:50 local, discovery 8080 PID 34904 and remote 47800 PID 23144, both created at approximately 15:08. Parent performed no restart. Loopback companion returns 200, the service log again names this checkout's static root, all nine protected files still match, and all eight source versions match 3.9.112. Capture these current service owners before the static deployment and verify they stay unchanged across it.

The final deployment source is checkout-local `.logs/release-web-v3.9.112`. An initial Vite relative output resolved outside the checkout; its bytes were copied and hash-verified, then the implementation agent scheduled a final absolute-path rebuild after its last source guard. Wait for that build's final hashes before deployment. Parent dry-run on the contained source and a fresh 23-check disposable deployment fixture pass. The dry-run first exposed Windows PowerShell evaluating a parameter default before `PSScriptRoot` was available; initializing the default destination in the script body fixes that helper issue before any live mutation.

## Final static update result

Parent deployed the refreshed absolute-path build after checking its exact final entry hashes: companion `aa22c2df64bd195bbc32f5bddf13f8be7bbd6e1721a4753cef57903ccb754488`, Quest `d20504468d15c59c7d76d11e4ccef8b859df1446ffbc11e5c4516c3d3a22771c`, Share `0bd91c75e7c842476e46360d8e94470e53dded9a1398b216bc66093a5741a999`. All 52 build files match at the destination; 45 changed. Rollback and deployment manifest are retained at `.logs/remote-web-rollback-3.9.112-20261017`. Existing assets were retained, `offroader.json` stayed at SHA256 `E7B067EA95092131558063A044E8A5F8694A6452D89D2F4D56843F92A287DCCC`, and both live owners (8080 PID 34904, 47800 PID 23144) stayed unchanged.

Public HTTPS and loopback verification passed 102 checks: three entry-reference sets and 48 non-HTML application asset hashes on each host. The unreferenced desktop-only frame-gate.js is excluded from that HTTP count. The report is `.logs/release-web-http-verification-3.9.112.json`. No service restart, process termination or runtime/session data operation was performed.
