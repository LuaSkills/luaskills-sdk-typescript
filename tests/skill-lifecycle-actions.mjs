import assert from "node:assert/strict";
import { Authority, SkillInstallSourceType, SkillManagementClient, SystemSkillManagementClient } from "../dist/index.js";

// Recorded native calls emitted by the fake JSON FFI bridge.
// 假 JSON FFI 桥记录的原生调用。
const calls = [];

// Fake SDK client shape used by skill lifecycle clients at runtime.
// skill 生命周期客户端运行时使用的假 SDK 客户端形状。
const client = {
  engineId: 99,
  // callJson records one skill lifecycle FFI call and returns an object-shaped result.
  // callJson 记录一次 skill 生命周期 FFI 调用并返回对象形状结果。
  callJson(functionName, payload) {
    calls.push({ functionName, payload });
    return { status: "ok" };
  },
};

// Ordinary management namespace under test.
// 被测的普通管理命名空间。
const publicManagement = new SkillManagementClient(client, false);

assert.deepEqual(
  publicManagement.disable([{ name: "ROOT", skills_dir: "runtime/skills" }], "demo.skill", "manual"),
  { status: "ok" },
);
assert.deepEqual(calls[0], {
  functionName: "luaskills_ffi_disable_skill_json",
  payload: {
    engine_id: 99,
    skill_roots: [{ name: "ROOT", skills_dir: "runtime/skills" }],
    skill_id: "demo.skill",
    reason: "manual",
  },
});

// Authority-bound system management namespace under test.
// 被测的绑定 authority 的 system 管理命名空间。
const systemManagement = new SystemSkillManagementClient(client, Authority.DelegatedTool);

systemManagement.update(
  [{ name: "ROOT", skills_dir: "runtime/skills" }],
  { source_type: SkillInstallSourceType.Github, source: "LuaSkills/demo-skill" },
);
assert.deepEqual(calls[1], {
  functionName: "luaskills_ffi_system_update_skill_json",
  payload: {
    engine_id: 99,
    skill_roots: [{ name: "ROOT", skills_dir: "runtime/skills" }],
    request: { source_type: "github", source: "LuaSkills/demo-skill" },
    target_root: null,
    authority: Authority.DelegatedTool,
  },
});

assert.throws(
  () =>
    publicManagement.install(
      [{ name: "ROOT", skills_dir: "runtime/skills" }],
      { type: "github", url: "https://example.test/skill.git" },
    ),
  /unsupported keys/,
);

assert.throws(
  () =>
    systemManagement.install([{ name: "ROOT", skills_dir: "runtime/skills" }], {
      skill_id: "private.demo",
      source_type: SkillInstallSourceType.PrivateUrlManifest,
      source: "file:///tmp/private.json",
    }),
  /absolute HTTP/,
);

assert.equal("functionName" in systemManagement, false);
assert.equal("authorityPayload" in systemManagement, false);
assert.equal(calls.length, 2);
