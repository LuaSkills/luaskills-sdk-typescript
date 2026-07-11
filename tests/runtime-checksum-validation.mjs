import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyNamedSha256, verifySha256, verifySha512Integrity } from "../dist/index.js";

// Temporary file used to verify checksum helpers with real bytes.
// 用真实字节校验 checksum 辅助函数的临时文件。
const temporaryRoot = mkdtempSync(join(tmpdir(), "luaskills-checksum-validation-"));
const filePath = join(temporaryRoot, "sample.bin");

try {
  writeFileSync(filePath, Buffer.from("luaskills checksum sample", "utf8"));
  const bytes = readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512 = createHash("sha512").update(bytes).digest("base64");

  await verifySha256(filePath, `${sha256} sample.bin\n`);
  await assert.rejects(
    () => verifySha256(filePath, ""),
    /invalid SHA-256 sidecar/,
  );
  await assert.rejects(
    () => verifySha256(filePath, "abc sample.bin"),
    /invalid SHA-256 digest/,
  );

  await verifyNamedSha256(filePath, `${sha256} sample.bin\n`, "sample.bin");
  await assert.rejects(
    () => verifyNamedSha256(filePath, `${sha256} other.bin\n`, "sample.bin"),
    /was not found/,
  );
  await assert.rejects(
    () => verifyNamedSha256(filePath, "abc sample.bin\n", "sample.bin"),
    /invalid SHA-256 digest/,
  );

  await verifySha512Integrity(filePath, `sha512-${sha512}`);
  await assert.rejects(
    () => verifySha512Integrity(filePath, "sha256-not-sha512"),
    /invalid SHA-512 integrity/,
  );
  await assert.rejects(
    () => verifySha512Integrity(filePath, "sha512-not-base64!"),
    /invalid SHA-512 integrity/,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
