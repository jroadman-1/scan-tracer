import * as THREE from 'three';
import { units } from '../app/units';
import type { Viewer } from '../viewer/Viewer';
import { measure } from './dimensions';
import { toScreen } from './planePoint';
import { rectShape, rectSides, sideNormal } from './rect';
import { circleThrough, type Dimension, type Sketch } from './Sketch';

const SVG_NS = 'http://www.w3.org/2000/svg';
// How far a length dimension sits from its line, in pixels.
const OFFSET_PX = 22;

/**
 * Draws dimension labels over the viewport, Fusion-style: extension lines,
 * a dimension line with arrows, and the value. Click a value to select it,
 * double-click to type a new one.
 */
export class DimensionView {
  /** Called with a new value (mm) typed into a dimension. */
  onEdit: (dim: Dimension, value: number) => void = () => {};
  selected: number | null = null;

  private readonly svg: SVGSVGElement;
  private readonly layer: HTMLDivElement;
  private readonly labels = new Map<number, HTMLDivElement>();
  private editing: number | null = null;

  constructor(
    parent: HTMLElement,
    private readonly viewer: Viewer,
    private readonly sketch: Sketch,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('dim-lines');
    this.layer = document.createElement('div');
    this.layer.className = 'dim-layer';
    parent.append(this.svg, this.layer);
  }

  /** Matches labels to the sketch's dimensions; call when the sketch changes. */
  sync() {
    const ids = new Set(this.sketch.dims.map((d) => d.id));
    for (const [id, el] of this.labels) {
      if (!ids.has(id)) {
        el.remove();
        this.labels.delete(id);
      }
    }
    if (this.selected !== null && !ids.has(this.selected)) this.selected = null;
    for (const dim of this.sketch.dims) {
      if (this.labels.has(dim.id)) continue;
      const el = document.createElement('div');
      el.className = 'dim-label';
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(dim.id);
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.edit(dim.id);
      });
      this.layer.appendChild(el);
      this.labels.set(dim.id, el);
    }
    this.update();
  }

  select(id: number | null) {
    this.selected = id;
    for (const [dimId, el] of this.labels) el.classList.toggle('sel', dimId === id);
  }

  /** Opens a dimension's value for typing. */
  edit(id: number) {
    const dim = this.sketch.dims.find((d) => d.id === id);
    const el = this.labels.get(id);
    const value = dim && measure(this.sketch, dim);
    if (!dim || !el || value === null || value === undefined) return;
    this.select(id);
    this.editing = id;
    const input = document.createElement('input');
    input.className = 'dim-input';
    input.value = units.num(value);
    el.replaceChildren(input);
    input.focus();
    input.select();
    const close = (apply: boolean) => {
      if (this.editing !== id) return;
      this.editing = null;
      const v = units.parse(input.value);
      if (apply && v !== null && v > 0) this.onEdit(dim, v);
      this.update();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }

  /** Positions everything for the current view; call every frame. */
  update() {
    this.svg.replaceChildren();
    const mesh = this.viewer.mesh;
    const rect = this.viewer.canvas.getBoundingClientRect();
    const screen = (p: THREE.Vector3) => {
      const s = toScreen(this.viewer, p);
      return new THREE.Vector2(s.x - rect.left, s.y - rect.top);
    };
    const line = (a: THREE.Vector2, b: THREE.Vector2, cls = 'dim-line') => {
      const el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', String(a.x));
      el.setAttribute('y1', String(a.y));
      el.setAttribute('x2', String(b.x));
      el.setAttribute('y2', String(b.y));
      el.setAttribute('class', cls);
      this.svg.appendChild(el);
    };
    const arrow = (tip: THREE.Vector2, dir: THREE.Vector2) => {
      const back = tip.clone().addScaledVector(dir, -7);
      const side = new THREE.Vector2(-dir.y, dir.x).multiplyScalar(3);
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', `M${tip.x} ${tip.y}L${back.x + side.x} ${back.y + side.y}L${back.x - side.x} ${back.y - side.y}Z`);
      el.setAttribute('class', 'dim-arrow');
      this.svg.appendChild(el);
    };

    for (const dim of this.sketch.dims) {
      const el = this.labels.get(dim.id);
      const e = this.sketch.get(dim.entity);
      const value = measure(this.sketch, dim);
      if (!el) continue;
      el.hidden = !mesh || !e || value === null;
      if (el.hidden || !e || value === null) continue;
      if (this.editing !== dim.id) el.textContent = `${dim.kind === 'diameter' ? 'Ø' : dim.kind === 'radius' ? 'R' : ''}${units.num(value)}`;

      let at: THREE.Vector2;
      if (dim.kind === 'length') {
        const a = screen(e.pts[0]);
        const b = screen(e.pts[1]);
        const d = b.clone().sub(a).normalize();
        let n = new THREE.Vector2(-d.y, d.x);
        const sides = rectSides(this.sketch, e);
        if (sides) {
          // Rectangle dimensions go outside the rectangle.
          const mid = e.pts[0].clone().lerp(e.pts[1], 0.5);
          const out = sideNormal(rectShape(sides), e.rect!.side);
          n = screen(mid.clone().add(out)).sub(screen(mid)).normalize();
        } else if (n.y > 0 || (n.y === 0 && n.x < 0)) {
          n.negate(); // otherwise prefer above
        }
        const a2 = a.clone().addScaledVector(n, OFFSET_PX);
        const b2 = b.clone().addScaledVector(n, OFFSET_PX);
        line(a.clone().addScaledVector(n, 4), a2.clone().addScaledVector(n, 4), 'dim-ext');
        line(b.clone().addScaledVector(n, 4), b2.clone().addScaledVector(n, 4), 'dim-ext');
        line(a2, b2);
        arrow(a2, d.clone().negate());
        arrow(b2, d);
        at = a2.clone().lerp(b2, 0.5);
      } else {
        const c = circleThrough(e.pts[0], e.pts[1], e.pts[2])!;
        const center = screen(c.center);
        if (dim.kind === 'diameter') {
          const dir = new THREE.Vector2(Math.SQRT1_2, -Math.SQRT1_2);
          const r = screen(e.pts[0]).distanceTo(center);
          const edge = center.clone().addScaledVector(dir, r);
          at = center.clone().addScaledVector(dir, r + 26);
          line(center.clone().addScaledVector(dir, -r), at);
          arrow(edge, dir);
          arrow(center.clone().addScaledVector(dir, -r), dir.clone().negate());
        } else {
          const mid = screen(e.pts[1]);
          const dir = mid.clone().sub(center).normalize();
          at = mid.clone().addScaledVector(dir, 22);
          line(center, at);
          arrow(mid, dir);
        }
      }
      el.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
    }
  }

  hasSelection() {
    return this.selected !== null;
  }
}
