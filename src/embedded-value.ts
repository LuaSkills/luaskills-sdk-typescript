/**
 * Explicit finite floating-point intent, including integral magnitudes unsafe for plain JS integers.
 * 显式有限浮点意图，包含不适合普通 JS 整数的大幅值整数形浮点数。
 */
export class EmbeddedFloat {
  /** Exact IEEE-754 value, immutable after validation.
   * 精确 IEEE-754 值，校验后不可变。 */
  readonly value: number;

  /**
   * Construct an explicit float from value; reject NaN and infinities.
   * 从 value 构造显式浮点数；拒绝 NaN 和无穷值。
   * @param value Finite JavaScript floating-point value.
   * 有限 JavaScript 浮点值。
   */
  constructor(value: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("EmbeddedFloat requires a finite number");
    this.value = value;
    Object.freeze(this);
  }
}
