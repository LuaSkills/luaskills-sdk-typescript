import assert from "node:assert/strict";
import {
  Authority,
  LuaSkillsClient,
  RuntimeLeaseClient,
  SkillConfigClient,
  SkillManagementClient,
  SystemSkillManagementClient,
} from "../dist/index.js";

// Fake low-level FFI shape used only to prove the constructor boundary.
// 仅用于证明构造边界的假底层 FFI 形状。
const fakeFfi = {};

assert.throws(
  () => new LuaSkillsClient(fakeFfi, 1),
  /LuaSkillsClient must be created with LuaSkillsClient\.create/,
);

// Runtime engine id is exposed through a getter-only boundary instead of a writable field.
// 运行时 engine id 通过只读 getter 边界暴露，而不是可写字段。
const engineIdDescriptor = Object.getOwnPropertyDescriptor(LuaSkillsClient.prototype, "engineId");
assert.equal(typeof engineIdDescriptor?.get, "function");
assert.equal(engineIdDescriptor?.set, undefined);

// Strict-mode assignment cannot shadow the getter-only boundary on SDK-shaped objects.
// strict mode 赋值不能覆盖 SDK 形状对象上的只读 getter 边界。
const forgedClient = Object.create(LuaSkillsClient.prototype);
assert.throws(
  () => {
    forgedClient.engineId = 7;
  },
  TypeError,
);
assert.equal(Object.hasOwn(forgedClient, "engineId"), false);

assert.throws(
  () => LuaSkillsClient.prototype.callJson.call({}, "luaskills_ffi_list_entries_json", {}, Symbol("outside")),
  /LuaSkillsClient\.callJson is reserved for SDK internals/,
);

// Count of direct low-level FFI calls that would indicate a child namespace bypass.
// 表示子命名空间绕过父级生命周期入口的直接底层 FFI 调用计数。
let bypassCalls = 0;

// Closed parent client shape used to prove child namespaces use the guarded parent call boundary.
// 用于证明子命名空间会使用父级受保护调用边界的已关闭父客户端形状。
const closedClient = {
  engineId: 42,
  callJson() {
    throw new Error("LuaSkills engine 42 is already closed");
  },
  ffi: {
    callJson() {
      bypassCalls += 1;
      throw new Error("child namespace bypassed parent lifecycle boundary");
    },
  },
};

assert.throws(
  () => new SkillConfigClient(closedClient).list(),
  /LuaSkills engine 42 is already closed/,
);
assert.throws(
  () => new SkillManagementClient(closedClient, false).enable([], "demo.skill"),
  /LuaSkills engine 42 is already closed/,
);
assert.throws(
  () => new SystemSkillManagementClient(closedClient, Authority.System).listEntries(),
  /LuaSkills engine 42 is already closed/,
);
assert.throws(
  () => new RuntimeLeaseClient(closedClient).callRaw("status", { lease_id: "lease-1" }),
  /LuaSkills engine 42 is already closed/,
);
assert.equal(bypassCalls, 0);
