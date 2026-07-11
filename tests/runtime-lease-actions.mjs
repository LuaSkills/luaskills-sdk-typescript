import assert from "node:assert/strict";
import { Authority, RuntimeLeaseClient } from "../dist/index.js";

// Recorded native calls emitted by the fake JSON FFI bridge.
// 假 JSON FFI 桥记录的原生调用。
const calls = [];

// Fake SDK client shape used by RuntimeLeaseClient at runtime.
// RuntimeLeaseClient 运行时使用的假 SDK 客户端形状。
const client = {
  engineId: 77,
  // callJson records one runtime-lease FFI call and returns an object-shaped result.
  // callJson 记录一次运行时租约 FFI 调用并返回对象形状结果。
  callJson(functionName, payload) {
    calls.push({ functionName, payload });
    return { ok: true };
  },
};

// Authority-bound runtime lease namespace under test.
// 被测的绑定权限运行时租约命名空间。
const leases = new RuntimeLeaseClient(client, Authority.System);

assert.equal("runtimeLeaseFunctionName" in leases, false);
assert.deepEqual(leases.callRaw("status", { lease_id: "lease-1" }), { ok: true });
assert.deepEqual(calls[0], {
  functionName: "luaskills_ffi_system_runtime_lease_status_json",
  payload: {
    lease_id: "lease-1",
    engine_id: 77,
    authority: Authority.System,
  },
});

assert.throws(
  () => leases.callRaw("destroy", {}),
  /unsupported runtime lease action/,
);
assert.equal(calls.length, 1);

assert.deepEqual(leases.create("system-session", null, false, {
  system_package: {
    id: "debug",
    root: "C:/plugins/debug",
    dependencies_file: "dependencies.json",
  },
}), { ok: true });
assert.deepEqual(calls[1], {
  functionName: "luaskills_ffi_system_runtime_lease_create_json",
  payload: {
    sid: "system-session",
    replace: false,
    system_package: {
      id: "debug",
      root: "C:/plugins/debug",
      dependencies_file: "dependencies.json",
    },
    engine_id: 77,
    authority: Authority.System,
  },
});
assert.throws(() => leases.create("missing-package"), /requires system_package/);
assert.throws(
  () => leases.create("invalid-roots", null, false, { lua_roots: ["lua"] }),
  /does not accept lua_roots/,
);
