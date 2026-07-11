import assert from "node:assert/strict";
import { Authority, SystemSkillManagementClient } from "../dist/index.js";

// Recorded native calls emitted by the fake JSON FFI bridge.
// 假 JSON FFI 桥记录的原生调用。
const calls = [];

// Fake SDK client shape used by SystemSkillManagementClient at runtime.
// SystemSkillManagementClient 运行时使用的假 SDK 客户端形状。
const client = {
  engineId: 123,
  // callJson records one native function call and returns the helper-specific shape.
  // callJson 记录一次原生函数调用并返回辅助方法需要的形状。
  callJson(functionName, payload) {
    calls.push({ functionName, payload });
    if (functionName === "luaskills_ffi_list_entries_json") {
      return [{ id: "entry.demo" }];
    }
    return {};
  },
};

// Authority-bound system management namespace under test.
// 被测的绑定 authority 的 system 管理命名空间。
const system = new SystemSkillManagementClient(client, Authority.DelegatedTool);

assert.equal("call" in system, false);
assert.equal("callValue" in system, false);
assert.deepEqual(system.listEntries(), [{ id: "entry.demo" }]);
assert.deepEqual(calls[0], {
  functionName: "luaskills_ffi_list_entries_json",
  payload: {
    engine_id: 123,
    authority: Authority.DelegatedTool,
  },
});
