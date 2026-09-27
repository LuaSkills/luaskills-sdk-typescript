import type { MessagePort } from "node:worker_threads";
import { EmbeddedCompatibilityError } from "./embedded-compatibility.js";
import { requestEmbeddedNative, EmbeddedResultReleaseError, EmbeddedTransportError, type NativeResult, type EmbeddedNativeBindings } from "./embedded-transport.js";
import { EmbeddedNativeStatus } from "./embedded-contract.js";
import { EMBEDDED_WORKER_ERROR_CHARS, type EmbeddedWorkerConfig, type EmbeddedWorkerError, type EmbeddedWorkerReply, type EmbeddedWorkerRequest } from "./embedded-worker-protocol.js";

/**
 * Convert an exception into bounded owned evidence, keeping copied native delivery bytes separate.
 * 将异常转换为有界拥有型证据，单独保留已复制原生交付字节。
 * @param error C binding or SDK boundary failure.
 * C 绑定或 SDK 边界失败。
 * @returns Explicit cloneable error with no pointers, hooks or application aliases.
 * 无指针、钩子或应用别名的显式可克隆错误。
 */
export function errorEvidence(error: unknown): EmbeddedWorkerError {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, EMBEDDED_WORKER_ERROR_CHARS);
  if (error instanceof EmbeddedCompatibilityError) return { kind: "compatibility", message };
  if (error instanceof EmbeddedResultReleaseError) {
    const bytes = error.responseBytes;
    return { kind: "release", status: error.status, message, responseBytes: bytes === null ? null : Uint8Array.from(bytes) };
  }
  if (error instanceof EmbeddedTransportError) return { kind: "transport", functionName: error.functionName, status: error.status, message };
  return { kind: "binding", message };
}

/**
 * Start one serial native lane borrowed from its parent's transport; stop only without retained results.
 * 启动一条借用父线程传输的串行原生通道；仅在没有保留结果时停止。
 * @param config Exact immutable owner-supplied identity and budgets.
 * 所有者提供的精确不可变身份及预算。
 * @param port Owned worker message port.
 * 拥有的工作线程消息端口。
 * @param native Exact bindings retained by this worker; independently injectable at the native boundary.
 * 此工作线程保留的精确绑定；可在原生边界独立注入。
 * @returns Nothing; the message port retains this execution context until graceful shutdown.
 * 无返回值；消息端口保留此执行上下文直到正常关闭。
 */
export function serveEmbeddedWorker(config: EmbeddedWorkerConfig, port: MessagePort, native: EmbeddedNativeBindings): void {
  // Reject a second module before installing any command listener or announcing readiness.
  // 在安装任何命令监听器或宣布就绪之前拒绝第二个模块。
  if (typeof config.bindingIdentity !== "string" || !/^[0-9a-f]{64}$/.test(config.bindingIdentity) || config.bindingIdentity !== native.bindingIdentity) throw new EmbeddedCompatibilityError("Embedded worker loaded a different native module instance");
  const results = new Map<bigint, Readonly<NativeResult>>();
  let stopping = false;

  /**
   * Publish one explicit reply; byte views already own independent, exact-size backing storage.
   * 发布一条显式回复；字节视图已经拥有独立且大小精确的后备存储。
   * @param reply Completed protocol reply.
   * 完整协议回复。
   */
  function send(reply: EmbeddedWorkerReply): void { port.postMessage(reply); }

  port.on("message", (request: EmbeddedWorkerRequest) => {
    if (stopping) throw new Error("Embedded worker received work after stop");
    if (request.type === "stop") {
      if (results.size) throw new Error("Embedded worker cannot stop with retained native results");
      stopping = true;
      send({ type: "stopped" });
      port.close();
      return;
    }
    if (request.type === "release") {
      let error: EmbeddedWorkerError | null = null;
      try {
        for (const [identity, result] of results) {
          const status = native.resultFree(config.transportId, result);
          if (status !== EmbeddedNativeStatus.OK) throw new EmbeddedTransportError("luaskills_ffi_embedded_result_free_v1", status);
          results.delete(identity);
        }
      } catch (failure) { error = errorEvidence(failure); }
      send({ type: "released", id: request.id, error, retained: results.size !== 0 });
      return;
    }
    if (request.type !== "request" || results.size) throw new Error("Embedded worker admission invariant failed");
    let bytes: Uint8Array | null = null;
    let error: EmbeddedWorkerError | null = null;
    try {
      if (!(request.bytes instanceof Uint8Array) || BigInt(request.bytes.byteLength) > config.maxRequestBytes) throw new RangeError("Embedded worker request exceeds its byte budget");
      // Copy before entering C and publish exact-size bytes, never an entire pooled Buffer allocation.
      // 进入 C 前复制，并发布精确大小字节，绝不发布整个池化 Buffer 分配。
      const response = requestEmbeddedNative(config.transportId, Buffer.from(request.bytes), config.maxResponseBytes, results, native.request, native.resultFree);
      bytes = Uint8Array.from(response);
    } catch (failure) { error = errorEvidence(failure); }
    send({ type: "completed", id: request.id, bytes, error, retained: results.size !== 0 });
  });
  send({ type: "ready" });
}
