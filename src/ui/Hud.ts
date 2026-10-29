import { units } from '../app/units';

/** A value the user can type while drawing, like Fusion's on-screen inputs. */
export interface HudField {
  key: string;
  label: string;
  /** The value the cursor currently gives (mm or degrees). */
  live: number;
  kind: 'length' | 'angle';
}

const fmt = (f: HudField, v: number) => (f.kind === 'angle' ? v.toFixed(1) : units.num(v));
const parse = (f: HudField, text: string) => {
  if (f.kind === 'angle') {
    const v = Number(text.replace('°', ''));
    return text.trim() && Number.isFinite(v) ? v : null;
  }
  return units.parse(text);
};

/**
 * Small input boxes beside the cursor. Start typing a number to fill the
 * first box; Tab moves between boxes; Enter places the point using the typed
 * values; Esc clears them. A typed value is locked, so moving the mouse only
 * changes what wasn't typed.
 */
export class Hud {
  onChange: () => void = () => {};
  onCommit: () => void = () => {};

  private readonly el: HTMLDivElement;
  private fields: HudField[] = [];
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly locked = new Map<string, number>();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  /** The typed (locked) value for a field, if any. */
  get(key: string): number | undefined {
    return this.locked.get(key);
  }

  get lockedKeys(): string[] {
    return [...this.locked.keys()];
  }

  show(fields: HudField[], x: number, y: number) {
    if (fields.map((f) => f.key).join() !== this.fields.map((f) => f.key).join()) this.build(fields);
    this.fields = fields;
    for (const f of fields) {
      const input = this.inputs.get(f.key)!;
      const lockedValue = this.locked.get(f.key);
      input.classList.toggle('locked', lockedValue !== undefined);
      if (document.activeElement !== input) input.value = fmt(f, lockedValue ?? f.live);
    }
    this.el.hidden = false;
    this.el.style.transform = `translate(${x + 18}px, ${y + 18}px)`;
  }

  hide() {
    this.blur();
    this.reset();
    this.el.hidden = true;
    this.fields = [];
    this.el.replaceChildren();
    this.inputs.clear();
  }

  /** Clears typed values (after a point was placed). */
  reset() {
    this.locked.clear();
    this.blur();
  }

  /** Focuses the first box, starting it with `text` (the key that was pressed). */
  startTyping(text: string) {
    const first = this.fields[0];
    if (!first) return;
    const input = this.inputs.get(first.key)!;
    input.focus();
    input.value = text;
    this.read(first, input);
  }

  private blur() {
    if (this.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  private build(fields: HudField[]) {
    this.el.replaceChildren();
    this.inputs.clear();
    fields.forEach((f, i) => {
      const row = document.createElement('label');
      row.className = 'hud-row';
      const name = document.createElement('span');
      name.textContent = f.label;
      const input = document.createElement('input');
      input.inputMode = 'decimal';
      input.spellcheck = false;
      const unit = document.createElement('em');
      unit.textContent = f.kind === 'angle' ? '°' : units.unit;
      row.append(name, input, unit);
      this.el.appendChild(row);
      this.inputs.set(f.key, input);

      input.addEventListener('focus', () => input.select());
      input.addEventListener('input', () => this.read(this.fields[i], input));
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Tab') {
          e.preventDefault();
          const next = this.fields[(i + (e.shiftKey ? -1 : 1) + this.fields.length) % this.fields.length];
          this.inputs.get(next.key)!.focus();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this.onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.reset();
          this.onChange();
        }
      });
    });
  }

  private read(f: HudField, input: HTMLInputElement) {
    const v = parse(f, input.value);
    if (v === null) this.locked.delete(f.key);
    else this.locked.set(f.key, v);
    input.classList.toggle('locked', v !== null);
    this.onChange();
  }
}
