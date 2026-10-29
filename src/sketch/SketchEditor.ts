import * as THREE from 'three';
import type { Session } from '../app/Session';
import type { Viewer } from '../viewer/Viewer';
import { planeAxesLocal, planePointAt, toScreen } from './planePoint';
import { coincidentPoints, entityPolyline, type Entity, type SketchSnapshot } from './Sketch';
import { allRects, enforceCenterLocks, rectShape, setRect, sideNormal, type RectShape } from './rect';
import type { SnapOverlay, Snapper } from './Snap';
import { handlePoints, type SketchView } from './SketchView';

// How close (pixels) the cursor must be to pick a curve or grab a handle.
const HIT_PX = 7;
const HANDLE_PX = 8;

function segmentDistance(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  const t = len2 > 0 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

interface Drag {
  pointerId: number;
  entity: Entity;
  /**
   * 'move' shifts `targets` by the drag; 'resize' sets a circle's radius about
   * `anchor` (its center); 'rect-*' reshape a rectangle so it stays one.
   */
  mode: 'move' | 'resize' | 'rect-corner' | 'rect-side' | 'rect-move';
  /** Rectangle drags: its sides, shape at the start, and which corner or side. */
  rect?: { sides: Entity[]; start: RectShape; index: number };
  /** Whether the dragged point snaps (off when dragging a whole line or spline). */
  snap: boolean;
  anchor: THREE.Vector3;
  targets: { p: THREE.Vector3; orig: THREE.Vector3 }[];
  before: SketchSnapshot;
  moved: boolean;
}

/**
 * Selecting, hovering, deleting and dragging sketch geometry when no tool is
 * active. Dragging a shared line end moves every end at that spot, so
 * connected lines stay connected.
 */
export class SketchEditor {
  private hovered: number | null = null;
  private drag: Drag | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewer: Viewer,
    private readonly session: Session,
    private readonly view: SketchView,
    private readonly snapper: Snapper,
    private readonly overlay: SnapOverlay,
    private readonly isIdle: () => boolean,
  ) {
    // Capture phase, so a handle drag takes the pointer before navigation sees it.
    canvas.addEventListener('pointerdown', this.onDown, { capture: true });
    canvas.addEventListener('pointermove', this.onDragMove, { capture: true });
    canvas.addEventListener('pointerup', this.onUp, { capture: true });
    canvas.addEventListener('pointercancel', this.onUp, { capture: true });
    canvas.addEventListener('dblclick', this.onDoubleClick, { capture: true });
  }

  private get sketch() {
    return this.session.sketch;
  }

  redraw() {
    this.view.update(this.sketch, this.hovered, this.snapper.intersections());
    this.viewer.requestRender();
  }

  hover(e: PointerEvent) {
    if (!this.isIdle()) {
      this.setHovered(null);
      this.canvas.style.cursor = '';
      return;
    }
    const handle = this.hitHandle(e);
    const id = this.hitRectCenter(e)?.sides[0].id ?? handle?.entity.id ?? this.hitEntity(e);
    this.canvas.style.cursor = id !== null ? 'move' : '';
    // Over a draggable point, hide the scan's hover dot so the point itself is clear.
    if (handle) this.viewer.setHover(null);
    this.setHovered(id);
  }

  /** Click selects; Shift or ⌘ click adds or removes; clicking empty space clears. */
  click(e: PointerEvent) {
    const id = this.hitHandle(e)?.entity.id ?? this.hitEntity(e);
    if (e.shiftKey || e.metaKey) {
      if (id === null) return;
      const next = new Set(this.sketch.selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      this.sketch.setSelection(next);
    } else {
      this.sketch.setSelection(id === null ? [] : [id]);
    }
  }

  /** Returns false if nothing was selected. */
  deleteSelection(): boolean {
    const ids = [...this.sketch.selection];
    if (!ids.length) return false;
    this.session.editSketch(ids.length > 1 ? `Delete ${ids.length} items` : 'Delete', () => this.sketch.remove(ids));
    return true;
  }

  clearSelection(): boolean {
    if (!this.sketch.selection.size) return false;
    this.sketch.setSelection([]);
    return true;
  }

  private setHovered(id: number | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.redraw();
  }

  private cursor(e: MouseEvent) {
    return new THREE.Vector2(e.clientX, e.clientY);
  }

  private hitEntity(e: MouseEvent): number | null {
    if (!this.viewer.mesh) return null;
    const c = this.cursor(e);
    let best: number | null = null;
    let bestD = HIT_PX;
    for (const ent of this.sketch.entities) {
      const pts = entityPolyline(ent).map((p) => toScreen(this.viewer, p));
      let d = pts.length === 1 ? c.distanceTo(pts[0]) : Infinity;
      for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segmentDistance(c, pts[i], pts[i + 1]));
      if (d < bestD) {
        bestD = d;
        best = ent.id;
      }
    }
    return best;
  }

  private hitHandle(e: MouseEvent): { entity: Entity; index: number } | null {
    if (!this.viewer.mesh) return null;
    const c = this.cursor(e);
    let best: { entity: Entity; index: number } | null = null;
    let bestD = HANDLE_PX;
    for (const entity of this.sketch.entities) {
      handlePoints(entity).forEach((p, index) => {
        const d = c.distanceTo(toScreen(this.viewer, p));
        if (d < bestD) {
          bestD = d;
          best = { entity, index };
        }
      });
    }
    return best;
  }

  /**
   * The spot on a spline's curve under the cursor, and the fit-point index a
   * new point there should be inserted at.
   */
  private hitSplineCurve(e: MouseEvent): { entity: Entity; point: THREE.Vector3; insertAt: number } | null {
    if (!this.viewer.mesh) return null;
    const c = this.cursor(e);
    let best: { entity: Entity; point: THREE.Vector3; insertAt: number } | null = null;
    let bestD = HIT_PX;
    for (const entity of this.sketch.entities) {
      if (entity.kind !== 'spline') continue;
      const poly = entityPolyline(entity);
      const screen = poly.map((p) => toScreen(this.viewer, p));
      for (let j = 0; j + 1 < screen.length; j++) {
        const d = segmentDistance(c, screen[j], screen[j + 1]);
        if (d >= bestD) continue;
        const ab = screen[j + 1].clone().sub(screen[j]);
        const t = ab.lengthSq() > 0 ? THREE.MathUtils.clamp(c.clone().sub(screen[j]).dot(ab) / ab.lengthSq(), 0, 1) : 0;
        // Samples are evenly spaced in the curve's parameter, so the sample
        // index tells which pair of fit points this stretch lies between.
        const n = entity.pts.length;
        const spans = entity.closed ? n : n - 1;
        const span = poly.length === n ? j : Math.min(spans - 1, Math.floor(((j + 0.5) / (poly.length - 1)) * spans));
        bestD = d;
        best = { entity, point: poly[j].clone().lerp(poly[j + 1], t), insertAt: span + 1 };
      }
    }
    return best;
  }

  /** Double-click a spline to add a fit point there, or a fit point to remove it. */
  private onDoubleClick = (e: MouseEvent) => {
    if (!this.isIdle()) return;
    const handle = this.hitHandle(e);
    if (handle?.entity.kind === 'spline') {
      const { entity, index } = handle;
      e.stopImmediatePropagation();
      if (entity.pts.length <= (entity.closed ? 3 : 2)) return;
      this.session.editSketch('Remove spline point', () => {
        entity.pts.splice(index, 1);
        this.sketch.touch();
      });
      return;
    }
    if (handle) return;
    const hit = this.hitSplineCurve(e);
    if (!hit) return;
    e.stopImmediatePropagation();
    this.session.editSketch('Add spline point', () => {
      hit.entity.pts.splice(hit.insertAt, 0, hit.point);
      this.sketch.setSelection([hit.entity.id]);
    });
  };

  private pointsAt(p: THREE.Vector3): THREE.Vector3[] {
    return coincidentPoints(this.sketch, p);
  }

  private rectOf(e: Entity): Entity[] | null {
    return allRects(this.sketch).find((sides) => sides.includes(e)) ?? null;
  }

  /** A rectangle whose center dot is under the cursor. */
  private hitRectCenter(e: MouseEvent): { sides: Entity[]; center: THREE.Vector3 } | null {
    const c = this.cursor(e);
    for (const sides of allRects(this.sketch)) {
      const center = rectShape(sides).center;
      if (c.distanceTo(toScreen(this.viewer, center)) < HANDLE_PX) return { sides, center };
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.isIdle()) return;
    const rectCenter = this.hitRectCenter(e);
    const handle = rectCenter ? null : this.hitHandle(e);
    const bodyId = handle || rectCenter ? null : this.hitEntity(e);
    const body = bodyId !== null ? this.sketch.get(bodyId) : undefined;
    const entity = rectCenter?.sides[0] ?? handle?.entity ?? body;
    if (!entity) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.viewer.setHover(null);

    const base = { pointerId: e.pointerId, entity, before: this.sketch.snapshot(), moved: false };
    const grab = planePointAt(this.viewer, entity.plane, e.clientX, e.clientY);
    const track = (ps: THREE.Vector3[]) => [...new Set(ps)].map((p) => ({ p, orig: p.clone() }));
    const sides = rectCenter?.sides ?? (entity.kind === 'line' && entity.rect ? this.rectOf(entity) : null);

    if (sides && rectCenter) {
      this.drag = { ...base, mode: 'rect-move', snap: true, anchor: rectCenter.center, targets: [], rect: { sides, start: rectShape(sides), index: 0 } };
    } else if (sides && handle) {
      // A rectangle corner: resize from the opposite corner (or the center).
      const start = rectShape(sides);
      const corner = handlePoints(entity)[handle.index];
      const index = sides.findIndex((s) => s.pts[0].distanceTo(corner) < 1e-6);
      this.drag = { ...base, mode: 'rect-corner', snap: true, anchor: corner.clone(), targets: [], rect: { sides, start, index } };
    } else if (sides && grab) {
      // A rectangle side: slide it straight in or out.
      this.drag = { ...base, mode: 'rect-side', snap: false, anchor: grab, targets: [], rect: { sides, start: rectShape(sides), index: entity.rect!.side } };
    } else if (handle && entity.kind === 'circle') {
      // A circle's handle is its center: move the whole circle.
      this.drag = { ...base, mode: 'move', snap: true, anchor: handlePoints(entity)[0].clone(), targets: track(entity.pts) };
    } else if (handle) {
      const anchor = handlePoints(entity)[handle.index].clone();
      this.drag = { ...base, mode: 'move', snap: true, anchor, targets: track(this.pointsAt(anchor)) };
    } else if (entity.kind === 'circle') {
      // Dragging a circle's edge changes its size about the center.
      this.drag = { ...base, mode: 'resize', snap: true, anchor: handlePoints(entity)[0].clone(), targets: [] };
    } else if (grab && entity.kind !== 'point') {
      // Dragging a line or spline by its body moves it whole; shapes connected at its ends stretch to follow.
      const ends = [entity.pts[0], entity.pts[entity.pts.length - 1]];
      this.drag = {
        ...base,
        mode: 'move',
        snap: false,
        anchor: grab,
        targets: track([...entity.pts, ...ends.flatMap((p) => this.pointsAt(p))]),
      };
    }
  };

  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    e.stopImmediatePropagation();
    const { plane } = d.entity;
    let p: THREE.Vector3 | null;
    if (d.snap) {
      const moving = d.rect ? d.rect.sides.flatMap((s) => s.pts) : d.mode === 'resize' ? d.entity.pts : d.targets.map((t) => t.p);
      const exclude = new Set(moving);
      const s = this.snapper.snap(e.clientX, e.clientY, { plane, exclude }, e.metaKey);
      this.overlay.show(s);
      p = s?.point ?? null;
    } else {
      p = planePointAt(this.viewer, plane, e.clientX, e.clientY);
    }
    if (!p) return;

    if (!d.moved && !this.sketch.selection.has(d.entity.id)) this.sketch.setSelection([d.entity.id]);
    d.moved = true;
    if (d.rect) {
      this.dragRect(d, p);
    } else if (d.mode === 'resize') {
      const r = p.distanceTo(d.anchor);
      if (r < 1e-6) return;
      const { right, up } = planeAxesLocal(this.viewer, plane);
      d.entity.pts[0].copy(d.anchor).addScaledVector(right, r);
      d.entity.pts[1].copy(d.anchor).addScaledVector(up, r);
      d.entity.pts[2].copy(d.anchor).addScaledVector(right, -r);
    } else {
      const delta = p.sub(d.anchor);
      for (const t of d.targets) t.p.copy(t.orig).add(delta);
    }
    // Shapes locked to a centerline stay on it, whether the shape or the line moved.
    enforceCenterLocks(this.sketch);
    this.sketch.touch();
  };

  private dragRect(d: Drag, p: THREE.Vector3) {
    const { sides, start, index } = d.rect!;
    const centered = sides[0].rect!.centered;
    const shape = { ...start, center: start.center.clone() };
    if (d.mode === 'rect-move') {
      shape.center.add(p.clone().sub(d.anchor));
    } else if (d.mode === 'rect-corner') {
      const fixed = centered ? start.center : sides[(index + 2) % 4].pts[0].clone();
      const span = p.clone().sub(fixed);
      const scale = centered ? 2 : 1;
      shape.w = Math.abs(span.dot(start.u)) * scale;
      shape.h = Math.abs(span.dot(start.v)) * scale;
      if (!centered) shape.center = fixed.clone().add(p).multiplyScalar(0.5);
    } else {
      const n = sideNormal(start, index);
      const offset = p.clone().sub(d.anchor).dot(n);
      const horizontal = index === 1 || index === 3;
      const grow = centered ? 2 * offset : offset;
      if (horizontal) shape.w = start.w + grow;
      else shape.h = start.h + grow;
      if (!centered) shape.center.addScaledVector(n, offset / 2);
    }
    setRect(sides, shape);
  }

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    e.stopImmediatePropagation();
    if (this.canvas.hasPointerCapture(d.pointerId)) this.canvas.releasePointerCapture(d.pointerId);
    this.drag = null;
    this.overlay.hide();
    if (d.moved) {
      const label = d.rect
        ? d.mode === 'rect-move' ? 'Move rectangle' : 'Resize rectangle'
        : d.mode === 'resize' ? 'Resize circle' : d.snap ? 'Move point' : `Move ${d.entity.kind}`;
      this.session.recordSketchEdit(label, d.before);
    } else {
      this.click(e); // a press without movement is an ordinary click
    }
  };
}
