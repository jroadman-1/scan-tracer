import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { allRects, rectShape } from './rect';
import { circleThrough, entityPolyline, type Entity, type Sketch } from './Sketch';

const COLORS = {
  normal: new THREE.Color('#1849a9'),
  hover: new THREE.Color('#3b82f6'),
  intersection: new THREE.Color('#3d4a66'),
  construction: new THREE.Color('#b0601e'),
  selected: new THREE.Color('#f08c00'),
  preview: new THREE.Color('#2f80ff'),
  remove: new THREE.Color('#e03131'),
};

function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(16, 16, 14, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
}

/** Thick screen-space lines plus dot handles, drawn on top of the scan. */
class Layer {
  readonly lines: LineSegments2;
  readonly dots: THREE.Points;

  constructor(dotSize: number, dotTex: THREE.Texture, private readonly dashed = false) {
    this.lines = new LineSegments2(
      new LineSegmentsGeometry(),
      new LineMaterial({ linewidth: dashed ? 1.75 : 2.25, vertexColors: true, depthTest: false, transparent: true, dashed }),
    );
    this.dots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        size: dotSize,
        sizeAttenuation: false,
        vertexColors: true,
        map: dotTex,
        alphaTest: 0.5,
        depthTest: false,
      }),
    );
    this.lines.renderOrder = 20;
    this.dots.renderOrder = 21;
    this.lines.frustumCulled = false;
    this.dots.frustumCulled = false;
  }

  set(polylines: { pts: THREE.Vector3[]; color: THREE.Color }[], dots: { p: THREE.Vector3; color: THREE.Color }[]) {
    const pos: number[] = [];
    const col: number[] = [];
    for (const { pts, color } of polylines) {
      for (let i = 0; i + 1 < pts.length; i++) {
        pos.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        col.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    this.lines.visible = pos.length > 0;
    if (pos.length) {
      this.lines.geometry.dispose();
      const g = new LineSegmentsGeometry();
      g.setPositions(pos);
      g.setColors(col);
      this.lines.geometry = g;
      if (this.dashed) this.lines.computeLineDistances();
    }

    const dp = this.dots.geometry;
    dp.setAttribute('position', new THREE.Float32BufferAttribute(dots.flatMap(({ p }) => [p.x, p.y, p.z]), 3));
    dp.setAttribute('color', new THREE.Float32BufferAttribute(dots.flatMap(({ color }) => [color.r, color.g, color.b]), 3));
    this.dots.visible = dots.length > 0;
  }
}

/**
 * Draws the sketch and tool previews. The group is parented to the scan mesh,
 * so everything is in the scan's coordinates and follows its alignment.
 */
export class SketchView {
  readonly group = new THREE.Group();
  private readonly committed: Layer;
  private readonly construction: Layer;
  private readonly preview: Layer;

  constructor(pixelRatio: number) {
    const tex = dotTexture();
    this.committed = new Layer(7 * pixelRatio, tex);
    this.construction = new Layer(7 * pixelRatio, tex, true);
    this.preview = new Layer(8 * pixelRatio, tex);
    this.preview.lines.renderOrder = this.preview.dots.renderOrder = 22;
    this.group.add(
      this.committed.lines, this.committed.dots,
      this.construction.lines,
      this.preview.lines, this.preview.dots,
    );
  }

  /** Keeps centerline dashes a constant size on screen; call when the zoom changes. */
  setDashScale(worldPerPixel: number) {
    const m = this.construction.lines.material;
    m.dashSize = 9 * worldPerPixel;
    m.gapSize = 5 * worldPerPixel;
  }

  attach(mesh: THREE.Object3D) {
    mesh.add(this.group);
  }

  update(sketch: Sketch, hovered: number | null, intersections: THREE.Vector3[] = []) {
    const color = (e: Entity) =>
      sketch.selection.has(e.id)
        ? COLORS.selected
        : e.id === hovered
          ? COLORS.hover
          : e.construction
            ? COLORS.construction
            : COLORS.normal;
    const lines: { pts: THREE.Vector3[]; color: THREE.Color }[] = [];
    const dashed: { pts: THREE.Vector3[]; color: THREE.Color }[] = [];
    const dots: { p: THREE.Vector3; color: THREE.Color }[] = [];
    for (const e of sketch.entities) {
      const c = color(e);
      if (e.kind === 'point') {
        dots.push({ p: e.pts[0], color: c });
        continue;
      }
      (e.construction ? dashed : lines).push({ pts: entityPolyline(e), color: c });
      for (const p of handlePoints(e)) dots.push({ p, color: c });
    }
    for (const p of intersections) dots.push({ p, color: COLORS.intersection });
    // Each rectangle's center, which can be dragged to move it.
    for (const sides of allRects(sketch)) dots.push({ p: rectShape(sides).center, color: color(sides[0]) });
    this.committed.set(lines, dots);
    this.construction.set(dashed, []);
  }

  /** Tool preview; 'remove' shows what a click will delete (red). */
  setPreview(polylines: THREE.Vector3[][], points: THREE.Vector3[] = [], style: 'add' | 'remove' = 'add') {
    const color = style === 'remove' ? COLORS.remove : COLORS.preview;
    this.preview.set(
      polylines.map((pts) => ({ pts, color })),
      points.map((p) => ({ p, color })),
    );
  }
}

/** Draggable points: line and arc ends, spline fit points, circle centers. */
export function handlePoints(e: Entity): THREE.Vector3[] {
  if (e.kind === 'circle') {
    const c = circleThrough(e.pts[0], e.pts[1], e.pts[2]);
    return c ? [c.center] : [];
  }
  if (e.kind === 'arc') return [e.pts[0], e.pts[2]];
  return e.pts;
}
