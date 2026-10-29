/**
 * Display units. Geometry is always stored in millimeters; this only changes
 * how lengths are shown and how typed values are read.
 */
export type Unit = 'mm' | 'in';

const MM_PER_INCH = 25.4;

let current: Unit = 'mm';
const listeners = new Set<() => void>();

export const units = {
  get unit(): Unit {
    return current;
  },

  set(unit: Unit) {
    if (unit === current) return;
    current = unit;
    for (const fn of listeners) fn();
  },

  onChange(fn: () => void) {
    listeners.add(fn);
  },

  /** A length (mm) as a number in the current unit, without the unit. */
  num(mm: number): string {
    return current === 'in' ? (mm / MM_PER_INCH).toFixed(3) : mm.toFixed(2);
  },

  /** A length (mm) with its unit, e.g. "25.40 mm" or "1.000 in". */
  fmt(mm: number): string {
    return `${this.num(mm)} ${current}`;
  },

  /**
   * Reads a typed length and returns it in mm, or null if it isn't one.
   * Accepts the current unit by default, or an explicit one: "25.4mm",
   * "1in", 1", and fractions like "3/8" or "1 3/8".
   */
  parse(text: string): number | null {
    let t = text.trim().toLowerCase();
    let unit: Unit = current;
    const suffix = t.match(/(mm|in|")$/);
    if (suffix) {
      unit = suffix[1] === 'mm' ? 'mm' : 'in';
      t = t.slice(0, -suffix[1].length).trim();
    }
    let value: number;
    const mixed = t.match(/^(-?\d+)\s+(\d+)\/(\d+)$/);
    const frac = t.match(/^(-?\d+)\/(\d+)$/);
    if (mixed) value = Number(mixed[1]) + Math.sign(Number(mixed[1]) || 1) * (Number(mixed[2]) / Number(mixed[3]));
    else if (frac) value = Number(frac[1]) / Number(frac[2]);
    else value = Number(t);
    if (!t || !Number.isFinite(value)) return null;
    return unit === 'in' ? value * MM_PER_INCH : value;
  },
};
