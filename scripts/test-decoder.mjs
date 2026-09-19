// Exercises the shipping queue without an Android device, Gradle or APK build.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "gametracker-decoder-test-"));
const suffix = process.platform === "win32" ? ".exe" : "";
const jdk = [process.env.JAVA_HOME, "C:/Program Files/Android/Android Studio/jbr"]
  .find((p) => p && existsSync(join(p, "bin", `javac${suffix}`)));
const run = (tool, args) => {
  const command = jdk ? join(jdk, "bin", tool + suffix) : tool;
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${tool}: ${result.status}`);
};
try {
  for (const [folder, file] of [["android-templates", "DecoderInbox.java"], ["android-tests", "DecoderInboxTest.java"]]) {
    const source = readFileSync(new URL(`./${folder}/${file}`, import.meta.url), "utf8")
      .replaceAll("__PACKAGE__", "decodercheck");
    writeFileSync(join(directory, file), source);
  }
  run("javac", ["-d", directory, join(directory, "DecoderInbox.java"), join(directory, "DecoderInboxTest.java")]);
  run("java", ["-cp", directory, "decodercheck.DecoderInboxTest"]);
} finally {
  if (resolve(directory).startsWith(resolve(tmpdir()) + "/") ||
      resolve(directory).startsWith(resolve(tmpdir()) + "\\")) rmSync(directory, { recursive: true, force: true });
}
