import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateArchiveLinkTarget,
  validateArchiveMemberPath,
  validateTarMemberType,
} from "../dist/index.js";

// Temporary destination used to evaluate archive member path containment.
// 用于评估归档成员路径包含关系的临时目标目录。
const destination = mkdtempSync(join(tmpdir(), "luaskills-archive-validation-"));

try {
  assert.doesNotThrow(() => validateArchiveMemberPath(destination, "safe/file.txt"));
  assert.throws(
    () => validateArchiveMemberPath(destination, "../evil.txt"),
    /Archive member escapes extraction directory/,
  );
  assert.throws(
    () => validateArchiveMemberPath(destination, ""),
    /Unsafe archive member path/,
  );
  assert.throws(
    () => validateArchiveMemberPath(destination, "C:\\outside.txt"),
    /Unsafe archive member path/,
  );

  assert.doesNotThrow(() => validateArchiveLinkTarget(destination, "safe/link", "../target.txt"));
  assert.throws(
    () => validateArchiveLinkTarget(destination, "safe/link", "../../evil.txt"),
    /Archive member escapes extraction directory/,
  );
  assert.throws(
    () => validateArchiveLinkTarget(destination, "safe/link", "C:\\outside.txt"),
    /Unsafe archive link target/,
  );

  for (const safeType of ["", "0", "1", "2", "5"]) {
    assert.doesNotThrow(() => validateTarMemberType(safeType, "safe/member"));
  }
  for (const unsafeType of ["3", "4", "6"]) {
    assert.throws(
      () => validateTarMemberType(unsafeType, "unsafe/member"),
      /Unsupported tar member type/,
    );
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
