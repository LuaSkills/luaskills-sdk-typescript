import { types as nodeTypes } from "node:util";
import type { EmbeddedJsonValue } from "./embedded-contract.js";
import { EmbeddedFloat } from "./embedded-value.js";
export { EmbeddedFloat } from "./embedded-value.js";

// The unsigned wire width is shared by JSON integers and C ABI identities.
// JSON 整数及 C ABI 身份共用无符号线位宽。
export const EMBEDDED_U64_MAX = (1n << 64n) - 1n;
// serde_json represents negative integral values using signed 64-bit storage.
// serde_json 使用有符号 64 位存储负整数值。
const JSON_I64_MIN = -(1n << 63n);

/**
 * Normalize an exact unsigned integer without allowing Koffi to wrap invalid inputs.
 * 规范化精确无符号整数，避免 Koffi 对无效输入回绕。
 * @param value Caller number or bigint.
 * 调用方 number 或 bigint。
 * @param name Diagnostic field name.
 * 诊断字段名称。
 * @returns The exact bigint; rejects unsafe number representations and overflow.
 * 精确 bigint；拒绝不安全 number 表示及溢出。
 */
export function embeddedUnsignedInteger(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new TypeError(`${name} requires a safe integer number or bigint`);
  const integer = BigInt(value);
  if (integer < 0n || integer > EMBEDDED_U64_MAX) throw new RangeError(`${name} is outside uint64`);
  return integer;
}

/**
 * Reject lone UTF-16 surrogates instead of silently replacing characters on the UTF-8 boundary.
 * 拒绝孤立 UTF-16 代理项，避免在 UTF-8 边界静默替换字符。
 * @param value Original string or object key.
 * 原始字符串或对象键。
 * @returns Nothing; invalid Unicode raises TypeError.
 * 无返回值；无效 Unicode 抛出 TypeError。
 */
function validateUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("Embedded JSON contains a lone surrogate");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError("Embedded JSON contains a lone surrogate");
  }
}

/**
 * Encode plain JSON data and explicit floats within a caller-owned UTF-8 byte budget.
 * 在调用方声明的 UTF-8 字节预算内编码普通 JSON 数据及显式浮点数。
 * @param value Data to freeze; accessors, proxies, sparse arrays and non-JSON objects are rejected.
 * 待冻结数据；拒绝访问器、代理、稀疏数组和非 JSON 对象。
 * @param maxBytes Positive exact output byte limit.
 * 精确正数输出字节上限。
 * @returns Newly owned request bytes; no toJSON hooks are invoked.
 * 新拥有的请求字节；不调用 toJSON 钩子。
 */
export function encodeEmbeddedJson(value: EmbeddedJsonValue, maxBytes: number | bigint): Buffer {
  const limit = embeddedUnsignedInteger(maxBytes, "maxBytes");
  if (limit === 0n) throw new RangeError("maxBytes must be positive");
  // Retained fragments stay within the declared budget; cycles are tracked only on the current path.
  // 保留片段始终位于声明预算内；循环引用仅按当前路径追踪。
  const fragments: string[] = [];
  const ancestors = new Set<object>();
  let size = 0n;

  /**
   * Append one token only after its exact UTF-8 size fits the remaining budget.
   * 仅在精确 UTF-8 大小适合剩余预算时追加一个词元。
   * @param token Already encoded JSON fragment.
   * 已编码 JSON 片段。
   */
  function append(token: string): void {
    size += BigInt(Buffer.byteLength(token, "utf8"));
    if (size > limit) throw new RangeError("Embedded JSON exceeds maxBytes");
    fragments.push(token);
  }

  /**
   * Check string size before allocating escaped output and then append its quoted form.
   * 在分配转义输出前检查字符串大小，然后追加带引号形式。
   * @param text String value or object key.
   * 字符串值或对象键。
   */
  function quoted(text: string): void {
    validateUnicode(text);
    if (BigInt(Buffer.byteLength(text, "utf8")) + size + 2n > limit) throw new RangeError("Embedded JSON exceeds maxBytes");
    append(JSON.stringify(text));
  }

  /**
   * Visit one data value without executing user-defined serialization or property accessors.
   * 遍历一个数据值，不执行用户定义序列化或属性访问器。
   * @param item Current value; validated dynamically even for untyped JavaScript callers.
   * 当前值；即使是无类型 JavaScript 调用方也会进行动态校验。
   */
  function visit(item: unknown): void {
    if (item === null) { append("null"); return; }
    switch (typeof item) {
      case "string": quoted(item); return;
      case "boolean": append(String(item)); return;
      case "bigint":
        if (item < JSON_I64_MIN || item > EMBEDDED_U64_MAX) throw new RangeError("Embedded JSON integer exceeds 64-bit representation");
        append(String(item)); return;
      case "number":
        if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new TypeError("Use bigint for an exact wide integer or EmbeddedFloat for a finite float");
        append(Object.is(item, -0) ? "-0.0" : String(item)); return;
      case "object": break;
      default: throw new TypeError("Embedded JSON rejects undefined, functions and symbols");
    }
    if (nodeTypes.isProxy(item)) throw new TypeError("Embedded JSON rejects proxies");
    // Prototype and own descriptors determine the only accepted data sources; getters are never probed.
    // 原型及自身描述符决定唯一允许的数据来源；绝不探测 getter。
    const prototype = Object.getPrototypeOf(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (prototype === EmbeddedFloat.prototype) {
      const descriptor = descriptors.value;
      if (Reflect.ownKeys(descriptors).length !== 1 || !descriptor || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "number" || !Number.isFinite(descriptor.value)) throw new TypeError("Invalid EmbeddedFloat value");
      append(Object.is(descriptor.value, -0) ? "-0.0" : descriptor.value.toExponential());
      return;
    }
    const array = Array.isArray(item);
    if ((!array && prototype !== Object.prototype && prototype !== null) || (array && prototype !== Array.prototype)) throw new TypeError("Embedded JSON requires plain objects and arrays");
    if (ancestors.has(item)) throw new TypeError("Embedded JSON rejects cycles");
    ancestors.add(item);
    try {
      const keys = Reflect.ownKeys(descriptors);
      for (const key of keys) {
        if (typeof key !== "string") throw new TypeError("Embedded JSON rejects symbol properties");
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length"))) throw new TypeError("Embedded JSON requires enumerable data properties");
      }
      if (array) {
        const length = descriptors.length.value as number;
        if (keys.length !== length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new TypeError("Embedded JSON rejects sparse or decorated arrays");
        append("[");
        for (let index = 0; index < length; index += 1) { if (index) append(","); visit(descriptors[String(index)].value); }
        append("]");
      } else {
        append("{");
        let first = true;
        for (const key of keys as string[]) {
          if (!first) append(",");
          first = false;
          quoted(key); append(":"); visit(descriptors[key].value);
        }
        append("}");
      }
    } finally {
      ancestors.delete(item);
    }
  }

  visit(value);
  return Buffer.from(fragments.join(""), "utf8");
}

/**
 * Decode strict UTF-8 JSON, retaining exact wide integers and integral float intent.
 * 解码严格 UTF-8 JSON，保留精确大整数及整数形浮点意图。
 * @param bytes Complete received bytes owned by the caller.
 * 调用方拥有的完整接收字节。
 * @returns JSON data with bigint outside the safe range and EmbeddedFloat for integral float tokens.
 * JSON 数据；安全范围外使用 bigint，整数形浮点词元使用 EmbeddedFloat。
 */
export function decodeEmbeddedJson(bytes: Uint8Array): EmbeddedJsonValue {
  // Preserve a BOM as an invalid JSON token rather than letting TextDecoder silently remove it.
  // 将 BOM 保留为无效 JSON 词元，避免 TextDecoder 静默移除。
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed: unknown = JSON.parse(source, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "string") validateUnicode(value);
    if (typeof value !== "number") return value;
    if (!context || typeof context.source !== "string") throw new Error("Embedded JSON requires Node.js 24 JSON source context");
    if (/^-?(0|[1-9][0-9]*)$/.test(context.source) && context.source !== "-0") {
      const integer = BigInt(context.source);
      if (integer < JSON_I64_MIN || integer > EMBEDDED_U64_MAX) throw new RangeError("Embedded JSON integer exceeds 64-bit representation");
      return Number.isSafeInteger(value) ? value : integer;
    }
    if (!Number.isFinite(value)) throw new RangeError("Embedded JSON float is not finite");
    return Number.isInteger(value) ? new EmbeddedFloat(value) : value;
  });
  // Native JSON.parse accepts duplicate keys. Check decoded names before returning any parsed result.
  // 原生 JSON.parse 接受重复键；返回任何解析结果前检查解码名称。
  const stack: Array<Set<string> | null> = [];
  for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/gs)) {
    if (token[0] === "{") stack.push(new Set());
    else if (token[0] === "[") stack.push(null);
    else if (token[0] === "}" || token[0] === "]") stack.pop();
    else if (/^\s*:/.test(source.slice(token.index! + token[0].length))) {
      const name: string = JSON.parse(token[0]);
      validateUnicode(name);
      const keys = stack.at(-1);
      if (!(keys instanceof Set) || keys.has(name)) throw new TypeError("Embedded JSON contains duplicate object members");
      keys.add(name);
    }
  }
  return parsed as EmbeddedJsonValue;
}
