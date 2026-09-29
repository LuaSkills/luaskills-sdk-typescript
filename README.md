# @luaskills/sdk

English documentation is the default package documentation. For Chinese, see [README_cn.md](README_cn.md).

Main LuaSkills repository: [LuaSkills/luaskills](https://github.com/LuaSkills/luaskills)

TypeScript / Node.js SDK for integrating the LuaSkills runtime through the public JSON FFI surface.

`0.5.7` is the current release line. It retains the strict package-level skill configuration contract and defaults runtime assets to LuaSkills core `v0.5.7`, vldb-controller `v0.2.3`, and vldb-sqlite `v0.1.6`.

The SDK wraps native library loading, JSON FFI buffers, engine lifecycle, formal skill roots, authority-aware management calls, skill config, provider callbacks, host-tool callbacks, and runtime asset installation. Hosts should not need to hand-write low-level FFI buffers or JSON envelopes for normal integration.

## Embedded runtime contract (development)

Optional `caller.request_id` freezes the host's `context.request_context.request_id` at core admission. It is distinct from the core operation ID and the queued callback request ID; Lua-visible context or arguments cannot replace it. Same-operation single-call finalization preserves it, while session opening and independent session/reusable finalization omit it. The host must register and authorize any associated scope explicitly: correlation alone grants no permission, and omitted historical values must not be filled from a newer request.

Explicit persistence is available through `initialize(engineOptions, runtimeConfig, persistence = null)`. Omitting the storage argument keeps memory-only behavior. Supply the generated configuration with a host-owned absolute `path`, complete `journal` retention budgets and `worker` receipt budgets; the SDK adds no storage defaults or fallback. Initialization acknowledges an attempt; inspect native status for the outcome. Status includes actual optional storage ownership, and coordinated shutdown waits for the core, writer and retained receipts.

Runtime methods `storageStatus / recoverStorage` expose worker ownership and explicit same-file recovery. `historyGet / historyNext / historyForget` read and remove original history by **core runtime namespace**, distinct from the FFI slot ID. History and recovery use the work lane; storage status and operation methods `persistenceFailure / retryCheckpoint` use the control lane. Recovery never retries a checkpoint automatically or replays business work. A retry without a failed checkpoint reports busy; false means an existing retry is already pending. History enumeration uses original-key cursors, not a multi-call snapshot.

`recoverStorageWorker` independently reconstructs one supervised failed writer only after its actual thread exits and all queued/active attempts have been supervised. It returns false for a healthy running writer and rejects explicit writer closure, unproven exits or poisoned ownership. Original receipts, byte/count reservations and the same storage owner remain intact. It never replays old writes or business work; database recovery and original checkpoint retry remain separate explicit actions. Runtime closure can still recover a writer while the original core is draining, before permanent writer closure.

Historical records never become active handles. Before administrative reconciliation or removal, forget any retained live operation. `historyReconcile` attaches one final, bounded host attestation while preserving the original snapshot, caller and effect identities. The trusted host must authorize the resolver, prove all original execution and external owners stopped, and verify the whole operation and every recorded effect; a supplied resolver string is not authentication. Unknown ordinary Lua effects cannot be inferred from successful return. Use the original namespace, operation ID and predecessor revision; retry the identical resolution to acknowledge the same successor after storage recovery. The returned revision supports explicit removal. This API does not query external systems, replay callbacks, manufacture an interrupted result or recover a failed writer/execution stack. Development disk format 4 rejects unpublished formats 1–3 without rewriting them. Matching development core and SDK contracts are required.

`embeddedContract` exports generated request/response types, per-command response maps and the exact contract digest. The checked-in `contracts/embedded/v1/` directory is copied from the developing core, with independent input and output types reflecting Rust deserialization and serialization rules. `EmbeddedNativeStatus` is also exported at package level. This is a development contract; the existing published 0.5.7 native libraries do not provide the new embedded runtime API. `EmbeddedTransport` binds one read-only discovery export and five transport exports to an explicitly selected matching library. Fixed command workers, the automatic callback pump, typed handles and coordinated lifecycle scopes are implemented; complete durable recovery remains a later milestone.

Before native allocation, `EmbeddedTransport` copies the bounded library-owned `luaskills_ffi_embedded_describe_v1` bytes and validates exact core, protocol, ABI and description versions, the packaged contract digest, required commands/capabilities, supported backend, process OS and pointer width. Missing discovery or incompatible metadata raises `EmbeddedCompatibilityError`; native status failures retain `EmbeddedTransportError`. Borrowed discovery bytes must never be passed to result-free functions. `coreDescription` returns an independent typed snapshot, including after release. Build input hashes describe selected inputs; they do not authenticate a binary or attest to a complete hermetic build.

Workers validate the same metadata before becoming ready and compare an opaque process-local binding token derived from the stable, library-local descriptor address and exact descriptor bytes. The matching core guarantees that address remains stable while its library is loaded. Thus an identical copied library, which owns a separate native registry, cannot borrow another loaded instance's transport ID. This token is only an equality check within the process, not an authentication token or release identity. The transport retains its library until workers actually exit and native ownership is released. Its `libraryPath` is read-only; hosts must use immutable versioned asset paths and finish old-instance cleanup before replacing or unloading assets. Startup compatibility errors cross worker messages as `EmbeddedCompatibilityError`; claims remain until actual worker exit.

Wide integer fields use `EmbeddedInteger` (`number | bigint`); callers must use `bigint` outside JavaScript's safe integer range. `encodeEmbeddedJson(value, maxBytes)` and `decodeEmbeddedJson(bytes)` retain all signed/unsigned 64-bit integer bits without quoting numbers. An unsafe plain integer number is rejected: use `bigint` for exact integer intent, or `new EmbeddedFloat(value)` for explicit finite floating-point intent, including values such as `1e100`. Integral floating-point tokens decode to `EmbeddedFloat` (read `.value`); fractional tokens decode to ordinary numbers. Negative zero is preserved. Do not use ordinary `JSON.stringify` on these values. Runtime authorization and lifecycle rules remain core responsibilities. Explicit JSON null and an omitted optional property have distinct types. Use `strict` and `exactOptionalPropertyTypes` for consumer checks.

`EmbeddedTransport` requires all five positive budgets (`max_runtimes`, `max_result_buffers`, `max_result_bytes`, `max_response_bytes`, `max_request_bytes`), retains an immutable bigint copy, and follows the existing SDK's explicit library selection. `request(command)` is synchronous: initialization or native waits must not run on an event loop responsible for callbacks. `close()` requests admission closure; callers must finish actual callback acknowledgements, drain and remove each runtime, then call `free()`. Core rejection leaves the owner available for cleanup. No finalizer or garbage collection substitutes for native release: `EmbeddedTransport.live` exposes a frozen snapshot of strongly retained owners. An unexpected constructor binding exception with unconfirmed publication keeps the library retained and requires infrastructure recovery; it is not proof that unload is safe.

Result bytes are copied before their exact native descriptor is released. `EmbeddedResultReleaseError` retains an independent `responseBytes` copy and `deliveredResult()` can recover the original success or business error without repeating a command. A thrown release binding exception has `status === null` and preserves `cause`; this is distinct from an actual numeric C status. `releaseResults()` retries only retained buffer releases and refuses active readers; it does not replay business work. Failed release prevents transport `free()`. Missing or invalid copied evidence is explicitly rejected. Encoding rejects getters, proxies, serialization hooks, sparse/decorated arrays, undefined, non-finite numbers and invalid Unicode instead of silently changing them.

`EmbeddedCommandDriver(transport, { workThreads, maxWorkCommands, maxControlCommands })` borrows the transport and starts fixed business workers plus one independent control worker. Await `ready()`, obtain a synchronous receipt with `submit(command, "work" | "control")`, then observe `receipt.result({ signal })`. Admission freezes bounded JSON bytes; worker messages contain exact identities and independently owned bytes, never application class instances or whole Buffer pools. Configuration requires exactly three positive safe integer data fields. Native result budgets must fit all workers returning their maximum response simultaneously. Additional raw transport concurrency requires additional headroom; the core still rejects requests exceeding its limits.

Each lane bounds all queued, running and completed-but-unforgotten receipts. `commands` and `EmbeddedCommandDriver.live` expose frozen owner snapshots. `receipt.forget()` returns only a completed local receipt quota, without deleting a core operation. Aborting observation of readiness, results or closure does not terminate actual execution; original receipts and response bytes remain available. The driver rejects blocking `operation_wait`; poll `operation_status` instead. Reserve the control lane for queries, cancellation and host acknowledgements; do not submit long initialization work to that lane.

Workers copy responses before freeing native results. Failed release quarantines that worker and retains the exact descriptor and original delivery bytes; `driver.releaseResults()` explicitly retries only result release, never business work. Driver `close()` rejects new commands, completes accepted work, and releases its transport claim only after every worker confirms stopping and actually exits. It does not close borrowed native runtimes or the transport. Finish all host-handler acknowledgements before closing the command driver, then perform native lifecycle cleanup. Closing before startup rejects readiness observation while still joining real workers. Unexpected exits without drainage proof or message-send failures retain the transport claim and report an infrastructure failure requiring process-level recovery; workers are never forcibly terminated, automatically replaced or used to replay business work.

`EmbeddedCallbackPump(transport, runtimeId, { maxConcurrentHandlers, maxPendingCommands, pollIntervalMs })` owns one additional independent control worker for an initialized runtime. Each transport/runtime pair permits one pump, and aggregate response-frame budgets include the ordinary driver and every pump. Await `pump.ready()`, then register explicit queued declarations with `pump.register([new HostCapability(descriptor, handler)])`. Admission copies and freezes descriptors under the transport byte budget. Dispatch uses exact registration IDs, never replaceable names. A replacement registration requires a new pool snapshot; existing pools cannot redirect to a new handler. Do not register other queued handlers through raw commands for a pump-owned runtime.

Handlers receive structured arguments and `HostCallbackContext`, and may return a value or a Promise. Trusted `caller` metadata is immutable and separate from application arguments. `signal`, `cancellation` and `throwIfCancelled()` only observe core cancellation; `remainingMs` is an advisory bigint duration. `reportEffects()` reports actual transaction evidence: mutating handlers default to unknown and read-only handlers to not_applicable. Success or cancellation never implies commit. Actual handler return seals effects, freezes acknowledgement bytes and releases SDK aliases to mutable results. Ordinary exceptions use a generic diagnostic without secrets; explicit SDK errors retain valid protocol codes. Invalid or oversized output becomes a bounded failure retaining its actual effects. Lua capability calls return an envelope containing ok, value or error, and effects; a callback failure does not automatically fail the enclosing Lua operation.

JavaScript handlers run on the pump-owning Node event loop. Synchronous handlers must remain short and must not block or perform long CPU work; asynchronous I/O should return a Promise covering all handler work. Detached background tasks are outside pump ownership. maxConcurrentHandlers includes completed handlers awaiting acknowledgement. maxPendingCommands bounds unfinished or uncertain registration batches; unregister observers share an existing registration drain, and close/recovery bypass registration admission quotas. pump.status and EmbeddedCallbackPump.live retain discoverable identities. Aborting register, unregister or close observation never abandons ownership. A handler cannot await its own pump.

`pump.unregister(id)` waits for actual native and JavaScript drainage before forgetting registration metadata. `pump.close()` stops admission and intake, unregisters owned handlers, completes handlers and acknowledgements, then joins its worker. Unregister does not synthesize cancellation for executing handlers; request core operation cancellation or runtime closure when needed, and still wait for real cooperative return. The pump does not close its borrowed runtime or transport. Keep it running through core finalization, then close it before freeing the runtime slot; the runtime scope owns this ordering.

Uncertain registration, request extraction, unregister and metadata-forget responses retain original command receipts without automatic replay. Recovery of an extracted batch installs its exact requests before invoking each previously unstarted handler once; it never repeats the native extraction. `status.pendingExtraction` and `status.needsResultRelease` expose outstanding delivery and buffer-recovery ownership. Failed callback acknowledgements retain their handler slots, and faults fence new callback admission. `retryAcknowledgements()` explicitly recovers result allocations and reconciles original receipts or exact operation effect records. It resends only frozen acknowledgement bytes when the core proves the request still needs completion; it never re-executes a handler. not_found or already_completed alone is not completion evidence. Missing delivery proof retains ownership; terminal worker infrastructure failure rejects close observers without reporting successful closure or releasing an unproven claim. Durable crash-recovery logging remains a later milestone; these in-memory records are not durable recovery.

`EmbeddedClient(driver)` provides typed runtime, plugin, pool, fixed-session and operation handles. `client.reserve()` immediately returns `EmbeddedPending<EmbeddedRuntime>`; native mutations retain their original receipt until explicit `forget()`. `pending.result({ signal })` observes delivery, `pending.deliveredResult()` recovers copied delivery after a release failure, and `pending.map()` creates another local view of that same receipt. Projection errors and observer aborts keep original evidence on the driver. These handles borrow the driver; use `EmbeddedRuntimeScope` to own and coordinate native lifecycle cleanup.

`new EmbeddedRuntimeScope(runtime, { pump, pollIntervalMs })` adopts one known runtime and its existing callback pump. Without a pump it can adopt a reserved slot before initialization. Construction allocates an independent control worker and ownership only; it neither initializes nor closes the runtime. `ready()` proves only worker readiness. An existing pump must match the exact transport and runtime and cannot be omitted. Adoption rejects later pump creation, duplicate scopes and independent typed `runtime.free()`. Scope, pump and ordinary driver response frames share aggregate transport limits. Closure does not consume ordinary driver receipt capacity or close the shared driver, root transport or other runtimes. Low-level raw commands still require the host to honor ownership order.

`scope.close({ signal })` closes native admission, polls core drainage with the callback pump available, joins the pump, removes the exact slot and joins the control worker. Even an already-aborted signal starts and retains owned shutdown; cancellation ends only that observation. `await using scope = new EmbeddedRuntimeScope(runtime)` awaits the same closure on leaving the scope. A host handler that has not returned delays real drainage; observer timeout is never release proof. `EmbeddedRuntimeScope.live` and `scope.status` expose retained ownership and proven checkpoints.

Single-call modules may declare `finalizer` with a declared `export`, fixed `arguments` and finite `timeout_ms`. The core retains the same VM and original operation through automatic closing, with independently retained `finalization.business` and `finalization.outcome` results. Success with null keeps an explicit value; a missing closing outcome does not prove the callback never ran. Scope shutdown preserves callback delivery until finalizers finish; explicit capability revocation still applies. Use matching generated contracts and core binaries; storage recovery never replays a closing callback.

Session modules also support this declaration. Opening reserves one additional operation slot under both runtime and plugin retention limits before initialization; plugin status exposes `reserved_operations` separately from retained records. Closing an initialized session consumes that reservation, preserves earlier business results, and exposes the independent operation through session status `finalization_operation`. Its business baseline is successful null with no business effects; the actual closing result is `finalization`'s outcome. Explicit session, pool, plugin and runtime close, or business failure/use exhaustion, all preserve the original VM through closing and actual retirement. The closing deadline starts only when closing execution is issued.

Reusable pools also support automatic closing. Each new VM reserves one closing operation slot before initialization; reuse of that VM needs no additional reservation. Idle expiry, pressure eviction, business failure/use exhaustion and scope closure trigger an independent closing operation after the business result is published. Pool/plugin closure drains admitted business calls; explicit runtime closure still cancels them. Use runtime `listOperations` (wire command `operation_list`) with an optional exact pool filter, a retained `after_operation_id` cursor and explicit positive `limit` to discover these operations in publication order. Their module context carries `finalization_instance_id`, and the outcome remains queryable after pool removal. An empty page preserves its cursor; forgetting the cursor requires restarting enumeration. Pages and response bytes stay bounded by core budgets, and discovery neither executes callbacks nor replaces durable history.

After failure, ordinary `close()` observes the original attempt. `retryClose()` explicitly recovers original delivery, retained buffers or root capacity rejection proven to precede mutation. Copied removal success advances the checkpoint even when buffer release fails, preventing a second slot removal. Every consumed control response must identify the exact runtime; status checkpoints additionally require a boolean `closed` and a known generated initialization state. Invalid evidence retains the original receipt and ownership; retry revalidates that receipt without resubmitting a native mutation. Callback evidence recovery is reported explicitly; retry recovers the original pump without rerunning handlers. Missing release proof retains the scope claim. Only unused startup failure may relinquish its claim after actual worker exit. Slot release removes operation records, so hosts must persist any effect evidence they need beyond closure. Complete durable recovery remains a later milestone of the overall implementation.

`runtime.initialize(engineOptions, runtimeConfig)` is a one-shot attempt. Query `runtime.status()` to distinguish reserved, initializing, ready, failed and faulted; an initialization receipt alone is not success. `runtime.registerPlugin()` sets aggregate limits and `runtime.registerPool()` preserves an immutable definition, explicit permissions and execution revision. `pool.submit()` and `session.submit()` return operation identity receipts, not completed Lua results. `pool.openSession()` returns a session handle and its separately queryable initialization operation. Handle IDs cannot be redirected; known-ID constructors do not probe or infer native existence.

`pool.prewarmInstance(context, timeoutMs)` returns `EmbeddedPending<EmbeddedOperation>` on the work lane and initializes one **additional** VM in an explicitly reusable pool. Observe the operation separately; successful `value.instance_id` identifies the actual new instance. Prewarming does not invoke a business export, but initialization can call authorized host capabilities and produce effects. A full pool yields an operation with `capacity_exceeded`; single-call/session pools reject admission. Ordinary cancellation, checkpoint recovery, receipts and `EmbeddedRuntimeScope` ownership apply, including waiting for actual callbacks during close. This is neither a target-count request nor a permanent residency guarantee; idle/pressure policies remain active. The development API requires the matching `explicit_instance_prewarm_v1` contract and native library.

`runtime.registerCapacity(pluginId, config)` returns a pending `EmbeddedCapacity`; `runtime.capacity(capacityId)` binds the exact known identity. Supply `resources`, `max_queued_calls` and `max_queued_bytes` explicitly. `capacity.registerPool(...)` requires matching plugin ownership and pool kind, zero member minimum and limits within the capacity. Aggregate reservation and admission are shared; Lua state, module generations and capability snapshots remain per member. Existing `runtime.registerPool(...)` keeps independent placement. `status()`, `requestClose()` and `forget()` use the reserved control lane. Close drains members; forget every closed, drained member before forgetting the capacity. Its minimum remains reserved when empty and does not automatically prewarm VMs. This development feature requires the matching `capacity_groups_v1` contract and native library.

`policy()` atomically returns the current revision string, complete capacity status and `pending_convergence`. `revise(expectedRevision, config)` compares that exact predecessor and replaces the complete configuration, returning a revision string. Both return queryable receipts through the reserved control lane; never convert tokens to numbers, and the SDK does not automatically retry conflicts. A stale predecessor or an execution limit below already dispatched operations returns `busy` without changing policy. Resident or queue shrink may retain excess actual usage and report pending convergence; pinned sessions keep their original VM state, while resident shrink retires reusable caches through their original cleanup path. Query remains available after closure, but revision is rejected. Explicitly forget command receipts. These development APIs require the matching `capacity_policy_revisions_v1` contract and native library and are not yet released.

`operation.wait({ signal, pollIntervalMs })` polls actual core snapshots using the reserved control lane, consuming only successful read-only query receipts. It returns success, failure or cancellation snapshots with effect evidence. Use an `AbortSignal` (including `AbortSignal.timeout`) to bound observation; this never requests native cancellation. `operation.cancel()` separately requests cooperative cancellation, and `operation.forget()` removes the core record independently of SDK receipt forgetting. Interrupted or failed queries remain discoverable on `driver.commands`. Polling validates positive integer timer bounds before admission. Ordinary driver and lifecycle waits from host callbacks are currently rejected as unsupported, including cross-runtime waits, until controlled dependency tracking is implemented.

The existing `createEngineOptions()` now composes with the generated embedded input contract. Its JSON option structures are structural type aliases; declaration merging of the former interfaces is no longer supported. Cache configuration uses the generated three numeric fields rather than arbitrary JSON, and fully explicit engine options require `enable_managed_io_compat`. Partial builder overrides still merge over existing defaults, including nested capability and controller options. Legacy JSON options continue to use `number`; use the generated embedded types when explicit bigint budgets are needed. These are development migration changes for the forthcoming coordinated version, not an update to already published 0.5.7 libraries.

Run `npm run generate:embedded-contract` to regenerate entirely offline, or `node scripts/generate-embedded-contract.mjs --check` to compare without writing. To explicitly synchronize a new core artifact, use `--source <path/to/contract.json>`; its adjacent digest and README must be present. Unknown schema constructs, duplicate JSON members, missing local references, conflicting output definitions, identifier collisions and command coverage drift stop generation. The generator and complete contract are included in the npm package; no developer-machine repository path is needed.

`npm pack` checks the generated files before building. Run `node scripts/verify-embedded-distribution.mjs <archive.tgz>` against that exact local artifact to compare embedded member bytes, import its compiled contract in a fresh process, and run its standalone generator. This development verifier requires the system `tar` command; ordinary offline generation requires only Node.js. The contract CI covers Node 24/26 on Linux, Windows and macOS; it does not constitute native embedded runtime acceptance.

## Installation

The 0.5.7 SDK requires Node.js 24 LTS or newer.

```bash
npm install @luaskills/sdk
```

The npm package does not embed native runtime binaries or LuaRocks modules. Prepare a `runtimeRoot` with `install-runtime`, or pass an explicit `libraryPath` / `LUASKILLS_LIB` when you manage native files yourself.

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

Linux and macOS use the corresponding `.so` / `.dylib` binaries installed under `runtimeRoot/libs`.

## Runtime Assets

The npm package includes a unified script that does not require the Node.js CLI and directly fetches LuaSkills FFI, Lua runtime packages, and VLDB:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deps/sync_runtime_assets.ps1 -Target all -Database vldb-controller -RuntimeRoot D:\runtime\luaskills
```

```bash
RUNTIME_ROOT=/opt/luaskills scripts/deps/sync_runtime_assets.sh all vldb-controller
```

Supported targets are `all`, `luaskills`, `lua`, and `vldb`. VLDB presets are `none`, `vldb-controller`, `vldb-direct`, and `host-callback`. The scripts pin LuaSkills to `v0.5.7` by default and accept explicit release-version overrides.

`install-runtime` downloads GitHub Release assets, verifies `.sha256` sidecars, extracts native files and Lua runtime packages, and writes:

```text
runtimeRoot/resources/luaskills-sdk-runtime-manifest.json
```

Supported database modes:

- `none`: installs the Lua runtime archive and the LuaSkills FFI SDK archive, without database providers.
- `vldb-direct`: installs `vldb-sqlite-lib` and `vldb-lancedb-lib` dynamic libraries and uses `dynamic_library` provider mode.
- `vldb-controller`: installs `vldb-controller` and uses managed `space_controller` provider mode.
- `host-callback`: installs no VLDB binaries and generates `host_callback + json` host options.

Default LuaSkills assets:

- `lua-runtime-packages-{platform}.tar.gz` from `LuaSkills/luaskills-packages`: installed by default; provides `lua_packages`, package-side runtime `libs`, `resources`, and third-party runtime licenses.
- `luaskills-ffi-sdk-{platform}.tar.gz`: installed by default; provides the public FFI dynamic library, headers, and FFI licenses.
- `lua-deps-{platform}.tar.gz`: not installed by the SDK; it is a build-time bundle for CI, source builds, or advanced native module rebuilds.

Managed Python and Node.js child runtimes are optional. Use `--managed-runtimes all` when Lua skills need `vulcan.runtime.python.*` or `vulcan.runtime.node.*`; the installer places Python, `uv`, Node.js, and `pnpm` under `runtimeRoot/dependencies/runtimes/...`.

Managed child runtimes support Windows x64, Linux x64/ARM64, and macOS x64/ARM64. Windows ARM is explicitly rejected before any download or target-directory creation. The npm package includes standalone `scripts/deps/fetch_managed_runtimes.ps1`, `scripts/deps/fetch_managed_runtimes.sh`, and `scripts/debug-tools/managed_runtime_layout_check.py` tools for preparing and validating debug runtime roots.

The current exact managed dependency versions are Python `3.14.6`, uv `0.11.28`, Node.js `24.18.0`, and pnpm `11.11.0`. Package `dependencies.yaml` files must declare the same exact runtime and package-manager versions unless the host deliberately installs another supported version.

### Host-selected managed runtime roots

LuaSkills 0.5.1 separates the LuaSkills data root, the read-only interpreter distribution root, and the writable managed-environment root. Both explicit managed roots must be absolute; when omitted, LuaSkills keeps the compatible `runtimeRoot/dependencies/runtimes` and `runtimeRoot/dependencies/envs` layout.

```ts
import { LuaSkillsClient } from "@luaskills/sdk";

const distributionRoot = "D:/VulcanCode/dependencies/runtimes";
const client = LuaSkillsClient.create({
  runtimeRoot: "D:/VulcanCodeData/luaskills",
  hostOptions: {
    managed_runtime_distribution_root: distributionRoot,
    managed_runtime_environment_root: "D:/VulcanCodeData/managed-runtime-envs",
    managed_runtime_config: {
      worker_pool_max_size_per_environment: 8,
      worker_idle_ttl_secs: 120,
      persistent_session_limit_per_engine: 128,
      persistent_session_default_buffer_limit_bytes_per_stream: 2 * 1024 * 1024,
      invoke_default_timeout_ms: 30_000,
    },
  },
});

const pythonInstall = LuaSkillsClient.resolveManagedRuntimeInstall({
  runtimeRoot: "D:/VulcanCodeData/luaskills",
  distributionRoot,
  runtime: "python",
  version: "3.14.6",
  platform: "windows-x64",
});
```

`defaultManagedRuntimeConfig()` returns the stable engine defaults: `4` Workers per exact environment/package-owner pool, `60` idle seconds, `256` persistent sessions, `1 MiB` per session output stream, and no default invoke timeout. Start from that complete object when changing individual values. Every configured number must be positive; per-call `invoke.timeout_ms` and per-session `session.open.buffer_limit_bytes` override only their matching engine defaults.

The standalone fetch and debug tools accept the same split layout through `-DistributionRoot` or `MANAGED_RUNTIME_DISTRIBUTION_ROOT`, plus `--distribution-root` and `--environment-root` for validation.

The SDK keeps LuaSkills core aligned with the SDK release and resolves runtime packages from the compatible `0.1` series by selecting the newest published patch automatically.

## Version Alignment

- Keep the SDK and LuaSkills core on the same current release line whenever possible.
- The current SDK defaults to LuaSkills core tag `v0.5.7`.
- Runtime packages and native dependencies still come from the split `LuaSkills/luaskills-packages` and related release assets.
- SDK default host options pass `runtime_root`, null managed-root override slots, and the complete stable `managed_runtime_config`; LuaSkills derives the fixed data layout until the host explicitly overrides roots or policy.
- Host tools live directly under `runtime_root/bin`, not `runtime_root/bin/tools`.

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database host-callback --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database none --managed-runtimes all --runtime-root D:\runtime\luaskills
```

Use `--dry-run` to inspect exact release URLs before downloading:

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills --dry-run
```

Advanced hosts that already manage Lua packages can skip the Lua runtime archive:

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills --skip-lua-runtime
```

## Skill Roots

The SDK default root chain is formal and layered:

```text
ROOT    = system-protected layer
PROJECT = ordinary project layer
USER    = ordinary user layer
```

`RuntimeRoots.standard(runtimeRoot)` maps to:

```text
runtimeRoot/root_skills
runtimeRoot/project_skills
runtimeRoot/user_skills
```

Put user-facing demo or installed skills under `user_skills` or `project_skills`. The legacy `skills` directory is not part of the SDK standard chain.

## CLI Flow

End-to-end CLI flow with a prepared runtime root:

```powershell
$env:NODE_USE_ENV_PROXY = "1" # only needed when Node fetch must use HTTP_PROXY/HTTPS_PROXY

npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
npx @luaskills/sdk list --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"npx"}' --runtime-root D:\runtime\luaskills
```

If you prefer the shared controller mode:

```powershell
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"controller"}' --runtime-root D:\runtime\luaskills
```

The SDK automatically resolves `luaskills.dll` / `libluaskills.so` / `libluaskills.dylib` from the runtime manifest and `runtimeRoot/libs`.

## Code Usage

Basic client usage:

```ts
import { Authority, LuaSkillsClient, RuntimeRoots } from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const roots = RuntimeRoots.standard(runtimeRoot);
const client = LuaSkillsClient.create({ runtimeRoot });

try {
  client.loadFromRoots(roots);

  const entries = client.listEntries(Authority.DelegatedTool);
  const result = client.callSkill("demo-standard-ffi-skill-ping", {
    note: "typescript-sdk",
  });

  console.log(entries);
  console.log(result.content);
} finally {
  client.close();
}
```

Use `libraryPath` only when you intentionally bypass the runtime manifest:

```ts
const client = LuaSkillsClient.create({
  libraryPath: "D:/path/to/luaskills.dll",
  runtimeRoot: "D:/runtime/luaskills",
});
```

## Examples

Published examples import the package exactly as an external user would:

```js
import { LuaSkillsClient } from "@luaskills/sdk";
```

Run after preparing `runtimeRoot`:

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
$env:LUASKILLS_RUNTIME_ROOT = "D:\runtime\luaskills"
node node_modules\@luaskills\sdk\examples\basic.mjs
```

For source-tree examples, use npm scripts:

```powershell
npm run example:basic
npm run example:call
npm run example:host-tool-callback
npm run example:query
npm run example:lifecycle
npm run example:runtime-lease
npm run example:runtime-lease
npm run example:provider-callback
```

The query, lifecycle, and persistent runtime-lease examples use the bundled fixture skill at `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`. Install runtime assets into that root first:

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root .\examples\fixture-runtime
```

See [examples/README.md](examples/README.md) for the full example index and runtime notes. The Chinese example guide is [examples/README_cn.md](examples/README_cn.md).

## Persistent Runtime Leases

Use `client.runtimeLeases()` for the public lease endpoints, or `client.system(authority).runtimeLeases()` when the host wants fixed authority injection through the dedicated system runtime-lease exports provided by the latest native library.

```ts
import { Authority, LuaSkillsClient } from "@luaskills/sdk";

const client = LuaSkillsClient.create({ runtimeRoot: "D:/runtime/luaskills" });

try {
  const leases = client.system(Authority.System).runtimeLeases();
  const session = leases.createHandle("demo-session", 600, true, {
    cwd: "D:/runtime/luaskills/system_lua_lib",
    mounts: { channel: "demo" },
    system_package: { id: "debug-plugin", root: "D:/runtime/luaskills/system_lua_lib/debug-plugin", dependencies_file: "dependencies.json" },
  });
  const result = session.eval("counter = (counter or 0) + 1; return { counter = counter }");
  console.log(result.result);
  console.log(session.status());
  console.log(session.close());
} finally {
  client.close();
}
```

## Migration Notes

- Existing `client.system(authority)` lifecycle calls keep working; the returned wrapper now also exposes query helpers and `runtimeLeases()`.
- `RuntimeLeaseHandle` persists `lease_id + sid + generation` and automatically reattaches identity guards on `eval`, `status`, and `close`.
- `client.system(authority).runtimeLeases()` requires the dedicated `luaskills_ffi_system_runtime_lease_*` exports from the latest native library and fails fast when they are missing.
- `callSkill()` now returns `host_result` when the host enables `request_context.client_capabilities.host_result`; structure-aware tools can emit one fourth return value for IDE-native result processing.
- When `host_result.kind === "change_set"`, hosts should treat `payload` as `RuntimeChangeSetPayload`.
- Canonical `change_set` payloads now use file lifecycle records plus hunk-level `before + delete[] + insert[] + after` blocks for `modify` changes.
- `create` and `delete` file records carry full-file `content`, while `rename` records carry `old_path` and `new_path`.
- Public leases accept `cwd`, `workspace_root`, `lua_roots`, `c_roots`, and `mounts`. System leases require `system_package`, reject `lua_roots/c_roots`, and derive roots from the trusted package manifest.
- `pollManagedSessionEvents()`, `waitManagedSessionEvents()`, and `setManagedSessionWakeCallback()` expose the 0.5.1 event surface.
- Source-tree examples now load the published package when available and otherwise fall back to the local `dist` build, so the repository smoke path and standalone examples package use the same scripts.

## JSON Provider Callback

SQLite / LanceDB `host_callback + json` mode can be registered through the SDK before engine creation:

```ts
import { LuaSkillsClient, LuaSkillsJsonFfi } from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

ffi.setSqliteProviderJsonCallback((request) => {
  return { ok: true, request };
});

try {
  const client = LuaSkillsClient.create({
    runtimeRoot,
    hostOptions: {
      sqlite_provider_mode: "host_callback",
      sqlite_callback_mode: "json",
    },
  });
  client.close();
} finally {
  ffi.clearSqliteProviderJsonCallback();
}
```

Callbacks must be registered before `engine_new`. Changing callbacks later does not retroactively affect already-created engines.

## Host Tool Callback

`vulcan.host.*` uses the fixed host-tool callback registered through `luaskills_ffi_set_host_tool_json_callback`. Register it before running skills that may call host-owned tools:

```ts
import { LuaSkillsJsonFfi, type HostToolJsonRequest } from "@luaskills/sdk";

// Runtime root used by the host integration.
// 宿主集成使用的运行时根目录。
const runtimeRoot = "D:/runtime/luaskills";
// Low-level FFI bridge that owns callback registration.
// 持有 callback 注册的底层 FFI 桥。
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

// Handle list, has, and call actions from vulcan.host.*.
// 处理来自 vulcan.host.* 的 list、has 和 call 动作。
ffi.setHostToolJsonCallback((request: HostToolJsonRequest) => {
  switch (request.action) {
    case "list":
      return [{ name: "model.embed", description: "embedding model bridge" }];
    case "has":
      return request.tool_name === "model.embed";
    case "call":
      return { ok: true, value: { request: request.args } };
    default:
      return { ok: false, error: { code: "unsupported_action", message: request.action } };
  }
});
```

The callback receives `{ action, tool_name, args }`. `list` should return host-visible tool metadata, `has` should return a boolean or an object with `exists` / `has` / `available`, and `call` should return one complete table-shaped result. Call `ffi.clearHostToolJsonCallback()` during shutdown. Streaming is intentionally outside this bridge.

## Model Callback

`vulcan.models.*` uses fixed model callbacks registered through `luaskills_ffi_set_model_embed_json_callback` and `luaskills_ffi_set_model_llm_json_callback`. Lua skills can only call `vulcan.models.embed(text)` and `vulcan.models.llm(system, user)`; provider selection, model names, keys, temperature, thinking, limits, and stream policy stay fully host-owned.

Register model callbacks before creating or using an engine that may run model-aware skills. Keep the `LuaSkillsJsonFfi` instance alive for as long as the callback should stay registered, and clear callbacks during shutdown or test teardown.

The SDK callback is the host boundary:

- It receives a fixed request shape from LuaSkills.
- It should call the host-selected provider using host-managed configuration.
- It should return a bare success payload for successful provider calls.
- It should return an error envelope for provider failures that need `provider_message`, `provider_code`, or `provider_status`.
- It should not expose API keys, Authorization headers, signatures, or raw request headers in provider error fields.

```ts
import {
  LuaSkillsJsonFfi,
  type RuntimeModelEmbedRequest,
  type RuntimeModelLlmRequest,
} from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

ffi.setModelEmbedJsonCallback((request: RuntimeModelEmbedRequest) => {
  return {
    vector: [0.1, 0.2, 0.3],
    dimensions: 3,
    usage: { input_tokens: request.text.length },
  };
});

ffi.setModelLlmJsonCallback((request: RuntimeModelLlmRequest) => {
  if (request.user.includes("missing-model")) {
    return {
      ok: false,
      error: {
        code: "provider_error",
        message: "model provider rejected the request",
        provider_message: "raw provider message after host-side redaction",
        provider_code: "model_not_found",
        provider_status: 404,
      },
    };
  }
  return {
    assistant: `handled ${request.system}: ${request.user}`,
    usage: { input_tokens: 12, output_tokens: 8 },
  };
});
```

The callback request includes `{ text, caller }` for embeddings and `{ system, user, caller }` for LLM calls. Return bare success payloads, or `{ ok: false, error: { code, message, provider_message?, provider_code?, provider_status? } }` for provider failures. Call `ffi.clearModelEmbedJsonCallback()` and `ffi.clearModelLlmJsonCallback()` during shutdown.

Minimal runtime check after registration:

```ts
const status = client.runLua("return vulcan.models.status()");
const embedResult = client.runLua('return vulcan.models.embed("hello")');
const llmResult = client.runLua('return vulcan.models.llm("system", "user")');
```

Common integration mistakes:

- `model_unavailable`: the matching callback was not registered or was cleared before the skill call.
- Missing provider details: return a structured error envelope instead of throwing provider errors from the callback.
- Missing FFI symbol: install a LuaSkills runtime that exports `luaskills_ffi_set_model_embed_json_callback` and `luaskills_ffi_set_model_llm_json_callback`.
- Empty `caller` fields: call through a loaded runtime skill or a runtime `runLua` context, not a detached provider unit test.

## Authority And Management

Query APIs default to `Authority.DelegatedTool`, so ROOT skills are hidden from delegated tools:

```ts
client.listEntries();
client.listSkillHelp();
client.isSkill("some-root-tool");
```

`Authority.System` only means the host may manage ROOT. It does not bypass ROOT ownership or same-`skill_id` conflict rules.

Ordinary management should target USER or PROJECT:

```powershell
npx @luaskills/sdk install LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk update LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk uninstall luaskills-demo-skill --target-root USER
```

System management should be exposed only through trusted host/admin surfaces:

```powershell
npx @luaskills/sdk system-install LuaSkills/luaskills-demo-skill --target-root ROOT --authority system
```

If a system command is wrapped for ordinary tools, bind `--authority delegated_tool` in the host wrapper instead of letting the caller choose it.

## Call Surface

`callSkill` and `runLua` execute active runtime code. They are not the same as delegated visibility queries.

If your product should not expose arbitrary Lua execution, do not expose `runLua` to untrusted users. If only selected tools should be callable, enforce that allowlist in your host tool wrapper.

## Skill Config

Skill config is declared by each effective package. Discover the declaration before requesting or changing values:

```ts
const schema = client.config.describe({ skillId: "my-skill" });
const status = client.config.validate("my-skill");

const write = client.config.set("my-skill", {
  api_key: "value",
  retry_count: 3,
});
client.config.set("my-skill", "retry_count", 4, {
  expectedRevision: write.revision,
});
client.config.get("my-skill", "api_key");
client.config.list("my-skill");
client.config.delete("my-skill", "api_key", {
  expectedRevision: write.revision,
});
client.config.refresh();
const events = client.config.pollEvents(undefined, 100);
```

Set `hostOptions.skill_config_root` to an absolute user-level directory. LuaSkills stores ordinary and ROOT-owned package configuration separately under `skills/config.json` and `system-skills/config.json`. Every raw `list()` entry includes `store_scope`, so retained records with the same package id remain unambiguous across both files. The strict versioned documents use decimal-string revisions, cross-process companion locks, atomic replacement, cached snapshots, and file-watch reloads. Old unversioned documents are rejected.

`describe()` returns parameter names, types, constraints, UI hints, package-authored descriptions, enum options, defaults, and unambiguous value states. `mode: "installed"` discovers every physical package without executing Lua; effective mode is the default. Package authors choose one language for human-readable fields; English is recommended but not enforced. Writes are accepted only for keys declared by the effective package, satisfy declaration and package validator rules, and commit atomically as one package batch.

Values are omitted by default. `includeValues: true` returns unmasked effective values. The SDK and LuaSkills do not authorize or mask this data; the host must allow, deny, force, or obtain user approval for that flag and for mutations. Lua code can modify only its own package, while host SDK calls are intentionally unrestricted.

`expectedRevision` enables compare-and-swap writes and deletes. `pollEvents`, `waitForEvents`, and `watchEvents` expose ordered local-write and external-reload events; persist the returned `next_sequence` only after processing the complete page. A missing configuration should be handled by showing `describe()` output and asking the user or an authorized AI tool for the declared parameters.

JavaScript cannot distinguish an unsafe integer from an integer-shaped binary64 float. Numeric values outside the safe-integer range are therefore rejected by the SDK; pass a finite float such as `1e20` as the decimal string `"1e20"` so the core can validate it against a declared `float`.

CLI equivalents:

```bash
luaskills config describe my-skill --skill-config-root /absolute/user-config
luaskills config validate my-skill
luaskills config describe my-skill --include-values
luaskills config describe --installed --root-name ROOT
luaskills config set my-skill retry_count 3 --expected-revision 7
luaskills config set-batch my-skill '{"retry_count":4,"mode":"safe"}'
luaskills config refresh skills
luaskills config events --after-sequence 12 --limit 100
```

The CLI defaults `--skill-config-root` to `<runtime-root>/config`; hosts embedding the SDK must still choose and pass their own absolute user-level root.

Configuration survives package uninstall. Hosts own any explicit data-removal policy. Configuration only affects behavior when the Lua skill reads it; it is not a hard runtime policy layer.

## Troubleshooting

### `fetch failed` while installing runtime assets

`install-runtime` uses Node `fetch` to download GitHub Release assets. In proxy environments, PowerShell or curl may work while Node fetch still fails with `ECONNRESET` or `UND_ERR_CONNECT_TIMEOUT`.

Set proxy variables and enable Node environment proxy support when needed:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:10808"
$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:NODE_USE_ENV_PROXY = "1"
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
```

### `LuaSkills library path is required`

This means the SDK could not find a native LuaSkills library. Run `install-runtime`, pass `--runtime-root`, or set `LUASKILLS_LIB`.

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

### Lua modules are missing at runtime

If a skill fails with Lua module loading errors, make sure `install-runtime` was run without `--skip-lua-runtime` and that `runtimeRoot/lua_packages` exists. The SDK installs `lua-runtime-packages-{platform}.tar.gz` from `LuaSkills/luaskills-packages` by default for this reason.

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
Test-Path D:\runtime\luaskills\lua_packages
```

### `list` is empty after copying a demo skill

Check the directory. SDK standard roots are `root_skills`, `project_skills`, and `user_skills`; putting a skill under `runtimeRoot/skills` will not load it through the standard chain.

```text
D:\runtime\luaskills\user_skills\demo-standard-ffi-skill\skill.yaml
```

### JSON parse errors on Windows local shims

When calling the local npm `.cmd` shim directly from PowerShell, single-quoted JSON may be forwarded differently and produce `Expected property name or '}' in JSON`. Prefer `npx`, the `.ps1` shim, or a JS script for local smoke tests.

```powershell
.\node_modules\.bin\luaskills.ps1 call demo-standard-ffi-skill-ping '{"note":"powershell"}' --runtime-root D:\runtime\luaskills
```

### `vldb-controller` process remains after tests

Managed controller mode may keep a controller process alive for its lease/idle timeout. For tests, stop only the controller executable under your test `runtimeRoot/bin`.

## JSON FFI Coverage

The SDK covers the public JSON FFI surface:

- version / describe
- engine_new / engine_free
- load_from_roots / reload_from_roots
- list_entries / list_skill_help / render_skill_help_detail
- prompt_argument_completions / is_skill / skill_name_for_tool
- call_skill / run_lua
- skill_config list / describe / validate / get / batch set / CAS delete / refresh / event polling
- SQLite / LanceDB JSON provider callback register / clear
- Host-tool JSON callback register / clear
- Model embed / LLM JSON callback register / clear
- disable / enable / install / update / uninstall
- system_disable / system_enable / system_install / system_update / system_uninstall

## Publishing

The release version is stored in `VERSION`. Keep `VERSION`, `package.json`, and `package-lock.json` aligned before publishing.

For one unified ecosystem release, publish `LuaSkills/luaskills-packages` first, then publish `LuaSkills/luaskills`, so the default runtime installer assets for this SDK already exist before npm goes live.

Before publishing:

```bash
npm install
npm run check
npm run build
npm pack --dry-run
```

The package exposes:

- `main`: `dist/index.js`
- `types`: `dist/index.d.ts`
- `bin`: `dist/cli.js`

Use a new patch version for every npm publish. Published versions cannot be overwritten.

Recommended unified publish order: `luaskills-packages` -> `luaskills` core release -> TypeScript SDK -> Python SDK -> Go SDK -> SDK examples releases.

After npm publishes successfully, run the GitHub Actions workflow **Examples Release** manually. It reads `VERSION`, installs `@luaskills/sdk@{VERSION}` from npm, installs LuaSkills runtime assets, runs the examples, then creates or updates the `examples-v{VERSION}` GitHub Release with:

- `luaskills-sdk-typescript-examples-{VERSION}.zip`
- `luaskills-sdk-typescript-examples-{VERSION}.zip.sha256`

The examples release tag intentionally uses the `examples-v` prefix because it is an examples asset release, not an SDK package version.
