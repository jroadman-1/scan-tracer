import * as THREE from 'three';
import { enforceCenterLocks, rectShape, rectSides, setRect } from './rect';
import { circleThrough, coincidentPoints, type Dimension, type Entity, type Sketch } from './Sketch';

/** The size a dimension shows (mm), or null if its shape no longer suits it. */
export function measure(sketch: Sketch, dim: Dimension): number | null {
  const e = sketch.get(dim.entity);
  if (!e) return null;
  if (dim.kind === 'length' && e.kind === 'line') return e.pts[0].distanceTo(e.pts[1]);
  if ((dim.kind === 'diameter' || dim.kind === 'radius') && (e.kind === 'circle' || e.kind === 'arc')) {
    const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
    if (!c) return null;
    return dim.kind === 'diameter' ? c.radius * 2 : c.radius;
  }
  return null;
}

/** Moves every point at `from` (shapes connected there) to `to`. */
function moveConnected(sketch: Sketch, from: THREE.Vector3, to: THREE.Vector3) {
  for (const p of coincidentPoints(sketch, from.clone())) p.copy(to);
}

/**
 * Resizes the dimension's shape to `value` (mm). A rectangle side changes the
 * rectangle's width or height (about its center for a center rectangle, else
 * keeping its first corner); a line keeps its connected end; circles and arcs
 * keep their center.
 */
export function applyDimension(sketch: Sketch, dim: Dimension, value: number) {
  const e = sketch.get(dim.entity);
  if (!e || !(value > 0)) return;

  if (dim.kind === 'length' && e.kind === 'line') {
    const sides = rectSides(sketch, e);
    if (sides) {
      const shape = rectShape(sides);
      const alongU = e.rect!.side === 0 || e.rect!.side === 2;
      const next = { ...shape, center: shape.center.clone() };
      if (alongU) next.w = value;
      else next.h = value;
      if (!e.rect!.centered) {
        // Keep corner 0 where it is.
        const c0 = sides[0].pts[0].clone();
        next.center = c0.addScaledVector(shape.u, next.w / 2).addScaledVector(shape.v, next.h / 2);
      }
      setRect(sides, next);
      enforceCenterLocks(sketch);
      return;
    }
    const [a, b] = e.pts;
    // Keep the end that's connected to something (or the start).
    const keepEnd = coincidentPoints(sketch, b).length > 1 && coincidentPoints(sketch, a).length <= 1 ? 1 : 0;
    const fixed = e.pts[keepEnd];
    const moving = e.pts[1 - keepEnd];
    const dir = moving.clone().sub(fixed).normalize();
    moveConnected(sketch, moving, fixed.clone().addScaledVector(dir, value));
    return;
  }

  if (e.kind === 'circle' || e.kind === 'arc') {
    const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
    if (!c) return;
    const radius = dim.kind === 'diameter' ? value / 2 : value;
    const k = radius / c.radius;
    const scaled = (p: THREE.Vector3) => p.clone().sub(c.center).multiplyScalar(k).add(c.center);
    if (e.kind === 'arc') {
      // Arc ends carry anything connected to them along.
      const [start, , end] = e.pts.map((p) => p.clone());
      e.pts[1].copy(scaled(e.pts[1]));
      moveConnected(sketch, start, scaled(start));
      moveConnected(sketch, end, scaled(end));
    } else {
      for (const p of e.pts) p.copy(scaled(p));
    }
  }
}

/** Which kind of dimension suits a shape, if any. */
export function dimensionKindFor(e: Entity): Dimension['kind'] | null {
  if (e.kind === 'line') return 'length';
  if (e.kind === 'circle') return 'diameter';
  if (e.kind === 'arc') return 'radius';
  return null;
}
