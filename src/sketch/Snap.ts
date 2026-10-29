import * as THREE from 'three';
import { PLANES, type PlaneName } from '../app/alignMath';
import type { Viewer } from '../viewer/Viewer';
import { planePointAt, toScreen } from './planePoint';
import { circleThrough, curveEnds, entityPolyline, type Sketch } from './Sketch';

// Screen distances (pixels) for each kind of snap.
const POINT_PX = 10;
const GUIDE_PX = 8;
// ...or this many degrees, whichever is looser, so long lines still catch guides.
const GUIDE_DEG = 2.5;
const CURVE_PX = 7;
// Guides only appear once the cursor is this far from where the line starts.
const GUIDE_MIN_PX = 15;

export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'intersection'
  | 'on'
  | 'horizontal'
  | 'vertical'
  | 'perpendicular'
  | 'parallel';

export interface SnapResult {
  /** Where the click lands, in scan coordinates on the sketch plane. */
  point: THREE.Vector3;
  /** What it snapped to; null when it didn't snap. */
  kind: SnapKind | null;
  /** The sketch entity it snapped to, for point and curve snaps. */
  entityId?: number;
  /** For guide snaps: the dashed guide from the line's start. */
  guide?: { from: THREE.Vector3; to: THREE.Vector3 };
}

export interface SnapContext {
  plane: PlaneName;
  /** Start of the line being drawn: enables horizontal/vertical guides. */
  from?: THREE.Vector3 | null;
  /** A line to be perpendicular or parallel to. */
  refDir?: THREE.Vector3 | null;
  /** Points being dragged, which must not snap to themselves. */
  exclude?: Set<THREE.Vector3>;
}

interface Candidate {
  p: THREE.Vector3;
  kind: 'endpoint' | 'midpoint' | 'center' | 'intersection';
  entityId?: number;
}

/** Converts between scan coordinates and 2D coordinates within a sketch plane. */
function planeBasis(viewer: Viewer, plane: PlaneName) {
  const inv = viewer.mesh!.matrixWorld.clone().invert();
  const right = PLANES[plane].right.clone().transformDirection(inv);
  const up = PLANES[plane].up.clone().transformDirection(inv);
  const normal = PLANES[plane].n.clone().transformDirection(inv);
  return { right, up, normal };
}

function segmentIntersection(
  a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, d: THREE.Vector2,
): number | null {
  const r = b.clone().sub(a);
  const s = d.clone().sub(c);
  const denom = r.cross(s);
  if (Math.abs(denom) < 1e-12) return null;
  const ca = c.clone().sub(a);
  const t = ca.cross(s) / denom;
  const u = ca.cross(r) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/**
 * Finds where the cursor should land while drawing: existing points
 * (endpoints, midpoints, centers, intersections), then guide lines
 * (horizontal, vertical, perpendicular, parallel), then anywhere on a curve.
 */
export class Snapper {
  private cache: { key: string; points: THREE.Vector3[] } | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly sketch: Sketch,
  ) {}

  /** Points where sketch curves cross (not where they merely share an end). */
  intersections(): THREE.Vector3[] {
    const mesh = this.viewer.mesh;
    if (!mesh) return [];
    const key = `${this.sketch.version}|${mesh.matrixWorld.elements.join(',')}`;
    if (this.cache?.key === key) return this.cache.points;

    const points: THREE.Vector3[] = [];
    const curves = this.sketch.entities.filter((e) => e.kind !== 'point');
    const prepared = curves.map((e) => {
      const { right, up } = planeBasis(this.viewer, e.plane);
      const poly = entityPolyline(e);
      const flat = poly.map((p) => new THREE.Vector2(p.dot(right), p.dot(up)));
      const box = new THREE.Box2().setFromPoints(flat);
      return { e, poly, flat, box };
    });

    for (let i = 0; i < prepared.length; i++) {
      for (let j = i + 1; j < prepared.length; j++) {
        const A = prepared[i];
        const B = prepared[j];
        if (A.e.plane !== B.e.plane || !A.box.intersectsBox(B.box)) continue;
        const sharedEnds = [...curveEnds(A.e), ...curveEnds(B.e)];
        for (let a = 0; a + 1 < A.flat.length; a++) {
          for (let b = 0; b + 1 < B.flat.length; b++) {
            const t = segmentIntersection(A.flat[a], A.flat[a + 1], B.flat[b], B.flat[b + 1]);
            if (t === null) continue;
            const p = A.poly[a].clone().lerp(A.poly[a + 1], t);
            if (sharedEnds.some((q) => q.distanceTo(p) < 1e-4)) continue;
            if (points.some((q) => q.distanceTo(p) < 1e-4)) continue;
            points.push(p);
          }
        }
      }
    }
    this.cache = { key, points };
    return points;
  }

  snap(clientX: number, clientY: number, ctx: SnapContext, disabled = false): SnapResult | null {
    const raw = planePointAt(this.viewer, ctx.plane, clientX, clientY);
    if (!raw || !this.viewer.mesh) return raw ? { point: raw, kind: null } : null;
    if (disabled) return { point: raw, kind: null };
    const cursor = new THREE.Vector2(clientX, clientY);
    const screen = (p: THREE.Vector3) => toScreen(this.viewer, p);
    const excluded = (p: THREE.Vector3) => ctx.exclude?.has(p) ?? false;

    // 1. Existing points.
    const candidates: Candidate[] = [];
    for (const e of this.sketch.entities) {
      if (e.plane !== ctx.plane) continue;
      if (e.kind === 'circle') {
        const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
        if (c && !e.pts.some(excluded)) candidates.push({ p: c.center, kind: 'center', entityId: e.id });
        continue;
      }
      if (e.kind === 'arc') {
        const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
        if (c && !e.pts.some(excluded)) candidates.push({ p: c.center, kind: 'center', entityId: e.id });
      }
      const ends = e.kind === 'arc' ? [e.pts[0], e.pts[2]] : e.pts;
      for (const p of ends) if (!excluded(p)) candidates.push({ p, kind: 'endpoint', entityId: e.id });
      if (e.kind === 'line' && !e.pts.some(excluded)) {
        candidates.push({ p: e.pts[0].clone().lerp(e.pts[1], 0.5), kind: 'midpoint', entityId: e.id });
      }
    }
    for (const p of this.intersections()) candidates.push({ p, kind: 'intersection' });

    let best: Candidate | null = null;
    let bestD = POINT_PX;
    for (const c of candidates) {
      // Endpoints win close calls, since they're the most common target.
      const d = cursor.distanceTo(screen(c.p)) - (c.kind === 'endpoint' ? 2 : 0);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) return { point: best.p.clone(), kind: best.kind, entityId: best.entityId };

    // 2. Guides from the start of the line being drawn.
    if (ctx.from && cursor.distanceTo(screen(ctx.from)) > GUIDE_MIN_PX) {
      const { right, up, normal } = planeBasis(this.viewer, ctx.plane);
      const guides: { dir: THREE.Vector3; kind: SnapKind }[] = [];
      if (ctx.refDir && ctx.refDir.lengthSq() > 0) {
        const along = ctx.refDir.clone().normalize();
        guides.push({ dir: new THREE.Vector3().crossVectors(normal, along).normalize(), kind: 'perpendicular' });
        guides.push({ dir: along, kind: 'parallel' });
      }
      guides.push({ dir: right, kind: 'horizontal' }, { dir: up, kind: 'vertical' });

      const reach = cursor.distanceTo(screen(ctx.from));
      const tolerance = Math.max(GUIDE_PX, reach * Math.tan(THREE.MathUtils.degToRad(GUIDE_DEG)));
      let guide: SnapResult | null = null;
      let guideD = tolerance;
      for (const g of guides) {
        const q = ctx.from.clone().addScaledVector(g.dir, raw.clone().sub(ctx.from).dot(g.dir));
        const d = cursor.distanceTo(screen(q));
        if (d < guideD) {
          guideD = d;
          guide = { point: q, kind: g.kind, guide: { from: ctx.from.clone(), to: q.clone() } };
        }
      }
      if (guide) return guide;
    }

    // 3. Anywhere along a curve.
    let on: SnapResult | null = null;
    let onD = CURVE_PX;
    for (const e of this.sketch.entities) {
      if (e.plane !== ctx.plane || e.kind === 'point' || e.pts.some(excluded)) continue;
      const poly = entityPolyline(e);
      const pts = poly.map(screen);
      for (let i = 0; i + 1 < pts.length; i++) {
        const ab = pts[i + 1].clone().sub(pts[i]);
        const len2 = ab.lengthSq();
        const t = len2 > 0 ? THREE.MathUtils.clamp(cursor.clone().sub(pts[i]).dot(ab) / len2, 0, 1) : 0;
        const d = cursor.distanceTo(pts[i].clone().addScaledVector(ab, t));
        if (d < onD) {
          onD = d;
          on = { point: poly[i].clone().lerp(poly[i + 1], t), kind: 'on', entityId: e.id };
        }
      }
    }
    return on ?? { point: raw, kind: null };
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const LABELS: Partial<Record<SnapKind, string>> = {
  midpoint: 'Midpoint',
  center: 'Center',
  intersection: 'Intersection',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  perpendicular: '⊥ Perpendicular',
  parallel: '∥ Parallel',
};

/** Draws the snap marker and guide line over the viewport. */
export class SnapOverlay {
  private readonly svg: SVGSVGElement;

  constructor(parent: HTMLElement, private readonly viewer: Viewer) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('snap-overlay');
    parent.appendChild(this.svg);
  }

  show(s: SnapResult | null) {
    this.svg.replaceChildren();
    if (!s?.kind || !this.viewer.mesh) return;
    const rect = this.viewer.canvas.getBoundingClientRect();
    const local = (p: THREE.Vector3) => {
      const v = toScreen(this.viewer, p);
      return new THREE.Vector2(v.x - rect.left, v.y - rect.top);
    };
    const at = local(s.point);
    const add = (tag: string, attrs: Record<string, string | number>) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      this.svg.appendChild(el);
      return el;
    };

    if (s.guide) {
      // Extend the guide well past the cursor so it reads as a direction.
      const from = local(s.guide.from);
      const dir = at.clone().sub(from).normalize();
      const far = at.clone().addScaledVector(dir, 4000);
      add('line', { x1: from.x, y1: from.y, x2: far.x, y2: far.y, class: 'snap-guide' });
    }

    const { x, y } = at;
    switch (s.kind) {
      case 'endpoint':
        add('rect', { x: x - 5, y: y - 5, width: 10, height: 10, class: 'snap-glyph' });
        break;
      case 'midpoint':
        add('path', { d: `M${x} ${y - 6}L${x + 6} ${y + 5}H${x - 6}Z`, class: 'snap-glyph' });
        break;
      case 'center':
        add('circle', { cx: x, cy: y, r: 6, class: 'snap-glyph' });
        add('circle', { cx: x, cy: y, r: 1.5, class: 'snap-glyph filled' });
        break;
      case 'intersection':
        add('path', { d: `M${x - 5} ${y - 5}L${x + 5} ${y + 5}M${x + 5} ${y - 5}L${x - 5} ${y + 5}`, class: 'snap-glyph' });
        break;
      case 'on':
        add('path', { d: `M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z`, class: 'snap-glyph' });
        break;
      default:
        add('circle', { cx: x, cy: y, r: 3, class: 'snap-glyph filled' });
    }
    const label = LABELS[s.kind];
    if (label) {
      const t = add('text', { x: x + 10, y: y - 10, class: 'snap-label' });
      t.textContent = label;
    }
  }

  hide() {
    this.svg.replaceChildren();
  }
}
