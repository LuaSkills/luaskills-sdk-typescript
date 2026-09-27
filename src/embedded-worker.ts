import { parentPort, workerData } from "node:worker_threads";
import { bindEmbeddedNative } from "./embedded-transport.js";
import { errorEvidence, serveEmbeddedWorker } from "./embedded-worker-runtime.js";
import type { EmbeddedWorkerConfig, EmbeddedWorkerReply } from "./embedded-worker-protocol.js";

// Startup binds functions only. No native command may run before the parent receives ready.
// 启动仅绑定函数；父线程收到 ready 之前不得运行任何原生命令。
try {
  if (parentPort === null) throw new Error("Embedded worker requires a parent port");
  // Only the parent provides this immutable configuration before native ownership is borrowed.
  // 仅由父线程在借用原生所有权之前提供此不可变配置。
  const config = workerData as EmbeddedWorkerConfig;
  serveEmbeddedWorker(config, parentPort, bindEmbeddedNative(config.libraryPath));
}
catch (error) {
  if (parentPort === null) throw error;
  parentPort.postMessage({ type: "startup_failed", error: errorEvidence(error) } satisfies EmbeddedWorkerReply);
  parentPort.close();
}
