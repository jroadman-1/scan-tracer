import * as THREE from 'three';
import { curveAtCursor, pointAt } from '../sketch/curves';
import { planeAxesLocal, toScreen } from '../sketch/planePoint';
import { coincidentPoints, type Entity } from '../sketch/Sketch';
import { handlePoints } from '../sketch/SketchView';
import type { Hit } from '../viewer/Viewer';
import type { Tool, ToolContext } from './Tool';

export type ConstraintMode = 'hv' | 'perpendicular' | 'parallel' | 'coincident';

const HANDLE_PX = 8;

const TITLES: Record<ConstraintMode, string> = {
  hv: 'Horizontal / Vertical',
  perpendicular: 'Perpendicular',
  parallel: 'Parallel',
  coincident: 'Coincident',
};

/** True if point p lies on the line segment (within a hair). */
function onLine(p: THREE.Vector3, line: Entity) {
  const [a, b] = line.pts;
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t)) < 1e-4;
}

/**
 * One-step corrections, like Fusion's constraints but applied once rather
 * than kept: turn lines horizontal/vertical, perpendicular or parallel to
 * another line, or move a point onto another point or curve.
 */
export class ConstrainTool implements Tool {
  readonly picks = true;
  /** Perpendicular/Parallel: the reference line. Coincident: the point being moved. */
  private first: { entity: Entity; point?: THREE.Vector3 } | null = null;
  private lastEvent: PointerEvent | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly mode: ConstraintMode,
  ) {}

  get id() {
    return this.mode;
  }

  start() {
    if (!this.ctx.session.view2d) this.ctx.session.enter2D('top');
    // Like Fusion, a selection made beforehand is used straight away.
    const selected = [...this.ctx.sketch.selection].map((id) => this.ctx.sketch.get(id)).filter((e): e is Entity => !!e);
    const lines = selected.filter((e) => e.kind === 'line');
    if (this.mode === 'hv' && lines.length) {
      this.ctx.session.editSketch('Horizontal / Vertical', () => lines.forEach((l) => this.straighten(l)));
      this.finish();
      return;
    }
    if ((this.mode === 'perpendicular' || this.mode === 'parallel') && lines.length === 2) {
      this.ctx.session.editSketch(TITLES[this.mode], () => this.turnRelative(lines[0], lines[1]));
      this.finish();
      return;
    }
    this.refresh();
  }

  move(e: PointerEvent) {
    this.lastEvent = e;
    this.refresh();
  }

  click(_hit: Hit | null, e: PointerEvent) {
    this.lastEvent = e;
    const { session } = this.ctx;
    if (this.mode === 'coincident') {
      if (!this.first) {
        const h = this.handleAt(e);
        if (h) this.first = h;
      } else {
        const target = this.targetAt(e);
        if (target) {
          const moving = this.first;
          session.editSketch('Coincident', () => this.moveOnto(moving, target));
          this.first = null;
        }
      }
    } else {
      const line = this.lineAt(e);
      if (!line) return;
      if (this.mode === 'hv') {
        session.editSketch('Horizontal / Vertical', () => this.straighten(line));
      } else if (!this.first) {
        this.first = { entity: line };
      } else if (line.id !== this.first.entity.id) {
        const ref = this.first.entity;
        session.editSketch(TITLES[this.mode], () => this.turnRelative(ref, line));
        this.first = null;
      }
    }
    this.refresh();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.first) {
      this.first = null;
      this.refresh();
      return true;
    }
    return false;
  }

  commit() {
    this.finish();
  }

  cancel() {
    this.finish();
  }

  private finish() {
    this.ctx.sketchView.setPreview([]);
    this.ctx.viewer.requestRender();
    this.ctx.done();
  }

  // --- Picking ---------------------------------------------------------------

  private lineAt(e: PointerEvent): Entity | null {
    const hit = curveAtCursor(this.ctx.viewer, this.ctx.sketch, e.clientX, e.clientY);
    return hit?.param.entity.kind === 'line' ? hit.param.entity : null;
  }

  private handleAt(e: PointerEvent): { entity: Entity; point: THREE.Vector3 } | null {
    const c = new THREE.Vector2(e.clientX, e.clientY);
    let best: { entity: Entity; point: THREE.Vector3 } | null = null;
    let bestD = HANDLE_PX;
    for (const entity of this.ctx.sketch.entities) {
      for (const p of handlePoints(entity)) {
        const d = c.distanceTo(toScreen(this.ctx.viewer, p));
        if (d < bestD) {
          bestD = d;
          best = { entity, point: p };
        }
      }
    }
    return best;
  }

  /** Where a point would be moved to: another point if close, else the nearest spot on a curve. */
  private targetAt(e: PointerEvent): THREE.Vector3 | null {
    const moving = this.first;
    const h = this.handleAt(e);
    if (h && h.entity.id !== moving?.entity.id) return h.point.clone();
    const hit = curveAtCursor(this.ctx.viewer, this.ctx.sketch, e.clientX, e.clientY);
    if (!hit || hit.param.entity.id === moving?.entity.id) return null;
    return pointAt(hit.param, hit.s);
  }

  // --- Changes ---------------------------------------------------------------

  /**
   * Turns a line to `dir` (or its reverse, whichever is the smaller turn),
   * keeping its length. It pivots on `pivot` (0 or 1) or, if null, its middle.
   * Shapes connected at a moving end stretch to follow.
   */
  private turnLine(line: Entity, dir: THREE.Vector3, pivot: 0 | 1 | null) {
    const [a, b] = line.pts;
    const current = b.clone().sub(a);
    const len = current.length();
    const d = dir.clone().normalize();
    if (d.dot(current) < 0) d.negate();
    const moveGroup = (from: THREE.Vector3, to: THREE.Vector3) => {
      for (const p of coincidentPoints(this.ctx.sketch, from.clone())) p.copy(to);
    };
    if (pivot === 0) moveGroup(b, a.clone().addScaledVector(d, len));
    else if (pivot === 1) moveGroup(a, b.clone().addScaledVector(d, -len));
    else {
      const mid = a.clone().lerp(b, 0.5);
      const newA = mid.clone().addScaledVector(d, -len / 2);
      const newB = mid.clone().addScaledVector(d, len / 2);
      moveGroup(a, newA);
      moveGroup(b, newB);
    }
    this.ctx.sketch.touch();
  }

  /** The end to pivot on: one touching `ref`, else one connected to anything, else none (the middle). */
  private pivotOf(line: Entity, ref?: Entity): 0 | 1 | null {
    if (ref) {
      for (const i of [0, 1] as const) if (onLine(line.pts[i], ref)) return i;
    }
    for (const i of [0, 1] as const) {
      if (coincidentPoints(this.ctx.sketch, line.pts[i]).length > 1) return i;
    }
    return null;
  }

  private straighten(line: Entity) {
    const { right, up } = planeAxesLocal(this.ctx.viewer, line.plane);
    const d = line.pts[1].clone().sub(line.pts[0]);
    const dir = Math.abs(d.dot(right)) >= Math.abs(d.dot(up)) ? right : up;
    this.turnLine(line, dir, this.pivotOf(line));
  }

  private turnRelative(ref: Entity, line: Entity) {
    const refDir = ref.pts[1].clone().sub(ref.pts[0]).normalize();
    let dir = refDir;
    if (this.mode === 'perpendicular') {
      const { right, up } = planeAxesLocal(this.ctx.viewer, ref.plane);
      const normal = new THREE.Vector3().crossVectors(right, up);
      dir = new THREE.Vector3().crossVectors(normal, refDir);
    }
    this.turnLine(line, dir, this.pivotOf(line, ref));
  }

  private moveOnto(moving: { entity: Entity; point?: THREE.Vector3 }, target: THREE.Vector3) {
    const from = moving.point!.clone();
    if (moving.entity.kind === 'circle') {
      // A circle's point is its center: move the whole circle.
      const delta = target.clone().sub(from);
      for (const p of moving.entity.pts) p.add(delta);
    } else {
      for (const p of coincidentPoints(this.ctx.sketch, from)) p.copy(target);
    }
    this.ctx.sketch.touch();
  }

  // --- Display ---------------------------------------------------------------

  private refresh() {
    const e = this.lastEvent;
    const previews: THREE.Vector3[][] = [];
    const dots: THREE.Vector3[] = [];
    if (this.first?.point) dots.push(this.first.point);
    else if (this.first) previews.push(this.first.entity.pts);
    if (e) {
      if (this.mode === 'coincident') {
        const target = this.first ? this.targetAt(e) : this.handleAt(e)?.point;
        if (target) dots.push(target);
      } else {
        const line = this.lineAt(e);
        if (line) previews.push(line.pts);
      }
    }
    this.ctx.sketchView.setPreview(previews, dots);
    this.ctx.viewer.requestRender();

    const steps = {
      hv: [{ label: 'Click a line to make it horizontal or vertical', done: false }],
      perpendicular: [
        { label: 'Pick the reference line', done: !!this.first },
        { label: 'Pick the line to turn', done: false },
      ],
      parallel: [
        { label: 'Pick the reference line', done: !!this.first },
        { label: 'Pick the line to turn', done: false },
      ],
      coincident: [
        { label: 'Pick the point to move', done: !!this.first },
        { label: 'Pick a point or curve to put it on', done: false },
      ],
    }[this.mode];
    const notes = {
      hv: 'Turns the line to whichever is nearer, pivoting on a connected end so connections hold.',
      perpendicular: 'The second line turns to 90° from the first, pivoting on the end that touches it.',
      parallel: 'The second line turns to match the first, pivoting on a connected end.',
      coincident: 'Moves a point (an end, a spline point, or a circle center) onto another point or onto a curve.',
    }[this.mode];
    const current = steps.find((s) => !s.done)?.label ?? '';
    this.ctx.setPrompt(`${TITLES[this.mode]}: ${current.toLowerCase()} · Esc when done`);
    this.ctx.panel.show({
      title: TITLES[this.mode],
      steps,
      note: notes,
      okEnabled: true,
      okLabel: 'Done',
      hideCancel: true,
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}
