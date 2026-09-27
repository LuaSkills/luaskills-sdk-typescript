import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Package-local paths also work after npm extraction, without adjacent repositories.
// 包内路径在 npm 解包后仍可使用，无需相邻仓库。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Schema annotations do not change the TypeScript shape.
// Schema 注解不会改变 TypeScript 形状。
const annotations = new Set(["$defs", "$schema", "title", "description", "default"]);
// Supported Rust-generated keywords; new semantics require deliberate generator support.
// 支持的 Rust 生成关键字；新语义必须显式扩展生成器。
const keywords = new Set([...annotations, "$ref", "type", "properties", "required", "additionalProperties", "items", "uniqueItems", "oneOf", "anyOf", "const", "format", "minimum"]);

/**
 * Convert a wire name to a stable PascalCase identifier; reject unsupported names.
 * 将线名称转换为稳定的大驼峰标识符；拒绝不支持的名称。
 * @param {string} name Exact Rust name.
 * 精确 Rust 名称。
 * @returns {string} A TypeScript identifier.
 * TypeScript 标识符。
 */
function identifier(name) {
  const result = name.split("_").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join("");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(result)) throw new Error(`Unsupported wire name: ${name}`);
  return result;
}

/**
 * Parse verified UTF-8 JSON while rejecting duplicate keys and unsafe metadata numbers.
 * 解析已校验 UTF-8 JSON，同时拒绝重复键和不安全的元数据数值。
 * @param {Uint8Array} bytes Exact contract bytes.
 * 精确契约字节。
 * @returns {object} Parsed contract without overwritten members.
 * 未覆盖成员的解析契约。
 */
export function parseContract(bytes) {
  // Native parsing proves grammar first; the second lexical pass only tracks object key uniqueness.
  // 原生解析先证明语法有效；第二次词法遍历仅追踪对象键唯一性。
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document = JSON.parse(source, (_key, value) => {
    if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new Error("Unsafe contract metadata number");
    }
    return value;
  });
  const stack = [];
  const tokens = source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/gs);
  for (const token of tokens) {
    if (token[0] === "{") stack.push(new Set());
    else if (token[0] === "[") stack.push(null);
    else if (token[0] === "}" || token[0] === "]") stack.pop();
    else if (/^\s*:/.test(source.slice(token.index + token[0].length))) {
      const name = JSON.parse(token[0]);
      const keys = stack.at(-1);
      if (!(keys instanceof Set)) throw new Error("Invalid object key context");
      if (keys.has(name)) throw new Error(`Duplicate contract member: ${name}`);
      keys.add(name);
    }
  }
  return document;
}

/**
 * Verify one independent schema root before any output definitions can be merged.
 * 在合并任何输出定义之前验证一个独立 Schema 根。
 * @param {object} rootSchema Independent Rust schema.
 * 独立 Rust Schema。
 * @returns {void} Throws for unknown constructs or foreign references.
 * 对未知结构或外部引用抛错。
 */
function verifySchema(rootSchema) {
  const definitions = rootSchema.$defs ?? {};
  const pending = [rootSchema];
  while (pending.length) {
    const schema = pending.pop();
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Unsupported non-object schema");
    for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    if (schema !== rootSchema && "$defs" in schema) throw new Error("Nested definition namespaces are unsupported");
    if ("$schema" in schema && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error("Unsupported schema dialect");
    if ("format" in schema && !["uint", "uint32", "uint64"].includes(schema.format)) throw new Error("Unsupported numeric format");
    for (const selector of ["$ref", "oneOf", "anyOf"]) {
      if (selector in schema && Object.keys(schema).some((key) => !annotations.has(key) && key !== selector)) throw new Error(`Unsupported combined schema: ${selector}`);
    }
    if ("const" in schema && Object.keys(schema).some((key) => !annotations.has(key) && key !== "const" && key !== "type")) throw new Error("Unsupported combined constant schema");
    if ("uniqueItems" in schema && typeof schema.uniqueItems !== "boolean") throw new Error("Invalid uniqueItems constraint");
    if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean" && (!schema.additionalProperties || typeof schema.additionalProperties !== "object" || Array.isArray(schema.additionalProperties))) throw new Error("Invalid additional properties schema");
    if ("minimum" in schema && (typeof schema.minimum !== "number" || !Number.isFinite(schema.minimum))) throw new Error("Invalid numeric minimum");
    if ("$ref" in schema && (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/") || !Object.hasOwn(definitions, schema.$ref.slice(8)))) {
      throw new Error(`Reference does not belong to its independent root: ${schema.$ref}`);
    }
    for (const key of ["$defs", "properties"]) {
      if (key in schema) {
        if (!schema[key] || typeof schema[key] !== "object" || Array.isArray(schema[key])) throw new Error(`Invalid schema map: ${key}`);
        pending.push(...Object.values(schema[key]));
      }
    }
    for (const key of ["oneOf", "anyOf"]) {
      if (key in schema) {
        if (!Array.isArray(schema[key]) || !schema[key].length) throw new Error(`Invalid alternatives: ${key}`);
        pending.push(...schema[key]);
      }
    }
    if ("items" in schema) pending.push(schema.items);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") pending.push(schema.additionalProperties);
  }
}

/**
 * Render safe JSDoc from the actual bilingual Rust description or an explicit generated label.
 * 从实际 Rust 双语说明或显式生成标签渲染安全 JSDoc。
 * @param {object} schema Source description owner.
 * 源说明所属 Schema。
 * @param {string} name Declaration name.
 * 声明名称。
 * @returns {string} Escaped documentation block.
 * 已转义的文档块。
 */
function documentation(schema, name) {
  const description = schema.description ?? `Generated wire shape for ${name}.\n${name} 的生成线形状。`;
  return "/**\n" + description.replaceAll("*/", "* / ").split("\n").map((line) => ` * ${line}`).join("\n") + "\n */\n";
}

/**
 * Render the explicitly supported shape without replacing unknown schemas with any.
 * 渲染显式支持的形状，不把未知 Schema 替换为 any。
 * @param {object} schema Validated shape.
 * 已校验的形状。
 * @param {Map<string,string>} names Exact local reference bindings.
 * 精确局部引用绑定。
 * @returns {string} TypeScript type expression.
 * TypeScript 类型表达式。
 */
function expression(schema, names) {
  if ("$ref" in schema) return names.get(schema.$ref.slice(8));
  for (const selector of ["oneOf", "anyOf"]) {
    if (selector in schema) return `(${schema[selector].map((variant) => expression(variant, names)).join(" | ")})`;
  }
  if ("const" in schema) {
    if (schema.type !== typeof schema.const || !["string", "boolean", "number"].includes(typeof schema.const)) throw new Error("Unsupported const shape");
    return JSON.stringify(schema.const);
  }
  if (Object.keys(schema).every((key) => annotations.has(key))) return "EmbeddedJsonValue";
  if (Array.isArray(schema.type)) {
    if (!schema.type.length || new Set(schema.type).size !== schema.type.length) throw new Error("Invalid type alternatives");
    // Numeric constraints apply only to numeric instances in a nullable type union.
    // 在可空类型联合中，数值约束仅适用于数值实例。
    return `(${schema.type.map((type) => {
      const branch = { ...schema, type };
      if (type === "null" && schema.type.includes("integer")) { delete branch.minimum; delete branch.format; }
      return expression(branch, names);
    }).join(" | ")})`;
  }
  const allowed = new Set([...annotations, "type"]);
  if (schema.type === "integer") { allowed.add("minimum"); allowed.add("format"); }
  if (schema.type === "object") for (const key of ["properties", "required", "additionalProperties"]) allowed.add(key);
  if (schema.type === "array") for (const key of ["items", "uniqueItems"]) allowed.add(key);
  if (Object.keys(schema).some((key) => !allowed.has(key))) throw new Error(`Unsupported constraints on ${schema.type}`);
  switch (schema.type) {
    case "string": case "boolean": case "number": case "null": return schema.type;
    case "integer": return schema.format === "uint32" ? "number" : "EmbeddedInteger";
    case "array":
      if (!("items" in schema)) throw new Error("Array without item schema");
      return `Array<${expression(schema.items, names)}>`;
    case "object": {
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];
      if (!Array.isArray(required) || new Set(required).size !== required.length || required.some((name) => !Object.hasOwn(properties, name))) throw new Error("Invalid required property set");
      const fields = Object.entries(properties).map(([name, field]) => documentation(field, name) + `${JSON.stringify(name)}${required.includes(name) ? "" : "?"}: ${expression(field, names)};`);
      const additional = schema.additionalProperties ?? true;
      if (additional !== false && additional !== true && (typeof additional !== "object" || additional === null)) throw new Error("Invalid additional properties schema");
      const index = additional === false ? "" : `Record<string, ${additional === true ? "EmbeddedJsonValue" : expression(additional, names)}>`;
      return fields.length ? `({\n${fields.join("\n")}\n}${index ? ` & ${index}` : ""})` : index || "Record<string, never>";
    }
    default: throw new Error(`Unsupported schema type: ${schema.type}`);
  }
}

/**
 * Generate all types, command mappings and identity metadata from one verified core contract.
 * 从一份已校验核心契约生成全部类型、命令映射和身份元数据。
 * @param {object} contract Parsed core document.
 * 已解析的核心文档。
 * @param {Uint8Array} bytes Original hashed bytes.
 * 计算摘要的原始字节。
 * @returns {string} Deterministic LF TypeScript source.
 * 确定性的 LF TypeScript 源码。
 */
export function generate(contract, bytes) {
  if (contract.contract_version !== 1 || contract.generator.schema_draft !== "2020-12") throw new Error("Unsupported contract version or draft");
  for (const [commands, responses, excluded] of [[contract.commands, contract.root_responses, "runtime"], [contract.runtime_commands, contract.runtime_responses, null]]) {
    if (!Array.isArray(commands) || commands.some((name) => typeof name !== "string") || new Set(commands).size !== commands.length || !isDeepStrictEqual([...commands.filter((name) => name !== excluded)].sort(), Object.keys(responses).sort())) throw new Error("Command response coverage mismatch");
  }
  const outputRoots = [["OutputErrorResponse", contract.error_response]];
  for (const [prefix, responses] of [["OutputRoot", contract.root_responses], ["OutputRuntime", contract.runtime_responses]]) {
    for (const [name, schema] of Object.entries(responses)) outputRoots.push([prefix + identifier(name) + "Response", schema]);
  }
  for (const schema of [contract.request, ...outputRoots.map((entry) => entry[1])]) verifySchema(schema);
  // Route inventories must agree with the actual request enum, not merely with each other.
  // 路由清单必须与实际请求枚举一致，而不只是彼此一致。
  for (const [name, commands] of [["Command", contract.commands], ["RuntimeCommand", contract.runtime_commands]]) {
    const variants = contract.request.$defs[name].oneOf.map((variant) => variant.properties.type.const);
    if (new Set(variants).size !== variants.length || !isDeepStrictEqual([...variants].sort(), [...commands].sort())) throw new Error(`Request enum coverage mismatch: ${name}`);
  }
  const definitions = new Map();
  for (const [, schema] of outputRoots) {
    for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
      if (definitions.has(name) && !isDeepStrictEqual(definitions.get(name), definition)) throw new Error(`Conflicting output definition: ${name}`);
      definitions.set(name, definition);
    }
  }
  const lines = [documentation({}, "embedded contract") + "// Generated by scripts/generate-embedded-contract.mjs; do not edit.\n// 由 scripts/generate-embedded-contract.mjs 生成；请勿编辑。\n",
    'import type { EmbeddedFloat } from "./embedded-value.js";\n',
    "/** Exact integer inputs use bigint outside the safe number range.\n * 超出安全 number 范围的精确整数输入使用 bigint。 */\nexport type EmbeddedInteger = number | bigint;\n",
    "/** Recursive JSON values with lossless integers and explicit float intent.\n * 具有无损整数和显式浮点意图的递归 JSON 值。 */\nexport type EmbeddedJsonValue = null | boolean | string | number | bigint | EmbeddedFloat | EmbeddedJsonValue[] | { [key: string]: EmbeddedJsonValue };\n"];
  const owners = new Set(["EmbeddedInteger", "EmbeddedJsonValue", "EmbeddedNativeStatus", "EmbeddedRootResponseMap", "EmbeddedRuntimeResponseMap"]);
  for (const [name, value] of Object.entries({ EMBEDDED_PROTOCOL_VERSION: contract.protocol_version, EMBEDDED_CONTRACT_VERSION: contract.contract_version, EMBEDDED_CORE_VERSION: contract.core_version, EMBEDDED_CONTRACT_SHA256: createHash("sha256").update(bytes).digest("hex"), EMBEDDED_ROOT_COMMANDS: contract.commands, EMBEDDED_RUNTIME_COMMANDS: contract.runtime_commands })) {
    owners.add(name);
    const literal = JSON.stringify(value) + " as const";
    lines.push(documentation({}, name) + `export const ${name} = ${Array.isArray(value) ? `Object.freeze(${literal})` : literal};\n`);
  }
  const statuses = Object.entries(contract.native_status);
  if (!statuses.length || statuses.some(([name, value]) => !/^[a-z][a-z_]*$/.test(name) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) || new Set(statuses.map((entry) => entry[1])).size !== statuses.length) throw new Error("Invalid native status codes");
  lines.push(documentation({}, "EmbeddedNativeStatus") + "export enum EmbeddedNativeStatus {\n" + statuses.sort((a, b) => a[1] - b[1]).map(([name, value]) => documentation({}, name) + `${name.toUpperCase()} = ${value},`).join("\n") + "\n}\n");
  lines.push("// Native codes are immutable runtime metadata as well as compile-time names.\n// 原生状态码既是编译期名称，也是不可变运行时元数据。\nObject.freeze(EmbeddedNativeStatus);\n");
  for (const [prefix, defs, roots] of [["Input", new Map(Object.entries(contract.request.$defs ?? {})), [["InputRequest", contract.request]]], ["Output", definitions, outputRoots]]) {
    const names = new Map([...defs.keys()].map((name) => [name, prefix + identifier(name)]));
    const declarations = [...[...defs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, schema]) => [names.get(name), schema]), ...roots];
    for (const [name, schema] of declarations) {
      if (owners.has(name)) throw new Error(`Generated name collision: ${name}`);
      owners.add(name);
      lines.push(documentation(schema, name) + `export type ${name} = ${expression(schema, names)};\n`);
    }
  }
  for (const [name, prefix, responses] of [["EmbeddedRootResponseMap", "OutputRoot", contract.root_responses], ["EmbeddedRuntimeResponseMap", "OutputRuntime", contract.runtime_responses]]) {
    lines.push(documentation({}, name) + `export type ${name} = {\n` + Object.keys(responses).map((command) => documentation({}, command) + `${JSON.stringify(command)}: ${prefix}${identifier(command)}Response;`).join("\n") + "\n};\n");
  }
  return lines.join("\n");
}

/**
 * Read and check offline artifacts, or explicitly synchronize a caller-selected upstream contract.
 * 读取并检查离线产物，或显式同步调用方选择的上游契约。
 * @param {string[]} args CLI arguments: --check or --source <contract.json>.
 * 命令行参数。
 * @returns {void} Writes only after generation succeeds; check mode never writes.
 * 生成成功后才写入；检查模式不写入。
 */
export function main(args) {
  let check = false;
  let source = join(root, "contracts/embedded/v1/contract.json");
  let synchronize = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--check" && !check) check = true;
    else if (flag === "--source" && !synchronize && args[0] && !args[0].startsWith("--")) { source = resolve(args.shift()); synchronize = true; }
    else throw new Error(`Unsupported or repeated argument: ${flag}`);
  }
  if (check && synchronize) throw new Error("--check cannot synchronize an upstream contract");
  const bytes = readFileSync(source);
  const digest = readFileSync(join(dirname(source), "contract.sha256"));
  const expected = Buffer.from(createHash("sha256").update(bytes).digest("hex") + "  contract.json\n");
  if (!digest.equals(expected)) throw new Error("Embedded contract SHA-256 mismatch");
  const generated = Buffer.from(generate(parseContract(bytes), bytes));
  const output = join(root, "src/embedded-contract.ts");
  if (check) {
    if (!readFileSync(output).equals(generated)) throw new Error("Generated embedded contract is stale");
  } else {
    if (synchronize) {
      const directory = join(root, "contracts/embedded/v1");
      const readme = readFileSync(join(dirname(source), "README.md"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "contract.json"), bytes);
      writeFileSync(join(directory, "contract.sha256"), digest);
      writeFileSync(join(directory, "README.md"), readme);
    }
    writeFileSync(output, generated);
  }
}

// Imports expose pure generator functions to tests; direct invocation owns CLI mutation.
// 导入向测试暴露纯生成函数；直接调用负责命令行变更。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
