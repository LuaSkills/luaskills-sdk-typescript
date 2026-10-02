import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCandidate } from "../scripts/verify-embedded-candidate.mjs";

// Absence of the native environment must never make this explicit gate pass or skip.
// 缺少原生环境绝不能让此显式门禁通过或跳过。
test("candidate CLI fails without required inputs even when LUASKILLS_LIB is absent", () => {
  // A fresh process proves CLI behavior without importing a fake transport.
  // 新进程证明 CLI 行为，不导入伪造传输。
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/verify-embedded-candidate.mjs", import.meta.url))], { encoding: "utf8", env: { ...process.env, LUASKILLS_LIB: "" } });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Usage: npm run test:embedded-candidate/);
});

// These failures precede installation and native loading, proving they cannot become offline successes.
// 这些失败先于安装和原生加载，证明它们不能变成离线成功。
test("candidate gate rejects implicit selection, missing files, invalid digests and malformed identity", () => {
  // The test owns exact input files and removes only its own temporary directory.
  // 测试拥有精确输入文件，且仅移除自身临时目录。
  const root = mkdtempSync(join(tmpdir(), "luaskills-candidate-inputs-"));
  try {
    // Each input retains its declared role; none represents a discovered native candidate.
    // 每个输入保留声明角色；没有任何输入代表自动发现的原生候选。
    const library = join(root, "candidate.bin");
    // Deliberately malformed frozen description for pre-install validation.
    // 用于安装前校验的故意畸形冻结描述。
    const description = join(root, "core-description.json");
    // The archive need not exist because each assertion must fail before artifact verification.
    // 归档无需存在，因为每个断言必须在产物验证前失败。
    const archive = join(root, "sdk.tgz");
    // Fake bytes may be hashed but must never be loaded as a native library.
    // 伪造字节可以计算摘要，但绝不能作为原生库加载。
    const bytes = Buffer.from("not a native library");
    // Matching fake-file identity isolates malformed-description rejection from digest rejection.
    // 匹配伪文件身份将畸形描述拒绝与摘要拒绝隔离。
    const digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(library, bytes);
    writeFileSync(description, "invalid JSON");
    assert.throws(() => verifyCandidate(archive, undefined, digest, description), /Candidate library is required/);
    assert.throws(() => verifyCandidate(archive, "relative.dll", digest, description), /must be absolute/);
    assert.throws(() => verifyCandidate(archive, join(root, "missing.dll"), digest, description), /ENOENT/);
    assert.throws(() => verifyCandidate(archive, library, "latest", description), /frozen lowercase digest/);
    assert.throws(() => verifyCandidate(archive, library, "0".repeat(64), description), /SHA-256 mismatch/);
    assert.throws(() => verifyCandidate(archive, library, digest, description), SyntaxError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
