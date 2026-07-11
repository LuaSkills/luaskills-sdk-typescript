import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  relativeInstalledPath,
  resolveManagedRuntimeChildPath,
  resolveManagedRuntimeInstalledPath,
} from "../dist/index.js";

// Temporary runtime root used to verify managed runtime path containment.
// 用于校验受管运行时路径包含关系的临时 runtime root。
const temporaryRoot = mkdtempSync(join(tmpdir(), "luaskills-managed-path-validation-"));
const runtimeRoot = join(temporaryRoot, "runtime");
const outsideRoot = join(temporaryRoot, "outside");

try {
  const plan = {
    installed_paths: {
      uv: "dependencies/runtimes/python/uv-test",
    },
  };
  assert.equal(
    resolveManagedRuntimeInstalledPath(runtimeRoot, plan, "uv"),
    join(runtimeRoot, "dependencies", "runtimes", "python", "uv-test"),
  );

  assert.throws(
    () => resolveManagedRuntimeInstalledPath(runtimeRoot, { installed_paths: { uv: "../outside" } }, "uv"),
    /relative path inside|escapes its root/,
  );
  assert.throws(
    () => resolveManagedRuntimeInstalledPath(runtimeRoot, { installed_paths: { uv: "C:\\outside" } }, "uv"),
    /relative path inside/,
  );
  assert.throws(
    () => resolveManagedRuntimeChildPath(join(runtimeRoot, "uv"), "../uv.exe", "managed uv executable"),
    /relative path inside|escapes its root/,
  );

  const installedFile = join(runtimeRoot, "dependencies", "installed.txt");
  mkdirSync(join(runtimeRoot, "dependencies"), { recursive: true });
  writeFileSync(installedFile, "ok");
  assert.equal(relativeInstalledPath(runtimeRoot, installedFile), "dependencies/installed.txt");
  assert.throws(
    () => relativeInstalledPath(runtimeRoot, join(temporaryRoot, "outside-file.txt")),
    /escapes its root/,
  );

  // Existing symlinked parents must not redirect managed runtime writes outside runtimeRoot.
  // 已存在的符号链接父目录不能把受管运行时写入重定向到 runtimeRoot 外部。
  rmSync(join(runtimeRoot, "dependencies"), { recursive: true, force: true });
  mkdirSync(outsideRoot, { recursive: true });
  symlinkSync(outsideRoot, join(runtimeRoot, "dependencies"), "junction");
  assert.throws(
    () => resolveManagedRuntimeInstalledPath(runtimeRoot, plan, "uv"),
    /escapes its root/,
  );
  assert.throws(
    () => relativeInstalledPath(runtimeRoot, join(runtimeRoot, "dependencies")),
    /must not be a symbolic link|escapes its root/,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
