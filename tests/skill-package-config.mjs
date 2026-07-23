import assert from "node:assert/strict";
import { SkillConfigClient } from "../dist/index.js";

// Recorded JSON FFI calls emitted by the package-configuration client.
// 技能包配置客户端发出的已记录 JSON FFI 调用。
const calls = [];

// Stable descriptor returned by the fake JSON FFI bridge.
// 假 JSON FFI 桥返回的稳定描述结构。
const descriptor = {
  skill_id: "demo-skill",
  skill_version: "1.0.0",
  complete: false,
  orphaned_count: 0,
  items: [],
};

// Stable validation status returned by the fake JSON FFI bridge.
// 假 JSON FFI 桥返回的稳定校验状态。
const status = {
  skill_id: "demo-skill",
  complete: false,
  missing: [{ key: "api_token", code: "config_value_missing", message: "missing" }],
  invalid: [],
  orphaned_count: 0,
};

// Fake SDK client shape used by the package-configuration namespace.
// 技能包配置命名空间使用的假 SDK 客户端形状。
const client = {
  engineId: 77,
  // Record one JSON FFI call and return the corresponding typed result.
  // 记录一次 JSON FFI 调用并返回对应的类型化结果。
  callJson(functionName, payload) {
    calls.push({ functionName, payload });
    return functionName.endsWith("_describe_json") ? [descriptor] : status;
  },
};

// Package-configuration namespace under test.
// 被测的技能包配置命名空间。
const config = new SkillConfigClient(client);

assert.deepEqual(config.describe(), [descriptor]);
assert.deepEqual(calls[0], {
  functionName: "luaskills_ffi_skill_config_describe_json",
  payload: {
    engine_id: 77,
    skill_id: null,
    include_values: false,
    mode: "effective",
    root_name: null,
  },
});

assert.deepEqual(
  config.describe({
    skillId: "demo-skill",
    includeValues: true,
  }),
  [descriptor],
);
assert.deepEqual(calls[1], {
  functionName: "luaskills_ffi_skill_config_describe_json",
  payload: {
    engine_id: 77,
    skill_id: "demo-skill",
    include_values: true,
    mode: "effective",
    root_name: null,
  },
});

assert.deepEqual(config.validate("demo-skill"), status);
assert.deepEqual(calls[2], {
  functionName: "luaskills_ffi_skill_config_validate_json",
  payload: {
    engine_id: 77,
    skill_id: "demo-skill",
  },
});

assert.deepEqual(
  config.describe({
    skillId: "demo-skill",
    mode: "installed",
    rootName: "ROOT",
  }),
  [descriptor],
);
assert.deepEqual(calls[3], {
  functionName: "luaskills_ffi_skill_config_describe_json",
  payload: {
    engine_id: 77,
    skill_id: "demo-skill",
    include_values: false,
    mode: "installed",
    root_name: "ROOT",
  },
});

config.set(
  "demo-skill",
  {
    retry_count: 3,
    enabled: true,
  },
  { expectedRevision: "7" },
);
assert.deepEqual(calls[4], {
  functionName: "luaskills_ffi_skill_config_set_json",
  payload: {
    engine_id: 77,
    skill_id: "demo-skill",
    values: {
      retry_count: 3,
      enabled: true,
    },
    expected_revision: "7",
  },
});

config.delete("demo-skill", "retry_count", { expectedRevision: "8" });
assert.deepEqual(calls[5], {
  functionName: "luaskills_ffi_skill_config_delete_json",
  payload: {
    engine_id: 77,
    skill_id: "demo-skill",
    key: "retry_count",
    expected_revision: "8",
  },
});

config.refresh("skills");
assert.deepEqual(calls[6], {
  functionName: "luaskills_ffi_skill_config_refresh_json",
  payload: {
    engine_id: 77,
    store_scope: "skills",
  },
});

config.pollEvents("12", 25);
assert.deepEqual(calls[7], {
  functionName: "luaskills_ffi_skill_config_events_poll_json",
  payload: {
    engine_id: 77,
    after_sequence: "12",
    limit: 25,
  },
});

assert.throws(
  () => config.set("demo-skill", "retry_count", Number.MAX_SAFE_INTEGER + 1),
  /safe range/,
);
assert.throws(
  () => config.set("demo-skill", "ratio", Number.POSITIVE_INFINITY),
  /finite number/,
);
assert.throws(
  () => config.set("demo-skill", {}),
  /must not be empty/,
);
assert.throws(
  () => config.pollEvents(undefined, 0),
  /between 1 and/,
);
