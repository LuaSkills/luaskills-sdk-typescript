import assert from "node:assert/strict";
import { LuaSkillsJsonFfi } from "../dist/index.js";

// Recorded callback registration calls emitted by the fake FFI bridge.
// 假 FFI 桥记录的 callback 注册调用。
const calls = [];

// FFI instance shell that bypasses native library loading for callback helper tests.
// 绕过原生动态库加载的 FFI 实例外壳，用于 callback 辅助方法测试。
const ffi = Object.create(LuaSkillsJsonFfi.prototype);

// setJsonProviderCallback records one callback registration request.
// setJsonProviderCallback 记录一次 callback 注册请求。
ffi.setJsonProviderCallback = (kind, functionName, callback) => {
  calls.push({ kind, functionName, callback });
};

// Progress callback used to verify the public helper forwards the exact function.
// 用于校验公开辅助方法转发精确函数的进度 callback。
const callback = (event) => ({ operation_id: event.operation_id });

ffi.setSkillOperationProgressJsonCallback(callback);
ffi.clearSkillOperationProgressJsonCallback();

assert.deepEqual(calls, [
  {
    kind: "skill-operation-progress",
    functionName: "luaskills_ffi_set_skill_operation_progress_json_callback",
    callback,
  },
  {
    kind: "skill-operation-progress",
    functionName: "luaskills_ffi_set_skill_operation_progress_json_callback",
    callback: null,
  },
]);

calls.length = 0;
ffi.clearJsonProviderCallbacks();

assert.deepEqual(calls, [
  {
    kind: "sqlite",
    functionName: "luaskills_ffi_set_sqlite_provider_json_callback",
    callback: null,
  },
  {
    kind: "lancedb",
    functionName: "luaskills_ffi_set_lancedb_provider_json_callback",
    callback: null,
  },
  {
    kind: "host-tool",
    functionName: "luaskills_ffi_set_host_tool_json_callback",
    callback: null,
  },
  {
    kind: "skill-operation-progress",
    functionName: "luaskills_ffi_set_skill_operation_progress_json_callback",
    callback: null,
  },
  {
    kind: "model-embed",
    functionName: "luaskills_ffi_set_model_embed_json_callback",
    callback: null,
  },
  {
    kind: "model-llm",
    functionName: "luaskills_ffi_set_model_llm_json_callback",
    callback: null,
  },
]);
