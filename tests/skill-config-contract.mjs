import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SKILL_CONFIG_CONTRACT_VERSION,
  SKILL_CONFIG_ERROR_CODES,
  SKILL_CONFIG_MAXIMUM_EVENT_POLL_LIMIT,
  SKILL_CONFIG_MAXIMUM_SAFE_INTEGER,
  SKILL_CONFIG_STORE_SCOPES,
  SKILL_PACKAGE_CONFIG_DESCRIBE_MODES,
  SKILL_PACKAGE_CONFIG_FORMATS,
  SKILL_PACKAGE_CONFIG_STATES,
  SKILL_PACKAGE_CONFIG_TYPES,
} from "../dist/index.js";

// Repository root that owns the checked-in core-generated contract.
// 保存核心生成契约副本的仓库根目录。
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Parsed SDK contract used to reject generated-constant drift.
// 用于拒绝生成常量漂移的 SDK 契约。
const contract = JSON.parse(
  readFileSync(join(repositoryRoot, "contracts", "skill-config", "v1", "contract.json"), "utf8"),
);

assert.equal(SKILL_CONFIG_CONTRACT_VERSION, contract.contract_version);
assert.deepEqual([...SKILL_CONFIG_ERROR_CODES], contract.errors);
assert.deepEqual([...SKILL_PACKAGE_CONFIG_TYPES], contract.declaration.types);
assert.deepEqual([...SKILL_PACKAGE_CONFIG_FORMATS], contract.declaration.formats);
assert.deepEqual([...SKILL_PACKAGE_CONFIG_STATES], contract.declaration.states);
assert.deepEqual(
  [...SKILL_PACKAGE_CONFIG_DESCRIBE_MODES],
  contract.declaration.describe_modes,
);
assert.deepEqual([...SKILL_CONFIG_STORE_SCOPES], contract.declaration.store_scopes);
assert.equal(SKILL_CONFIG_MAXIMUM_SAFE_INTEGER, contract.limits.maximum_safe_integer);
assert.equal(
  SKILL_CONFIG_MAXIMUM_EVENT_POLL_LIMIT,
  contract.limits.maximum_event_poll_limit,
);
