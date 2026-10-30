import * as THREE from 'three';
import { PLANES } from '../app/alignMath';
import { units } from '../app/units';
import { planeAxesLocal, planePointAt, toScreen } from '../sketch/planePoint';
import type { SnapContext, SnapResult } from '../sketch/Snap';
import { rectCorners, type RectShape } from '../sketch/rect';
import {
  arcMidpoint, arcPoints, circlePoints, circleThrough, entityPolyline, splinePoints,
  type DimensionKind, type Entity, type EntityKind, type NewEntity, type Sketch,
} from '../sketch/Sketch';
import type { Viewer } from '../viewer/Viewer';
import type { PanelButton } from '../ui/CommandPanel';
import type { HudField } from '../ui/Hud';
import type { Hit } from '../viewer/Viewer';
import type { Tool, ToolContext } from './Tool';

// Clicking within this many pixels of a shape's first point closes it.
const CLOSE_PX = 9;

/**
 * Shared behavior for drawing tools: they draw on the 2D sketch plane
 * (switching to 2D Top if needed), track the cursor for live previews, and
 * stay active until Done or Esc.
 */
abstract class SketchTool implements Tool {
  abstract readonly id: string;
  readonly picks = true;
  /** Cursor position on the sketch plane, in scan coordinates. */
  protected cursor: THREE.Vector3 | null = null;
  protected cursorScreen = { x: 0, y: 0 };
  /** What the last cursor position snapped to. */
  protected lastSnap: SnapResult | null = null;

  constructor(protected readonly ctx: ToolContext) {}

  protected get plane() {
    return this.ctx.session.plane;
  }

  start() {
    if (!this.ctx.session.view2d) this.ctx.session.enter2D('top');
    this.refresh();
  }

  move(e: PointerEvent) {
    this.cursor = this.snapAt(e);
    this.refresh();
  }

  click(_hit: Hit | null, e: PointerEvent) {
    const p = this.snapAt(e);
    if (p) this.place(p, e);
    this.ctx.hud.reset(); // typed values apply to one point
    this.refresh();
  }

  /** Values that can be typed in the current state (e.g. a line's length and angle). */
  protected fields(): HudField[] {
    return [];
  }

  acceptsTyping() {
    return this.fields().length > 0;
  }

  hudChanged() {
    this.refresh();
  }

  typedCommit() {
    if (this.cursor) {
      const { x, y } = this.cursorScreen;
      this.place(this.cursor, { detail: 1, clientX: x, clientY: y } as PointerEvent);
    }
    this.ctx.hud.reset();
    this.refresh();
  }

  /** Extra snapping context, such as where the current line starts. */
  protected snapContext(): Partial<SnapContext> {
    return {};
  }

  /** Cursor position on the sketch plane after snapping (⌘ turns snapping off). */
  private snapAt(e: PointerEvent): THREE.Vector3 | null {
    this.cursorScreen = { x: e.clientX, y: e.clientY };
    const s = this.ctx.snapper.snap(e.clientX, e.clientY, { plane: this.plane, ...this.snapContext(), lock: e.shiftKey }, e.metaKey);
    this.lastSnap = s;
    this.ctx.snapOverlay.show(s);
    return s?.point ?? null;
  }

  key(_e: KeyboardEvent): boolean {
    return false;
  }

  /** Done: keep anything in progress, then leave the tool. */
  commit() {
    this.flush();
    this.finish();
  }

  /** Esc or switching tools: drop anything in progress. */
  cancel() {
    this.finish();
  }

  /** Saves a shape that's still being drawn, if it's complete enough. */
  protected flush() {}

  protected abstract place(p: THREE.Vector3, e: PointerEvent): void;
  protected abstract refresh(): void;

  protected finish() {
    this.ctx.hud.hide();
    this.ctx.snapOverlay.hide();
    this.ctx.sketchView.setPreview([]);
    this.ctx.setCursorLabel(null);
    this.ctx.viewer.requestRender();
    this.ctx.done();
  }

  /** Adds a shape as one undo step, with dimensions for any values that were typed. */
  protected add(
    label: string,
    kind: EntityKind,
    pts: THREE.Vector3[],
    extra: Partial<NewEntity> = {},
    dims: DimensionKind[] = [],
  ) {
    this.ctx.session.editSketch(label, () => {
      const e = this.ctx.sketch.add({ kind, plane: this.plane, pts: pts.map((p) => p.clone()), ...extra });
      for (const d of dims) this.ctx.sketch.addDim(d, e.id);
    });
  }

  /**
   * If the last click snapped onto a centerline, its id: a shape centered
   * there gets locked to slide along it.
   */
  protected centerlineUnderCursor(): number | undefined {
    const s = this.lastSnap;
    if (!s || s.entityId === undefined || !['on', 'midpoint', 'endpoint'].includes(s.kind ?? '')) return undefined;
    const e = this.ctx.sketch.get(s.entityId);
    return e?.kind === 'line' && e.construction ? e.id : undefined;
  }

  /** True if a scan-coordinate point is within CLOSE_PX of the cursor. */
  protected nearCursor(p: THREE.Vector3): boolean {
    const s = toScreen(this.ctx.viewer, p);
    return Math.hypot(s.x - this.cursorScreen.x, s.y - this.cursorScreen.y) < CLOSE_PX;
  }

  protected label(text: string | null) {
    this.ctx.setCursorLabel(text, this.cursorScreen.x, this.cursorScreen.y);
  }

  /** Angle of a direction within the sketch plane, in degrees from the plane's right axis. */
  protected angleOf(d: THREE.Vector3): number {
    const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
    return THREE.MathUtils.radToDeg(Math.atan2(d.dot(up), d.dot(right)));
  }

  protected show(title: string, note: string, preview: THREE.Vector3[][], dots: THREE.Vector3[], prompt: string) {
    this.showWith(title, note, preview, dots, prompt, []);
  }

  protected showWith(
    title: string,
    note: string,
    preview: THREE.Vector3[][],
    dots: THREE.Vector3[],
    prompt: string,
    rows: PanelButton[][],
  ) {
    this.ctx.sketchView.setPreview(preview, dots);
    this.ctx.viewer.requestRender();
    this.ctx.setPrompt(prompt);
    const fields = this.fields();
    if (fields.length) {
      this.ctx.setCursorLabel(null); // the inputs show the values instead
      this.ctx.hud.show(fields, this.cursorScreen.x, this.cursorScreen.y);
    } else {
      this.ctx.hud.hide();
    }
    this.ctx.panel.show({
      title,
      note,
      okEnabled: true,
      okLabel: 'Done',
      hideCancel: true,
      rows,
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}

export class PointTool extends SketchTool {
  readonly id = 'point';

  protected place(p: THREE.Vector3) {
    this.add('Point', 'point', [p]);
  }

  protected refresh() {
    this.label(null);
    this.show(
      'Point',
      'Click to place points.',
      [],
      this.cursor ? [this.cursor] : [],
      'Point: click to place a point · Esc when done',
    );
  }
}

export class LineTool extends SketchTool {
  readonly id = 'line';
  /** Where the next segment starts, while a chain is in progress. */
  private from: THREE.Vector3 | null = null;
  private chainStart: THREE.Vector3 | null = null;
  private segments = 0;
  /** Direction that perpendicular/parallel guides are measured from. */
  private refDir: THREE.Vector3 | null = null;
  /** Draw centerlines (construction lines) instead of part lines. */
  private construction = false;

  protected snapContext(): Partial<SnapContext> {
    return { from: this.from, refDir: this.refDir };
  }

  protected fields(): HudField[] {
    if (!this.from || !this.cursor) return [];
    const d = this.cursor.clone().sub(this.from);
    return [
      { key: 'length', label: 'Length', live: d.length(), kind: 'length' },
      { key: 'angle', label: 'Angle', live: this.angleOf(d), kind: 'angle' },
    ];
  }

  private typed() {
    return this.ctx.hud.get('length') !== undefined || this.ctx.hud.get('angle') !== undefined;
  }

  /** Where the segment to cursor `p` ends once typed length and angle are applied. */
  private endFor(p: THREE.Vector3): THREE.Vector3 {
    if (!this.from || !this.typed()) return p;
    const length = this.ctx.hud.get('length');
    const angle = this.ctx.hud.get('angle');
    const toCursor = p.clone().sub(this.from);
    let dir: THREE.Vector3;
    if (angle !== undefined) {
      const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
      const a = THREE.MathUtils.degToRad(angle);
      dir = right.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
    } else {
      dir = toCursor.lengthSq() > 0 ? toCursor.clone().normalize() : planeAxesLocal(this.ctx.viewer, this.plane).right;
    }
    const len = length ?? Math.max(0, toCursor.dot(dir));
    return this.from.clone().addScaledVector(dir, len);
  }

  protected place(p: THREE.Vector3, e: PointerEvent) {
    if (e.detail >= 2) {
      this.endChain(); // second click of a double-click
      return;
    }
    if (this.from) p = this.endFor(p);
    if (!this.from) {
      this.from = this.chainStart = p;
      this.segments = 0;
      // Starting on an existing line offers guides square to that line.
      const start = this.lastSnap?.entityId !== undefined ? this.ctx.sketch.get(this.lastSnap.entityId) : undefined;
      this.refDir = start?.kind === 'line' ? start.pts[1].clone().sub(start.pts[0]) : null;
      return;
    }
    const closing = !this.typed() && this.closing();
    const end = closing ? this.chainStart!.clone() : p;
    if (end.distanceTo(this.from) < 1e-6) return;
    this.add(
      this.construction ? 'Centerline' : 'Line',
      'line',
      [this.from, end],
      { construction: this.construction || undefined },
      this.ctx.hud.get('length') !== undefined ? ['length'] : [],
    );
    this.segments++;
    // The next segment's guides are measured from this one, for square corners.
    this.refDir = end.clone().sub(this.from);
    if (closing) this.endChain();
    else this.from = end;
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'x' || e.key === 'X') {
      this.construction = !this.construction;
      this.refresh();
      return true;
    }
    if ((e.key === 'Escape' || e.key === 'Enter') && this.from) {
      this.endChain();
      this.refresh();
      return true;
    }
    return false;
  }

  private closing(): boolean {
    return this.segments >= 2 && !!this.chainStart && this.nearCursor(this.chainStart);
  }

  private endChain() {
    this.refDir = null;
    this.from = this.chainStart = null;
    this.segments = 0;
  }

  protected refresh() {
    const preview: THREE.Vector3[][] = [];
    if (this.from && this.cursor) {
      const end = !this.typed() && this.closing() ? this.chainStart! : this.endFor(this.cursor);
      const d = end.clone().sub(this.from);
      preview.push([this.from, end]);
      this.label(`${units.fmt(d.length())} · ${this.angleOf(d).toFixed(1)}°`);
    } else {
      this.label(null);
    }
    this.showWith(
      this.construction ? 'Centerline' : 'Line',
      'Click points to draw connected lines. Click the first point to close the shape.',
      preview,
      this.from ? [this.from] : this.cursor ? [this.cursor] : [],
      this.from
        ? 'Line: click the next point · Shift locks level/plumb · ⌘ turns off snapping · double-click, Enter or Esc ends this line · X centerline'
        : 'Line: click to start a line · X toggles centerline · Esc when done',
      [[{ label: 'Centerline (construction)', title: 'X', on: this.construction, onClick: () => { this.construction = !this.construction; this.refresh(); } }]],
    );
  }
}

/** Fusion's Center Diameter Circle: click the center, then a point on the edge. */
export class CenterCircleTool extends SketchTool {
  readonly id = 'centerCircle';
  private center: THREE.Vector3 | null = null;
  private centerOn: number | undefined;

  protected place(p: THREE.Vector3) {
    if (!this.center) {
      this.center = p;
      this.centerOn = this.centerlineUnderCursor();
      return;
    }
    const typed = this.ctx.hud.get('diameter');
    const r = typed !== undefined ? typed / 2 : p.distanceTo(this.center);
    if (r < 1e-6) return;
    // Circles are stored as three points on them, so both circle tools save the same shape.
    const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
    const c = this.center;
    this.add(
      'Circle',
      'circle',
      [c.clone().addScaledVector(right, r), c.clone().addScaledVector(up, r), c.clone().addScaledVector(right, -r)],
      { centerOn: this.centerOn },
      typed !== undefined ? ['diameter'] : [],
    );
    this.center = null;
  }

  protected fields(): HudField[] {
    if (!this.center || !this.cursor) return [];
    return [{ key: 'diameter', label: 'Diameter', live: this.cursor.distanceTo(this.center) * 2, kind: 'length' }];
  }

  key(e: KeyboardEvent): boolean {
    if ((e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') && this.center) {
      this.center = null;
      this.refresh();
      return true;
    }
    return false;
  }

  protected refresh() {
    const preview: THREE.Vector3[][] = [];
    this.label(null);
    if (this.center && this.cursor) {
      const typed = this.ctx.hud.get('diameter');
      const r = typed !== undefined ? typed / 2 : this.cursor.distanceTo(this.center);
      if (r > 1e-6) {
        const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
        preview.push(circlePoints(this.center, r, new THREE.Vector3().crossVectors(right, up)), [this.center, this.cursor]);
        this.label(`Ø ${units.fmt(r * 2)}`);
      }
    }
    this.show(
      'Center Circle',
      'Click the center, then click a point on the edge.',
      preview,
      this.center ? [this.center] : this.cursor ? [this.cursor] : [],
      this.center
        ? 'Center Circle: click a point on the edge to set the size · Esc starts over'
        : 'Center Circle: click the center · Esc when done',
    );
  }
}

export class CircleTool extends SketchTool {
  readonly id = 'circle';
  private pts: THREE.Vector3[] = [];

  protected place(p: THREE.Vector3) {
    if (this.pts.length < 2) {
      if (!this.pts.length || p.distanceTo(this.pts[this.pts.length - 1]) > 1e-6) this.pts.push(p);
      return;
    }
    if (!circleThrough(this.pts[0], this.pts[1], p)) {
      this.ctx.notify('Those three points are in a line. Pick a third point off the line.');
      return;
    }
    this.add('Circle', 'circle', [...this.pts, p]);
    this.pts = [];
  }

  key(e: KeyboardEvent): boolean {
    if ((e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') && this.pts.length) {
      if (e.key === 'Escape') this.pts = [];
      else this.pts.pop();
      this.refresh();
      return true;
    }
    return false;
  }

  protected refresh() {
    const preview: THREE.Vector3[][] = [];
    this.label(null);
    if (this.cursor && this.pts.length === 1) {
      preview.push([this.pts[0], this.cursor]);
    } else if (this.cursor && this.pts.length === 2) {
      const c = circleThrough(this.pts[0], this.pts[1], this.cursor);
      if (c) {
        preview.push(circlePoints(c.center, c.radius, c.normal));
        this.label(`Ø ${units.fmt(c.radius * 2)}`);
      }
    }
    const n = this.pts.length + 1;
    this.show(
      '3-Point Circle',
      'Click three points on the edge of a round feature.',
      preview,
      this.pts.length ? this.pts : this.cursor ? [this.cursor] : [],
      `3-Point Circle: click point ${n} of 3 on the edge · Backspace removes the last point · Esc when done`,
    );
  }
}

/** Arc through a start, an end, and a third point that sets how far it bends. Arcs are stored as [start, midpoint, end]. */
export class ThreePointArcTool extends SketchTool {
  readonly id = 'arc3';
  private pts: THREE.Vector3[] = [];

  /** The arc from the two picked ends bending toward `p`: through `p`, or with the typed radius on p's side. */
  private arcFor(p: THREE.Vector3): THREE.Vector3[] | null {
    const [a, b] = this.pts;
    const typed = this.ctx.hud.get('radius');
    if (typed === undefined) {
      const mid = arcMidpoint(a, p, b);
      return mid ? [a, mid, b] : null;
    }
    const half = a.distanceTo(b) / 2;
    if (typed < half) return null;
    const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
    const chord = b.clone().sub(a).normalize();
    const across = new THREE.Vector3().crossVectors(new THREE.Vector3().crossVectors(right, up), chord);
    const middle = a.clone().lerp(b, 0.5);
    const side = p.clone().sub(middle).dot(across) < 0 ? -1 : 1;
    // The shorter of the two arcs with this radius, bulging toward the cursor.
    const rise = typed - Math.sqrt(typed * typed - half * half);
    return [a, middle.addScaledVector(across, side * rise), b];
  }

  protected place(p: THREE.Vector3) {
    if (this.pts.length < 2) {
      if (!this.pts.length || p.distanceTo(this.pts[0]) > 1e-6) this.pts.push(p);
      return;
    }
    const arc = this.arcFor(p);
    if (!arc) {
      this.ctx.notify(
        this.ctx.hud.get('radius') !== undefined
          ? 'That radius is too small to reach between the two ends. Type at least half the distance between them.'
          : 'That point is in line with the two ends. Move it to one side to bend the arc.',
      );
      return;
    }
    this.add('Arc', 'arc', arc, {}, this.ctx.hud.get('radius') !== undefined ? ['radius'] : []);
    this.pts = [];
  }

  protected fields(): HudField[] {
    if (this.pts.length < 2 || !this.cursor) return [];
    const c = circleThrough(this.pts[0], this.cursor, this.pts[1]);
    return [{ key: 'radius', label: 'Radius', live: c?.radius ?? 0, kind: 'length' }];
  }

  key(e: KeyboardEvent): boolean {
    if ((e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') && this.pts.length) {
      if (e.key === 'Escape') this.pts = [];
      else this.pts.pop();
      this.refresh();
      return true;
    }
    return false;
  }

  protected refresh() {
    const preview: THREE.Vector3[][] = [];
    this.label(null);
    if (this.cursor && this.pts.length === 1) {
      preview.push([this.pts[0], this.cursor]);
      this.label(units.fmt(this.pts[0].distanceTo(this.cursor)));
    } else if (this.cursor && this.pts.length === 2) {
      const arc = this.arcFor(this.cursor);
      const drawn = arc && arcPoints(arc[0], arc[1], arc[2]);
      if (drawn) preview.push(drawn);
      else preview.push([this.pts[0], this.pts[1]]);
    }
    const step = ['start', 'end', 'bend'][this.pts.length];
    this.show(
      '3-Point Arc',
      'Click where the arc starts and ends, then move the mouse to bend it and click. Type a radius to set its size.',
      preview,
      this.pts.length ? this.pts : this.cursor ? [this.cursor] : [],
      step === 'bend'
        ? '3-Point Arc: move to bend the arc, click to finish · type a radius · Backspace removes the last point'
        : `3-Point Arc: click the ${step} point · Esc when done`,
    );
  }
}

/** Arc around a center: click the center, then the start (setting the radius), then sweep round to the end. */
export class CenterArcTool extends SketchTool {
  readonly id = 'centerArc';
  private center: THREE.Vector3 | null = null;
  /** Where the arc starts; its distance from the center is the radius. */
  private from: THREE.Vector3 | null = null;
  /** Whether the radius was typed, so the finished arc gets a radius dimension. */
  private startRadiusTyped = false;
  /** Signed angle swept so far from the start, following the cursor round (counterclockwise is positive). */
  private sweep = 0;
  private lastAngle = 0;

  private get normal() {
    const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
    return new THREE.Vector3().crossVectors(right, up).normalize();
  }

  private angleAt(p: THREE.Vector3) {
    return THREE.MathUtils.degToRad(this.angleOf(p.clone().sub(this.center!)));
  }

  /** Follows the cursor round the center, so the arc can sweep past 180° in either direction. */
  private track(p: THREE.Vector3) {
    if (!this.center || !this.from || p.distanceTo(this.center) < 1e-9) return;
    const a = this.angleAt(p);
    let d = a - this.lastAngle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.sweep = THREE.MathUtils.clamp(this.sweep + d, -Math.PI * 2, Math.PI * 2);
    this.lastAngle = a;
  }

  /** The sweep to draw: a typed angle (in the direction being swept) or the tracked one. */
  private currentSweep() {
    const typed = this.ctx.hud.get('angle');
    if (typed === undefined) return this.sweep;
    const sign = this.sweep < 0 ? -1 : 1;
    return sign * THREE.MathUtils.degToRad(Math.min(Math.abs(typed), 359.9));
  }

  private arc(): THREE.Vector3[] | null {
    const sweep = THREE.MathUtils.clamp(this.currentSweep(), -Math.PI * 2 + 1e-3, Math.PI * 2 - 1e-3);
    if (!this.center || !this.from || Math.abs(sweep) < 1e-4) return null;
    const rel = this.from.clone().sub(this.center);
    const at = (t: number) => this.center!.clone().add(rel.clone().applyAxisAngle(this.normal, t));
    return [this.from, at(sweep / 2), at(sweep)];
  }

  protected place(p: THREE.Vector3) {
    if (!this.center) {
      this.center = p;
      return;
    }
    if (!this.from) {
      const typed = this.ctx.hud.get('radius');
      const r = typed ?? p.distanceTo(this.center);
      if (r < 1e-6) return;
      const dir = p.distanceTo(this.center) > 1e-9 ? p.clone().sub(this.center).normalize() : planeAxesLocal(this.ctx.viewer, this.plane).right;
      this.from = this.center.clone().addScaledVector(dir, r);
      this.startRadiusTyped = typed !== undefined;
      this.sweep = 0;
      this.lastAngle = this.angleAt(this.from);
      return;
    }
    this.track(p);
    const arc = this.arc();
    if (!arc) return;
    this.add('Arc', 'arc', arc, {}, this.startRadiusTyped ? ['radius'] : []);
    this.center = this.from = null;
  }

  protected fields(): HudField[] {
    if (!this.center || !this.cursor) return [];
    if (!this.from) return [{ key: 'radius', label: 'Radius', live: this.cursor.distanceTo(this.center), kind: 'length' }];
    return [{ key: 'angle', label: 'Angle', live: Math.abs(THREE.MathUtils.radToDeg(this.sweep)), kind: 'angle' }];
  }

  key(e: KeyboardEvent): boolean {
    if ((e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') && this.center) {
      if (e.key !== 'Escape' && this.from) this.from = null;
      else this.center = this.from = null;
      this.refresh();
      return true;
    }
    return false;
  }

  protected refresh() {
    if (this.cursor) this.track(this.cursor);
    const preview: THREE.Vector3[][] = [];
    this.label(null);
    if (this.center && !this.from && this.cursor) {
      const typed = this.ctx.hud.get('radius');
      const r = typed ?? this.cursor.distanceTo(this.center);
      if (r > 1e-6) {
        preview.push([this.center, this.cursor]);
        this.label(`R ${units.fmt(r)}`);
      }
    } else if (this.center && this.from) {
      const arc = this.arc();
      const drawn = arc && arcPoints(arc[0], arc[1], arc[2]);
      preview.push([this.center, this.from]);
      if (drawn) preview.push(drawn, [this.center, arc[2]]);
    }
    this.show(
      'Center Point Arc',
      'Click the center, then where the arc starts, then sweep around to where it ends. Type a radius or an angle to set them exactly.',
      preview,
      [this.center, this.from, ...(this.center ? [] : this.cursor ? [this.cursor] : [])].filter((p): p is THREE.Vector3 => !!p),
      !this.center
        ? 'Center Point Arc: click the center · Esc when done'
        : !this.from
          ? 'Center Point Arc: click where the arc starts (sets the radius) · type a radius · Esc starts over'
          : 'Center Point Arc: sweep round and click where it ends · type an angle · Backspace picks the start again',
    );
  }
}

/**
 * Fit-point spline. Starting on the end of an existing spline continues that
 * spline; starting or ending on a line's end can leave or meet the line
 * smoothly (Tangent, T).
 */
export class SplineTool extends SketchTool {
  readonly id = 'spline';
  /** New fit points, in drawing order. */
  private pts: THREE.Vector3[] = [];
  /** The spline being continued, and whether we're growing it from its first point. */
  private extending: { entity: Entity; atStart: boolean } | null = null;
  /** Direction of travel out of / into a line whose end the spline starts / finishes on. */
  private startDir: THREE.Vector3 | null = null;
  private endDir: THREE.Vector3 | null = null;
  private tangent = false;

  protected place(p: THREE.Vector3, e: PointerEvent) {
    if (e.detail >= 2) {
      this.saveSpline(false); // second click of a double-click
      return;
    }
    if (this.closing()) {
      this.saveSpline(true);
      return;
    }
    const last = this.pts[this.pts.length - 1];
    if (last && p.distanceTo(last) < 1e-6) return;

    const snapped = this.snappedEnd();
    if (!this.pts.length) {
      const spline = snapped?.entity.kind === 'spline' && !snapped.entity.closed ? snapped : null;
      if (spline) {
        // Continue the existing spline instead of starting a new one.
        this.extending = { entity: spline.entity, atStart: spline.atStart };
        return;
      }
      this.startDir = snapped?.entity.kind === 'line' ? snapped.outward : null;
      this.pts.push(p);
      return;
    }
    // A line end on a later point might be where the spline finishes; remember its direction.
    this.endDir = snapped?.entity.kind === 'line' ? snapped.outward.clone().negate() : null;
    this.pts.push(p);
  }

  /**
   * If the cursor snapped onto the first or last point of a line or spline:
   * that entity, which end, and the direction pointing out of the shape there.
   */
  private snappedEnd() {
    const s = this.lastSnap;
    if (s?.kind !== 'endpoint' || s.entityId === undefined) return null;
    const entity = this.ctx.sketch.get(s.entityId);
    if (!entity || (entity.kind !== 'line' && entity.kind !== 'spline')) return null;
    const first = entity.pts[0];
    const last = entity.pts[entity.pts.length - 1];
    const atStart = first.distanceTo(s.point) < 1e-6;
    if (!atStart && last.distanceTo(s.point) >= 1e-6) return null;
    const [end, inner] = atStart ? [first, entity.pts[1]] : [last, entity.pts[entity.pts.length - 2]];
    return { entity, atStart, outward: end.clone().sub(inner).normalize() };
  }

  key(e: KeyboardEvent): boolean {
    if ((e.key === 't' || e.key === 'T') && this.canTangent()) {
      this.tangent = !this.tangent;
      this.refresh();
      return true;
    }
    if (!this.pts.length && !this.extending) return false;
    if (e.key === 'Enter' || e.key === 'Escape') {
      // Esc keeps a spline that has enough points rather than throwing the work away.
      if (this.enoughPoints()) this.saveSpline(false);
      else this.reset();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.pts.length) this.pts.pop();
      else this.reset();
    } else {
      return false;
    }
    this.refresh();
    return true;
  }

  protected flush() {
    this.saveSpline(false);
  }

  private enoughPoints() {
    return this.extending ? this.pts.length >= 1 : this.pts.length >= 2;
  }

  private canTangent() {
    return !!(this.startDir || this.endDir);
  }

  private reset() {
    this.pts = [];
    this.extending = null;
    this.startDir = this.endDir = null;
  }

  private closing(): boolean {
    return !this.extending && this.pts.length >= 3 && this.nearCursor(this.pts[0]);
  }

  /** All fit points in drawing order, including the spline being continued. */
  private allPoints(extra: THREE.Vector3[] = []): THREE.Vector3[] {
    const added = [...this.pts, ...extra];
    if (!this.extending) return added;
    const { entity, atStart } = this.extending;
    const existing = atStart ? [...entity.pts].reverse() : entity.pts;
    return [...existing, ...added];
  }

  private tangentsFor(): Entity['tangents'] {
    if (!this.tangent || this.extending) return undefined;
    const t: Entity['tangents'] = {};
    if (this.startDir) t.start = this.startDir.clone();
    // The end tangent only applies if the last point is the line end it was recorded for.
    const last = this.pts[this.pts.length - 1];
    if (this.endDir && last && this.lastPointOnLineEnd(last)) t.end = this.endDir.clone();
    return t.start || t.end ? t : undefined;
  }

  private lastPointOnLineEnd(p: THREE.Vector3) {
    return this.ctx.sketch.entities.some((e) => e.kind === 'line' && e.pts.some((q) => q.distanceTo(p) < 1e-6));
  }

  private saveSpline(closed: boolean) {
    if (this.extending && this.pts.length) {
      const { entity, atStart } = this.extending;
      const added = this.pts;
      this.ctx.session.editSketch('Extend spline', () => {
        entity.pts = atStart ? [...[...added].reverse(), ...entity.pts] : [...entity.pts, ...added];
        // The end it grew from is no longer an end, so its fixed direction no longer applies.
        if (entity.tangents) {
          if (atStart) delete entity.tangents.start;
          else delete entity.tangents.end;
        }
        this.ctx.sketch.touch();
      });
    } else if (!this.extending && this.pts.length >= 2) {
      this.ctx.session.editSketch('Spline', () => {
        this.ctx.sketch.add({
          kind: 'spline',
          plane: this.plane,
          pts: this.pts.map((p) => p.clone()),
          closed: closed || undefined,
          tangents: closed ? undefined : this.tangentsFor(),
        });
      });
    }
    this.reset();
  }

  protected refresh() {
    this.label(null);
    let preview: THREE.Vector3[][] = [];
    const started = this.pts.length > 0 || !!this.extending;
    if (started) {
      if (this.closing()) {
        preview = [splinePoints(this.pts, true)];
      } else {
        const pts = this.allPoints(this.cursor ? [this.cursor] : []);
        const tangents = this.tangent && !this.extending && this.startDir ? { start: this.startDir } : undefined;
        if (pts.length >= 2) preview = [splinePoints(pts, false, tangents)];
      }
    }
    const tangentRow = this.canTangent()
      ? [[{ label: 'Tangent to line', title: 'T', on: this.tangent, onClick: () => { this.tangent = !this.tangent; this.refresh(); } }]]
      : [];
    this.showWith(
      this.extending ? 'Spline · continuing' : 'Spline',
      'Click points along the curve. Start on the end of a spline to continue it; click the first point to close.',
      preview,
      started ? this.allPoints() : this.cursor ? [this.cursor] : [],
      started
        ? 'Spline: click the next point · Backspace removes the last · double-click or Enter finishes'
        : 'Spline: click to start a curve, or click the end of a spline to continue it · Esc when done',
      tangentRow,
    );
  }
}

/** Shared behavior for the two rectangle tools: two clicks, aligned to the sketch plane's axes. */
abstract class RectTool extends SketchTool {
  protected first: THREE.Vector3 | null = null;
  private centerOn: number | undefined;
  protected abstract readonly centered: boolean;
  protected abstract readonly title: string;

  /** The rectangle from the first click to `p`, or null if it has no area. */
  protected shapeTo(p: THREE.Vector3): RectShape | null {
    if (!this.first) return null;
    const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
    const d = p.clone().sub(this.first);
    // Typed sizes win; the cursor still picks which way the rectangle goes.
    const sx = Math.sign(d.dot(right)) || 1;
    const sy = Math.sign(d.dot(up)) || 1;
    const scale = this.centered ? 2 : 1;
    const w = this.ctx.hud.get('width') ?? Math.abs(d.dot(right)) * scale;
    const h = this.ctx.hud.get('height') ?? Math.abs(d.dot(up)) * scale;
    if (w < 1e-4 || h < 1e-4) return null;
    if (this.centered) return { center: this.first.clone(), u: right, v: up, w, h };
    // Orient the axes so corner 0 is the first click.
    return {
      center: this.first.clone().addScaledVector(right, (sx * w) / 2).addScaledVector(up, (sy * h) / 2),
      u: right.clone().multiplyScalar(sx),
      v: up.clone().multiplyScalar(sy),
      w,
      h,
    };
  }

  protected place(p: THREE.Vector3) {
    if (!this.first) {
      this.first = p;
      this.centerOn = this.centered ? this.centerlineUnderCursor() : undefined;
      return;
    }
    const shape = this.shapeTo(p);
    if (!shape) return;
    this.addRect(shape);
    this.first = null;
  }

  protected fields(): HudField[] {
    if (!this.first || !this.cursor) return [];
    const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
    const d = this.cursor.clone().sub(this.first);
    const scale = this.centered ? 2 : 1;
    return [
      { key: 'width', label: 'Width', live: Math.abs(d.dot(right)) * scale, kind: 'length' },
      { key: 'height', label: 'Height', live: Math.abs(d.dot(up)) * scale, kind: 'length' },
    ];
  }

  protected addRect(shape: RectShape) {
    const { sketch, session, hud } = this.ctx;
    const dimWidth = hud.get('width') !== undefined;
    const dimHeight = hud.get('height') !== undefined;
    const corners = rectCorners(shape);
    session.editSketch('Rectangle', () => {
      const sides = [0, 1, 2, 3].map((i) =>
        sketch.add({ kind: 'line', plane: this.plane, pts: [corners[i].clone(), corners[(i + 1) % 4].clone()] }),
      );
      sides.forEach((side, i) => {
        side.rect = { group: sides[0].id, side: i as 0 | 1 | 2 | 3, centered: this.centered };
        if (this.centerOn !== undefined) side.centerOn = this.centerOn;
      });
      if (dimWidth) sketch.addDim('length', sides[0].id);
      if (dimHeight) sketch.addDim('length', sides[1].id);
      sketch.touch();
    });
  }

  key(e: KeyboardEvent): boolean {
    if ((e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') && this.first) {
      this.first = null;
      this.refresh();
      return true;
    }
    return false;
  }

  protected refresh() {
    const shape = this.cursor ? this.shapeTo(this.cursor) : null;
    const preview: THREE.Vector3[][] = [];
    if (shape) {
      const c = rectCorners(shape);
      preview.push([...c, c[0]]);
      this.label(`${units.fmt(shape.w)} × ${units.fmt(shape.h)}`);
    } else {
      this.label(null);
    }
    const firstStep = this.centered ? 'click the center' : 'click the first corner';
    this.show(
      this.title,
      this.centered
        ? 'Click the center, then a corner. Start on a centerline to keep the rectangle centered on it.'
        : 'Click one corner, then the opposite corner.',
      preview,
      this.first ? [this.first] : this.cursor ? [this.cursor] : [],
      this.first
        ? `${this.title}: click the ${this.centered ? 'corner' : 'opposite corner'} · Esc starts over`
        : `${this.title}: ${firstStep} · Esc when done`,
    );
  }
}

export class CornerRectTool extends RectTool {
  readonly id = 'cornerRect';
  protected readonly centered = false;
  protected readonly title = '2-Point Rectangle';
}

export class CenterRectTool extends RectTool {
  readonly id = 'centerRect';
  protected readonly centered = true;
  protected readonly title = 'Center Rectangle';
}

/** A corner where two lines share an end. `e1`/`e2` say which end of each line is at the corner. */
interface Corner {
  c: THREE.Vector3;
  l1: Entity;
  l2: Entity;
  e1: 0 | 1;
  e2: 0 | 1;
}

// How close (pixels) the cursor must be to a corner to pick it.
const CORNER_PX = 14;

/**
 * Fusion-style Fillet: click a corner where two lines meet, then size the
 * round with the mouse or type a radius. The lines are trimmed back and a
 * tangent arc joins them. The radius is remembered, so further corners take
 * one click each.
 */
export class FilletTool extends SketchTool {
  readonly id = 'fillet';
  private static lastRadius: number | null = null;
  /** The corner being sized (after the first click when no radius is remembered yet). */
  private corner: Corner | null = null;
  private hover: Corner | null = null;

  move(e: PointerEvent) {
    this.cursorScreen = { x: e.clientX, y: e.clientY };
    this.cursor = planePointAt(this.ctx.viewer, this.plane, e.clientX, e.clientY);
    if (!this.corner) this.hover = this.cornerAt(e.clientX, e.clientY);
    this.refresh();
  }

  click(_hit: Hit | null, e: PointerEvent) {
    this.cursorScreen = { x: e.clientX, y: e.clientY };
    this.cursor = planePointAt(this.ctx.viewer, this.plane, e.clientX, e.clientY);
    if (this.corner) {
      this.apply(this.corner, this.radiusFor(this.corner));
      this.corner = null;
    } else {
      const picked = this.cornerAt(e.clientX, e.clientY);
      if (!picked) return;
      const typed = this.ctx.hud.get('radius');
      if (typed !== undefined || FilletTool.lastRadius !== null) {
        this.apply(picked, typed ?? FilletTool.lastRadius!);
      } else {
        this.corner = picked; // first fillet: size it with the mouse
      }
    }
    this.ctx.hud.reset();
    this.hover = this.cornerAt(e.clientX, e.clientY);
    this.refresh();
  }

  typedCommit() {
    const target = this.corner ?? this.hover;
    if (target) this.apply(target, this.radiusFor(target));
    this.corner = null;
    this.ctx.hud.reset();
    this.refresh();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.corner) {
      this.corner = null;
      this.refresh();
      return true;
    }
    return false;
  }

  protected place() {}

  protected fields(): HudField[] {
    const target = this.corner ?? this.hover;
    if (!target || (!this.corner && FilletTool.lastRadius === null)) return [];
    return [{ key: 'radius', label: 'Radius', live: this.radiusFor(target, false), kind: 'length' }];
  }

  /** Every corner where exactly two lines on this plane meet at an angle. */
  private corners(): Corner[] {
    const lines = this.ctx.sketch.entities.filter((e) => e.kind === 'line' && e.plane === this.plane);
    const out: Corner[] = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        for (const e1 of [0, 1] as const) {
          for (const e2 of [0, 1] as const) {
            const c = lines[i].pts[e1];
            if (c.distanceTo(lines[j].pts[e2]) > 1e-6) continue;
            const u1 = lines[i].pts[1 - e1].clone().sub(c).normalize();
            const u2 = lines[j].pts[1 - e2].clone().sub(c).normalize();
            if (Math.abs(u1.dot(u2)) > 0.9995) continue; // straight through: no corner
            out.push({ c, l1: lines[i], l2: lines[j], e1, e2 });
          }
        }
      }
    }
    return out;
  }

  private cornerAt(x: number, y: number): Corner | null {
    let best: Corner | null = null;
    let bestD = CORNER_PX;
    for (const corner of this.corners()) {
      const s = toScreen(this.ctx.viewer, corner.c);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = corner;
      }
    }
    return best;
  }

  /**
   * The radius to use: typed, else (while sizing) the round that passes
   * where the cursor is along the corner's bisector, else the remembered one.
   */
  private radiusFor(corner: Corner, useTyped = true): number {
    const typed = this.ctx.hud.get('radius');
    if (useTyped && typed !== undefined) return typed;
    if (this.corner === corner && this.cursor) {
      const { bisector, half } = this.angles(corner);
      const d = Math.max(0, this.cursor.clone().sub(corner.c).dot(bisector));
      const s = Math.sin(half);
      return (d * s) / (1 - s);
    }
    return FilletTool.lastRadius ?? 0;
  }

  private angles(corner: Corner) {
    const u1 = corner.l1.pts[1 - corner.e1].clone().sub(corner.c).normalize();
    const u2 = corner.l2.pts[1 - corner.e2].clone().sub(corner.c).normalize();
    return { u1, u2, bisector: u1.clone().add(u2).normalize(), half: Math.acos(THREE.MathUtils.clamp(u1.dot(u2), -1, 1)) / 2 };
  }

  /** Where the round meets each line, and a point in the middle of the arc; null if it doesn't fit. */
  private geometry(corner: Corner, r: number) {
    if (!(r > 1e-6)) return null;
    const { u1, u2, bisector, half } = this.angles(corner);
    const along = r / Math.tan(half);
    const len1 = corner.l1.pts[0].distanceTo(corner.l1.pts[1]);
    const len2 = corner.l2.pts[0].distanceTo(corner.l2.pts[1]);
    if (along > len1 + 1e-6 || along > len2 + 1e-6) return null;
    return {
      t1: corner.c.clone().addScaledVector(u1, along),
      t2: corner.c.clone().addScaledVector(u2, along),
      mid: corner.c.clone().addScaledVector(bisector, r / Math.sin(half) - r),
    };
  }

  private apply(corner: Corner, r: number) {
    const g = this.geometry(corner, r);
    if (!g) {
      this.ctx.notify(r > 0 ? 'That radius is too big for this corner: the lines are too short.' : 'Move away from the corner (or type a radius) to size the fillet.');
      return;
    }
    const typed = this.ctx.hud.get('radius') !== undefined;
    this.ctx.session.editSketch('Fillet', () => {
      corner.l1.pts[corner.e1].copy(g.t1);
      corner.l2.pts[corner.e2].copy(g.t2);
      const arc = this.ctx.sketch.add({
        kind: 'arc',
        plane: this.plane,
        pts: [g.t1.clone(), g.mid, g.t2.clone()],
        construction: (corner.l1.construction && corner.l2.construction) || undefined,
      });
      if (typed) this.ctx.sketch.addDim('radius', arc.id);
      this.ctx.sketch.touch();
    });
    FilletTool.lastRadius = r;
  }

  protected refresh() {
    const target = this.corner ?? this.hover;
    const preview: THREE.Vector3[][] = [];
    const dots: THREE.Vector3[] = [];
    if (target) {
      dots.push(target.c);
      const g = this.geometry(target, this.radiusFor(target));
      if (g && (this.corner || FilletTool.lastRadius !== null || this.ctx.hud.get('radius') !== undefined)) {
        const pts = arcPoints(g.t1, g.mid, g.t2);
        if (pts) preview.push(pts);
      }
    }
    this.label(null);
    const r = FilletTool.lastRadius;
    this.show(
      'Fillet',
      'Click a corner where two lines meet, then move to size the round or type a radius. Further corners take one click and reuse the radius.',
      preview,
      dots,
      this.corner
        ? 'Fillet: move to size the round or type a radius · click or Enter to apply · Esc to pick another corner'
        : r !== null
          ? `Fillet: click a corner to round it (R ${units.fmt(r)}) · type a number for a new radius · Esc when done`
          : 'Fillet: click a corner where two lines meet · Esc when done',
    );
  }
}

// ---------------------------------------------------------------------------
// Copy and paste

/**
 * Copied shapes in flat sketch-plane coordinates (X right, Y up), so they can
 * be pasted onto any plane and survive re-aligning the scan in between.
 */
export interface Clipboard {
  entities: { id: number; shape: Omit<Entity, 'id' | 'plane' | 'pts' | 'tangents'>; pts: THREE.Vector2[]; tangents?: { start?: THREE.Vector2; end?: THREE.Vector2 } }[];
  dims: { kind: DimensionKind; entity: number }[];
  /** Middle of the copied shapes: the point that follows the cursor when pasting. */
  center: THREE.Vector2;
}

/** The selected shapes and their dimensions, or null if nothing is selected. */
export function copySelection(sketch: Sketch, viewer: Viewer): Clipboard | null {
  const mesh = viewer.mesh;
  const chosen = [...sketch.selection].map((id) => sketch.get(id)).filter((e): e is Entity => !!e);
  if (!mesh || !chosen.length) return null;
  const ids = new Set(chosen.map((e) => e.id));
  const box = new THREE.Box2();
  const entities = chosen.map((e) => {
    const { right, up } = PLANES[e.plane];
    const flat = (p: THREE.Vector3) => {
      const w = p.clone().applyMatrix4(mesh.matrixWorld);
      return new THREE.Vector2(w.dot(right), w.dot(up));
    };
    const dir = (d?: THREE.Vector3) => {
      if (!d) return undefined;
      const w = d.clone().transformDirection(mesh.matrixWorld);
      return new THREE.Vector2(w.dot(right), w.dot(up));
    };
    for (const p of entityPolyline(e)) box.expandByPoint(flat(p));
    const { id, kind, closed, rect, construction } = e;
    // A center stays locked to its centerline only if the centerline comes along.
    const centerOn = e.centerOn !== undefined && ids.has(e.centerOn) ? e.centerOn : undefined;
    return {
      id,
      shape: { kind, closed, rect: rect && { ...rect }, construction, centerOn },
      pts: e.pts.map(flat),
      tangents: e.tangents && { start: dir(e.tangents.start), end: dir(e.tangents.end) },
    };
  });
  const dims = sketch.dims.filter((d) => ids.has(d.entity)).map(({ kind, entity }) => ({ kind, entity }));
  return { entities, dims, center: box.getCenter(new THREE.Vector2()) };
}

/** Places a copy of the clipboard: it follows the cursor (and snaps) until you click. R turns it, M mirrors it. */
export class PasteTool extends SketchTool {
  readonly id = 'paste';
  private turns = 0;
  private mirrored = false;
  private placedOnce = false;

  constructor(ctx: ToolContext, private readonly clip: Clipboard) {
    super(ctx);
  }

  start() {
    super.start();
    if (!this.cursor) {
      // Start at the view's center so the copy is visible before the mouse moves.
      const r = this.ctx.viewer.canvas.getBoundingClientRect();
      this.cursorScreen = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.cursor = planePointAt(this.ctx.viewer, this.plane, this.cursorScreen.x, this.cursorScreen.y);
      this.refresh();
    }
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'r') this.turn();
    else if (k === 'm') this.mirror();
    else return false;
    return true;
  }

  private turn() {
    this.turns = (this.turns + 1) % 4;
    this.refresh();
  }

  private mirror() {
    this.mirrored = !this.mirrored;
    this.refresh();
  }

  /** Enter or Done places the copy where it is. */
  commit() {
    if (this.cursor) this.place(this.cursor);
    else this.finish();
  }

  /** The copied shapes moved so their center sits at `at`, on the current plane. */
  private placed(at: THREE.Vector3): NewEntity[] {
    const { right, up } = planeAxesLocal(this.ctx.viewer, this.plane);
    const origin = this.ctx.viewer.mesh!.worldToLocal(new THREE.Vector3());
    const rel = at.clone().sub(origin);
    const target = new THREE.Vector2(rel.dot(right), rel.dot(up));
    const cos = [1, 0, -1, 0][this.turns], sin = [0, 1, 0, -1][this.turns];
    const orient = (v: THREE.Vector2) => {
      const x = this.mirrored ? -v.x : v.x;
      return new THREE.Vector2(x * cos - v.y * sin, x * sin + v.y * cos);
    };
    const toLocal = (v: THREE.Vector2) => origin.clone().addScaledVector(right, v.x).addScaledVector(up, v.y);
    const point = (v: THREE.Vector2) => toLocal(orient(v.clone().sub(this.clip.center)).add(target));
    const dir = (v?: THREE.Vector2) => {
      if (!v) return undefined;
      const o = orient(v);
      return right.clone().multiplyScalar(o.x).addScaledVector(up, o.y).normalize();
    };
    return this.clip.entities.map((c) => ({
      ...c.shape,
      rect: c.shape.rect && { ...c.shape.rect },
      plane: this.plane,
      pts: c.pts.map(point),
      tangents: c.tangents && { start: dir(c.tangents.start), end: dir(c.tangents.end) },
    }));
  }

  protected place(p: THREE.Vector3) {
    const shapes = this.placed(p);
    const { sketch } = this.ctx;
    const n = shapes.length;
    this.ctx.session.editSketch(n > 1 ? `Paste ${n} items` : 'Paste', () => {
      const newId = new Map<number, number>();
      const added = shapes.map((s, i) => {
        const e = sketch.add(s);
        newId.set(this.clip.entities[i].id, e.id);
        return e;
      });
      // Rectangle groups and centerline locks refer to entity ids: point them at the copies.
      for (const e of added) {
        if (e.rect) e.rect.group = newId.get(e.rect.group) ?? e.id;
        if (e.centerOn !== undefined) e.centerOn = newId.get(e.centerOn);
      }
      for (const d of this.clip.dims) sketch.addDim(d.kind, newId.get(d.entity)!);
      sketch.touch();
      sketch.setSelection(added.map((e) => e.id));
    });
    this.placedOnce = true;
    this.finish();
  }

  protected refresh() {
    if (this.placedOnce) return;
    const shapes = this.cursor ? this.placed(this.cursor) : [];
    const n = this.clip.entities.length;
    const turn = this.turns ? ` · turned ${this.turns * 90}°` : '';
    this.label(null);
    this.showWith(
      'Paste',
      'Move the copy into place and click. Its center snaps like a drawing tool. R turns it 90°, M mirrors it.',
      shapes.map((s) => entityPolyline({ ...s, id: -1 })),
      this.cursor ? [this.cursor] : [],
      `Paste ${n > 1 ? `${n} items` : this.clip.entities[0].shape.kind}: click to place${turn}${this.mirrored ? ' · mirrored' : ''} · R turn 90° · M mirror · Esc to cancel`,
      [[
        { label: 'Turn 90°', title: 'Rotate the copy a quarter turn (R)', onClick: () => this.turn() },
        { label: 'Mirror', title: 'Flip the copy left to right (M)', on: this.mirrored, onClick: () => this.mirror() },
      ]],
    );
  }
}
