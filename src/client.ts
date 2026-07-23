import { isAbsolute, join, resolve } from "node:path";
import {
  SKILL_CONFIG_MAXIMUM_EVENT_POLL_LIMIT,
  type SkillConfigStoreScope,
} from "./config-contract.js";
import { LuaSkillsJsonFfi, type ManagedSessionWakeCallback } from "./ffi.js";
import { RuntimeRoots } from "./roots.js";
import { hostOptionsFromRuntimeManifest, loadRuntimeInstallManifestSync } from "./runtime-assets.js";
import {
  Authority,
  SkillInstallSourceType,
  type BooleanResult,
  type EngineHandleResult,
  type FfiDescribeResult,
  type FfiVersionResult,
  type JsonValue,
  type LuaEngineOptions,
  type LuaInvocationContext,
  type ManagedRuntimeInstallDescriptor,
  type ManagedRuntimeResolveOptions,
  type RuntimeLeaseCreateOptions,
  type LuaRuntimeCapabilityOptions,
  type LuaRuntimeHostOptions,
  type LuaRuntimeManagedRuntimeConfig,
  type LuaRuntimeSpaceControllerOptions,
  type LuaSkillsClientOptions,
  type LuaSkillsSdkOptions,
  type LuaVmPoolConfig,
  type OptionalSkillNameResult,
  type PrivateUrlManifestSkillOptions,
  type RuntimeAckResult,
  type RuntimeEntryDescriptor,
  type RuntimeHelpDetail,
  type RuntimeInvocationResult,
  type RuntimeSkillHelpDescriptor,
  type RuntimeSkillRoot,
  type SkillApplyResult,
  type SkillConfigEntry,
  type SkillConfigDeleteResult,
  type SkillConfigEvent,
  type SkillConfigEventBatch,
  type SkillConfigGetResult,
  type SkillConfigMutationOptions,
  type SkillConfigStoreRefresh,
  type SkillConfigValue,
  type SkillConfigWriteResult,
  type InstalledSkillPackageConfigDescriptor,
  type SkillPackageConfigDescribeOptions,
  type SkillPackageConfigDescriptor,
  type SkillPackageConfigStatus,
  type SkillInstallRequest,
  type SkillLifecycleOptions,
  type SkillUninstallOptions,
  type SkillUninstallResult,
} from "./types.js";

/**
 * Partial nested host options accepted by SDK defaults.
 * SDK 默认值接受的部分嵌套宿主选项。
 */
type HostOptionsOverride = Partial<Omit<LuaRuntimeHostOptions, "space_controller" | "capabilities">> & {
  /**
   * Partial space-controller option overrides.
   * 部分 space-controller 选项覆盖。
   */
  space_controller?: Partial<LuaRuntimeSpaceControllerOptions>;
  /**
   * Partial runtime capability overrides.
   * 部分运行时能力选项覆盖。
   */
  capabilities?: Partial<LuaRuntimeCapabilityOptions>;
};

/**
 * Private constructor token that prevents direct JavaScript construction of SDK clients.
 * 阻止 JavaScript 直接构造 SDK 客户端的私有构造令牌。
 */
const LUA_SKILLS_CLIENT_CONSTRUCTOR_TOKEN = Symbol("LuaSkillsClient.constructor");

/**
 * Private SDK-internal call token for engine-bound child namespaces.
 * 用于绑定 engine 子命名空间的 SDK 内部私有调用令牌。
 */
const LUA_SKILLS_CLIENT_CALL_TOKEN = Symbol("LuaSkillsClient.callJson");

/**
 * Generic JSON object payload used by runtime-lease and system helpers.
 * 运行时租约与 system 辅助器使用的通用 JSON 对象载荷。
 */
export type JsonMap = Record<string, JsonValue | undefined>;

/**
 * Supported skill lifecycle JSON FFI action names.
 * 受支持的 skill 生命周期 JSON FFI 动作名称。
 */
export type SkillLifecycleAction = "disable_skill" | "enable_skill" | "uninstall_skill" | "install_skill" | "update_skill";

/**
 * Runtime whitelist for skill lifecycle FFI name construction.
 * skill 生命周期 FFI 函数名构造的运行时白名单。
 */
const SKILL_LIFECYCLE_ACTIONS: ReadonlySet<SkillLifecycleAction> = new Set([
  "disable_skill",
  "enable_skill",
  "uninstall_skill",
  "install_skill",
  "update_skill",
]);

/**
 * Exact Rust SkillInstallRequest JSON keys accepted by SDK lifecycle wrappers.
 * SDK 生命周期封装接受的精确 Rust SkillInstallRequest JSON 键。
 */
const SKILL_INSTALL_REQUEST_KEYS: ReadonlySet<string> = new Set(["skill_id", "source", "source_type"]);

/**
 * Source types whose source locator is parsed as an absolute remote URL.
 * source 定位值会被解析为绝对远程 URL 的来源类型。
 */
const URL_SKILL_INSTALL_SOURCE_TYPES: ReadonlySet<string> = new Set([
  SkillInstallSourceType.Url,
  SkillInstallSourceType.PrivateUrlManifest,
]);

/**
 * Supported runtime-lease JSON FFI action names.
 * 受支持的运行时租约 JSON FFI 动作名称。
 */
export type RuntimeLeaseAction = "create" | "eval" | "status" | "list" | "close";

/**
 * Runtime whitelist for runtime-lease raw dispatch actions.
 * 运行时租约原始分发动作的运行时白名单。
 */
const RUNTIME_LEASE_ACTIONS: ReadonlySet<RuntimeLeaseAction> = new Set([
  "create",
  "eval",
  "status",
  "list",
  "close",
]);

/**
 * Options accepted by runtime help rendering.
 * 运行时帮助渲染接受的选项。
 */
export interface RenderHelpOptions {
  /**
   * Host-injected query authority.
   * 宿主注入的查询权限。
   */
  authority?: Authority | `${Authority}`;
  /**
   * Optional request context forwarded to help rendering.
   * 转发给帮助渲染的可选请求上下文。
   */
  requestContext?: JsonValue;
}

/**
 * High-level LuaSkills SDK client over the public JSON FFI surface.
 * 基于公共 JSON FFI 表面的高级 LuaSkills SDK 客户端。
 */
export class LuaSkillsClient {
  /**
   * Low-level JSON FFI bridge used by this client.
   * 当前客户端使用的底层 JSON FFI 桥。
   */
  readonly ffi: LuaSkillsJsonFfi;

  /**
   * Skill-config API namespace.
   * skill 配置 API 命名空间。
   */
  readonly config: SkillConfigClient;

  /**
   * Ordinary Skills-plane management API namespace.
   * 普通 Skills plane 管理 API 命名空间。
   */
  readonly skills: SkillManagementClient;

  /**
   * Stable numeric engine handle stored inside the native FFI registry.
   * 存放在原生 FFI 注册表中的稳定数值引擎句柄。
   */
  #engineId: number;

  /**
   * Number of active engine-bound FFI calls currently using the native handle.
   * 当前正在使用原生句柄的绑定 engine FFI 调用数量。
   */
  #activeCalls = 0;

  /**
   * Whether this client is currently freeing the native engine handle.
   * 当前客户端是否正在释放原生引擎句柄。
   */
  #closing = false;

  /**
   * Whether the native engine handle has already been released.
   * 原生引擎句柄是否已经被释放。
   */
  #closed = false;

  /**
   * Create one SDK client around an already-created engine id.
   * 围绕已创建的 engine id 创建一个 SDK 客户端。
   */
  private constructor(ffi: LuaSkillsJsonFfi, engineId: number, constructorToken: symbol) {
    if (constructorToken !== LUA_SKILLS_CLIENT_CONSTRUCTOR_TOKEN) {
      throw new TypeError("LuaSkillsClient must be created with LuaSkillsClient.create");
    }
    this.ffi = ffi;
    this.#engineId = engineId;
    // Define an own non-configurable accessor so external code cannot shadow the real handle on client instances.
    // 在实例上定义不可配置访问器，避免外部代码覆盖客户端实例上的真实句柄。
    Object.defineProperty(this, "engineId", {
      configurable: false,
      enumerable: true,
      get: () => this.#engineId,
    });
    this.config = new SkillConfigClient(this);
    this.skills = new SkillManagementClient(this, false);
  }

  /**
   * Return the immutable native engine handle identifier.
   * 返回不可变的原生引擎句柄标识符。
   */
  get engineId(): number {
    return this.#engineId;
  }

  /**
   * Call one engine-bound JSON FFI function after checking the lifecycle state.
   * 检查生命周期状态后调用一个绑定 engine 的 JSON FFI 函数。
   *
   * @internal
   */
  callJson<T>(functionName: string, payload: JsonValue | Record<string, unknown>, callToken: symbol): T {
    if (callToken !== LUA_SKILLS_CLIENT_CALL_TOKEN) {
      throw new TypeError("LuaSkillsClient.callJson is reserved for SDK internals");
    }
    return this.#callJson<T>(functionName, payload);
  }

  /**
   * Create one native LuaSkills engine and wrap it in a high-level SDK client.
   * 创建一个原生 LuaSkills 引擎并封装为高级 SDK 客户端。
   */
  static create(options: LuaSkillsClientOptions = {}): LuaSkillsClient {
    const ffi = new LuaSkillsJsonFfi(options);
    const engineOptions = createEngineOptions(options);
    if (!options.engineOptions && (options.ensureRuntimeLayout ?? true)) {
      const runtimeRoot = resolve(options.runtimeRoot ?? join(process.cwd(), "luaskills-runtime"));
      RuntimeRoots.ensureLayout(runtimeRoot);
    }
    const result = ffi.callJson<EngineHandleResult>("luaskills_ffi_engine_new_json", {
      options: engineOptions,
    });
    return new LuaSkillsClient(ffi, result.engine_id, LUA_SKILLS_CLIENT_CONSTRUCTOR_TOKEN);
  }

  /**
   * Query the JSON FFI version without creating a runtime engine.
   * 不创建运行时引擎并查询 JSON FFI 版本。
   */
  static version(options: LuaSkillsSdkOptions = {}): FfiVersionResult {
    return new LuaSkillsJsonFfi(options).callJsonNoInput<FfiVersionResult>("luaskills_ffi_version_json");
  }

  /**
   * Query the JSON FFI self-description without creating a runtime engine.
   * 不创建运行时引擎并查询 JSON FFI 自描述。
   */
  static describe(options: LuaSkillsSdkOptions = {}): FfiDescribeResult {
    return new LuaSkillsJsonFfi(options).callJsonNoInput<FfiDescribeResult>("luaskills_ffi_describe_json");
  }

  /**
   * Resolve and validate one host-shared managed Python or Node.js installation without creating an engine.
   * 不创建引擎，解析并校验一个由宿主共享的受管 Python 或 Node.js 安装。
   *
   * @param options Exact distribution root, runtime family, semantic version, platform, and FFI discovery inputs.
   * @returns Canonical installation paths and SHA-256 identities validated by LuaSkills.
   * @param options 精确发行根、运行时类型、语义化版本、平台与 FFI 发现参数。
   * @returns LuaSkills 校验后的规范安装路径与 SHA-256 身份。
   */
  static resolveManagedRuntimeInstall(options: ManagedRuntimeResolveOptions): ManagedRuntimeInstallDescriptor {
    if (options.runtime !== "python" && options.runtime !== "node") {
      throw new Error("runtime must be either 'python' or 'node'");
    }
    if (!isAbsolute(options.distributionRoot)) {
      throw new Error("distributionRoot must be an absolute path");
    }
    // DistributionRoot is normalized once before crossing the native boundary.
    // DistributionRoot 在跨越原生边界前统一规范化一次。
    const distributionRoot = resolve(options.distributionRoot);
    return new LuaSkillsJsonFfi(options).callJson<ManagedRuntimeInstallDescriptor>(
      "luaskills_ffi_managed_runtime_resolve_json",
      {
        distribution_root: distributionRoot,
        runtime: options.runtime,
        version: options.version,
        platform: options.platform,
      },
    );
  }

  /**
   * Destructively drain one bounded engine-level managed-session event batch.
   * 以破坏性方式排空一批有界的引擎级受管会话事件。
   */
  pollManagedSessionEvents(maxEvents: number, authority: Authority = Authority.System): JsonMap {
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
      throw new Error("max_events must be one positive safe integer");
    }
    return this.#callJson<JsonMap>("luaskills_ffi_managed_session_events_poll_json", {
      engine_id: this.#engineId,
      max_events: maxEvents,
      authority,
    });
  }

  /**
   * Wait for and destructively drain one bounded engine-level managed-session event batch.
   * 等待并以破坏性方式排空一批有界的引擎级受管会话事件。
   */
  waitManagedSessionEvents(maxEvents: number, timeoutMs: number, authority: Authority = Authority.System): JsonMap {
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
      throw new Error("max_events must be one positive safe integer");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error("timeout_ms must be one non-negative safe integer");
    }
    return this.#callJson<JsonMap>("luaskills_ffi_managed_session_events_wait_json", {
      engine_id: this.#engineId,
      max_events: maxEvents,
      timeout_ms: timeoutMs,
      authority,
    });
  }

  /**
   * Register, replace, or clear this engine's managed-session wake callback.
   * 注册、替换或清除当前引擎的受管会话唤醒回调。
   */
  setManagedSessionWakeCallback(callback: ManagedSessionWakeCallback | null): void {
    this.ffi.setManagedSessionWakeCallback(this.#engineId, callback);
  }

  /**
   * Return one system-management namespace bound to a host-injected authority.
   * 返回绑定到宿主注入权限的 system 管理命名空间。
   */
  system(authority: Authority | `${Authority}` = Authority.System): SystemSkillManagementClient {
    return new SystemSkillManagementClient(this, authority);
  }

  /**
   * Return one runtime-lease namespace over the public JSON FFI surface.
   * 返回一个基于公共 JSON FFI 接口的运行时租约命名空间。
   */
  runtimeLeases(): RuntimeLeaseClient {
    return new RuntimeLeaseClient(this);
  }

  /**
   * Query the JSON FFI version through the current low-level bridge.
   * 通过当前底层桥查询 JSON FFI 版本。
   */
  version(): FfiVersionResult {
    return this.ffi.callJsonNoInput<FfiVersionResult>("luaskills_ffi_version_json");
  }

  /**
   * Query the JSON FFI self-description through the current low-level bridge.
   * 通过当前底层桥查询 JSON FFI 自描述。
   */
  describe(): FfiDescribeResult {
    return this.ffi.callJsonNoInput<FfiDescribeResult>("luaskills_ffi_describe_json");
  }

  /**
   * Load skills from the formal ordered root chain.
   * 从正式有序 root 链加载 skills。
   */
  loadFromRoots(skillRoots: RuntimeSkillRoot[]): RuntimeAckResult {
    return this.#callJson<RuntimeAckResult>("luaskills_ffi_load_from_roots_json", {
      engine_id: this.#engineId,
      skill_roots: skillRoots,
    });
  }

  /**
   * Reload skills from the formal ordered root chain.
   * 从正式有序 root 链重载 skills。
   */
  reloadFromRoots(skillRoots: RuntimeSkillRoot[]): RuntimeAckResult {
    return this.#callJson<RuntimeAckResult>("luaskills_ffi_reload_from_roots_json", {
      engine_id: this.#engineId,
      skill_roots: skillRoots,
    });
  }

  /**
   * List runtime entries visible to the selected authority.
   * 列出指定权限可见的运行时入口。
   */
  listEntries(authority: Authority | `${Authority}` = Authority.DelegatedTool): RuntimeEntryDescriptor[] {
    return this.#callJson<RuntimeEntryDescriptor[]>("luaskills_ffi_list_entries_json", {
      engine_id: this.#engineId,
      authority,
    });
  }

  /**
   * List runtime help trees visible to the selected authority.
   * 列出指定权限可见的运行时帮助树。
   */
  listSkillHelp(authority: Authority | `${Authority}` = Authority.DelegatedTool): RuntimeSkillHelpDescriptor[] {
    return this.#callJson<RuntimeSkillHelpDescriptor[]>("luaskills_ffi_list_skill_help_json", {
      engine_id: this.#engineId,
      authority,
    });
  }

  /**
   * Render one help flow detail visible to the selected authority.
   * 渲染指定权限可见的单个帮助流程详情。
   */
  renderSkillHelpDetail(
    skillId: string,
    flowName = "main",
    options: RenderHelpOptions = {},
  ): RuntimeHelpDetail | null {
    return this.#callJson<RuntimeHelpDetail | null>("luaskills_ffi_render_skill_help_detail_json", {
      engine_id: this.#engineId,
      skill_id: skillId,
      flow_name: flowName,
      request_context: options.requestContext ?? null,
      authority: options.authority ?? Authority.DelegatedTool,
    });
  }

  /**
   * Query prompt argument completions visible to the selected authority.
   * 查询指定权限可见的 prompt 参数补全项。
   */
  promptArgumentCompletions(
    promptName: string,
    argumentName: string,
    authority: Authority | `${Authority}` = Authority.DelegatedTool,
  ): string[] | null {
    return this.#callJson<string[] | null>("luaskills_ffi_prompt_argument_completions_json", {
      engine_id: this.#engineId,
      prompt_name: promptName,
      argument_name: argumentName,
      authority,
    });
  }

  /**
   * Return whether one canonical tool name is visible as a skill entry for the selected authority.
   * 返回指定 canonical 工具名对所选权限是否可见为 skill 入口。
   */
  isSkill(toolName: string, authority: Authority | `${Authority}` = Authority.DelegatedTool): boolean {
    const result = this.#callJson<BooleanResult>("luaskills_ffi_is_skill_json", {
      engine_id: this.#engineId,
      tool_name: toolName,
      authority,
    });
    return result.value;
  }

  /**
   * Resolve the owning skill id for one visible canonical tool name.
   * 解析单个可见 canonical 工具名称所属的 skill id。
   */
  skillNameForTool(
    toolName: string,
    authority: Authority | `${Authority}` = Authority.DelegatedTool,
  ): string | null {
    const result = this.#callJson<OptionalSkillNameResult>("luaskills_ffi_skill_name_for_tool_json", {
      engine_id: this.#engineId,
      tool_name: toolName,
      authority,
    });
    return result.skill_id ?? null;
  }

  /**
   * Call one active skill entry by canonical tool name.
   * 按 canonical 工具名称调用单个已激活 skill 入口。
   */
  callSkill(
    toolName: string,
    args: JsonValue = {},
    invocationContext?: LuaInvocationContext,
  ): RuntimeInvocationResult {
    return this.#callJson<RuntimeInvocationResult>("luaskills_ffi_call_skill_json", {
      engine_id: this.#engineId,
      tool_name: toolName,
      args,
      invocation_context: normalizeInvocationContext(invocationContext),
    });
  }

  /**
   * Execute one inline Lua snippet against the active runtime.
   * 针对当前活动运行时执行单段内联 Lua。
   */
  runLua<T = JsonValue>(code: string, args: JsonValue = {}, invocationContext?: LuaInvocationContext): T {
    return this.#callJson<T>("luaskills_ffi_run_lua_json", {
      engine_id: this.#engineId,
      code,
      args,
      invocation_context: normalizeInvocationContext(invocationContext),
    });
  }

  /**
   * Release the native engine handle.
   * 释放原生引擎句柄。
   */
  close(): RuntimeAckResult | null {
    if (this.#closed) {
      return null;
    }
    if (this.#closing) {
      throw new Error(`LuaSkills engine ${this.#engineId} is closing`);
    }
    if (this.#activeCalls > 0) {
      throw new Error(`LuaSkills engine ${this.#engineId} has active calls and cannot close reentrantly`);
    }
    this.#closing = true;
    try {
      const result = this.ffi.callJson<RuntimeAckResult>("luaskills_ffi_engine_free_json", {
        engine_id: this.#engineId,
      });
      this.#closed = true;
      return result;
    } finally {
      this.#closing = false;
    }
  }

  /**
   * Call one engine-bound JSON FFI function while reserving the native handle.
   * 保留原生句柄期间调用一个绑定 engine 的 JSON FFI 函数。
   */
  #callJson<T>(functionName: string, payload: JsonValue | Record<string, unknown>): T {
    this.#beginCall();
    try {
      return this.ffi.callJson<T>(functionName, payload);
    } finally {
      this.#endCall();
    }
  }

  /**
   * Reserve the native engine handle for one synchronous FFI dispatch.
   * 为单次同步 FFI 分发保留原生引擎句柄。
   */
  #beginCall(): void {
    this.#assertOpen();
    if (this.#closing) {
      throw new Error(`LuaSkills engine ${this.#engineId} is closing`);
    }
    this.#activeCalls += 1;
  }

  /**
   * Release one active synchronous FFI dispatch reservation.
   * 释放一次活跃同步 FFI 分发占用。
   */
  #endCall(): void {
    this.#activeCalls -= 1;
  }

  /**
   * Assert that the client still owns a live native engine handle.
   * 断言当前客户端仍持有存活的原生引擎句柄。
   */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(`LuaSkills engine ${this.#engineId} is already closed`);
    }
  }
}

/**
 * Skill-config namespace backed by the unified runtime config store.
 * 基于统一运行时配置存储的 skill 配置命名空间。
 */
export class SkillConfigClient {
  /**
   * Create one skill-config namespace for a parent SDK client.
   * 为父级 SDK 客户端创建一个 skill 配置命名空间。
   */
  constructor(private readonly client: LuaSkillsClient) {}

  /**
   * List flattened config records, optionally limited to one skill id.
   * 列出扁平化配置记录，并可选限制到单个 skill id。
   */
  list(skillId?: string): SkillConfigEntry[] {
    return this.client.callJson<SkillConfigEntry[]>(
      "luaskills_ffi_skill_config_list_json",
      {
        engine_id: this.client.engineId,
        skill_id: skillId ?? null,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Discover declared package-configuration structure with optional values.
   * 发现已声明的技能包配置结构并可选返回值。
   *
   * The host must authorize `includeValues: true`; returned values are never masked.
   * 宿主必须授权 `includeValues: true`；返回值永不自动遮罩。
   *
   * @param options Optional package and explicit value-disclosure controls.
   * 可选的技能包与显式值披露控制项。
   * @returns One descriptor per matching effective package.
   * 每个匹配有效技能包的描述符。
   */
  describe(
    options: SkillPackageConfigDescribeOptions = {},
  ): Array<SkillPackageConfigDescriptor | InstalledSkillPackageConfigDescriptor> {
    return this.client.callJson<
      Array<SkillPackageConfigDescriptor | InstalledSkillPackageConfigDescriptor>
    >(
      "luaskills_ffi_skill_config_describe_json",
      {
        engine_id: this.client.engineId,
        skill_id: options.skillId ?? null,
        include_values: options.includeValues ?? false,
        mode: options.mode ?? "effective",
        root_name: options.rootName ?? null,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Validate completeness and persisted values for one effective skill package.
   * 校验单个有效技能包的完整性与持久化值。
   *
   * @param skillId Exact owning package identifier.
   * 精确的所属技能包标识。
   * @returns Structured completeness and validity status.
   * 结构化完整性与合法性状态。
   */
  validate(skillId: string): SkillPackageConfigStatus {
    return this.client.callJson<SkillPackageConfigStatus>(
      "luaskills_ffi_skill_config_validate_json",
      {
        engine_id: this.client.engineId,
        skill_id: skillId,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Get one config value by skill id and key.
   * 按 skill id 与 key 获取单个配置值。
   */
  get(skillId: string, key: string): SkillConfigGetResult {
    return this.client.callJson<SkillConfigGetResult>(
      "luaskills_ffi_skill_config_get_json",
      {
        engine_id: this.client.engineId,
        skill_id: skillId,
        key,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Atomically set one typed configuration value.
   * 原子设置单个类型化配置值。
   */
  set(
    skillId: string,
    key: string,
    value: SkillConfigValue,
    options?: SkillConfigMutationOptions,
  ): SkillConfigWriteResult;

  /**
   * Atomically set one nonempty typed configuration batch.
   * 原子设置一个非空类型化配置批次。
   */
  set(
    skillId: string,
    values: Record<string, SkillConfigValue>,
    options?: SkillConfigMutationOptions,
  ): SkillConfigWriteResult;

  /**
   * Normalize the overload into the unique batch JSON FFI request.
   * 把重载规范化为唯一的批量 JSON FFI 请求。
   */
  set(
    skillId: string,
    keyOrValues: string | Record<string, SkillConfigValue>,
    valueOrOptions?: SkillConfigValue | SkillConfigMutationOptions,
    maybeOptions?: SkillConfigMutationOptions,
  ): SkillConfigWriteResult {
    const values =
      typeof keyOrValues === "string"
        ? { [keyOrValues]: valueOrOptions as SkillConfigValue }
        : keyOrValues;
    const options =
      typeof keyOrValues === "string"
        ? maybeOptions
        : (valueOrOptions as SkillConfigMutationOptions | undefined);
    const entries = Object.entries(values);
    if (entries.length === 0) {
      throw new TypeError("configuration batch must not be empty");
    }
    for (const [key, value] of entries) {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("configuration keys must be nonempty strings");
      }
      assertSafeSkillConfigValue(value, key);
    }
    return this.client.callJson<SkillConfigWriteResult>(
      "luaskills_ffi_skill_config_set_json",
      {
        engine_id: this.client.engineId,
        skill_id: skillId,
        values,
        expected_revision: options?.expectedRevision ?? null,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Delete one config value by skill id and key.
   * 按 skill id 与 key 删除单个配置值。
   */
  delete(
    skillId: string,
    key: string,
    options: SkillConfigMutationOptions = {},
  ): SkillConfigDeleteResult {
    return this.client.callJson<SkillConfigDeleteResult>(
      "luaskills_ffi_skill_config_delete_json",
      {
        engine_id: this.client.engineId,
        skill_id: skillId,
        key,
        expected_revision: options.expectedRevision ?? null,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Explicitly refresh one selected store or both stores.
   * 显式刷新一个选定存储或两个存储。
   */
  refresh(storeScope?: SkillConfigStoreScope): SkillConfigStoreRefresh[] {
    return this.client.callJson<SkillConfigStoreRefresh[]>(
      "luaskills_ffi_skill_config_refresh_json",
      {
        engine_id: this.client.engineId,
        store_scope: storeScope ?? null,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Poll ordered configuration events after one optional cursor.
   * 在一个可选游标之后轮询有序配置事件。
   */
  pollEvents(afterSequence?: string, limit = 100): SkillConfigEventBatch {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SKILL_CONFIG_MAXIMUM_EVENT_POLL_LIMIT
    ) {
      throw new RangeError(
        `event poll limit must be a safe integer between 1 and ${SKILL_CONFIG_MAXIMUM_EVENT_POLL_LIMIT}`,
      );
    }
    return this.client.callJson<SkillConfigEventBatch>(
      "luaskills_ffi_skill_config_events_poll_json",
      {
        engine_id: this.client.engineId,
        after_sequence: afterSequence ?? null,
        limit,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Wait until at least one event is available or the timeout expires.
   * 等待至少一个事件可用或等待超时。
   */
  async waitForEvents(
    afterSequence?: string,
    options: { timeoutMs?: number; pollIntervalMs?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<SkillConfigEventBatch> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be one nonnegative safe integer");
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) {
      throw new RangeError("pollIntervalMs must be a safe integer between 1 and 60000");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      options.signal?.throwIfAborted();
      const batch = this.pollEvents(afterSequence, options.limit ?? 100);
      if (batch.events.length > 0 || Date.now() >= deadline) {
        return batch;
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), options.signal);
    }
  }

  /**
   * Start callback delivery for ordered events and return a stop function.
   * 启动有序事件回调投递并返回停止函数。
   */
  watchEvents(
    handler: (event: SkillConfigEvent) => void,
    options: {
      afterSequence?: string;
      pollIntervalMs?: number;
      limit?: number;
      onError?: (error: unknown) => void;
    } = {},
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      let cursor = options.afterSequence;
      try {
        while (!controller.signal.aborted) {
          const batch = await this.waitForEvents(cursor, {
            timeoutMs: options.pollIntervalMs ?? 250,
            pollIntervalMs: options.pollIntervalMs ?? 50,
            limit: options.limit,
            signal: controller.signal,
          });
          for (const event of batch.events) {
            handler(event);
          }
          cursor = batch.next_sequence;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          options.onError?.(error);
        }
      }
    })();
    return () => controller.abort();
  }
}

/**
 * Reject lossy or non-finite JavaScript numeric configuration inputs.
 * 拒绝有损或非有限的 JavaScript 数值配置输入。
 */
function assertSafeSkillConfigValue(value: SkillConfigValue, key: string): void {
  if (typeof value !== "number") {
    return;
  }
  if (!Number.isFinite(value)) {
    throw new TypeError(`configuration '${key}' requires one finite number`);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new RangeError(`configuration '${key}' integer exceeds the JavaScript safe range`);
  }
}

/**
 * Await one abortable timer without retaining a second cancellation path.
 * 等待单个可中止计时器且不保留第二条取消路径。
 */
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(signal.reason);
      return;
    }
    // Abort listener removed on both completion paths to keep long-lived watchers bounded.
    // 在两种完成路径中都移除中止监听器，确保长期监听保持有界。
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(signal?.reason);
    };
    // Poll timer that releases its paired abort listener after normal completion.
    // 正常完成后释放配对中止监听器的轮询计时器。
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Ordinary and system lifecycle namespace over the JSON FFI management entrypoints.
 * 覆盖 JSON FFI 管理入口的普通与 system 生命周期命名空间。
 */
export class SkillManagementClient {
  /**
   * Create one lifecycle namespace for a parent SDK client.
   * 为父级 SDK 客户端创建一个生命周期命名空间。
   */
  constructor(
    protected readonly client: LuaSkillsClient,
    protected readonly systemPlane: boolean,
    protected readonly authority: Authority | `${Authority}` = Authority.System,
  ) {}

  /**
   * Disable one skill through formal root-chain lifecycle state.
   * 通过正式 root 链生命周期状态停用单个 skill。
   */
  disable(skillRoots: RuntimeSkillRoot[], skillId: string, reason?: string | null): RuntimeAckResult {
    return this.client.callJson<RuntimeAckResult>(
      this.#functionName("disable_skill"),
      {
        engine_id: this.client.engineId,
        skill_roots: skillRoots,
        skill_id: skillId,
        reason: reason ?? null,
        ...this.#authorityPayload(),
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Enable one skill through formal root-chain lifecycle state.
   * 通过正式 root 链生命周期状态启用单个 skill。
   */
  enable(skillRoots: RuntimeSkillRoot[], skillId: string): RuntimeAckResult {
    return this.client.callJson<RuntimeAckResult>(
      this.#functionName("enable_skill"),
      {
        engine_id: this.client.engineId,
        skill_roots: skillRoots,
        skill_id: skillId,
        ...this.#authorityPayload(),
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Uninstall one skill and optionally clean its databases.
   * 卸载单个 skill，并可选清理其数据库。
   */
  uninstall(
    skillRoots: RuntimeSkillRoot[],
    skillId: string,
    options: SkillUninstallOptions = {},
    lifecycleOptions: SkillLifecycleOptions = {},
  ): SkillUninstallResult {
    return this.client.callJson<SkillUninstallResult>(
      this.#functionName("uninstall_skill"),
      {
        engine_id: this.client.engineId,
        skill_roots: skillRoots,
        skill_id: skillId,
        options,
        target_root: lifecycleOptions.targetRoot ?? null,
        ...this.#authorityPayload(lifecycleOptions.authority),
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Install one managed skill through the current lifecycle namespace.
   * 通过当前生命周期命名空间安装单个受管 skill。
   */
  install(
    skillRoots: RuntimeSkillRoot[],
    request: SkillInstallRequest,
    lifecycleOptions: SkillLifecycleOptions = {},
  ): SkillApplyResult {
    const validatedRequest = validateSkillInstallRequest("install_skill", request);
    return this.client.callJson<SkillApplyResult>(
      this.#functionName("install_skill"),
      {
        engine_id: this.client.engineId,
        skill_roots: skillRoots,
        request: validatedRequest,
        target_root: lifecycleOptions.targetRoot ?? null,
        ...this.#authorityPayload(lifecycleOptions.authority),
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Update one managed skill through the current lifecycle namespace.
   * 通过当前生命周期命名空间更新单个受管 skill。
   */
  update(
    skillRoots: RuntimeSkillRoot[],
    request: SkillInstallRequest,
    lifecycleOptions: SkillLifecycleOptions = {},
  ): SkillApplyResult {
    const validatedRequest = validateSkillInstallRequest("update_skill", request);
    return this.client.callJson<SkillApplyResult>(
      this.#functionName("update_skill"),
      {
        engine_id: this.client.engineId,
        skill_roots: skillRoots,
        request: validatedRequest,
        target_root: lifecycleOptions.targetRoot ?? null,
        ...this.#authorityPayload(lifecycleOptions.authority),
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Build the concrete JSON FFI function name for the current namespace.
   * 为当前命名空间构造具体 JSON FFI 函数名称。
   */
  #functionName(actionName: SkillLifecycleAction): string {
    const baseName = skillLifecycleActionValue(actionName);
    return `luaskills_ffi_${this.systemPlane ? "system_" : ""}${baseName}_json`;
  }

  /**
   * Build the authority payload required by system JSON FFI entrypoints.
   * 构造 system JSON FFI 入口要求的权限载荷。
   */
  #authorityPayload(overrideAuthority?: Authority | `${Authority}`): { authority?: Authority | `${Authority}` } {
    return this.systemPlane ? { authority: overrideAuthority ?? this.authority } : {};
  }
}

/**
 * System lifecycle namespace with host-injected authority.
 * 携带宿主注入权限的 system 生命周期命名空间。
 */
export class SystemSkillManagementClient extends SkillManagementClient {
  /**
   * Create one system lifecycle namespace for a parent SDK client.
   * 为父级 SDK 客户端创建一个 system 生命周期命名空间。
   */
  constructor(client: LuaSkillsClient, authority: Authority | `${Authority}`) {
    super(client, true, authority);
  }

  /**
   * Install one host-approved private URL-manifest skill through the system-private JSON FFI endpoint.
   * 通过 system 私有 JSON FFI 入口安装单个宿主已批准的私有 URL manifest 技能。
   */
  installPrivateUrlManifest(
    skillRoots: RuntimeSkillRoot[],
    skillId: string,
    manifestUrl: string,
    options: PrivateUrlManifestSkillOptions = {},
  ): SkillApplyResult {
    return this.#privateUrlManifest("install", skillRoots, skillId, manifestUrl, options);
  }

  /**
   * Update one host-approved private URL-manifest skill through the system-private JSON FFI endpoint.
   * 通过 system 私有 JSON FFI 入口更新单个宿主已批准的私有 URL manifest 技能。
   */
  updatePrivateUrlManifest(
    skillRoots: RuntimeSkillRoot[],
    skillId: string,
    manifestUrl: string,
    options: PrivateUrlManifestSkillOptions = {},
  ): SkillApplyResult {
    return this.#privateUrlManifest("update", skillRoots, skillId, manifestUrl, options);
  }

  /**
   * Call one authority-bound JSON FFI function and require an object-shaped result payload.
   * 调用一个绑定 authority 的 JSON FFI 函数并要求返回对象形状结果载荷。
   */
  #callObject(functionName: string, payload: JsonMap = {}): JsonMap {
    return requireJsonMap(
      this.client.callJson<JsonValue>(
        functionName,
        this.#withEngineAuthority(payload),
        LUA_SKILLS_CLIENT_CALL_TOKEN,
      ),
      `${functionName} object result`,
    );
  }

  /**
   * Call one authority-bound JSON FFI function and return any decoded JSON result shape.
   * 调用一个绑定 authority 的 JSON FFI 函数并返回任意已解码 JSON 结果形状。
   */
  #callValue<T = JsonValue>(functionName: string, payload: JsonMap = {}): T {
    return this.client.callJson<T>(
      functionName,
      this.#withEngineAuthority(payload),
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }

  /**
   * Return one authority-bound runtime-lease namespace.
   * 返回一个绑定 authority 的运行时租约命名空间。
   */
  runtimeLeases(): RuntimeLeaseClient {
    return new RuntimeLeaseClient(this.client, this.authority);
  }

  /**
   * List runtime entries visible to the bound authority.
   * 列出当前绑定 authority 可见的运行时入口。
   */
  listEntries(): RuntimeEntryDescriptor[] {
    const result = this.#callValue<RuntimeEntryDescriptor[]>("luaskills_ffi_list_entries_json");
    if (!Array.isArray(result)) {
      throw new Error("luaskills_ffi_list_entries_json did not return one array result");
    }
    return result;
  }

  /**
   * List skill help trees visible to the bound authority.
   * 列出当前绑定 authority 可见的技能帮助树。
   */
  listSkillHelp(): RuntimeSkillHelpDescriptor[] {
    const result = this.#callValue<RuntimeSkillHelpDescriptor[]>("luaskills_ffi_list_skill_help_json");
    if (!Array.isArray(result)) {
      throw new Error("luaskills_ffi_list_skill_help_json did not return one array result");
    }
    return result;
  }

  /**
   * Render one help flow detail visible to the bound authority.
   * 渲染当前绑定 authority 可见的单个帮助流程详情。
   */
  renderSkillHelpDetail(
    skillId: string,
    flowName = "main",
    requestContext?: JsonValue,
  ): RuntimeHelpDetail | null {
    const payload: JsonMap = {
      skill_id: skillId,
      flow_name: flowName,
    };
    if (requestContext !== undefined) {
      payload.request_context = requestContext;
    }
    const result = this.#callValue<RuntimeHelpDetail | null>("luaskills_ffi_render_skill_help_detail_json", payload);
    if (result === null) {
      return null;
    }
    return result;
  }

  /**
   * Query prompt argument completions visible to the bound authority.
   * 查询当前绑定 authority 可见的 prompt 参数补全项。
   */
  promptArgumentCompletions(promptName: string, argumentName: string): string[] | null {
    const result = this.#callValue<string[] | null>("luaskills_ffi_prompt_argument_completions_json", {
      prompt_name: promptName,
      argument_name: argumentName,
    });
    if (result === null) {
      return null;
    }
    if (!Array.isArray(result)) {
      throw new Error("luaskills_ffi_prompt_argument_completions_json did not return one array result");
    }
    return result.filter((value): value is string => typeof value === "string");
  }

  /**
   * Return whether one canonical tool name resolves to one visible skill entry.
   * 返回某个 canonical 工具名是否解析为一个可见技能入口。
   */
  isSkill(toolName: string): boolean {
    const result = this.#callObject("luaskills_ffi_is_skill_json", {
      tool_name: toolName,
    });
    if (typeof result.value !== "boolean") {
      throw new Error("luaskills_ffi_is_skill_json did not return one boolean value field");
    }
    return result.value;
  }

  /**
   * Resolve the visible owning skill id for one canonical tool name when available.
   * 在可见时解析某个 canonical 工具名所属的技能标识。
   */
  skillNameForTool(toolName: string): string | null {
    const result = this.#callObject("luaskills_ffi_skill_name_for_tool_json", {
      tool_name: toolName,
    });
    if (result.skill_id === null || result.skill_id === undefined) {
      return null;
    }
    if (typeof result.skill_id !== "string") {
      throw new Error("luaskills_ffi_skill_name_for_tool_json did not return a nullable string field");
    }
    return result.skill_id;
  }

  /**
   * Attach the bound engine id and authority to one outgoing payload.
   * 为单个发出的载荷附加已绑定的引擎标识与 authority。
   */
  #withEngineAuthority(payload: JsonMap): JsonMap {
    return {
      ...payload,
      engine_id: this.client.engineId,
      authority: this.authority,
    };
  }

  /**
   * Execute one host-private URL-manifest install or update operation.
   * 执行单个宿主私有 URL manifest 安装或更新操作。
   */
  #privateUrlManifest(
    actionName: "install" | "update",
    skillRoots: RuntimeSkillRoot[],
    skillId: string,
    manifestUrl: string,
    options: PrivateUrlManifestSkillOptions,
  ): SkillApplyResult {
    validatePrivateUrlManifestInput(skillId, manifestUrl);
    return this.client.callJson<SkillApplyResult>(
      `luaskills_ffi_system_private_${actionName}_skill_from_url_manifest_json`,
      {
        engine_id: this.client.engineId,
        skill_roots: skillRoots,
        skill_id: skillId,
        manifest_url: manifestUrl,
        target_root: options.targetRoot ?? null,
        authority: Authority.System,
      },
      LUA_SKILLS_CLIENT_CALL_TOKEN,
    );
  }
}

/**
 * Stable runtime-lease identity payload persisted by SDK hosts.
 * 由 SDK 宿主持久化的稳定运行时租约身份载荷。
 */
export interface RuntimeLeaseIdentity {
  /**
   * Stable runtime lease id returned by the native engine.
   * 原生引擎返回的稳定运行时租约标识。
   */
  lease_id: string;
  /**
   * Stable session id chosen by the host.
   * 由宿主选择的稳定会话标识。
   */
  sid: string;
  /**
   * Monotonic generation number for one SID lineage.
   * 单个 SID 谱系对应的单调递增代际编号。
   */
  generation: number;
}

/**
 * Stateful runtime-lease namespace over the JSON FFI runtime-lease entrypoints.
 * 覆盖 JSON FFI 运行时租约入口的有状态运行时租约命名空间。
 */
export class RuntimeLeaseClient {
  /**
   * Create one runtime-lease namespace for a parent SDK client.
   * 为父级 SDK 客户端创建一个运行时租约命名空间。
   */
  constructor(
    private readonly client: LuaSkillsClient,
    private readonly authority?: Authority | `${Authority}`,
  ) {}

  /**
   * Dispatch one raw runtime-lease JSON request without applying success checks.
   * 分发单个原始运行时租约 JSON 请求而不附加成功校验。
   */
  callRaw(action: RuntimeLeaseAction, payload: JsonMap): JsonMap {
    const requestPayload: JsonMap = {
      ...payload,
      engine_id: this.client.engineId,
    };
    if (this.authority !== undefined) {
      requestPayload.authority = this.authority;
    }
    return requireJsonMap(
      this.client.callJson<JsonValue>(
        this.#runtimeLeaseFunctionName(action),
        requestPayload,
        LUA_SKILLS_CLIENT_CALL_TOKEN,
      ),
      `runtime lease ${action} result`,
    );
  }

  /**
   * Create or replace one persistent runtime lease.
   * 创建或替换一个持久运行时租约。
   */
  create(
    sid: string,
    ttlSec?: number | null,
    replace = false,
    options: RuntimeLeaseCreateOptions = {},
  ): JsonMap {
    if (this.authority !== undefined && (options.lua_roots !== undefined || options.c_roots !== undefined)) {
      throw new Error("system runtime lease create does not accept lua_roots or c_roots");
    }
    if (this.authority !== undefined) {
      requireSystemRuntimePackage(options.system_package);
    }
    const createPayload: JsonMap = {
      sid,
      replace,
    };
    if (ttlSec !== undefined && ttlSec !== null) {
      createPayload.ttl_sec = ttlSec;
    }
    if (options.cwd !== undefined) {
      createPayload.cwd = options.cwd;
    }
    if (options.workspace_root !== undefined) {
      createPayload.workspace_root = options.workspace_root;
    }
    if (options.lua_roots !== undefined) {
      createPayload.lua_roots = options.lua_roots;
    }
    if (options.c_roots !== undefined) {
      createPayload.c_roots = options.c_roots;
    }
    if (options.mounts !== undefined) {
      createPayload.mounts = options.mounts;
    }
    if (this.authority !== undefined) {
      const systemPackage = options.system_package!;
      createPayload.system_package = {
        id: systemPackage.id,
        root: systemPackage.root,
        dependencies_file: systemPackage.dependencies_file,
      };
    }
    return requireRuntimeLeaseOK(
      this.callRaw("create", createPayload),
      "runtime lease create",
    );
  }

  /**
   * Create one runtime-lease handle object from one fresh create response.
   * 基于一份新的 create 响应创建一个运行时租约句柄对象。
   */
  createHandle(
    sid: string,
    ttlSec?: number | null,
    replace = false,
    options: RuntimeLeaseCreateOptions = {},
  ): RuntimeLeaseHandle {
    return RuntimeLeaseHandle.fromPayload(this, this.create(sid, ttlSec, replace, options));
  }

  /**
   * Rebuild one runtime-lease handle object from one persisted payload.
   * 基于一份已持久化载荷重建一个运行时租约句柄对象。
   */
  bindHandle(payload: JsonMap): RuntimeLeaseHandle {
    return RuntimeLeaseHandle.fromPayload(this, payload);
  }

  /**
   * Evaluate one Lua chunk inside one persistent runtime lease.
   * 在一个持久运行时租约中执行单个 Lua 代码块。
   */
  eval(
    leaseId: string,
    code: string,
    args: JsonMap = {},
    timeoutMs = 60_000,
    sid?: string,
    generation?: number,
    invocationContext?: LuaInvocationContext,
  ): JsonMap {
    const payload: JsonMap = {
      lease_id: leaseId,
      code,
      args,
      timeout_ms: timeoutMs,
      invocation_context: normalizeInvocationContext(invocationContext),
    };
    if (sid !== undefined) {
      payload.sid = sid;
    }
    if (generation !== undefined) {
      payload.generation = generation;
    }
    return requireRuntimeLeaseOK(this.callRaw("eval", payload), "runtime lease eval");
  }

  /**
   * Read one runtime lease status payload with optional identity guards.
   * 读取单个运行时租约状态载荷，并可附带可选身份护栏。
   */
  status(leaseId: string, sid?: string, generation?: number): JsonMap {
    const payload: JsonMap = {
      lease_id: leaseId,
    };
    if (sid !== undefined) {
      payload.sid = sid;
    }
    if (generation !== undefined) {
      payload.generation = generation;
    }
    return this.callRaw("status", payload);
  }

  /**
   * List active runtime leases and optionally filter by one SID.
   * 列出活跃运行时租约，并可按单个 SID 过滤。
   */
  list(sid?: string): JsonMap {
    const payload: JsonMap = {};
    if (sid !== undefined) {
      payload.sid = sid;
    }
    return this.callRaw("list", payload);
  }

  /**
   * List active runtime-lease handles rebuilt from the current lease listing payload.
   * 基于当前租约列表载荷重建活跃运行时租约句柄列表。
   */
  listHandles(sid?: string): RuntimeLeaseHandle[] {
    const payload = this.list(sid);
    const leases = payload.leases;
    if (!Array.isArray(leases)) {
      throw new Error("runtime lease list payload is missing the leases array");
    }
    return leases.map((lease) => this.bindHandle(requireJsonMap(lease, "runtime lease entry")));
  }

  /**
   * Return the first active runtime-lease handle for one SID when present.
   * 返回某个 SID 的第一个活跃运行时租约句柄（如果存在）。
   */
  findHandle(sid: string): RuntimeLeaseHandle | null {
    const handles = this.listHandles(sid);
    return handles.length > 0 ? handles[0] : null;
  }

  /**
   * Close one runtime lease and return its final status payload with optional identity guards.
   * 关闭单个运行时租约并返回其最终状态载荷，并可附带可选身份护栏。
   */
  close(leaseId: string, sid?: string, generation?: number): JsonMap {
    const payload: JsonMap = {
      lease_id: leaseId,
    };
    if (sid !== undefined) {
      payload.sid = sid;
    }
    if (generation !== undefined) {
      payload.generation = generation;
    }
    return this.callRaw("close", payload);
  }

  /**
   * Return whether this helper will dispatch runtime-lease requests to dedicated system entrypoints.
   * 返回当前辅助器是否会把运行时租约请求分发到专用 system 入口。
   */
  usesSystemRuntimeLeaseEndpoints(): boolean {
    return this.authority !== undefined;
  }

  /**
   * Resolve the concrete runtime-lease JSON FFI entrypoint name for one logical action.
   * 为单个逻辑动作解析具体的运行时租约 JSON FFI 入口名称。
   */
  #runtimeLeaseFunctionName(action: RuntimeLeaseAction): string {
    const actionValue = runtimeLeaseActionValue(action);
    const publicName = `luaskills_ffi_runtime_lease_${actionValue}_json`;
    if (this.authority === undefined) {
      return publicName;
    }
    return `luaskills_ffi_system_runtime_lease_${actionValue}_json`;
  }
}

/**
 * Stable host-side runtime-lease handle that carries lease identity guards automatically.
 * 自动携带租约身份护栏的稳定宿主侧运行时租约句柄。
 */
export class RuntimeLeaseHandle {
  /**
   * Bind one session client to one concrete lease identity triplet.
   * 将一个会话客户端绑定到一个具体的租约身份三元组。
   */
  constructor(
    private readonly sessions: RuntimeLeaseClient,
    readonly leaseId: string,
    readonly sid: string,
    readonly generation: number,
  ) {}

  /**
   * Construct one runtime-lease handle from one payload that contains identity fields.
   * 从包含身份字段的一份载荷中构造一个运行时租约句柄。
   */
  static fromPayload(sessions: RuntimeLeaseClient, payload: JsonMap): RuntimeLeaseHandle {
    return new RuntimeLeaseHandle(
      sessions,
      requireRuntimeLeaseStringField(payload, "lease_id"),
      requireRuntimeLeaseStringField(payload, "sid"),
      requireRuntimeLeaseNumberField(payload, "generation"),
    );
  }

  /**
   * Export the stable lease identity fields for persistence or raw FFI calls.
   * 导出稳定租约身份字段，供持久化或原始 FFI 调用使用。
   */
  identityPayload(): RuntimeLeaseIdentity {
    return {
      lease_id: this.leaseId,
      sid: this.sid,
      generation: this.generation,
    };
  }

  /**
   * Evaluate Lua code while automatically attaching the stored lease identity guards.
   * 执行 Lua 代码时自动附带已保存的租约身份护栏。
   */
  eval(
    code: string,
    args: JsonMap = {},
    timeoutMs = 60_000,
    invocationContext?: LuaInvocationContext,
  ): JsonMap {
    return this.sessions.eval(
      this.leaseId,
      code,
      args,
      timeoutMs,
      this.sid,
      this.generation,
      invocationContext,
    );
  }

  /**
   * Read the current lease status while automatically attaching the stored identity guards.
   * 读取当前租约状态时自动附带已保存的身份护栏。
   */
  status(): JsonMap {
    return this.sessions.status(this.leaseId, this.sid, this.generation);
  }

  /**
   * Close the current lease while automatically attaching the stored identity guards.
   * 关闭当前租约时自动附带已保存的身份护栏。
   */
  close(): JsonMap {
    return this.sessions.close(this.leaseId, this.sid, this.generation);
  }
}

/**
 * Require one runtime-lease payload to report success.
 * 要求单个运行时租约载荷报告成功。
 */
export function requireRuntimeLeaseOK(payload: JsonMap, action: string): JsonMap {
  if (payload.ok === true) {
    return payload;
  }
  throw new Error(
    `${action} failed: ${String(payload.error_code ?? "unknown")}: ${String(payload.message ?? "Unknown runtime lease error")}`,
  );
}

/**
 * Validate the exact trusted System Plugin package descriptor required by Rust.
 * 校验 Rust 强制要求的精确信任 System Plugin 包描述符。
 */
function requireSystemRuntimePackage(value: RuntimeLeaseCreateOptions["system_package"]): void {
  if (!value) {
    throw new Error("system runtime lease create requires system_package");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "dependencies_file,id,root") {
    throw new Error("system_package must contain exactly id, root, and dependencies_file");
  }
  for (const [fieldName, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new Error(`system_package ${fieldName} must be one non-empty string`);
    }
  }
}

/**
 * Read one required runtime-lease string field from one payload object.
 * 从一份载荷对象中读取一个必填的运行时租约字符串字段。
 */
export function requireRuntimeLeaseStringField(payload: JsonMap, fieldName: string): string {
  const value = payload[fieldName];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`runtime lease payload is missing required string field: ${fieldName}`);
}

/**
 * Read one required runtime-lease integer field from one payload object.
 * 从一份载荷对象中读取一个必填的运行时租约整数字段。
 */
export function requireRuntimeLeaseNumberField(payload: JsonMap, fieldName: string): number {
  const value = payload[fieldName];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`runtime lease payload is missing required integer field: ${fieldName}`);
}

/**
 * Require one arbitrary JSON value to be one plain object map.
 * 要求某个任意 JSON 值必须是普通对象映射。
 */
function requireJsonMap(value: JsonValue, context: string): JsonMap {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonMap;
  }
  throw new Error(`${context} must be one JSON object`);
}

/**
 * Return a protocol-shaped install or update request after rejecting malformed SDK input.
 * 拒绝格式错误的 SDK 输入后返回符合协议形状的安装或更新请求。
 */
function validateSkillInstallRequest(actionName: SkillLifecycleAction, request: SkillInstallRequest): SkillInstallRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("skill install request must be one JSON object");
  }
  const record = request as unknown as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !SKILL_INSTALL_REQUEST_KEYS.has(key)).sort();
  if (unknownKeys.length > 0) {
    throw new Error(`skill install request contains unsupported keys: ${unknownKeys.join(", ")}`);
  }
  const sourceType = requireSkillInstallSourceType(record.source_type);
  const skillId = optionalExactNonBlankString(record.skill_id, "skill_id");
  const source = optionalExactNonBlankString(record.source, "source");
  if (source !== null && URL_SKILL_INSTALL_SOURCE_TYPES.has(sourceType)) {
    validateHttpUrl(source, "source");
  }
  validateSkillInstallRequestPresence(actionName, sourceType, skillId, source);
  const validated: SkillInstallRequest = { source_type: sourceType };
  if (skillId !== null) {
    validated.skill_id = skillId;
  }
  if (source !== null) {
    validated.source = source;
  }
  return validated;
}

/**
 * Return one supported Rust SkillInstallSourceType value from an SDK request field.
 * 从 SDK 请求字段返回一个受支持的 Rust SkillInstallSourceType 值。
 */
function requireSkillInstallSourceType(value: unknown): SkillInstallSourceType {
  if (
    value === SkillInstallSourceType.Github ||
    value === SkillInstallSourceType.OfficialHub ||
    value === SkillInstallSourceType.Url ||
    value === SkillInstallSourceType.PrivateUrlManifest
  ) {
    return value;
  }
  throw new Error("skill install request source_type must be one of github, official_hub, url, private_url_manifest");
}

/**
 * Enforce the identifiers and source locators consumed by the native resolver for one lifecycle action.
 * 强制校验原生解析器在单个生命周期动作中会消费的标识与来源定位值。
 */
function validateSkillInstallRequestPresence(
  actionName: SkillLifecycleAction,
  sourceType: SkillInstallSourceType,
  skillId: string | null,
  source: string | null,
): void {
  if (actionName === "install_skill") {
    validateSkillInstallPresence(sourceType, skillId, source);
  } else if (actionName === "update_skill") {
    validateSkillUpdatePresence(sourceType, skillId, source);
  }
}

/**
 * Enforce required fields for one install request before FFI dispatch.
 * 在 FFI 分发前强制校验单个安装请求的必填字段。
 */
function validateSkillInstallPresence(
  sourceType: SkillInstallSourceType,
  skillId: string | null,
  source: string | null,
): void {
  if (sourceType === SkillInstallSourceType.Github && source === null) {
    throw new Error("github install request requires source");
  }
  if (sourceType === SkillInstallSourceType.OfficialHub && skillId === null && source === null) {
    throw new Error("official_hub install request requires skill_id or source");
  }
  if (sourceType === SkillInstallSourceType.Url && (skillId === null || source === null)) {
    throw new Error("url install request requires skill_id and source");
  }
  if (sourceType === SkillInstallSourceType.PrivateUrlManifest && (skillId === null || source === null)) {
    throw new Error("private_url_manifest install request requires skill_id and source");
  }
}

/**
 * Enforce required fields for one update request before FFI dispatch.
 * 在 FFI 分发前强制校验单个更新请求的必填字段。
 */
function validateSkillUpdatePresence(sourceType: SkillInstallSourceType, skillId: string | null, source: string | null): void {
  if (sourceType === SkillInstallSourceType.Github || sourceType === SkillInstallSourceType.OfficialHub) {
    if (skillId === null && source === null) {
      throw new Error(`${sourceType} update request requires skill_id or source`);
    }
  } else if (skillId === null) {
    throw new Error(`${sourceType} update request requires skill_id`);
  }
}

/**
 * Validate the dedicated private URL-manifest shortcut payload before FFI dispatch.
 * 在 FFI 分发前校验专用私有 URL manifest 快捷入口载荷。
 */
function validatePrivateUrlManifestInput(skillId: string, manifestUrl: string): void {
  requireExactNonBlankString(skillId, "skill_id");
  validateHttpUrl(manifestUrl, "manifest_url");
}

/**
 * Return an optional exact JSON string while rejecting empty or implicitly trimmed values.
 * 返回可选的精确 JSON 字符串，同时拒绝空值或需要隐式裁剪的值。
 */
function optionalExactNonBlankString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return requireExactNonBlankString(value, fieldName);
  }
  throw new Error(`skill install request ${fieldName} must be a string`);
}

/**
 * Return one non-empty string that does not require SDK-side whitespace normalization.
 * 返回一个不需要 SDK 侧空白规范化的非空字符串。
 */
function requireExactNonBlankString(value: string, fieldName: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`skill install request ${fieldName} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

/**
 * Reject non-HTTP, relative, or credential-bearing URLs before native download resolution.
 * 在原生下载解析前拒绝非 HTTP、相对路径或携带账号信息的 URL。
 */
function validateHttpUrl(value: string, fieldName: string): void {
  requireExactNonBlankString(value, fieldName);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`skill install request ${fieldName} must be an absolute HTTP or HTTPS URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname.length === 0) {
    throw new Error(`skill install request ${fieldName} must be an absolute HTTP or HTTPS URL`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`skill install request ${fieldName} must not include credentials`);
  }
}

/**
 * Return one validated skill lifecycle action string for JSON FFI function names.
 * 返回一个用于 JSON FFI 函数名的已验证 skill 生命周期动作字符串。
 */
function skillLifecycleActionValue(action: string): SkillLifecycleAction {
  if (SKILL_LIFECYCLE_ACTIONS.has(action as SkillLifecycleAction)) {
    return action as SkillLifecycleAction;
  }
  throw new Error(`unsupported skill lifecycle action: ${action}`);
}

/**
 * Return one validated runtime-lease action string for JSON FFI function names.
 * 返回一个用于 JSON FFI 函数名的已验证运行时租约动作字符串。
 */
function runtimeLeaseActionValue(action: string): RuntimeLeaseAction {
  if (RUNTIME_LEASE_ACTIONS.has(action as RuntimeLeaseAction)) {
    return action as RuntimeLeaseAction;
  }
  throw new Error(`unsupported runtime lease action: ${action}`);
}

/**
 * Build complete engine options from SDK defaults and caller overrides.
 * 基于 SDK 默认值和调用方覆盖构造完整引擎选项。
 */
export function createEngineOptions(options: LuaSkillsClientOptions = {}): LuaEngineOptions {
  if (options.engineOptions) {
    return options.engineOptions;
  }
  const runtimeRoot = resolve(options.runtimeRoot ?? join(process.cwd(), "luaskills-runtime"));
  return {
    pool_config: {
      ...defaultPoolConfig(),
      ...(options.poolConfig ?? {}),
    },
    host_options: mergeHostOptions(defaultHostOptions(runtimeRoot), options.hostOptions as HostOptionsOverride | undefined),
  };
}

/**
 * Return the SDK default VM pool configuration.
 * 返回 SDK 默认虚拟机池配置。
 */
export function defaultPoolConfig(): LuaVmPoolConfig {
  return {
    min_size: 1,
    max_size: 4,
    idle_ttl_secs: 60,
  };
}

/**
 * Return the stable managed Python/Node Worker and persistent-session defaults.
 * 返回稳定的受管 Python/Node Worker 与持久会话默认值。
 */
export function defaultManagedRuntimeConfig(): LuaRuntimeManagedRuntimeConfig {
  return {
    worker_pool_max_size_per_environment: 4,
    worker_idle_ttl_secs: 60,
    persistent_session_limit_per_engine: 256,
    persistent_session_default_buffer_limit_bytes_per_stream: 1024 * 1024,
    invoke_default_timeout_ms: null,
  };
}

/**
 * Return the SDK default host options for one runtime root.
 * 返回单个 runtime root 对应的 SDK 默认宿主选项。
 */
export function defaultHostOptions(runtimeRoot: string): LuaRuntimeHostOptions {
  const root = resolve(runtimeRoot);
  const baseOptions: LuaRuntimeHostOptions = {
    runtime_root: root,
    managed_runtime_distribution_root: null,
    managed_runtime_environment_root: null,
    managed_runtime_config: defaultManagedRuntimeConfig(),
    temp_dir: null,
    resources_dir: null,
    lua_packages_dir: null,
    host_provided_tool_root: null,
    host_provided_lua_root: null,
    host_provided_ffi_root: null,
    system_lua_lib_dir: null,
    download_cache_root: null,
    dependency_dir_name: "",
    state_dir_name: "",
    database_dir_name: "",
    skill_config_root: null,
    skill_config_lock_timeout_ms: null,
    skill_config_watch_debounce_ms: null,
    allow_network_download: true,
    github_base_url: null,
    github_api_base_url: null,
    sqlite_library_path: null,
    sqlite_provider_mode: "dynamic_library",
    sqlite_callback_mode: "standard",
    lancedb_library_path: null,
    lancedb_provider_mode: "dynamic_library",
    lancedb_callback_mode: "standard",
    space_controller: defaultSpaceControllerOptions(),
    cache_config: null,
    runlua_pool_config: null,
    reserved_entry_names: [],
    ignored_skill_ids: [],
    capabilities: {
      enable_skill_management_bridge: false,
      enable_managed_io_compat: true,
    },
  };
  const manifest = loadRuntimeInstallManifestSync(root);
  return manifest ? mergeHostOptions(baseOptions, hostOptionsFromRuntimeManifest(manifest) as HostOptionsOverride) : baseOptions;
}

/**
 * Return the SDK default space-controller options.
 * 返回 SDK 默认 space-controller 选项。
 */
export function defaultSpaceControllerOptions(): LuaRuntimeSpaceControllerOptions {
  return {
    endpoint: null,
    auto_spawn: false,
    executable_path: null,
    process_mode: "managed",
    minimum_uptime_secs: 300,
    idle_timeout_secs: 900,
    default_lease_ttl_secs: 120,
    connect_timeout_secs: 5,
    startup_timeout_secs: 15,
    startup_retry_interval_ms: 250,
    lease_renew_interval_secs: 30,
  };
}

/**
 * Merge caller-provided host overrides over one complete host option object.
 * 将调用方提供的宿主覆盖合并到一个完整宿主选项对象上。
 */
function mergeHostOptions(base: LuaRuntimeHostOptions, overrides?: HostOptionsOverride): LuaRuntimeHostOptions {
  if (!overrides) {
    return base;
  }
  return {
    ...base,
    ...overrides,
    space_controller: {
      ...base.space_controller,
      ...(overrides.space_controller ?? {}),
    },
    capabilities: {
      ...base.capabilities,
      ...(overrides.capabilities ?? {}),
    },
  };
}

/**
 * Normalize an optional invocation context so Rust always receives object payloads.
 * 归一化可选调用上下文，确保 Rust 始终收到对象载荷。
 */
function normalizeInvocationContext(context?: LuaInvocationContext): JsonMap | undefined {
  if (!context) {
    return undefined;
  }
  return {
    request_context: context.request_context ?? null,
    client_budget: context.client_budget ?? {},
    tool_config: context.tool_config ?? {},
  };
}
