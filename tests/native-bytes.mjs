import assert from "node:assert/strict";
import koffi from "koffi";
import { nativeBytes } from "../dist/ffi.js";

// Native result bytes are copied into JavaScript memory; an alias over native memory would be
// an external ArrayBuffer, which Electron's V8 memory sandbox aborts on.
// 原生结果字节复制到 JavaScript 内存；别名原生内存会成为外部 ArrayBuffer，Electron 的 V8 内存沙箱会因此中止。
const native = koffi.alloc("uint8_t", 4);
try {
  koffi.encode(native, koffi.array("uint8_t", 4), [1, 2, 3, 4]);
  const copied = nativeBytes(native, 4);
  assert.deepEqual([...copied], [1, 2, 3, 4]);
  koffi.encode(native, koffi.array("uint8_t", 4), [9, 9, 9, 9]);
  assert.deepEqual([...copied], [1, 2, 3, 4], "nativeBytes must copy, not alias native memory");
  console.log("Native result bytes are copied into JavaScript memory");
} finally {
  koffi.free(native);
}
