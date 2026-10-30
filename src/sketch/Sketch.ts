import * as THREE from 'three';
import type { PlaneName } from '../app/alignMath';
import { units } from '../app/units';

export type EntityKind = 'point' | 'line' | 'circle' | 'arc' | 'spline';

/**
 * One piece of sketch geometry. Points are in the scan's own coordinates so
 * drawings follow the scan when it's straightened or flipped.
 */
export interface Entity {
  id: number;
  kind: EntityKind;
  /** The sketch plane it was drawn on; DXF export flattens onto this plane. */
  plane: PlaneName;
  /** point: [p] · line: [a, b] · circle: three points on it · arc: [start, a point along it, end] · spline: fit points. */
  pts: THREE.Vector3[];
  /** Splines only: the curve loops back to its first point. */
  closed?: boolean;
  /** Lines only: this line is side `side` of a rectangle; `centered` if drawn from its center. */
  rect?: { group: number; side: 0 | 1 | 2 | 3; centered: boolean };
  /** Circles and rectangles: id of a centerline the center is locked onto. */
  centerOn?: number;
  /** Construction geometry (a centerline): a dashed reference that isn't part of the part outline. */
  construction?: boolean;
  /** Splines only: fixed directions of travel at the first and/or last point, e.g. to leave a line smoothly. */
  tangents?: { start?: THREE.Vector3; end?: THREE.Vector3 };
}

export type NewEntity = Omit<Entity, 'id'>;

export type DimensionKind = 'length' | 'diameter' | 'radius';

/**
 * A size label on a shape: a line's length (for a rectangle side, its width
 * or height), a circle's diameter, or an arc's radius. It shows the current
 * size, and typing a new value resizes the shape.
 */
export interface Dimension {
  id: number;
  kind: DimensionKind;
  entity: number;
}

/** Everything undo needs to restore the sketch. */
export interface SketchSnapshot {
  entities: Entity[];
  dims: Dimension[];
}

export const cloneEntity = (e: Entity): Entity => ({
  ...e,
  rect: e.rect && { ...e.rect },
  pts: e.pts.map((p) => p.clone()),
  tangents: e.tangents && { start: e.tangents.start?.clone(), end: e.tangents.end?.clone() },
});

export class Sketch {
  readonly selection = new Set<number>();
  onChange: () => void = () => {};

  private list: Entity[] = [];
  private dimList: Dimension[] = [];
  private nextId = 1;
  private revision = 0;

  /** Increases whenever geometry changes (not selection), for caching derived data. */
  get version() {
    return this.revision;
  }

  private changed() {
    this.revision++;
    this.onChange();
  }

  get entities(): readonly Entity[] {
    return this.list;
  }

  get dims(): readonly Dimension[] {
    return this.dimList;
  }

  /** Adds a dimension (or returns the existing one of that kind on that shape). */
  addDim(kind: DimensionKind, entity: number): Dimension {
    const existing = this.dimList.find((d) => d.kind === kind && d.entity === entity);
    if (existing) return existing;
    const dim = { id: this.nextId++, kind, entity };
    this.dimList.push(dim);
    this.changed();
    return dim;
  }

  removeDim(id: number) {
    this.dimList = this.dimList.filter((d) => d.id !== id);
    this.changed();
  }

  get(id: number): Entity | undefined {
    return this.list.find((e) => e.id === id);
  }

  add(e: NewEntity): Entity {
    const entity = { ...e, id: this.nextId++ };
    this.list.push(entity);
    this.changed();
    return entity;
  }

  remove(ids: Iterable<number>) {
    const gone = new Set(ids);
    this.list = this.list.filter((e) => !gone.has(e.id));
    this.dimList = this.dimList.filter((d) => !gone.has(d.entity));
    for (const id of gone) this.selection.delete(id);
    this.changed();
  }

  /** Call after changing entity points in place. */
  touch() {
    this.changed();
  }

  setSelection(ids: Iterable<number>) {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.onChange();
  }

  snapshot(): SketchSnapshot {
    return { entities: this.list.map(cloneEntity), dims: this.dimList.map((d) => ({ ...d })) };
  }

  restore(s: SketchSnapshot) {
    this.list = s.entities.map(cloneEntity);
    this.dimList = s.dims.map((d) => ({ ...d }));
    this.nextId = Math.max(this.nextId, ...this.list.map((e) => e.id + 1), ...this.dimList.map((d) => d.id + 1));
    for (const id of [...this.selection]) if (!this.get(id)) this.selection.delete(id);
    this.changed();
  }

  clear() {
    this.list = [];
    this.dimList = [];
    this.selection.clear();
    this.changed();
  }
}

/** The circle through three points, or null if they're (nearly) in a line. */
export function circleThrough(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const ac = a.clone().sub(c);
  const bc = b.clone().sub(c);
  const cross = new THREE.Vector3().crossVectors(ac, bc);
  const len2 = cross.lengthSq();
  const scale = Math.max(ac.lengthSq(), bc.lengthSq());
  if (scale === 0 || len2 < 1e-10 * scale * scale) return null;
  const center = bc
    .clone()
    .multiplyScalar(ac.lengthSq())
    .sub(ac.clone().multiplyScalar(bc.lengthSq()))
    .cross(cross)
    .divideScalar(2 * len2)
    .add(c);
  return { center, radius: center.distanceTo(a), normal: cross.normalize() };
}

/** Samples drawn per span between fit points (the spline editor relies on this being constant). */
export const SPLINE_SPAN_SAMPLES = 20;

/**
 * Smooth curve through fit points: a cubic Hermite spline whose tangent at
 * each point bisects the chords to its neighbors, scaled by chord length so
 * unevenly spaced points don't overshoot. End directions can be fixed (e.g.
 * to continue a line smoothly); otherwise they mirror the next tangent in.
 * Each span is a cubic, so it converts exactly to DXF spline data.
 */
export function splinePoints(
  pts: THREE.Vector3[],
  closed = false,
  tangents?: { start?: THREE.Vector3; end?: THREE.Vector3 },
): THREE.Vector3[] {
  const n = pts.length;
  if (n < 2) return pts.map((p) => p.clone());
  const dirs = splineTangents(pts, closed, tangents);
  const spans = closed ? n : n - 1;
  const out: THREE.Vector3[] = [];
  for (let s = 0; s < spans; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % n];
    const len = a.distanceTo(b);
    const ta = dirs[s].clone().multiplyScalar(len);
    const tb = dirs[(s + 1) % n].clone().multiplyScalar(len);
    for (let k = 0; k < SPLINE_SPAN_SAMPLES; k++) {
      const t = k / SPLINE_SPAN_SAMPLES;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        a.clone().multiplyScalar(2 * t3 - 3 * t2 + 1)
          .addScaledVector(ta, t3 - 2 * t2 + t)
          .addScaledVector(b, -2 * t3 + 3 * t2)
          .addScaledVector(tb, t3 - t2),
      );
    }
  }
  out.push(closed ? pts[0].clone() : pts[n - 1].clone());
  return out;
}

/** Unit tangent direction at each fit point. */
export function splineTangents(
  pts: THREE.Vector3[],
  closed: boolean,
  tangents?: { start?: THREE.Vector3; end?: THREE.Vector3 },
): THREE.Vector3[] {
  const n = pts.length;
  const unit = (a: THREE.Vector3, b: THREE.Vector3) => b.clone().sub(a).normalize();
  // Mirror a tangent across the chord, giving a natural end that curves the same way.
  const mirror = (d: THREE.Vector3, chord: THREE.Vector3) => chord.clone().multiplyScalar(2 * d.dot(chord)).sub(d).normalize();
  const dirs: THREE.Vector3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const d = unit(prev, pts[i]).add(unit(pts[i], next));
    dirs[i] = d.lengthSq() > 1e-12 ? d.normalize() : unit(prev, next);
  }
  if (!closed) {
    const first = unit(pts[0], pts[1]);
    const last = unit(pts[n - 2], pts[n - 1]);
    const start = tangents?.start?.clone().normalize();
    const end = tangents?.end?.clone().normalize();
    if (n === 2) {
      dirs[0] = start ?? (end ? mirror(end, first) : first);
      dirs[1] = end ?? (start ? mirror(start, first) : first);
    } else {
      dirs[0] = start ?? mirror(dirs[1], first);
      dirs[n - 1] = end ?? mirror(dirs[n - 2], last);
    }
  }
  return dirs;
}

/** Points on a circle, closed (first point repeated at the end). */
export function circlePoints(center: THREE.Vector3, radius: number, normal: THREE.Vector3, segments = 128) {
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(u.dot(normal)) > 0.9) u.set(0, 1, 0);
  u.sub(normal.clone().multiplyScalar(u.dot(normal))).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = (i / segments) * Math.PI * 2;
    return center.clone().addScaledVector(u, Math.cos(t) * radius).addScaledVector(v, Math.sin(t) * radius);
  });
}

/** Points along the arc from `a` through `m` to `b`, or null if they're in a line. */
/**
 * The circle an arc lies on, with axes u (toward its start) and v, and its
 * signed sweep from the start, going the way round that passes through m.
 */
export function arcGeometry(a: THREE.Vector3, m: THREE.Vector3, b: THREE.Vector3) {
  const c = circleThrough(a, m, b);
  if (!c) return null;
  const u = a.clone().sub(c.center).normalize();
  const v = new THREE.Vector3().crossVectors(c.normal, u);
  const angle = (p: THREE.Vector3) => {
    const d = p.clone().sub(c.center);
    const t = Math.atan2(d.dot(v), d.dot(u));
    return t < 0 ? t + Math.PI * 2 : t;
  };
  const am = angle(m);
  const ab = angle(b);
  const sweep = am <= ab ? ab : ab - Math.PI * 2;
  const at = (t: number) => c.center.clone().addScaledVector(u, Math.cos(t) * c.radius).addScaledVector(v, Math.sin(t) * c.radius);
  return { ...c, u, v, sweep, at };
}

/** The point halfway along the arc from a through `through` to b. */
export function arcMidpoint(a: THREE.Vector3, through: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null {
  const g = arcGeometry(a, through, b);
  return g ? g.at(g.sweep / 2) : null;
}

export function arcPoints(a: THREE.Vector3, m: THREE.Vector3, b: THREE.Vector3, segments = 96): THREE.Vector3[] | null {
  const g = arcGeometry(a, m, b);
  if (!g) return null;
  const n = Math.max(8, Math.ceil((segments * Math.abs(g.sweep)) / (Math.PI * 2)));
  return Array.from({ length: n + 1 }, (_, i) => g.at((g.sweep * i) / n));
}

/** Polyline drawn for an entity (a single point for point entities). */
export function entityPolyline(e: Entity): THREE.Vector3[] {
  switch (e.kind) {
    case 'point':
    case 'line':
      return e.pts;
    case 'circle': {
      const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
      return c ? circlePoints(c.center, c.radius, c.normal) : e.pts;
    }
    case 'arc':
      return arcPoints(e.pts[0], e.pts[1], e.pts[2]) ?? e.pts;
    case 'spline':
      return splinePoints(e.pts, e.closed, e.tangents);
  }
}

/**
 * Every line, arc, spline or point position sitting exactly at `p` (circles
 * excluded), so shapes connected there can move together.
 */
export function coincidentPoints(sketch: Sketch, p: THREE.Vector3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const e of sketch.entities) {
    if (e.kind === 'circle') continue;
    for (const q of e.pts) if (q.distanceTo(p) < 1e-6) out.push(q);
  }
  return out;
}

/** The first and last points of an open curve (none for circles and closed splines). */
export function curveEnds(e: Entity): THREE.Vector3[] {
  if (e.kind === 'circle' || (e.kind === 'spline' && e.closed)) return [];
  if (e.kind === 'point') return [e.pts[0]];
  return [e.pts[0], e.pts[e.pts.length - 1]];
}

export function describeEntity(e: Entity): string {
  switch (e.kind) {
    case 'point':
      return 'Point';
    case 'line':
      return `${e.construction ? 'Centerline' : 'Line'} · ${units.fmt(e.pts[0].distanceTo(e.pts[1]))}`;
    case 'circle': {
      const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
      return c ? `Circle · Ø ${units.fmt(c.radius * 2)}` : 'Circle';
    }
    case 'arc': {
      const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
      return c ? `Arc · R ${units.fmt(c.radius)}` : 'Arc';
    }
    case 'spline':
      return `Spline · ${e.pts.length} points${e.closed ? ', closed' : ''}`;
  }
}
