import * as THREE from 'three';
import type { Viewer } from '../viewer/Viewer';
import { planeAxesLocal, toScreen } from './planePoint';
import { circleThrough, entityPolyline, SPLINE_SPAN_SAMPLES, type Entity, type NewEntity, type Sketch } from './Sketch';

// Distances below this (mm) count as the same spot.
const EPS = 1e-5;

/**
 * A curve measured by distance along it (s, in mm), so trimming can talk
 * about "from here to there" uniformly for lines, arcs, circles and splines.
 */
export interface CurveParam {
  entity: Entity;
  poly: THREE.Vector3[];
  /** Polyline in 2D sketch-plane coordinates. */
  flat: THREE.Vector2[];
  /** Distance along the curve at each polyline point. */
  cum: number[];
  total: number;
  closed: boolean;
  /** For circles and arcs: the true circle, so cut points land exactly on it. */
  circle: ReturnType<typeof circleThrough>;
}

export function paramOf(viewer: Viewer, e: Entity): CurveParam {
  const { right, up } = planeAxesLocal(viewer, e.plane);
  const poly = entityPolyline(e);
  const flat = poly.map((p) => new THREE.Vector2(p.dot(right), p.dot(up)));
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + poly[i].distanceTo(poly[i - 1]));
  return {
    entity: e,
    poly,
    flat,
    cum,
    total: cum[cum.length - 1],
    closed: e.kind === 'circle' || (e.kind === 'spline' && !!e.closed),
    circle: e.kind === 'circle' || e.kind === 'arc' ? circleThrough(e.pts[0], e.pts[1], e.pts[2]) : null,
  };
}

function segmentAt(c: CurveParam, s: number): { i: number; t: number } {
  let lo = 0;
  let hi = c.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const len = c.cum[lo + 1] - c.cum[lo];
  return { i: lo, t: len > 0 ? (s - c.cum[lo]) / len : 0 };
}

/** Wraps s into the curve's range (closed curves go round). */
function wrap(c: CurveParam, s: number) {
  if (!c.closed) return THREE.MathUtils.clamp(s, 0, c.total);
  return ((s % c.total) + c.total) % c.total;
}

export function pointAt(c: CurveParam, s: number): THREE.Vector3 {
  const { i, t } = segmentAt(c, wrap(c, s));
  const p = c.poly[i].clone().lerp(c.poly[i + 1], t);
  // Push points on circles and arcs out onto the true circle.
  if (c.circle) p.sub(c.circle.center).setLength(c.circle.radius).add(c.circle.center);
  return p;
}

/** Direction of travel along the curve at s. */
export function tangentAt(c: CurveParam, s: number): THREE.Vector3 {
  const { i } = segmentAt(c, wrap(c, s));
  return c.poly[i + 1].clone().sub(c.poly[i]).normalize();
}

/** Points along the curve from a to b (b may pass the end of a closed curve). */
export function subPolyline(c: CurveParam, a: number, b: number): THREE.Vector3[] {
  const out = [pointAt(c, a)];
  const laps = c.closed ? [0, c.total] : [0];
  for (const lap of laps) {
    for (let i = 0; i < c.cum.length; i++) {
      const s = c.cum[i] + lap;
      if (s > a + EPS && s < b - EPS) out.push(c.poly[i].clone());
    }
  }
  out.push(pointAt(c, b));
  return out;
}

function cross2(a: THREE.Vector2, b: THREE.Vector2) {
  return a.x * b.y - a.y * b.x;
}

/**
 * Distances along `c` where other sketch shapes cross it or end on it.
 * Ends touching it count, so a line drawn up to another line splits it there.
 */
export function cutsOn(viewer: Viewer, sketch: Sketch, c: CurveParam): number[] {
  const { right, up } = planeAxesLocal(viewer, c.entity.plane);
  const flat = (p: THREE.Vector3) => new THREE.Vector2(p.dot(right), p.dot(up));
  const box = new THREE.Box2().setFromPoints(c.flat).expandByScalar(EPS * 10);
  const cuts: number[] = [];
  const tol = 1e-7;

  for (const other of sketch.entities) {
    if (other.id === c.entity.id || other.plane !== c.entity.plane) continue;
    const o = entityPolyline(other).map(flat);
    if (other.kind === 'point') {
      // A point sitting on the curve splits it too.
      for (let i = 0; i + 1 < c.flat.length; i++) {
        const a = c.flat[i];
        const ab = c.flat[i + 1].clone().sub(a);
        const len2 = ab.lengthSq();
        const t = len2 > 0 ? THREE.MathUtils.clamp(o[0].clone().sub(a).dot(ab) / len2, 0, 1) : 0;
        if (o[0].distanceTo(a.clone().addScaledVector(ab, t)) < EPS * 10) cuts.push(c.cum[i] + t * (c.cum[i + 1] - c.cum[i]));
      }
      continue;
    }
    if (!box.intersectsBox(new THREE.Box2().setFromPoints(o))) continue;
    for (let i = 0; i + 1 < c.flat.length; i++) {
      const a = c.flat[i];
      const r = c.flat[i + 1].clone().sub(a);
      for (let j = 0; j + 1 < o.length; j++) {
        const sv = o[j + 1].clone().sub(o[j]);
        const denom = cross2(r, sv);
        if (Math.abs(denom) < 1e-12) continue;
        const ca = o[j].clone().sub(a);
        const t = cross2(ca, sv) / denom;
        const u = cross2(ca, r) / denom;
        if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) continue;
        cuts.push(c.cum[i] + THREE.MathUtils.clamp(t, 0, 1) * (c.cum[i + 1] - c.cum[i]));
      }
    }
  }

  const kept = cuts
    .map((s) => (c.closed ? wrap(c, s) : s))
    .filter((s) => c.closed || (s > EPS && s < c.total - EPS))
    .sort((x, y) => x - y);
  const unique: number[] = [];
  for (const s of kept) if (!unique.length || s - unique[unique.length - 1] > EPS) unique.push(s);
  if (c.closed && unique.length > 1 && unique[0] + c.total - unique[unique.length - 1] < EPS) unique.pop();
  return unique;
}

/** The entity rebuilt to cover just [a, b] of the original curve. */
function piece(c: CurveParam, a: number, b: number): NewEntity | null {
  if (b - a < EPS) return null;
  const e = c.entity;
  const P = (s: number) => pointAt(c, s);
  switch (e.kind) {
    case 'line':
      return { kind: 'line', plane: e.plane, pts: [P(a), P(b)] };
    case 'circle':
    case 'arc':
      return { kind: 'arc', plane: e.plane, pts: [P(a), P((a + b) / 2), P(b)] };
    case 'spline': {
      // Keep the original fit points inside the piece, add the cut points as
      // new ends, and fix the end directions so the shape stays the same.
      const fit = e.pts.map((p, i) => ({ p, s: c.cum[Math.min(i * SPLINE_SPAN_SAMPLES, c.cum.length - 1)] }));
      const inside: { p: THREE.Vector3; s: number }[] = [];
      for (const lap of c.closed ? [0, c.total] : [0]) {
        for (const f of fit) if (f.s + lap > a + EPS && f.s + lap < b - EPS) inside.push({ p: f.p, s: f.s + lap });
      }
      inside.sort((x, y) => x.s - y.s);
      return {
        kind: 'spline',
        plane: e.plane,
        pts: [P(a), ...inside.map((f) => f.p.clone()), P(b)],
        tangents: { start: tangentAt(c, a + EPS), end: tangentAt(c, b - EPS) },
      };
    }
    default:
      return null;
  }
}

export interface TrimPlan {
  entity: Entity;
  /** What disappears (for the red preview). */
  removed: THREE.Vector3[];
  /** What replaces the entity; empty means it's deleted whole. */
  pieces: NewEntity[];
}

/** The trim that clicking at distance `s` along the curve would do. */
export function planTrim(c: CurveParam, cuts: number[], s: number): TrimPlan {
  const e = c.entity;
  if (e.kind === 'point') return { entity: e, removed: [], pieces: [] };
  if (!c.closed) {
    const bounds = [0, ...cuts, c.total];
    let k = 0;
    while (k < bounds.length - 2 && s > bounds[k + 1]) k++;
    const [a, b] = [bounds[k], bounds[k + 1]];
    const pieces = [piece(c, 0, a), piece(c, b, c.total)].filter((p): p is NewEntity => p !== null);
    return { entity: e, removed: subPolyline(c, a, b), pieces };
  }
  // A closed curve needs two cuts to leave anything; with fewer, it goes whole.
  if (cuts.length < 2) return { entity: e, removed: c.poly, pieces: [] };
  let a = cuts[cuts.length - 1];
  let b = cuts[0] + c.total;
  for (let k = 0; k + 1 < cuts.length; k++) {
    if (s >= cuts[k] && s <= cuts[k + 1]) {
      a = cuts[k];
      b = cuts[k + 1];
    }
  }
  const keep = piece(c, b, a + c.total);
  return { entity: e, removed: subPolyline(c, a, b), pieces: keep ? [keep] : [] };
}

/** The curve nearest the cursor (within `px`) and how far along it the cursor is. */
export function curveAtCursor(
  viewer: Viewer,
  sketch: Sketch,
  clientX: number,
  clientY: number,
  px = 8,
): { param: CurveParam; s: number } | null {
  if (!viewer.mesh) return null;
  const cursor = new THREE.Vector2(clientX, clientY);
  let best: { param: CurveParam; s: number } | null = null;
  let bestD = px;
  for (const e of sketch.entities) {
    if (e.kind === 'point') continue;
    const c = paramOf(viewer, e);
    const screen = c.poly.map((p) => toScreen(viewer, p));
    for (let i = 0; i + 1 < screen.length; i++) {
      const ab = screen[i + 1].clone().sub(screen[i]);
      const len2 = ab.lengthSq();
      const t = len2 > 0 ? THREE.MathUtils.clamp(cursor.clone().sub(screen[i]).dot(ab) / len2, 0, 1) : 0;
      const d = cursor.distanceTo(screen[i].clone().addScaledVector(ab, t));
      if (d < bestD) {
        bestD = d;
        best = { param: c, s: c.cum[i] + t * (c.cum[i + 1] - c.cum[i]) };
      }
    }
  }
  return best;
}

/**
 * Extending a line's end (the one nearer distance `s`) straight on until it
 * meets another shape. Null if nothing is in the way.
 */
export function planExtend(viewer: Viewer, sketch: Sketch, line: Entity, s: number): { end: number; to: THREE.Vector3 } | null {
  if (line.kind !== 'line') return null;
  const len = line.pts[0].distanceTo(line.pts[1]);
  const end = s > len / 2 ? 1 : 0;
  const from = line.pts[end];
  const dir3 = from.clone().sub(line.pts[1 - end]).normalize();
  const { right, up } = planeAxesLocal(viewer, line.plane);
  const flat = (p: THREE.Vector3) => new THREE.Vector2(p.dot(right), p.dot(up));
  const o = flat(from);
  const d = new THREE.Vector2(dir3.dot(right), dir3.dot(up));

  let best = Infinity;
  for (const other of sketch.entities) {
    if (other.id === line.id || other.plane !== line.plane || other.kind === 'point') continue;
    const poly = entityPolyline(other).map(flat);
    for (let j = 0; j + 1 < poly.length; j++) {
      const sv = poly[j + 1].clone().sub(poly[j]);
      const denom = cross2(d, sv);
      if (Math.abs(denom) < 1e-12) continue;
      const ca = poly[j].clone().sub(o);
      const lambda = cross2(ca, sv) / denom;
      const u = cross2(ca, d) / denom;
      if (lambda > EPS && u >= -1e-7 && u <= 1 + 1e-7 && lambda < best) best = lambda;
    }
  }
  return Number.isFinite(best) ? { end, to: from.clone().addScaledVector(dir3, best) } : null;
}
