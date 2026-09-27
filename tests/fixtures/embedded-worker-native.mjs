import { parentPort, workerData } from "node:worker_threads";
import { bindEmbeddedNative } from "../../dist/embedded-transport.js";
import { serveEmbeddedWorker } from "../../dist/embedded-worker-runtime.js";

// This test boundary reports entry immediately before invoking the real blocking C function.
// 此测试边界在调用实际阻塞 C 函数之前立即报告进入。
const native = bindEmbeddedNative(workerData.libraryPath);
serveEmbeddedWorker(workerData, parentPort, {
  ...native,
  request(...args) {
    parentPort.postMessage({ type: "native_entered" });
    return native.request(...args);
  },
});
