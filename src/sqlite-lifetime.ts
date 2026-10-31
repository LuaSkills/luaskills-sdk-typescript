import { resolve } from "node:path";

/** Counts native owners and in-progress creations for each explicitly loaded library.
 * 按显式加载的库统计原生所有者及正在创建的实例。 */
const scopes = new Map<string, number>();
/** Disposal callbacks retain retired native trampolines until every owner is freed.
 * 释放回调保留退役原生跳板，直到所有所有者释放。 */
const retired = new Map<string, Array<() => void>>();
/** JSON engines may be freed by another facade for the same native library.
 * JSON 引擎可以由同一原生库的另一个外观释放。 */
export const jsonEngineScopes = new Map<string, () => void>();

/** Return the canonical key for libraryPath, matching both SDK native surfaces.
 * 返回 libraryPath 的规范键，使两个 SDK 原生接口一致。 */
export function sqliteLibraryKey(libraryPath: string): string {
  // Both SDK surfaces canonicalize the existing file once before admission, so free needs no file access.
  // 两个 SDK 接口均在准入前一次性规范化既有文件，因此释放不需要访问文件。
  const path = resolve(libraryPath);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Pin all SQLite callback generations for libraryPath; return an idempotent release function.
 * 固定 libraryPath 的全部 SQLite 回调代次；返回幂等释放函数。
 * Release only after successful native destruction or failed creation.
 * 仅在原生销毁成功或创建失败后释放。 */
export function retainSqliteScope(libraryPath: string): () => void {
  // Key shares callback lifetime between legacy engines and embedded transports.
  // 键在传统引擎与嵌入式传输之间共享回调生命周期。
  const key = sqliteLibraryKey(libraryPath);
  // Released prevents duplicate cleanup from consuming another owner's pin.
  // released 防止重复清理消耗其他所有者的固定。
  let released = false;
  scopes.set(key, (scopes.get(key) ?? 0) + 1);
  return () => {
    if (released) return;
    released = true;
    // Count exists because this closure owns one registered pin.
    // 此闭包拥有一个已注册固定，因此计数必然存在。
    const count = scopes.get(key)! - 1;
    if (count > 0) {
      scopes.set(key, count);
      return;
    }
    scopes.delete(key);
    // Detach before disposal so a callback cannot observe a half-cleared registry.
    // 释放前先摘除，避免回调观察到清理一半的注册表。
    const disposals = retired.get(key) ?? [];
    retired.delete(key);
    for (const dispose of disposals) dispose();
  };
}

/** Retain dispose while libraryPath has native owners, otherwise release immediately.
 * libraryPath 存在原生所有者时保留 dispose，否则立即释放。 */
export function retireSqliteCallback(libraryPath: string, dispose: () => void): void {
  // Key is shared with owner admission and successful native destruction.
  // 键与所有者准入及原生销毁成功路径共享。
  const key = sqliteLibraryKey(libraryPath);
  if ((scopes.get(key) ?? 0) === 0) {
    dispose();
    return;
  }
  // Queue belongs only to this explicitly resolved native library.
  // 队列仅属于此显式解析的原生库。
  const queue = retired.get(key) ?? [];
  queue.push(dispose);
  retired.set(key, queue);
}
