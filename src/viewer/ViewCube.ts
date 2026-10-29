import * as THREE from 'three';
import { ICONS } from '../ui/icons';
import { quatFromBackUp, type CameraRig } from './CameraRig';

// Z is up and the front looks along +Y, matching Fusion with Z-up.
// `u` is the screen's up direction in that face's standard view.
const FACES = [
  { n: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(0, 1, 0), label: 'TOP' },
  { n: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(0, 1, 0), label: 'BOTTOM' },
  { n: new THREE.Vector3(0, -1, 0), u: new THREE.Vector3(0, 0, 1), label: 'FRONT' },
  { n: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(0, 0, 1), label: 'BACK' },
  { n: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 0, 1), label: 'RIGHT' },
  { n: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, 0, 1), label: 'LEFT' },
];

// Each face is split 3×3: the center is the face, the outer bands are edges
// and corners shared with neighboring faces, for 26 clickable views.
const BAND = 0.74;
const SPANS: [number, number][] = [[-1, -BAND], [-BAND, BAND], [BAND, 1]];

const BASE = '#e4e7ec';
const HOVER = '#9dbde6';
const LABEL_HOVER = '#b3d3fd';
const LIGHT = new THREE.Vector3(0.35, -0.5, 0.8).normalize();

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = BASE;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#3d4450';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 64;
  const font = () => `600 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  g.font = font();
  while (g.measureText(text).width > 236 && size > 20) { size -= 2; g.font = font(); }
  g.fillText(text, 128, 136);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

interface Region {
  dir: THREE.Vector3;
  label?: string;
  pos: number[];
  uv: number[];
  col: number[];
}

export class ViewCube {
  readonly el: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 20);
  private readonly regions: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private hovered: THREE.Mesh | null = null;
  private press: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly rig: CameraRig,
    private readonly requestRender: () => void,
    onHome: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'viewcube';
    this.el.innerHTML = `
      <button class="vc-btn vc-home" title="Home view">${ICONS.home}</button>
      <button class="vc-btn vc-arrow vc-up" title="Rotate to the face above">${ICONS.triUp}</button>
      <button class="vc-btn vc-arrow vc-down" title="Rotate to the face below">${ICONS.triDown}</button>
      <button class="vc-btn vc-arrow vc-left" title="Rotate to the face on the left">${ICONS.triLeft}</button>
      <button class="vc-btn vc-arrow vc-right" title="Rotate to the face on the right">${ICONS.triRight}</button>
      <button class="vc-btn vc-roll vc-roll-ccw" title="Roll 90° counterclockwise">${ICONS.rollCcw}</button>
      <button class="vc-btn vc-roll vc-roll-cw" title="Roll 90° clockwise">${ICONS.rollCw}</button>`;
    const canvas = document.createElement('canvas');
    this.el.appendChild(canvas);
    parent.appendChild(this.el);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(110, 110, false);
    this.build();

    const btn = (cls: string, fn: () => void) =>
      this.el.querySelector(`.${cls}`)!.addEventListener('click', fn);
    btn('vc-home', onHome);
    btn('vc-up', () => this.turn('right', -Math.PI / 2));
    btn('vc-down', () => this.turn('right', Math.PI / 2));
    btn('vc-left', () => this.turn('up', -Math.PI / 2));
    btn('vc-right', () => this.turn('up', Math.PI / 2));
    btn('vc-roll-ccw', () => this.turn('back', -Math.PI / 2));
    btn('vc-roll-cw', () => this.turn('back', Math.PI / 2));

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.press = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.press;
      if (!p) {
        this.setHovered(this.hitTest(e));
        return;
      }
      if (!p.moved && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 3) {
        p.moved = true;
        this.rig.cancelAnimation();
        this.setHovered(null);
      }
      if (p.moved) {
        // Dragging the cube orbits the main view about its target.
        this.rig.orbit(e.clientX - p.x, e.clientY - p.y, this.rig.target.clone());
        this.requestRender();
      }
      p.x = e.clientX;
      p.y = e.clientY;
    });
    canvas.addEventListener('pointerup', (e) => {
      const p = this.press;
      this.press = null;
      if (p && !p.moved) {
        const region = this.hitTest(e);
        if (region) this.goTo(region.userData.dir as THREE.Vector3);
      }
    });
    canvas.addEventListener('pointerleave', () => { if (!this.press) this.setHovered(null); });
  }

  /** In 2D the view is locked to the sketch plane, so the cube is shown dimmed and inactive. */
  setEnabled(on: boolean) {
    this.el.classList.toggle('disabled', !on);
  }

  render() {
    const q = this.rig.quat;
    this.camera.position.set(0, 0, 6).applyQuaternion(q);
    this.camera.quaternion.copy(q);
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);

    // Show the step/roll arrows only when looking straight at a face.
    const back = this.rig.back;
    this.el.classList.toggle('face-on', FACES.some((f) => back.dot(f.n) > 0.9995));
  }

  private build() {
    const buckets = new Map<string, Region>();
    const p = (n: THREE.Vector3, r: THREE.Vector3, u: THREE.Vector3, a: number, b: number) =>
      n.clone().addScaledVector(r, a).addScaledVector(u, b);

    for (const face of FACES) {
      const { n, u } = face;
      const r = new THREE.Vector3().crossVectors(u, n);
      const shade = 0.8 + 0.2 * n.dot(LIGHT);
      for (let ia = 0; ia < 3; ia++) {
        for (let ib = 0; ib < 3; ib++) {
          const dir = n.clone().addScaledVector(r, ia - 1).addScaledVector(u, ib - 1).round();
          const key = dir.toArray().join(',');
          let region = buckets.get(key);
          if (!region) {
            region = { dir, pos: [], uv: [], col: [] };
            buckets.set(key, region);
          }
          const isCenter = ia === 1 && ib === 1;
          if (isCenter) region.label = face.label;

          const [a0, a1] = SPANS[ia];
          const [b0, b1] = SPANS[ib];
          const corners = [p(n, r, u, a0, b0), p(n, r, u, a1, b0), p(n, r, u, a1, b1), p(n, r, u, a0, b1)];
          const uvs = isCenter ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 0], [0, 0], [0, 0]];
          for (const k of [0, 1, 2, 0, 2, 3]) {
            region.pos.push(...corners[k].toArray());
            region.uv.push(...uvs[k]);
            region.col.push(shade, shade, shade);
          }
        }
      }
    }

    for (const region of buckets.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(region.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(region.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(region.col, 3));
      const base = region.label ? '#ffffff' : BASE;
      const material = new THREE.MeshBasicMaterial({
        color: base,
        vertexColors: true,
        map: region.label ? labelTexture(region.label) : null,
      });
      const mesh = new THREE.Mesh(g, material);
      mesh.userData = { dir: region.dir, base, hover: region.label ? LABEL_HOVER : HOVER };
      this.regions.push(mesh);
      this.scene.add(mesh);
    }

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
      new THREE.LineBasicMaterial({ color: '#6f7783' }),
    );
    edges.scale.setScalar(1.003);
    this.scene.add(edges);

    // Axis triad from the back-left-bottom corner: X red, Y green, Z blue.
    const o = new THREE.Vector3(-1.03, -1.03, -1.03);
    const axes: [THREE.Vector3, string][] = [
      [new THREE.Vector3(1, 0, 0), '#e5484d'],
      [new THREE.Vector3(0, 1, 0), '#30a46c'],
      [new THREE.Vector3(0, 0, 1), '#3e7bfa'],
    ];
    for (const [d, color] of axes) {
      const g = new THREE.BufferGeometry().setFromPoints([o, o.clone().addScaledVector(d, 2.5)]);
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
    }
  }

  private hitTest(e: PointerEvent): THREE.Mesh | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return (this.raycaster.intersectObjects(this.regions, false)[0]?.object as THREE.Mesh) ?? null;
  }

  private setHovered(mesh: THREE.Mesh | null) {
    if (mesh === this.hovered) return;
    const paint = (m: THREE.Mesh | null, on: boolean) =>
      m && (m.material as THREE.MeshBasicMaterial).color.set(on ? m.userData.hover : m.userData.base);
    paint(this.hovered, false);
    paint(mesh, true);
    this.hovered = mesh;
    this.renderer.domElement.style.cursor = mesh ? 'pointer' : 'grab';
    this.requestRender();
  }

  private goTo(dir: THREE.Vector3) {
    const back = dir.clone().normalize();
    const face = FACES.find((f) => f.n.equals(dir));
    let up: THREE.Vector3;
    if (face) {
      up = face.u.clone();
    } else {
      up = new THREE.Vector3(0, 0, 1).addScaledVector(back, -back.z);
      if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
      up.normalize();
    }
    const goal = this.rig.goal;
    this.rig.setView({ ...goal, quat: quatFromBackUp(back, up) });
    this.requestRender();
  }

  /** Rotates 90° about one of the view's own axes, starting from where the view is heading. */
  private turn(axis: 'right' | 'up' | 'back', angle: number) {
    const goal = this.rig.goal;
    const local = { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), back: new THREE.Vector3(0, 0, 1) }[axis];
    const worldAxis = local.applyQuaternion(goal.quat);
    const quat = new THREE.Quaternion().setFromAxisAngle(worldAxis, angle).multiply(goal.quat);
    this.rig.setView({ ...goal, quat });
    this.requestRender();
  }
}
