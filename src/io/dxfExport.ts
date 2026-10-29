import Drawing from 'dxf-writer';
import * as THREE from 'three';
import { PLANES, type PlaneName } from '../app/alignMath';
import type { Unit } from '../app/units';
import { circleThrough, splineTangents, type Entity, type Sketch } from '../sketch/Sketch';

export interface DxfOptions {
  plane: PlaneName;
  unit: Unit;
  includeCenterlines: boolean;
  includePoints: boolean;
}

export interface DxfResult {
  text: string;
  counts: Record<string, number>;
}

const LAYER_SKETCH = 'SKETCH';
const LAYER_CENTER = 'CENTERLINE';
const LAYER_POINTS = 'POINTS';

/**
 * Writes one sketch plane as a 2D DXF. X and Y are the plane's right and up
 * directions, measured from the alignment origin, so a Top-plane sketch
 * lands in Fusion exactly as it was drawn. Lines, circles and arcs are exact
 * DXF entities; splines are written exactly as cubic B-splines.
 */
export function buildDxf(sketch: Sketch, scanToWorld: THREE.Matrix4, opts: DxfOptions): DxfResult {
  const { right, up } = PLANES[opts.plane];
  const k = opts.unit === 'in' ? 1 / 25.4 : 1;
  const to2d = (local: THREE.Vector3): [number, number] => {
    const w = local.clone().applyMatrix4(scanToWorld);
    return [w.dot(right) * k, w.dot(up) * k];
  };

  const d = new Drawing();
  d.setUnits(opts.unit === 'in' ? 'Inches' : 'Millimeters');
  // Long dash, gap, short dash, gap: a standard centerline pattern.
  const unitLen = opts.unit === 'in' ? 1 / 25.4 : 1;
  d.addLineType('CENTER', 'Center ____ _ ____ _', [20 * unitLen, -5 * unitLen, 5 * unitLen, -5 * unitLen]);
  d.addLayer(LAYER_SKETCH, Drawing.ACI.WHITE, 'CONTINUOUS');
  d.addLayer(LAYER_CENTER, Drawing.ACI.RED, 'CENTER');
  d.addLayer(LAYER_POINTS, Drawing.ACI.GREEN, 'CONTINUOUS');

  const counts: Record<string, number> = {};
  const count = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);

  for (const e of sketch.entities) {
    if (e.plane !== opts.plane) continue;
    if (e.kind === 'point') {
      if (!opts.includePoints) continue;
      d.setActiveLayer(LAYER_POINTS);
      const [x, y] = to2d(e.pts[0]);
      d.drawPoint(x, y);
      count('points');
      continue;
    }
    if (e.construction && !opts.includeCenterlines) continue;
    d.setActiveLayer(e.construction ? LAYER_CENTER : LAYER_SKETCH);

    switch (e.kind) {
      case 'line': {
        const [x1, y1] = to2d(e.pts[0]);
        const [x2, y2] = to2d(e.pts[1]);
        d.drawLine(x1, y1, x2, y2);
        count(e.construction ? 'centerlines' : 'lines');
        break;
      }
      case 'circle': {
        const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
        if (!c) break;
        const [x, y] = to2d(c.center);
        d.drawCircle(x, y, c.radius * k);
        count('circles');
        break;
      }
      case 'arc':
        if (writeArc(d, e, to2d, k)) count('arcs');
        break;
      case 'spline':
        if (writeSpline(d, e, to2d)) count('splines');
        break;
    }
  }
  return { text: d.toDxfString(), counts };
}

const deg = (a: number) => ((THREE.MathUtils.radToDeg(a) % 360) + 360) % 360;

/** DXF arcs run counterclockwise from the start angle, so pick the start that goes the right way round. */
function writeArc(d: Drawing, e: Entity, to2d: (p: THREE.Vector3) => [number, number], k: number): boolean {
  const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
  if (!c) return false;
  const [cx, cy] = to2d(c.center);
  const angle = (p: THREE.Vector3) => {
    const [x, y] = to2d(p);
    return deg(Math.atan2(y - cy, x - cx));
  };
  const a0 = angle(e.pts[0]);
  const am = angle(e.pts[1]);
  const a1 = angle(e.pts[2]);
  const ccw = (am - a0 + 360) % 360 < (a1 - a0 + 360) % 360;
  if (ccw) d.drawArc(cx, cy, c.radius * k, a0, a1);
  else d.drawArc(cx, cy, c.radius * k, a1, a0);
  return true;
}

/**
 * The app's spline is a chain of cubic Hermite spans (see splinePoints).
 * Each span converts exactly to a cubic Bézier, and a chain of Béziers is a
 * cubic B-spline with every interior knot repeated three times.
 */
function writeSpline(d: Drawing, e: Entity, to2d: (p: THREE.Vector3) => [number, number]): boolean {
  const pts = e.pts;
  const n = pts.length;
  if (n < 2) return false;
  const dirs = splineTangents(pts, !!e.closed, e.tangents);
  const spans = e.closed ? n : n - 1;
  const control: [number, number][] = [to2d(pts[0])];
  for (let s = 0; s < spans; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % n];
    const len = a.distanceTo(b);
    control.push(
      to2d(a.clone().addScaledVector(dirs[s], len / 3)),
      to2d(b.clone().addScaledVector(dirs[(s + 1) % n], -len / 3)),
      to2d(b),
    );
  }
  const knots = [0, 0, 0, 0];
  for (let i = 1; i < spans; i++) knots.push(i, i, i);
  knots.push(spans, spans, spans, spans);
  // drawSpline exists in dxf-writer but is missing from its type definitions.
  (d as unknown as { drawSpline(c: [number, number][], degree: number, knots: number[]): void }).drawSpline(control, 3, knots);
  return true;
}
