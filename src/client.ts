import { join, resolve } from "node:path";
import { LuaSkillsJsonFfi } from "./ffi.js";
import { RuntimeRoots } from "./roots.js";
import { hostOptionsFromRuntimeManifest, loadRuntimeInstallManifestSync } from "./runtime-assets.js";
import {
  Authority,
  type BooleanResult,
  type EngineHandleResult,
  type FfiDescribeResult,
  type FfiVersionResult,
  type JsonValue,
  type LuaEngineOptions,
  type LuaInvocationContext,
  type RuntimeLeaseCreateOptions,
  type LuaRuntimeCapabilityOptions,
  type LuaRuntimeHostOptions,
  type LuaRuntimeSpaceControllerOptions,
  type LuaSkillsClientOptions,
  type LuaSkillsSdkOptions,
  type LuaVmPoolConfig,
  type OptionalSkillNameResult,
  type RuntimeAckResult,
  type RuntimeEntryDescriptor,
  type RuntimeHelpDetail,
  type RuntimeInvocationResult,
  type RuntimeSkillHelpDescriptor,
  type RuntimeSkillRoot,
  type SkillApplyResult,
  type SkillConfigEntry,
  type SkillConfigGetResult,
  type SkillConfigMutationResult,
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
 * Generic JSON object payload used by runtime-lease and system helpers.
 * 运行时租约与 system 辅助器使用的通用 JSON 对象载荷。
 */
export type JsonMap = Record<string, JsonValue | undefined>;

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
   * Stable numeric engine handle stored inside the native FFI registry.
   * 存放在原生 FFI 注册表中的稳定数值引擎句柄。
   */
  readonly engineId: number;

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
   * Whether the native engine handle has already been released.
   * 原生引擎句柄是否已经被释放。
   */
  private closed = false;

  /**
   * Create one SDK client around an already-created engine id.
   * 围绕已创建的 engine id 创建一个 SDK 客户端。
   */
  private constructor(ffi: LuaSkillsJsonFfi, engineId: number) {
    this.ffi = ffi;
    this.engineId = engineId;
    this.config = new SkillConfigClient(this);
    this.skills = new SkillManagementClient(this, false);
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
    return new LuaSkillsClient(ffi, result.engine_id);
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
    this.assertOpen();
    return this.ffi.callJson<RuntimeAckResult>("luaskills_ffi_load_from_roots_json", {
      engine_id: this.engineId,
      skill_roots: skillRoots,
    });
  }

  /**
   * Reload skills from the formal ordered root chain.
   * 从正式有序 root 链重载 skills。
   */
  reloadFromRoots(skillRoots: RuntimeSkillRoot[]): RuntimeAckResult {
    this.assertOpen();
    return this.ffi.callJson<RuntimeAckResult>("luaskills_ffi_reload_from_roots_json", {
      engine_id: this.engineId,
      skill_roots: skillRoots,
    });
  }

  /**
   * List runtime entries visible to the selected authority.
   * 列出指定权限可见的运行时入口。
   */
  listEntries(authority: Authority | `${Authority}` = Authority.DelegatedTool): RuntimeEntryDescriptor[] {
    this.assertOpen();
    return this.ffi.callJson<RuntimeEntryDescriptor[]>("luaskills_ffi_list_entries_json", {
      engine_id: this.engineId,
      authority,
    });
  }

  /**
   * List runtime help trees visible to the selected authority.
   * 列出指定权限可见的运行时帮助树。
   */
  listSkillHelp(authority: Authority | `${Authority}` = Authority.DelegatedTool): RuntimeSkillHelpDescriptor[] {
    this.assertOpen();
    return this.ffi.callJson<RuntimeSkillHelpDescriptor[]>("luaskills_ffi_list_skill_help_json", {
      engine_id: this.engineId,
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
    this.assertOpen();
    return this.ffi.callJson<RuntimeHelpDetail | null>("luaskills_ffi_render_skill_help_detail_json", {
      engine_id: this.engineId,
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
    this.assertOpen();
    return this.ffi.callJson<string[] | null>("luaskills_ffi_prompt_argument_completions_json", {
      engine_id: this.engineId,
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
    this.assertOpen();
    const result = this.ffi.callJson<BooleanResult>("luaskills_ffi_is_skill_json", {
      engine_id: this.engineId,
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
    this.assertOpen();
    const result = this.ffi.callJson<OptionalSkillNameResult>("luaskills_ffi_skill_name_for_tool_json", {
      engine_id: this.engineId,
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
    this.assertOpen();
    return this.ffi.callJson<RuntimeInvocationResult>("luaskills_ffi_call_skill_json", {
      engine_id: this.engineId,
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
    this.assertOpen();
    return this.ffi.callJson<T>("luaskills_ffi_run_lua_json", {
      engine_id: this.engineId,
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
    if (this.closed) {
      return null;
    }
    const result = this.ffi.callJson<RuntimeAckResult>("luaskills_ffi_engine_free_json", {
      engine_id: this.engineId,
    });
    this.closed = true;
    return result;
  }

  /**
   * Assert that the client still owns a live native engine handle.
   * 断言当前客户端仍持有存活的原生引擎句柄。
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`LuaSkills engine ${this.engineId} is already closed`);
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
    return this.client.ffi.callJson<SkillConfigEntry[]>("luaskills_ffi_skill_config_list_json", {
      engine_id: this.client.engineId,
      skill_id: skillId ?? null,
    });
  }

  /**
   * Get one config value by skill id and key.
   * 按 skill id 与 key 获取单个配置值。
   */
  get(skillId: string, key: string): SkillConfigGetResult {
    return this.client.ffi.callJson<SkillConfigGetResult>("luaskills_ffi_skill_config_get_json", {
      engine_id: this.client.engineId,
      skill_id: skillId,
      key,
    });
  }

  /**
   * Set one config value by skill id and key.
   * 按 skill id 与 key 设置单个配置值。
   */
  set(skillId: string, key: string, value: string): SkillConfigMutationResult {
    return this.client.ffi.callJson<SkillConfigMutationResult>("luaskills_ffi_skill_config_set_json", {
      engine_id: this.client.engineId,
      skill_id: skillId,
      key,
      value,
    });
  }

  /**
   * Delete one config value by skill id and key.
   * 按 skill id 与 key 删除单个配置值。
   */
  delete(skillId: string, key: string): SkillConfigMutationResult {
    return this.client.ffi.callJson<SkillConfigMutationResult>("luaskills_ffi_skill_config_delete_json", {
      engine_id: this.client.engineId,
      skill_id: skillId,
      key,
    });
  }
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
    return this.client.ffi.callJson<RuntimeAckResult>(this.functionName("disable_skill"), {
      engine_id: this.client.engineId,
      skill_roots: skillRoots,
      skill_id: skillId,
      reason: reason ?? null,
      ...this.authorityPayload(),
    });
  }

  /**
   * Enable one skill through formal root-chain lifecycle state.
   * 通过正式 root 链生命周期状态启用单个 skill。
   */
  enable(skillRoots: RuntimeSkillRoot[], skillId: string): RuntimeAckResult {
    return this.client.ffi.callJson<RuntimeAckResult>(this.functionName("enable_skill"), {
      engine_id: this.client.engineId,
      skill_roots: skillRoots,
      skill_id: skillId,
      ...this.authorityPayload(),
    });
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
    return this.client.ffi.callJson<SkillUninstallResult>(this.functionName("uninstall_skill"), {
      engine_id: this.client.engineId,
      skill_roots: skillRoots,
      skill_id: skillId,
      options,
      target_root: lifecycleOptions.targetRoot ?? null,
      ...this.authorityPayload(lifecycleOptions.authority),
    });
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
    return this.client.ffi.callJson<SkillApplyResult>(this.functionName("install_skill"), {
      engine_id: this.client.engineId,
      skill_roots: skillRoots,
      request,
      target_root: lifecycleOptions.targetRoot ?? null,
      ...this.authorityPayload(lifecycleOptions.authority),
    });
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
    return this.client.ffi.callJson<SkillApplyResult>(this.functionName("update_skill"), {
      engine_id: this.client.engineId,
      skill_roots: skillRoots,
      request,
      target_root: lifecycleOptions.targetRoot ?? null,
      ...this.authorityPayload(lifecycleOptions.authority),
    });
  }

  /**
   * Build the concrete JSON FFI function name for the current namespace.
   * 为当前命名空间构造具体 JSON FFI 函数名称。
   */
  protected functionName(baseName: string): string {
    return `luaskills_ffi_${this.systemPlane ? "system_" : ""}${baseName}_json`;
  }

  /**
   * Build the authority payload required by system JSON FFI entrypoints.
   * 构造 system JSON FFI 入口要求的权限载荷。
   */
  protected authorityPayload(overrideAuthority?: Authority | `${Authority}`): { authority?: Authority | `${Authority}` } {
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
   * Call one authority-bound JSON FFI function and require an object-shaped result payload.
   * 调用一个绑定 authority 的 JSON FFI 函数并要求返回对象形状结果载荷。
   */
  call(functionName: string, payload: JsonMap = {}): JsonMap {
    return requireJsonMap(
      this.client.ffi.callJson<JsonValue>(functionName, this.withEngineAuthority(payload)),
      `${functionName} object result`,
    );
  }

  /**
   * Call one authority-bound JSON FFI function and return any decoded JSON result shape.
   * 调用一个绑定 authority 的 JSON FFI 函数并返回任意已解码 JSON 结果形状。
   */
  callValue<T = JsonValue>(functionName: string, payload: JsonMap = {}): T {
    return this.client.ffi.callJson<T>(functionName, this.withEngineAuthority(payload));
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
    const result = this.callValue<RuntimeEntryDescriptor[]>("luaskills_ffi_list_entries_json");
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
    const result = this.callValue<RuntimeSkillHelpDescriptor[]>("luaskills_ffi_list_skill_help_json");
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
    const result = this.callValue<RuntimeHelpDetail | null>("luaskills_ffi_render_skill_help_detail_json", payload);
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
    const result = this.callValue<string[] | null>("luaskills_ffi_prompt_argument_completions_json", {
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
    const result = this.call("luaskills_ffi_is_skill_json", {
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
    const result = this.call("luaskills_ffi_skill_name_for_tool_json", {
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
  private withEngineAuthority(payload: JsonMap): JsonMap {
    return {
      ...payload,
      engine_id: this.client.engineId,
      authority: this.authority,
    };
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
  callRaw(action: string, payload: JsonMap): JsonMap {
    const requestPayload: JsonMap = {
      ...payload,
      engine_id: this.client.engineId,
    };
    if (this.authority !== undefined) {
      requestPayload.authority = this.authority;
    }
    return requireJsonMap(
      this.client.ffi.callJson<JsonValue>(this.runtimeLeaseFunctionName(action), requestPayload),
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
  private runtimeLeaseFunctionName(action: string): string {
    const publicName = `luaskills_ffi_runtime_lease_${action}_json`;
    if (this.authority === undefined) {
      return publicName;
    }
    return `luaskills_ffi_system_runtime_lease_${action}_json`;
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
 * Return the SDK default host options for one runtime root.
 * 返回单个 runtime root 对应的 SDK 默认宿主选项。
 */
export function defaultHostOptions(runtimeRoot: string): LuaRuntimeHostOptions {
  const root = resolve(runtimeRoot);
  const baseOptions: LuaRuntimeHostOptions = {
    runtime_root: root,
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
    skill_config_file_path: null,
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
