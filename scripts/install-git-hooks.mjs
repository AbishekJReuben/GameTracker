/**
 * Point git at `.githooks` and install the platform-correct pre-commit entry.
 *
 * Windows: leave the extensionless `pre-commit` ABSENT so Git picks
 * `pre-commit.cmd` → PowerShell. A shebang `#!/bin/sh` hook is often routed
 * through `C:\Windows\System32\bash.exe` (WSL stub); with no distro that fails
 * as `execvpe(/bin/bash) failed` and blocks every commit (GitHub Desktop).
 *
 * Unix: copy `pre-commit.sh` → `pre-commit` (executable).
 */
import { chmodSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hooks = join(root, ".githooks");
const extless = join(hooks, "pre-commit");

try {
  execSync("git config core.hooksPath .githooks", { cwd: root, stdio: "ignore" });
} catch {
  /* not a git checkout / git missing — ignore */
}

if (process.platform === "win32") {
  // Remove a leftover shebang hook so Windows find_hook falls through to .cmd.
  if (existsSync(extless)) {
    try {
      unlinkSync(extless);
    } catch {
      /* locked / permission — commit may still fail until it's removed by hand */
    }
  }
} else {
  const sh = join(hooks, "pre-commit.sh");
  if (existsSync(sh)) {
    copyFileSync(sh, extless);
    try {
      chmodSync(extless, 0o755);
    } catch {
      /* ignore */
    }
  }
}
