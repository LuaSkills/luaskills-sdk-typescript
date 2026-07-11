import assert from "node:assert/strict";
import { LuaSkillsError, LuaSkillsJsonFfi } from "../dist/index.js";

// FFI shell used to access the SDK envelope decoder without loading a native library.
// 用于访问 SDK 包络解码器且不加载原生库的 FFI 外壳。
const ffi = Object.create(LuaSkillsJsonFfi.prototype);

assert.throws(
  () => ffi.decodeEnvelopeText("luaskills_ffi_demo_json", ""),
  (error) => error instanceof LuaSkillsError
    && /luaskills_ffi_demo_json: empty JSON FFI response envelope/.test(error.message),
);

assert.throws(
  () => ffi.decodeEnvelopeText("luaskills_ffi_demo_json", "{"),
  (error) => error instanceof LuaSkillsError
    && /luaskills_ffi_demo_json: invalid JSON FFI response envelope/.test(error.message),
);

assert.throws(
  () => ffi.decodeEnvelopeText("luaskills_ffi_demo_json", "[1]"),
  (error) => error instanceof LuaSkillsError
    && /luaskills_ffi_demo_json: JSON FFI response envelope must be one object/.test(error.message),
);
