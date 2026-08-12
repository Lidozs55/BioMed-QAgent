/**
 * Measurement identity primitives (Python ``app/datasets/build/identity.py``;
 * Phase 5 D3 / T4).
 *
 * The Compatibility Gate's merge identity is the fixed ordered triple
 * ``(value_semantics, value_scale, expression_unit)``: two sources may only
 * be merged when all three agree.  ``value_scale`` is a ``ValueScale`` member
 * — ``raw_count`` is a value *semantics*, never a scale — and ``unknown`` is
 * an honest value that is never promoted to a known scale.
 */

import type { ValueScale } from "../contracts/index.js";
import { assertValueScale } from "../contracts/index.js";

/**
 * Ordered identity triple ``(value_semantics, value_scale, expression_unit)``.
 *
 * The ordering mirrors the Python frozen dataclass with ``order=True``: the
 * canonicalizer's ``measurement_identities`` statistic sorts by semantics,
 * then scale value, then unit.
 */
export class MeasurementIdentity {
  readonly value_semantics: string;
  readonly value_scale: ValueScale;
  readonly expression_unit: string;

  constructor(valueSemantics: string, valueScale: ValueScale, expressionUnit: string) {
    this.value_semantics = valueSemantics;
    this.value_scale = valueScale;
    this.expression_unit = expressionUnit;
  }

  /** Stable JSON-safe serialization for batch statistics (Python ``serialize``). */
  serialize(): string[] {
    return [this.value_semantics, this.value_scale, this.expression_unit];
  }

  /** Rebuild from a serialized triple, validating the scale is a ValueScale. */
  static deserialize(serialized: readonly string[]): MeasurementIdentity {
    const [semantics, scale, unit] = serialized;
    return new MeasurementIdentity(
      semantics,
      assertValueScale(scale, "ValueScale"),
      unit,
    );
  }

  /** Python dataclass ``order=True`` comparison (semantics → scale → unit). */
  compareTo(other: MeasurementIdentity): number {
    if (this.value_semantics < other.value_semantics) return -1;
    if (this.value_semantics > other.value_semantics) return 1;
    if (this.value_scale < other.value_scale) return -1;
    if (this.value_scale > other.value_scale) return 1;
    if (this.expression_unit < other.expression_unit) return -1;
    if (this.expression_unit > other.expression_unit) return 1;
    return 0;
  }

  /** Hash-key form (semantics, scale, unit) for set-style dedup. */
  key(): string {
    return `${this.value_semantics}\u0000${this.value_scale}\u0000${this.expression_unit}`;
  }
}