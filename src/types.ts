/**
 * JSON value accepted by the LuaSkills JSON FFI surface.
 * LuaSkills JSON FFI 接口接受的 JSON 值。
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/**
 * Host-selected managed interpreter family.
 * 宿主选择的受管解释器类型。
 */
export type ManagedRuntimeKind = "python" | "node";

/**
 * Host-selected managed Python/Node Worker and persistent-session resource policy.
 * 宿主选择的受管 Python/Node Worker 与持久会话资源策略。
 */
export interface LuaRuntimeManagedRuntimeConfig {
  /**
   * Maximum live Workers for one exact environment and package-owner pool key.
   * 单个精确环境与包所有者池键允许的最大活动 Worker 数量。
   */
  worker_pool_max_size_per_environment: number;
  /**
   * Idle seconds after which an unused Worker may be retired.
   * 未使用 Worker 可被回收前的空闲秒数。
   */
  worker_idle_ttl_secs: number;
  /**
   * Maximum launching or live persistent sessions retained by one engine.
   * 单个引擎允许保留的启动中或活动持久会话最大数量。
   */
  persistent_session_limit_per_engine: number;
  /**
   * Default retained bytes for each persistent-session stdout or stderr stream.
   * 每个持久会话 stdout 或 stderr 流默认保留的字节数。
   */
  persistent_session_default_buffer_limit_bytes_per_stream: number;
  /**
   * Default positive invoke timeout in milliseconds; null means unlimited.
   * 默认正数 invoke 超时毫秒数；null 表示无限制。
   */
  invoke_default_timeout_ms: number | null;
}

/**
 * Validated host-visible managed runtime installation returned by LuaSkills.
 * LuaSkills 返回的已校验宿主可见受管运行时安装。
 */
export interface ManagedRuntimeInstallDescriptor {
  /**
   * Exact managed interpreter family.
   * 精确受管解释器类型。
   */
  runtime: ManagedRuntimeKind;
  /**
   * Exact semantic runtime version.
   * 精确语义化运行时版本。
   */
  version: string;
  /**
   * Normalized LuaSkills platform key.
   * 规范化 LuaSkills 平台键。
   */
  platform: string;
  /**
   * Canonical installation directory.
   * 规范安装目录。
   */
  install_root: string;
  /**
   * Canonical interpreter executable path.
   * 规范解释器可执行文件路径。
   */
  executable: string;
  /**
   * SHA-256 digest of runtime-manifest.json.
   * runtime-manifest.json 的 SHA-256 摘要。
   */
  manifest_hash: string;
  /**
   * SHA-256 digest of the interpreter executable.
   * 解释器可执行文件的 SHA-256 摘要。
   */
  executable_hash: string;
}

/**
 * Host-injected authority used by visibility queries and system management calls.
 * 可见性查询与 system 管理调用使用的宿主注入权限。
 */
export enum Authority {
  /**
   * Full host authority that may manage the ROOT layer.
   * 可管理 ROOT 层的完整宿主权限。
   */
  System = "system",
  /**
   * Delegated tool authority that follows ordinary user-facing boundaries.
   * 遵守普通用户可见边界的委托工具权限。
   */
  DelegatedTool = "delegated_tool",
}

/**
 * Supported managed skill source type.
 * 支持的受管 skill 来源类型。
 */
export enum SkillInstallSourceType {
  /**
   * GitHub Release backed managed skill.
   * 基于 GitHub Release 的受管 skill。
   */
  Github = "github",
  /**
   * Official LuaSkills Hub managed skill.
   * 官方 LuaSkills Hub 的受管理 skill。
   */
  OfficialHub = "official_hub",
  /**
   * Remote source descriptor URL.
   * 远程 source 描述文件 URL。
   */
  Url = "url",
  /**
   * Host-private URL manifest managed skill.
   * 宿主私有 URL manifest 受管理 skill。
   */
  PrivateUrlManifest = "private_url_manifest",
}

/**
 * Named runtime skill root used by the formal ROOT, PROJECT, USER chain.
 * 正式 ROOT、PROJECT、USER 链使用的命名运行时 skill 根。
 */
export interface RuntimeSkillRoot {
  /**
   * Formal root label.
   * 正式 root 标签。
   */
  name: "ROOT" | "PROJECT" | "USER" | string;
  /**
   * Physical skills directory represented by this root.
   * 当前 root 对应的物理 skills 目录。
   */
  skills_dir: string;
}

/**
 * Lua VM pool sizing options.
 * Lua 虚拟机池容量选项。
 */
export interface LuaVmPoolConfig {
  /**
   * Minimum warm VM count.
   * 最小保温虚拟机数量。
   */
  min_size: number;
  /**
   * Maximum VM count.
   * 最大虚拟机数量。
   */
  max_size: number;
  /**
   * Idle TTL in seconds.
   * 空闲回收秒数。
   */
  idle_ttl_secs: number;
}

/**
 * Runtime capability toggles exposed by the host.
 * 宿主暴露的运行时能力开关。
 */
export interface LuaRuntimeCapabilityOptions {
  /**
   * Whether vulcan.runtime.skills is available inside Lua.
   * Lua 内是否可使用 vulcan.runtime.skills。
   */
  enable_skill_management_bridge: boolean;
  /**
   * Whether the managed io compatibility layer is injected into Lua runtimes.
   * 是否向 Lua 运行时注入托管 io 兼容层。
   */
  enable_managed_io_compat?: boolean;
}

/**
 * Optional isolated run-lua pool configuration.
 * 可选隔离 run-lua 池配置。
 */
export interface LuaRuntimeRunLuaPoolConfig extends LuaVmPoolConfig {}

/**
 * Space controller options used by database providers.
 * 数据库 provider 使用的空间控制器选项。
 */
export interface LuaRuntimeSpaceControllerOptions {
  /**
   * Optional endpoint override.
   * 可选端点覆盖。
   */
  endpoint: string | null;
  /**
   * Whether the runtime may spawn a controller.
   * 运行时是否允许启动控制器。
   */
  auto_spawn: boolean;
  /**
   * Optional executable path.
   * 可选可执行文件路径。
   */
  executable_path: string | null;
  /**
   * Controller process mode.
   * 控制器进程模式。
   */
  process_mode: "service" | "managed";
  /**
   * Minimum controller uptime in seconds.
   * 控制器最小存活秒数。
   */
  minimum_uptime_secs: number;
  /**
   * Controller idle timeout in seconds.
   * 控制器空闲超时秒数。
   */
  idle_timeout_secs: number;
  /**
   * Default controller lease TTL in seconds.
   * 默认控制器租约 TTL 秒数。
   */
  default_lease_ttl_secs: number;
  /**
   * Connection timeout in seconds.
   * 连接超时秒数。
   */
  connect_timeout_secs: number;
  /**
   * Startup timeout in seconds.
   * 启动等待超时秒数。
   */
  startup_timeout_secs: number;
  /**
   * Startup retry interval in milliseconds.
   * 启动重试间隔毫秒数。
   */
  startup_retry_interval_ms: number;
  /**
   * Lease renew interval in seconds.
   * 租约续约间隔秒数。
   */
  lease_renew_interval_secs: number;
}

/**
 * Host options forwarded to LuaSkills engine creation.
 * 转发给 LuaSkills 引擎创建流程的宿主选项。
 */
export interface LuaRuntimeHostOptions {
  /**
   * Canonical runtime root used to derive the fixed LuaSkills layout.
   * 用于推导固定 LuaSkills 布局的规范 runtime root。
   */
  runtime_root: string | null;
  /**
   * Optional absolute root that directly contains managed python and node distributions.
   * 可选的绝对发行根，直接包含受管 python 与 node 目录。
   */
  managed_runtime_distribution_root: string | null;
  /**
   * Optional absolute writable root that owns managed Python and Node.js environments.
   * 可选的绝对可写根，用于保存受管 Python 与 Node.js 环境。
   */
  managed_runtime_environment_root: string | null;
  /**
   * Host-selected managed Worker and persistent-session resource policy.
   * 宿主选择的受管 Worker 与持久会话资源策略。
   */
  managed_runtime_config: LuaRuntimeManagedRuntimeConfig;
  /**
   * Temporary directory used by runtime helpers.
   * 运行时辅助功能使用的临时目录。
   */
  temp_dir: string | null;
  /**
   * Optional resources directory.
   * 可选资源目录。
   */
  resources_dir: string | null;
  /**
   * Optional Lua packages directory.
   * 可选 Lua 包目录。
   */
  lua_packages_dir: string | null;
  /**
   * Optional host-provided tool root.
   * 可选宿主工具根目录。
   */
  host_provided_tool_root: string | null;
  /**
   * Optional host-provided Lua root.
   * 可选宿主 Lua 根目录。
   */
  host_provided_lua_root: string | null;
  /**
   * Optional host-provided native FFI root.
   * 可选宿主原生 FFI 根目录。
   */
  host_provided_ffi_root: string | null;
  /**
   * Optional fixed host-owned system_lua_lib directory.
   * 可选固定宿主自有 system_lua_lib 目录。
   */
  system_lua_lib_dir: string | null;
  /**
   * Optional download cache root.
   * 可选下载缓存根目录。
   */
  download_cache_root: string | null;
  /**
   * Dependency sibling directory name.
   * 依赖兄弟目录名称。
   */
  dependency_dir_name: string;
  /**
   * State sibling directory name.
   * 状态兄弟目录名称。
   */
  state_dir_name: string;
  /**
   * Database sibling directory name.
   * 数据库兄弟目录名称。
   */
  database_dir_name: string;
  /**
   * Optional explicit user-level root for normal and system skill configuration stores.
   * 普通技能与系统技能配置存储使用的可选显式用户级根目录。
   */
  skill_config_root: string | null;
  /**
   * Optional cross-process configuration lock timeout in milliseconds.
   * 可选配置跨进程锁超时毫秒数。
   */
  skill_config_lock_timeout_ms: number | null;
  /**
   * Optional configuration watcher debounce interval in milliseconds.
   * 可选配置监听防抖毫秒数。
   */
  skill_config_watch_debounce_ms: number | null;
  /**
   * Whether network downloads are allowed.
   * 是否允许网络下载。
   */
  allow_network_download: boolean;
  /**
   * Optional GitHub web base URL.
   * 可选 GitHub Web 基址。
   */
  github_base_url: string | null;
  /**
   * Optional GitHub API base URL.
   * 可选 GitHub API 基址。
   */
  github_api_base_url: string | null;
  /**
   * Optional SQLite library path.
   * 可选 SQLite 动态库路径。
   */
  sqlite_library_path: string | null;
  /**
   * SQLite provider mode.
   * SQLite provider 模式。
   */
  sqlite_provider_mode: "dynamic_library" | "host_callback" | "space_controller";
  /**
   * SQLite callback mode.
   * SQLite 回调模式。
   */
  sqlite_callback_mode: "standard" | "json";
  /**
   * Optional LanceDB library path.
   * 可选 LanceDB 动态库路径。
   */
  lancedb_library_path: string | null;
  /**
   * LanceDB provider mode.
   * LanceDB provider 模式。
   */
  lancedb_provider_mode: "dynamic_library" | "host_callback" | "space_controller";
  /**
   * LanceDB callback mode.
   * LanceDB 回调模式。
   */
  lancedb_callback_mode: "standard" | "json";
  /**
   * Shared space controller options.
   * 共享空间控制器选项。
   */
  space_controller: LuaRuntimeSpaceControllerOptions;
  /**
   * Optional cache configuration object.
   * 可选缓存配置对象。
   */
  cache_config: JsonValue | null;
  /**
   * Optional isolated run-lua pool configuration.
   * 可选隔离 run-lua 池配置。
   */
  runlua_pool_config: LuaRuntimeRunLuaPoolConfig | null;
  /**
   * Host-reserved canonical entry names.
   * 宿主保留的 canonical 入口名称。
   */
  reserved_entry_names: string[];
  /**
   * Host-forced ignored skill ids.
   * 宿主强制忽略的 skill id。
   */
  ignored_skill_ids: string[];
  /**
   * Runtime capability toggles.
   * 运行时能力开关。
   */
  capabilities: LuaRuntimeCapabilityOptions;
}

/**
 * Engine creation options accepted by the JSON FFI.
 * JSON FFI 接受的引擎创建选项。
 */
export interface LuaEngineOptions {
  /**
   * Main VM pool config.
   * 主虚拟机池配置。
   */
  pool_config: LuaVmPoolConfig;
  /**
   * Host runtime options.
   * 宿主运行时选项。
   */
  host_options: LuaRuntimeHostOptions;
}

/**
 * Invocation context injected into call_skill and run_lua.
 * 注入 call_skill 与 run_lua 的调用上下文。
 */
export interface LuaInvocationContext {
  /**
   * Optional request context object.
   * 可选请求上下文对象。
   */
  request_context?: JsonValue;
  /**
   * Client budget JSON object.
   * 客户端预算 JSON 对象。
   */
  client_budget?: JsonValue;
  /**
   * Tool config JSON object.
   * 工具配置 JSON 对象。
   */
  tool_config?: JsonValue;
}

/**
 * Host-owned runtime-lease create options.
 * 宿主拥有的运行时租约创建选项。
 */
export interface RuntimeLeaseCreateOptions {
  /**
   * Optional host-controlled lease working directory.
   * 宿主控制的可选租约工作目录。
   */
  cwd?: string | null;
  /**
   * Optional workspace root recorded on the lease.
   * 记录到租约中的可选工作区根目录。
   */
  workspace_root?: string | null;
  /**
   * Optional extra Lua module roots prepended to package.path.
   * 前置追加到 package.path 的可选 Lua 模块根目录。
   */
  lua_roots?: string[];
  /**
   * Optional extra native module roots prepended to package.cpath.
   * 前置追加到 package.cpath 的可选原生模块根目录。
   */
  c_roots?: string[];
  /**
   * Optional structured host-owned mount metadata.
   * 可选结构化宿主挂载元数据。
   */
  mounts?: JsonValue;
  /**
   * Required trusted package descriptor for System runtime leases.
   * System 运行时租约必需的可信包描述符。
   */
  system_package?: SystemRuntimePackage;
}

/**
 * Trusted System Plugin package descriptor required by the System lease create endpoint.
 * System 租约创建端点强制要求的可信 System Plugin 包描述符。
 */
export interface SystemRuntimePackage {
  /** Stable package identifier. / 稳定包标识符。 */
  id: string;
  /** Absolute trusted package root. / 绝对可信包根目录。 */
  root: string;
  /** Package-relative dependency manifest path. / 包相对依赖清单路径。 */
  dependencies_file: string;
}

/**
 * Runtime entry descriptor returned by listEntries.
 * listEntries 返回的运行时入口描述。
 */
export interface RuntimeEntryDescriptor {
  /**
   * Canonical tool name.
   * canonical 工具名称。
   */
  canonical_name: string;
  /**
   * Owning skill id.
   * 所属 skill id。
   */
  skill_id: string;
  /**
   * Local entry name.
   * 本地入口名称。
   */
  local_name: string;
  /**
   * Owning root name.
   * 所属 root 名称。
   */
  root_name: string;
  /**
   * Physical skill directory.
   * 物理 skill 目录。
   */
  skill_dir: string;
  /**
   * Entry description.
   * 入口描述。
   */
  description: string;
  /**
   * Entry parameter descriptors.
   * 入口参数描述。
   */
  parameters: RuntimeEntryParameterDescriptor[];
  /**
   * Final AI-facing input schema resolved by the runtime.
   * 运行时解析后的最终面向 AI 输入 schema。
   */
  input_schema: JsonValue;
}

/**
 * Runtime entry parameter descriptor.
 * 运行时入口参数描述。
 */
export interface RuntimeEntryParameterDescriptor {
  /**
   * Parameter name.
   * 参数名称。
   */
  name: string;
  /**
   * Parameter type.
   * 参数类型。
   */
  param_type: string;
  /**
   * Parameter description.
   * 参数描述。
   */
  description: string;
  /**
   * Whether this parameter is required.
   * 当前参数是否必填。
   */
  required: boolean;
}

/**
 * Structured host-side result returned alongside tool text content.
 * 与工具文本结果一并返回的结构化宿主侧结果。
 */
export interface RuntimeHostResult {
  /**
   * Stable host-result kind identifier.
   * 稳定宿主结果类型标识。
   */
  kind: string;
  /**
   * Arbitrary JSON payload consumed by the host. Use RuntimeChangeSetPayload when kind is `change_set`.
   * 由宿主消费的任意 JSON 载荷。当 kind 为 `change_set` 时应使用 RuntimeChangeSetPayload。
   */
  payload: JsonValue;
}

/**
 * One canonical change-set line record.
 * 单条 canonical change_set 行记录。
 */
export interface RuntimeChangeSetLine {
  /**
   * One 1-based file line number.
   * 单个从 1 开始的文件行号。
   */
  line: number;
  /**
   * Exact line content stored for this record.
   * 当前记录保存的精确行内容。
   */
  content: string;
}

/**
 * One canonical change-set modify hunk.
 * 单个 canonical change_set modify hunk。
 */
export interface RuntimeChangeSetHunk {
  /**
   * Contiguous context immediately before the changed block.
   * 紧贴修改块之前的连续上下文。
   */
  before: string;
  /**
   * Deleted old-file lines recorded in ascending order.
   * 按升序记录的旧文件删除行。
   */
  delete: RuntimeChangeSetLine[];
  /**
   * Inserted new-file lines recorded in ascending order.
   * 按升序记录的新文件插入行。
   */
  insert: RuntimeChangeSetLine[];
  /**
   * Contiguous context immediately after the changed block.
   * 紧贴修改块之后的连续上下文。
   */
  after: string;
}

/**
 * One canonical change-set diagnostic record.
 * 单条 canonical change_set 诊断记录。
 */
export interface RuntimeChangeSetDiagnostic {
  /**
   * Structured diagnostic level.
   * 结构化诊断级别。
   */
  level: string;
  /**
   * Human-readable diagnostic message.
   * 人类可读诊断消息。
   */
  message: string;
}

/**
 * One canonical change-set file record.
 * 单个 canonical change_set 文件记录。
 */
export interface RuntimeChangeSetFile {
  /**
   * File lifecycle change kind.
   * 文件生命周期变更类型。
   */
  change: "create" | "modify" | "delete" | "rename";
  /**
   * Absolute file path used by create, modify, and delete records.
   * create、modify、delete 记录使用的绝对文件路径。
   */
  path?: string;
  /**
   * Absolute old path used by rename records.
   * rename 记录使用的旧绝对路径。
   */
  old_path?: string;
  /**
   * Absolute new path used by rename records.
   * rename 记录使用的新绝对路径。
   */
  new_path?: string;
  /**
   * Full-file content used by create and delete records.
   * create 与 delete 记录使用的整文件内容。
   */
  content?: string;
  /**
   * Explicit modify hunks used by modify records.
   * modify 记录使用的显式修改 hunk 列表。
   */
  hunks?: RuntimeChangeSetHunk[];
  /**
   * Optional human-readable patch mirror.
   * 可选的人类可读 patch 镜像。
   */
  patch?: string | null;
}

/**
 * Canonical `change_set` payload consumed by IDE-aware hosts.
 * IDE 感知宿主消费的 canonical `change_set` 载荷。
 */
export interface RuntimeChangeSetPayload {
  /**
   * Whether the result is one preview or applied change-set.
   * 当前结果是预览态还是已应用态。
   */
  mode: "preview" | "applied";
  /**
   * Optional high-level change summary.
   * 可选的高层变更摘要。
   */
  summary?: string | null;
  /**
   * Required file lifecycle records.
   * 必填的文件生命周期记录列表。
   */
  files: RuntimeChangeSetFile[];
  /**
   * Optional diagnostics returned alongside the change-set.
   * 随 change_set 一并返回的可选诊断列表。
   */
  diagnostics?: RuntimeChangeSetDiagnostic[];
}

/**
 * Runtime host-result envelope specialized for canonical `change_set`.
 * 专用于 canonical `change_set` 的运行时宿主结果包络。
 */
export interface RuntimeChangeSetHostResult {
  /**
   * Canonical host-result kind identifier.
   * canonical 宿主结果类型标识。
   */
  kind: "change_set";
  /**
   * Canonical change-set payload.
   * canonical change_set 载荷。
   */
  payload: RuntimeChangeSetPayload;
}

/**
 * Runtime invocation result returned by callSkill.
 * callSkill 返回的运行时调用结果。
 */
export interface RuntimeInvocationResult {
  /**
   * Textual content returned by the skill.
   * skill 返回的文本内容。
   */
  content: string;
  /**
   * Overflow mode encoded by the runtime.
   * 运行时编码的溢出模式。
   */
  overflow_mode: "Truncate" | "Page" | null;
  /**
   * Optional template hint.
   * 可选模板提示。
   */
  template_hint: string | null;
  /**
   * Content size in bytes.
   * 内容字节数。
   */
  content_bytes: number;
  /**
   * Content line count.
   * 内容行数。
   */
  content_lines: number;
  /**
   * Optional structured host-result payload.
   * 可选结构化宿主结果载荷。
   */
  host_result: RuntimeHostResult | null;
}

/**
 * Skill install or update request.
 * skill 安装或更新请求。
 */
export interface SkillInstallRequest {
  /**
   * Optional explicit skill id.
   * 可选显式 skill id。
   */
  skill_id?: string | null;
  /**
   * Optional source locator.
   * 可选来源定位。
   */
  source?: string | null;
  /**
   * Required managed source type.
   * 必填受管来源类型。
   */
  source_type: SkillInstallSourceType | `${SkillInstallSourceType}`;
}

/**
 * Skill uninstall options.
 * skill 卸载选项。
 */
export interface SkillUninstallOptions {
  /**
   * Whether SQLite data should be removed.
   * 是否删除 SQLite 数据。
   */
  remove_sqlite?: boolean;
  /**
   * Whether LanceDB data should be removed.
   * 是否删除 LanceDB 数据。
   */
  remove_lancedb?: boolean;
}

/**
 * FFI version result returned by the JSON bridge.
 * JSON 桥返回的 FFI 版本结果。
 */
export interface FfiVersionResult {
  /**
   * Crate-derived FFI version string.
   * 从 crate 派生的 FFI 版本字符串。
   */
  ffi_version: string;
  /**
   * Stable protocol family name.
   * 稳定协议族名称。
   */
  protocol: string;
}

/**
 * FFI self-description result returned by the JSON bridge.
 * JSON 桥返回的 FFI 自描述结果。
 */
export interface FfiDescribeResult {
  /**
   * Crate-derived FFI version string.
   * 从 crate 派生的 FFI 版本字符串。
   */
  ffi_version: string;
  /**
   * Exported JSON FFI function names.
   * 已导出的 JSON FFI 函数名称。
   */
  exported_functions: string[];
}

/**
 * Engine handle result returned by engine creation.
 * 引擎创建返回的句柄结果。
 */
export interface EngineHandleResult {
  /**
   * Stable numeric engine id stored inside the FFI registry.
   * 存放在 FFI 注册表中的稳定数值引擎标识。
   */
  engine_id: number;
}

/**
 * Boolean value wrapper returned by query helpers.
 * 查询辅助接口返回的布尔值包装。
 */
export interface BooleanResult {
  /**
   * Query boolean value.
   * 查询布尔值。
   */
  value: boolean;
}

/**
 * Optional skill-id wrapper returned by tool-name resolution.
 * 工具名称解析返回的可选 skill id 包装。
 */
export interface OptionalSkillNameResult {
  /**
   * Optional owning skill id.
   * 可选所属 skill id。
   */
  skill_id?: string | null;
}

/**
 * Generic lifecycle acknowledgement returned by load and reload operations.
 * load 与 reload 操作返回的通用生命周期确认。
 */
export interface RuntimeAckResult {
  /**
   * Whether the engine finished loading roots.
   * 引擎是否完成 root 加载。
   */
  loaded?: boolean;
  /**
   * Whether the engine finished reloading roots.
   * 引擎是否完成 root 重载。
   */
  reloaded?: boolean;
  /**
   * Whether the engine handle was released.
   * 引擎句柄是否已释放。
   */
  freed?: boolean;
  /**
   * Whether one skill was disabled.
   * 是否已有一个 skill 被停用。
   */
  disabled?: boolean;
  /**
   * Whether one skill was enabled.
   * 是否已有一个 skill 被启用。
   */
  enabled?: boolean;
}

/**
 * Single flattened skill-config record.
 * 单条扁平化 skill 配置记录。
 */
export interface SkillConfigEntry {
  /**
   * Persisted store containing this raw record.
   * 包含当前原始记录的持久化存储。
   */
  store_scope: SkillConfigStoreScope;
  /**
   * Owning skill id.
   * 所属 skill id。
   */
  skill_id: string;
  /**
   * Config key under the skill namespace.
   * skill 命名空间下的配置键。
   */
  key: string;
  /**
   * String config value.
   * 字符串配置值。
   */
  value: string;
}

/**
 * Skill-config lookup result.
 * skill 配置查找结果。
 */
export interface SkillConfigGetResult {
  /**
   * Whether the value exists.
   * 值是否存在。
   */
  found: boolean;
  /**
   * Queried skill id.
   * 被查询的 skill id。
   */
  skill_id: string;
  /**
   * Queried config key.
   * 被查询的配置键。
   */
  key: string;
  /**
   * Optional string config value.
   * 可选字符串配置值。
   */
  value?: string | null;
}

/**
 * Typed scalar accepted by package-configuration writes.
 * 技能包配置写入接受的类型化标量。
 */
export type SkillConfigValue = string | number | boolean;

/**
 * Result of one atomic package-configuration write.
 * 单次原子技能包配置写入结果。
 */
export interface SkillConfigWriteResult {
  /** Revision visible after the transaction.
   * 事务完成后可见的修订号。 */
  revision: string;
  /** Whether persisted data changed.
   * 持久化数据是否发生变化。 */
  changed: boolean;
  /** Canonical persisted values submitted by the transaction.
   * 当前事务提交的规范持久化值。 */
  values: Record<string, string>;
  /** Stable sorted keys changed by the transaction.
   * 当前事务变更的稳定排序键。 */
  changed_keys: string[];
}

/**
 * Result of one compare-and-swap deletion.
 * 单次比较并交换删除结果。
 */
export interface SkillConfigDeleteResult {
  /** Revision visible after deletion.
   * 删除完成后可见的修订号。 */
  revision: string;
  /** Whether one persisted value was removed.
   * 是否移除了一个持久化值。 */
  deleted: boolean;
  /** Exact targeted key.
   * 精确目标键。 */
  key: string;
}

/**
 * Optional compare-and-swap controls for configuration mutations.
 * 配置变更使用的可选比较并交换控制项。
 */
export interface SkillConfigMutationOptions {
  /** Expected current decimal revision.
   * 预期的当前十进制修订号。 */
  expectedRevision?: string;
}

/**
 * Declared package-configuration scalar type.
 * 已声明的技能包配置标量类型。
 */
export type SkillPackageConfigType = (typeof SKILL_PACKAGE_CONFIG_TYPES)[number];

/**
 * Optional host rendering format.
 * 可选的宿主渲染格式。
 */
export type SkillPackageConfigFormat = (typeof SKILL_PACKAGE_CONFIG_FORMATS)[number];

/**
 * Unambiguous runtime state of one declared item.
 * 单个已声明配置项的无歧义运行时状态。
 */
export type SkillPackageConfigItemState = (typeof SKILL_PACKAGE_CONFIG_STATES)[number];

/**
 * Type-specific declaration constraints.
 * 类型专属声明约束。
 */
export interface SkillPackageConfigConstraints {
  /** Optional inclusive numeric lower bound.
   * 可选的包含式数值下界。 */
  minimum?: number;
  /** Optional inclusive numeric upper bound.
   * 可选的包含式数值上界。 */
  maximum?: number;
  /** Optional minimum Unicode scalar count.
   * 可选的最小 Unicode 标量数量。 */
  min_length?: number;
  /** Optional maximum Unicode scalar count.
   * 可选的最大 Unicode 标量数量。 */
  max_length?: number;
}

/**
 * One declared enumeration option.
 * 单个已声明枚举选项。
 */
export interface SkillPackageConfigEnumOption {
  /** Stable persisted machine value.
   * 稳定的持久化机器值。 */
  value: string;
  /** Package-authored display label.
   * 技能包编写的显示名称。 */
  label: string;
  /** Package-authored explanation.
   * 技能包编写的说明。 */
  description: string;
}

/**
 * Manifest-level package configuration declaration.
 * 清单级技能包配置声明。
 */
export interface SkillPackageConfigDeclaration {
  /** Stable package configuration key.
   * 稳定的技能包配置键。 */
  key: string;
  /** Declared scalar type.
   * 已声明标量类型。 */
  type: SkillPackageConfigType;
  /** Whether completeness requires a value.
   * 完整性是否要求存在值。 */
  required: boolean;
  /** Host policy hint for sensitive values.
   * 敏感值使用的宿主策略提示。 */
  sensitive: boolean;
  /** Package-authored description.
   * 技能包编写的说明。 */
  description: string;
  /** Type-specific constraints.
   * 类型专属约束。 */
  constraints: SkillPackageConfigConstraints;
  /** Enumeration options, empty for other types.
   * 枚举选项，其他类型为空。 */
  options: SkillPackageConfigEnumOption[];
  /** Optional typed default.
   * 可选类型化默认值。 */
  default?: SkillConfigValue;
  /** Optional short title.
   * 可选短标题。 */
  title?: string;
  /** Optional host grouping hint.
   * 可选宿主分组提示。 */
  group?: string;
  /** Optional display order.
   * 可选显示顺序。 */
  order?: number;
  /** Whether the item is advanced.
   * 当前项是否为高级项。 */
  advanced: boolean;
  /** Optional input placeholder.
   * 可选输入占位文本。 */
  placeholder?: string;
  /** Optional typed example.
   * 可选类型化示例。 */
  example?: SkillConfigValue;
  /** Optional rendering format.
   * 可选渲染格式。 */
  format?: SkillPackageConfigFormat;
  /** Whether a host-managed restart may be required.
   * 是否可能需要宿主管理的重启。 */
  restart_required: boolean;
  /** Whether the declaration is deprecated.
   * 当前声明是否已弃用。 */
  deprecated: boolean;
  /** Optional deprecation guidance.
   * 可选弃用说明。 */
  deprecation_message?: string;
}

/**
 * Structured validation failure attached to one item.
 * 附加到单个配置项的结构化校验失败。
 */
export interface SkillPackageConfigValidationError {
  /** Stable machine-readable validation code.
   * 稳定机器可读校验代码。 */
  code: string;
  /** Human-readable value-safe explanation.
   * 人类可读且不泄漏值的说明。 */
  message: string;
}

/**
 * Runtime descriptor for one declared item.
 * 单个已声明配置项的运行时描述。
 */
export interface SkillPackageConfigItemDescriptor extends SkillPackageConfigDeclaration {
  /** Current unambiguous state.
   * 当前无歧义状态。 */
  state: SkillPackageConfigItemState;
  /** Whether the current item satisfies completeness.
   * 当前项是否满足完整性。 */
  satisfied: boolean;
  /** Optional validation failure.
   * 可选校验失败。 */
  validation_error?: SkillPackageConfigValidationError;
  /** Unmasked effective value included only by host opt-in.
   * 仅由宿主显式选择后包含的未遮罩有效值。 */
  value?: string;
}

/**
 * One key-owned configuration issue.
 * 单个配置键所属的问题。
 */
export interface SkillPackageConfigIssue {
  /** Stable owning key.
   * 稳定所属键。 */
  key: string;
  /** Stable machine-readable code.
   * 稳定机器可读代码。 */
  code: string;
  /** Human-readable explanation.
   * 人类可读说明。 */
  message: string;
}

/**
 * One optional-key business validation issue.
 * 单个可选键业务校验问题。
 */
export interface SkillPackageConfigBusinessIssue {
  /** Optional associated declared key.
   * 可选关联已声明键。 */
  key?: string;
  /** Stable package-namespaced code.
   * 稳定且带技能包命名空间的代码。 */
  code: string;
  /** Package-authored value-safe explanation.
   * 技能包编写且不泄漏敏感值的说明。 */
  message: string;
}

/**
 * Completeness and validity status of one effective package.
 * 单个有效技能包的完整性与合法性状态。
 */
export interface SkillPackageConfigStatus {
  /** Stable package identifier.
   * 稳定技能包标识符。 */
  skill_id: string;
  /** Whether the package configuration is complete.
   * 技能包配置是否完整。 */
  complete: boolean;
  /** Snapshot revision used by this status.
   * 当前状态使用的快照修订号。 */
  revision: string;
  /** Persisted store scope.
   * 持久化存储作用域。 */
  store_scope: SkillConfigStoreScope;
  /** Missing required declarations.
   * 缺失的必填声明。 */
  missing: SkillPackageConfigIssue[];
  /** Invalid persisted declared values.
   * 非法的持久化已声明值。 */
  invalid: SkillPackageConfigIssue[];
  /** Cross-field business issues.
   * 跨字段业务问题。 */
  business_issues: SkillPackageConfigBusinessIssue[];
  /** Persisted keys no longer declared.
   * 不再声明的持久化键。 */
  orphaned: string[];
  /** Number of orphaned keys.
   * 遗留键数量。 */
  orphaned_count: number;
}

/**
 * Effective package configuration descriptor.
 * 有效技能包配置描述。
 */
export interface SkillPackageConfigDescriptor {
  /** Stable package identifier.
   * 稳定技能包标识符。 */
  skill_id: string;
  /** Semantic package version.
   * 语义化技能包版本。 */
  skill_version: string;
  /** Whether configuration is complete.
   * 配置是否完整。 */
  complete: boolean;
  /** Snapshot revision.
   * 快照修订号。 */
  revision: string;
  /** Persisted store scope.
   * 持久化存储作用域。 */
  store_scope: SkillConfigStoreScope;
  /** Missing item count.
   * 缺失项数量。 */
  missing_count: number;
  /** Invalid item count.
   * 非法项数量。 */
  invalid_count: number;
  /** Business issue count.
   * 业务问题数量。 */
  business_issue_count: number;
  /** Orphaned key count.
   * 遗留键数量。 */
  orphaned_count: number;
  /** Orphaned keys.
   * 遗留键。 */
  orphaned: string[];
  /** Declared runtime items.
   * 已声明运行时配置项。 */
  items: SkillPackageConfigItemDescriptor[];
}

/**
 * Physical installed package declaration descriptor.
 * 物理已安装技能包声明描述。
 */
export interface InstalledSkillPackageConfigDescriptor {
  /** Directory-derived package identifier.
   * 目录派生的技能包标识符。 */
  skill_id: string;
  /** Owning root name.
   * 所属根名称。 */
  root_name: string;
  /** Absolute package path.
   * 技能包绝对路径。 */
  absolute_path: string;
  /** Whether the manifest enables the package.
   * 清单是否启用技能包。 */
  enabled: boolean;
  /** Whether an earlier root shadows this package.
   * 是否被更高优先级根遮蔽。 */
  shadowed: boolean;
  /** Whether this physical instance is effective.
   * 当前物理实例是否生效。 */
  effective: boolean;
  /** Whether the manifest is valid.
   * 清单是否合法。 */
  manifest_valid: boolean;
  /** Optional structured manifest issue.
   * 可选结构化清单问题。 */
  manifest_issue?: SkillConfigEventError;
  /** Optional semantic package version.
   * 可选语义化技能包版本。 */
  skill_version?: string;
  /** Valid package declarations.
   * 合法技能包声明。 */
  config?: SkillPackageConfigDeclaration[];
}

/**
 * Options for effective or installed declaration discovery.
 * 有效或已安装声明发现选项。
 */
export interface SkillPackageConfigDescribeOptions {
  /** Optional package identifier.
   * 可选技能包标识符。 */
  skillId?: string;
  /** Explicit raw-value disclosure switch for effective mode.
   * 有效模式的显式原始值披露开关。 */
  includeValues?: boolean;
  /** Declaration discovery mode.
   * 声明发现模式。 */
  mode?: SkillPackageConfigDescribeMode;
  /** Optional physical root filter for installed mode.
   * 已安装模式的可选物理根过滤器。 */
  rootName?: string;
}

/**
 * Structured watcher or reload failure.
 * 结构化监听或重载失败。
 */
export interface SkillConfigEventError {
  /** Stable machine-readable code.
   * 稳定机器可读代码。 */
  code: string;
  /** Human-readable value-safe message.
   * 人类可读且不泄漏值的消息。 */
  message: string;
}

/**
 * One ordered configuration change event.
 * 单个有序配置变更事件。
 */
export interface SkillConfigEvent {
  /** Engine-local decimal sequence.
   * 引擎内十进制序号。 */
  sequence: string;
  /** Stable event type.
   * 稳定事件类型。 */
  type: "skill_config_changed" | "skill_config_reload_failed";
  /** Persisted store scope.
   * 持久化存储作用域。 */
  store_scope: SkillConfigStoreScope;
  /** Optional changed package.
   * 可选变更技能包。 */
  skill_id?: string;
  /** Last known valid revision.
   * 最后一个已知合法修订号。 */
  revision: string;
  /** Stable sorted changed keys.
   * 稳定排序的变更键。 */
  changed_keys?: string[];
  /** Event source.
   * 事件来源。 */
  source: "local_write" | "external_reload";
  /** Changed keys recommending restart.
   * 建议重启的变更键。 */
  restart_required_keys?: string[];
  /** Optional package completeness.
   * 可选技能包完整性。 */
  complete?: boolean;
  /** Optional structured failure.
   * 可选结构化失败。 */
  error?: SkillConfigEventError;
}

/**
 * Ordered configuration event batch.
 * 有序配置事件批次。
 */
export interface SkillConfigEventBatch {
  /** Events after the requested cursor.
   * 请求游标之后的事件。 */
  events: SkillConfigEvent[];
  /** Highest observed sequence.
   * 观察到的最高序号。 */
  next_sequence: string;
}

/**
 * Explicit store refresh result.
 * 显式存储刷新结果。
 */
export interface SkillConfigStoreRefresh {
  /** Refreshed store scope.
   * 已刷新存储作用域。 */
  store_scope: SkillConfigStoreScope;
  /** Revision visible after refresh.
   * 刷新后可见的修订号。 */
  revision: string;
  /** Whether a newer snapshot was installed.
   * 是否安装了更新快照。 */
  changed: boolean;
}


/**
 * Runtime help node summary.
 * 运行时帮助节点摘要。
 */
export interface RuntimeHelpNodeDescriptor {
  /**
   * Stable flow name.
   * 稳定流程名称。
   */
  flow_name: string;
  /**
   * Short help description.
   * 简短帮助说明。
   */
  description: string;
  /**
   * Related canonical runtime entries.
   * 关联的 canonical 运行时入口。
   */
  related_entries: string[];
  /**
   * Whether this node is the main help node.
   * 当前节点是否为主帮助节点。
   */
  is_main: boolean;
}

/**
 * Runtime help tree summary for one skill.
 * 单个 skill 的运行时帮助树摘要。
 */
export interface RuntimeSkillHelpDescriptor {
  /**
   * Owning skill id.
   * 所属 skill id。
   */
  skill_id: string;
  /**
   * Human-readable skill name.
   * 人类可读 skill 名称。
   */
  skill_name: string;
  /**
   * Skill package version.
   * skill 包版本。
   */
  skill_version: string;
  /**
   * Owning root name.
   * 所属 root 名称。
   */
  root_name: string;
  /**
   * Physical skill directory.
   * 物理 skill 目录。
   */
  skill_dir: string;
  /**
   * Main help node.
   * 主帮助节点。
   */
  main: RuntimeHelpNodeDescriptor;
  /**
   * Additional flow help nodes.
   * 额外流程帮助节点。
   */
  flows: RuntimeHelpNodeDescriptor[];
}

/**
 * Rendered runtime help detail for one flow.
 * 单个流程渲染后的运行时帮助详情。
 */
export interface RuntimeHelpDetail extends RuntimeHelpNodeDescriptor {
  /**
   * Owning skill id.
   * 所属 skill id。
   */
  skill_id: string;
  /**
   * Human-readable skill name.
   * 人类可读 skill 名称。
   */
  skill_name: string;
  /**
   * Skill package version.
   * skill 包版本。
   */
  skill_version: string;
  /**
   * Owning root name.
   * 所属 root 名称。
   */
  root_name: string;
  /**
   * Physical skill directory.
   * 物理 skill 目录。
   */
  skill_dir: string;
  /**
   * Rendered content type.
   * 渲染后的内容类型。
   */
  content_type: string;
  /**
   * Rendered help content.
   * 渲染后的帮助正文。
   */
  content: string;
}

/**
 * Managed install or update result returned by lifecycle operations.
 * 生命周期操作返回的受管安装或更新结果。
 */
export interface SkillApplyResult {
  /**
   * Target skill id.
   * 目标 skill id。
   */
  skill_id: string;
  /**
   * High-level operation status.
   * 高层操作状态。
   */
  status: string;
  /**
   * Human-readable result message.
   * 人类可读结果消息。
   */
  message: string;
  /**
   * Optional involved version.
   * 可选涉及版本。
   */
  version?: string | null;
  /**
   * Optional managed source type.
   * 可选受管来源类型。
   */
  source_type?: SkillInstallSourceType | `${SkillInstallSourceType}` | null;
  /**
   * Optional stable source locator.
   * 可选稳定来源定位。
   */
  source_locator?: string | null;
}

/**
 * Skill uninstall result returned by lifecycle operations.
 * 生命周期操作返回的 skill 卸载结果。
 */
export interface SkillUninstallResult {
  /**
   * Target skill id.
   * 目标 skill id。
   */
  skill_id: string;
  /**
   * Whether the skill package directory was removed.
   * skill 包目录是否被删除。
   */
  skill_removed: boolean;
  /**
   * Whether the SQLite database directory was removed.
   * SQLite 数据库目录是否被删除。
   */
  sqlite_removed: boolean;
  /**
   * Whether the LanceDB database directory was removed.
   * LanceDB 数据库目录是否被删除。
   */
  lancedb_removed: boolean;
  /**
   * Whether the SQLite database directory was retained.
   * SQLite 数据库目录是否被保留。
   */
  sqlite_retained: boolean;
  /**
   * Whether the LanceDB database directory was retained.
   * LanceDB 数据库目录是否被保留。
   */
  lancedb_retained: boolean;
  /**
   * Human-readable result message.
   * 人类可读结果消息。
   */
  message: string;
}

/**
 * Options accepted by SDK lifecycle wrappers.
 * SDK 生命周期封装接受的选项。
 */
export interface SkillLifecycleOptions {
  /**
   * Optional explicit target root.
   * 可选显式目标 root。
   */
  targetRoot?: RuntimeSkillRoot;
  /**
   * Optional host-injected authority for system entrypoints.
   * system 入口使用的可选宿主注入权限。
   */
  authority?: Authority | `${Authority}`;
}

/**
 * Options accepted by host-private URL-manifest lifecycle wrappers.
 * 宿主私有 URL manifest 生命周期封装接受的选项。
 */
export interface PrivateUrlManifestSkillOptions {
  /**
   * Optional explicit target root.
   * 可选显式目标 root。
   */
  targetRoot?: RuntimeSkillRoot | null;
}

/**
 * Runtime-root helper creation options.
 * runtime-root 辅助创建选项。
 */
export interface RuntimeRootsOptions {
  /**
   * Shared runtime root directory.
   * 共享 runtime root 目录。
   */
  runtimeRoot: string;
  /**
   * Whether PROJECT should be included.
   * 是否包含 PROJECT。
   */
  includeProject?: boolean;
  /**
   * Whether USER should be included.
   * 是否包含 USER。
   */
  includeUser?: boolean;
  /**
   * Directory name used for ROOT skills.
   * ROOT skills 使用的目录名。
   */
  rootSkillsDirName?: string;
  /**
   * Directory name used for PROJECT skills.
   * PROJECT skills 使用的目录名。
   */
  projectSkillsDirName?: string;
  /**
   * Directory name used for USER skills.
   * USER skills 使用的目录名。
   */
  userSkillsDirName?: string;
}

/**
 * SDK client creation options.
 * SDK 客户端创建选项。
 */
export interface LuaSkillsClientOptions extends LuaSkillsSdkOptions {
  /**
   * Shared runtime root used to derive default host paths.
   * 用于派生默认宿主路径的共享 runtime root。
   */
  runtimeRoot?: string;
  /**
   * Fully explicit engine options; when present SDK defaults are skipped.
   * 完整显式引擎选项；存在时跳过 SDK 默认值。
   */
  engineOptions?: LuaEngineOptions;
  /**
   * Partial host option overrides merged over SDK defaults.
   * 覆盖 SDK 默认值的部分宿主选项。
   */
  hostOptions?: Partial<LuaRuntimeHostOptions>;
  /**
   * Partial VM pool overrides merged over SDK defaults.
   * 覆盖 SDK 默认值的部分虚拟机池选项。
   */
  poolConfig?: Partial<LuaVmPoolConfig>;
  /**
   * Whether the SDK should create the default runtime directories.
   * SDK 是否应创建默认运行时目录。
   */
  ensureRuntimeLayout?: boolean;
}

/**
 * Common SDK creation options.
 * 通用 SDK 创建选项。
 */
export interface LuaSkillsSdkOptions {
  /**
   * Explicit dynamic library path.
   * 显式动态库路径。
   */
  libraryPath?: string;
  /**
   * Optional runtime root used to resolve installed SDK assets.
   * 用于解析已安装 SDK 资产的可选 runtime root。
   */
  runtimeRoot?: string;
}

/**
 * Options for the read-only managed runtime installation resolver.
 * 只读受管运行时安装解析器选项。
 */
export interface ManagedRuntimeResolveOptions extends LuaSkillsSdkOptions {
  /**
   * Existing absolute root that directly contains python and node.
   * 直接包含 python 与 node 的现有绝对根。
   */
  distributionRoot: string;
  /**
   * Exact managed interpreter family.
   * 精确受管解释器类型。
   */
  runtime: ManagedRuntimeKind;
  /**
   * Exact semantic runtime version.
   * 精确语义化运行时版本。
   */
  version: string;
  /**
   * Exact normalized LuaSkills platform key.
   * 精确规范化 LuaSkills 平台键。
   */
  platform: string;
}
import {
  SKILL_PACKAGE_CONFIG_FORMATS,
  type SkillConfigStoreScope,
  type SkillPackageConfigDescribeMode,
  SKILL_PACKAGE_CONFIG_STATES,
  SKILL_PACKAGE_CONFIG_TYPES,
} from "./config-contract.js";
