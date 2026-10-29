import * as THREE from 'three';
import { circleThrough, type Entity, type Sketch } from './Sketch';

/**
 * A rectangle is four ordinary lines that remember they belong together, so
 * dragging and dimensions can keep them rectangular. Side i runs from corner
 * i to corner i+1.
 */
export interface RectShape {
  center: THREE.Vector3;
  /** Unit directions of the sides: u along side 0, v along side 3 reversed (corner 0 → corner 3). */
  u: THREE.Vector3;
  v: THREE.Vector3;
  w: number;
  h: number;
}

const MIN_SIZE = 1e-3;

export function rectCorners(r: RectShape): THREE.Vector3[] {
  const hu = r.u.clone().multiplyScalar(r.w / 2);
  const hv = r.v.clone().multiplyScalar(r.h / 2);
  return [
    r.center.clone().sub(hu).sub(hv),
    r.center.clone().add(hu).sub(hv),
    r.center.clone().add(hu).add(hv),
    r.center.clone().sub(hu).add(hv),
  ];
}

/** The four sides of the rectangle `e` belongs to, in order, or null if it's no longer an intact rectangle. */
export function rectSides(sketch: Sketch, e: Entity): Entity[] | null {
  if (e.kind !== 'line' || !e.rect) return null;
  const group = e.rect.group;
  const sides: Entity[] = [];
  for (const other of sketch.entities) {
    if (other.kind === 'line' && other.rect?.group === group) sides[other.rect.side] = other;
  }
  if (sides.length !== 4 || sides.some((s) => !s)) return null;
  for (let i = 0; i < 4; i++) {
    if (sides[i].pts[1].distanceTo(sides[(i + 1) % 4].pts[0]) > 1e-4) return null;
  }
  const shape = rectShape(sides);
  return Math.abs(shape.u.dot(shape.v)) < 1e-4 ? sides : null;
}

export function rectShape(sides: Entity[]): RectShape {
  const c0 = sides[0].pts[0];
  const c1 = sides[0].pts[1];
  const c3 = sides[3].pts[0];
  const along = c1.clone().sub(c0);
  const across = c3.clone().sub(c0);
  return {
    center: c1.clone().add(c3).multiplyScalar(0.5),
    u: along.clone().normalize(),
    v: across.clone().normalize(),
    w: along.length(),
    h: across.length(),
  };
}

/** Rewrites the four sides in place (keeping the same point objects) to match `shape`. */
export function setRect(sides: Entity[], shape: RectShape) {
  const r = { ...shape, w: Math.max(shape.w, MIN_SIZE), h: Math.max(shape.h, MIN_SIZE) };
  const c = rectCorners(r);
  for (let i = 0; i < 4; i++) {
    sides[i].pts[0].copy(c[i]);
    sides[i].pts[1].copy(c[(i + 1) % 4]);
  }
}

/** Outward direction of side i. */
export function sideNormal(shape: RectShape, side: number): THREE.Vector3 {
  return [shape.v.clone().negate(), shape.u.clone(), shape.v.clone(), shape.u.clone().negate()][side];
}

/** Closest point to p on the (endless) line through a line entity. */
export function projectOntoLine(p: THREE.Vector3, line: Entity): THREE.Vector3 {
  const [a, b] = line.pts;
  const d = b.clone().sub(a).normalize();
  return a.clone().addScaledVector(d, p.clone().sub(a).dot(d));
}

/** Each distinct intact rectangle, once. */
export function allRects(sketch: Sketch): Entity[][] {
  const out: Entity[][] = [];
  for (const e of sketch.entities) {
    if (e.kind === 'line' && e.rect?.side === 0) {
      const sides = rectSides(sketch, e);
      if (sides) out.push(sides);
    }
  }
  return out;
}

/**
 * Pulls every shape whose center is locked to a centerline back onto that
 * line (after the line or the shape moved).
 */
export function enforceCenterLocks(sketch: Sketch) {
  for (const e of sketch.entities) {
    if (e.centerOn === undefined) continue;
    const line = sketch.get(e.centerOn);
    if (!line || line.kind !== 'line') continue;
    if (e.kind === 'circle') {
      const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
      if (!c) continue;
      const delta = projectOntoLine(c.center, line).sub(c.center);
      for (const p of e.pts) p.add(delta);
    } else if (e.kind === 'line' && e.rect?.side === 0) {
      const sides = rectSides(sketch, e);
      if (!sides) continue;
      const shape = rectShape(sides);
      setRect(sides, { ...shape, center: projectOntoLine(shape.center, line) });
    }
  }
}
