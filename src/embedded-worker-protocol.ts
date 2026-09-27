/** Exactly one control worker is reserved independently of business workers.
 * 独立于业务工作线程精确预留一个控制工作线程。 */
export const EMBEDDED_CONTROL_WORKERS = 1;
/** Internal binding diagnostics are bounded independently of native JSON response budgets.
 * 内部绑定诊断的上限独立于原生 JSON 响应预算。 */
export const EMBEDDED_WORKER_ERROR_CHARS = 2048;

/** Immutable startup values borrowed from one owning transport.
 * 从一个所属传输借用的不可变启动值。 */
export interface EmbeddedWorkerConfig {
  /** Exact resolved library path.
   * 精确已解析动态库路径。 */
  readonly libraryPath: string;
  /** Opaque equality token for the owner's still-loaded module, never a dereferenceable address.
   * 所有者仍加载模块的不透明相等性标识，绝非可解引用地址。 */
  readonly bindingIdentity: string;
  /** Exact transport identity; workers never create or free it.
   * 精确传输身份；工作线程绝不创建或释放它。 */
  readonly transportId: bigint;
  /** Maximum request size before entering C.
   * 进入 C 前的最大请求大小。 */
  readonly maxRequestBytes: bigint;
  /** Maximum complete native response size.
   * 最大完整原生响应大小。 */
  readonly maxResponseBytes: bigint;
}

/** Explicit serialized error evidence; arbitrary Error subclasses do not survive structured cloning.
 * 显式序列化错误证据；任意 Error 子类不能经结构化克隆完整保留。
 */
export type EmbeddedWorkerError =
  | { readonly kind: "compatibility"; readonly message: string }
  | { readonly kind: "transport"; readonly functionName: string; readonly status: number | null; readonly message: string }
  | { readonly kind: "release"; readonly status: number | null; readonly message: string; readonly responseBytes: Uint8Array | null }
  | { readonly kind: "binding"; readonly message: string };

/** Parent messages contain owned bytes, never native pointers or application class instances.
 * 父线程消息包含拥有型字节，绝不包含原生指针或应用类实例。 */
export type EmbeddedWorkerRequest =
  | { readonly type: "request"; readonly id: string; readonly bytes: Uint8Array }
  | { readonly type: "release"; readonly id: string }
  | { readonly type: "stop" };

/** Worker reports carry exact receipt identities and explicit native-result ownership evidence.
 * 工作线程报告携带精确回执身份及显式原生结果所有权证据。 */
export type EmbeddedWorkerReply =
  | { readonly type: "ready" }
  | { readonly type: "startup_failed"; readonly error: EmbeddedWorkerError }
  | { readonly type: "completed"; readonly id: string; readonly bytes: Uint8Array | null; readonly error: EmbeddedWorkerError | null; readonly retained: boolean }
  | { readonly type: "released"; readonly id: string; readonly error: EmbeddedWorkerError | null; readonly retained: boolean }
  | { readonly type: "stopped" };
