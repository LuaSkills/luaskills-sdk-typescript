import assert from "node:assert/strict";
import { Authority, SystemSkillManagementClient } from "../dist/index.js";

// Recorded native calls emitted by the fake JSON FFI bridge.
// 假 JSON FFI 桥记录的原生调用。
const calls = [];

// Fake SDK client shape used by SystemSkillManagementClient at runtime.
// SystemSkillManagementClient 运行时使用的假 SDK 客户端形状。
const client = {
  engineId: 42,
  // callJson records one native function call and returns an object-shaped result.
  // callJson 记录一次原生函数调用并返回对象形状结果。
  callJson(functionName, payload) {
    calls.push({ functionName, payload });
    return { status: "ok", skill_id: payload.skill_id };
  },
};

// Authority-bound system management namespace under test.
// 被测的绑定权限 system 管理命名空间。
const system = new SystemSkillManagementClient(client, Authority.DelegatedTool);

assert.equal("privateUrlManifest" in system, false);

// Explicit target root forwarded to the native private install request.
// 转发给原生私有安装请求的显式目标 root。
const targetRoot = { name: "ROOT", skills_dir: "runtime/skills" };

// Result returned by the install helper through the fake bridge.
// 通过假桥从安装辅助方法返回的结果。
const installResult = system.installPrivateUrlManifest(
  [{ name: "ROOT", skills_dir: "runtime/skills" }],
  "private.demo",
  "https://example.test/skill.json",
  { targetRoot },
);

assert.equal(installResult.status, "ok");
assert.deepEqual(calls[0], {
  functionName: "luaskills_ffi_system_private_install_skill_from_url_manifest_json",
  payload: {
    engine_id: 42,
    skill_roots: [{ name: "ROOT", skills_dir: "runtime/skills" }],
    skill_id: "private.demo",
    manifest_url: "https://example.test/skill.json",
    target_root: targetRoot,
    authority: Authority.System,
  },
});

system.updatePrivateUrlManifest(
  [{ name: "ROOT", skills_dir: "runtime/skills" }],
  "private.demo",
  "https://example.test/skill.json",
);

assert.deepEqual(calls[1], {
  functionName: "luaskills_ffi_system_private_update_skill_from_url_manifest_json",
  payload: {
    engine_id: 42,
    skill_roots: [{ name: "ROOT", skills_dir: "runtime/skills" }],
    skill_id: "private.demo",
    manifest_url: "https://example.test/skill.json",
    target_root: null,
    authority: Authority.System,
  },
});

assert.throws(
  () =>
    system.installPrivateUrlManifest(
      [{ name: "ROOT", skills_dir: "runtime/skills" }],
      "private.demo",
      "/private/skill.json",
    ),
  /manifest_url must be an absolute HTTP or HTTPS URL/,
);

assert.equal(calls.length, 2);
