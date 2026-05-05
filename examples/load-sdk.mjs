/**
 * Load the published SDK package when available, otherwise fall back to the local dist build.
 * 优先加载已发布的 SDK 包；不可用时回退到本地 dist 构建产物。
 */
export const sdk = await import("@luaskills/sdk").catch(async () => import("../dist/index.js"));
