import { readFileSync } from 'node:fs';

// Each independent process selects one explicit diagnostic mode from the workflow.
// 每个独立进程从工作流选择一个明确的诊断模式。
const mode = process.argv[2];
console.error('diagnostic:start', mode);
// Keep the import order observable to distinguish module loading from native calls.
// 记录导入顺序，区分模块加载与原生调用。
const { runEmbeddedCandidate } = await import('./node_modules/@luaskills/sdk/examples/embedded-candidate.mjs');
console.error('diagnostic:embedded-imported');
const { runEmbeddedValuePolicy } = await import('./node_modules/@luaskills/sdk/examples/embedded-value-policy.mjs');
console.error('diagnostic:policy-imported');
const { main } = await import('./node_modules/@luaskills/sdk/examples/sqlite-demo.mjs');
console.error('diagnostic:sqlite-imported');
if (mode === 'embedded' || mode === 'combined') {
  console.error('diagnostic:embedded-start');
  console.log(await runEmbeddedCandidate(process.env.LUASKILLS_LIB, readFileSync(process.env.CORE_DESCRIPTION)));
  console.error('diagnostic:policy-start');
  await runEmbeddedValuePolicy(process.env.LUASKILLS_LIB, readFileSync(process.env.CORE_DESCRIPTION));
  console.error('diagnostic:policy-done');
}
if (mode === 'sqlite' || mode === 'combined') {
  console.error('diagnostic:sqlite-start');
  main();
  console.error('diagnostic:sqlite-done');
}
