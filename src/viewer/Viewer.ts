import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { CameraRig, HOME_QUAT } from './CameraRig';
import { ScanShading } from './ScanShading';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface Hit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/** A numbered point pinned to the scan, stored in the scan's own coordinates so it follows alignment. */
export interface Marker {
  local: THREE.Vector3;
  label: string;
}

/** Runs once per frame while it returns true. */
type Ticker = (now: number) => boolean;

function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1f6feb';
  g.beginPath(); g.arc(32, 32, 21, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Draws vertices as small dots, thinned with zoom so they stay at least
// `minGap` pixels apart (see computeVertexLevels). Points one level below the
// cutoff shrink in rather than popping. The depth is nudged toward the camera
// so dots on the surface win the depth test instead of flickering against it.
function vertexMaterial(pixelRatio: number, spacing: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      size: { value: 3 * pixelRatio },
      minGap: { value: 14 * pixelRatio },
      spacing: { value: spacing },
      halfHeight: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float level;
      uniform float size;
      uniform float minGap;
      uniform float spacing;
      uniform float halfHeight;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        float pxPerMm = projectionMatrix[1][1] * halfHeight / gl_Position.w;
        float need = log2(minGap / (spacing * pxPerMm));
        float t = clamp(level - need + 1.0, 0.0, 1.0);
        if (t <= 0.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        gl_Position.z -= 0.0004 * gl_Position.w;
        gl_PointSize = size * t;
      }`,
    fragmentShader: /* glsl */ `
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        if (dot(c, c) > 0.25) discard;
        gl_FragColor = vec4(0.12, 0.2, 0.36, 1.0);
      }`,
  });
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Owns the WebGL scene. Renders only when something changed. */
export class Viewer {
  readonly rig = new CameraRig();
  readonly shading = new ScanShading();
  readonly canvas: HTMLCanvasElement;
  /** Tool previews (planes, lines) in world coordinates. */
  readonly helpers = new THREE.Group();
  mesh: THREE.Mesh | null = null;
  onHover: (hit: Hit | null) => void = () => {};
  onRender: () => void = () => {};

  private vertices: THREE.Points | null = null;
  private showVertices = false;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly raycaster = new THREE.Raycaster();
  private readonly hoverMarker: THREE.Points;
  private hoverAt: { x: number; y: number } | null = null;
  private frameQueued = false;
  private readonly tickers = new Set<Ticker>();
  private readonly markerLayer: HTMLDivElement;
  private markers: { marker: Marker; el: HTMLDivElement }[] = [];
  private readonly heightAxis = new THREE.Vector3(0, 0, 1);
  /** Red X and green Y arrows at the origin, sized to stay readable at any zoom. */
  private readonly originMarker = new THREE.Group();
  /** Bumped on every alignment change so a newer change cancels a running animation. */
  private alignVersion = 0;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.classList.add('gl');
    container.prepend(this.canvas);
    this.raycaster.firstHitOnly = true;

    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'marker-layer';
    this.canvas.after(this.markerLayer);

    const markerGeom = new THREE.BufferGeometry();
    markerGeom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.hoverMarker = new THREE.Points(
      markerGeom,
      new THREE.PointsMaterial({
        size: 11 * this.renderer.getPixelRatio(),
        sizeAttenuation: false,
        map: dotTexture(),
        transparent: true,
        alphaTest: 0.1,
        depthTest: false,
      }),
    );
    this.hoverMarker.renderOrder = 10;
    this.hoverMarker.frustumCulled = false;
    this.hoverMarker.visible = false;
    this.scene.add(this.hoverMarker, this.helpers, this.originMarker);

    for (const [dir, color] of [[new THREE.Vector3(1, 0, 0), 0xe5484d], [new THREE.Vector3(0, 1, 0), 0x30a46c]] as const) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.24, 0.14);
      for (const m of [arrow.line.material, arrow.cone.material] as THREE.Material[]) m.depthTest = false;
      arrow.renderOrder = 30; // above sketch lines
      this.originMarker.add(arrow);
    }
    this.originMarker.visible = false;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  requestRender() {
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame((now) => this.frame(now));
  }

  addTicker(fn: Ticker) {
    this.tickers.add(fn);
    this.requestRender();
  }

  setMesh(geometry: THREE.BufferGeometry) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.boundsTree = undefined;
      this.mesh.geometry.dispose();
      this.mesh.remove(this.vertices!);
      this.vertices!.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(geometry, this.shading.material);
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);

    // Shares the mesh's position buffer, so it adds no GPU memory. Parented to
    // the mesh so it follows any alignment transform.
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', geometry.attributes.position);
    points.setAttribute('level', geometry.attributes.level);
    const material = vertexMaterial(this.renderer.getPixelRatio(), geometry.userData.vertexSpacing);
    material.uniforms.halfHeight.value = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y / 2;
    this.vertices = new THREE.Points(points, material);
    this.vertices.visible = this.showVertices;
    this.mesh.add(this.vertices);

    this.updateBounds();
    this.rig.setView(this.rig.fitState(HOME_QUAT), false);
    this.requestRender();
  }

  /** The scan's alignment: maps its file coordinates to world (sketch) coordinates. */
  get alignment(): THREE.Matrix4 {
    return this.mesh ? this.mesh.matrix.clone() : new THREE.Matrix4();
  }

  setAlignment(m: THREE.Matrix4) {
    this.alignVersion++;
    this.applyAlignment(m);
  }

  private applyAlignment(m: THREE.Matrix4) {
    if (!this.mesh) return;
    this.mesh.matrix.copy(m);
    this.mesh.updateMatrixWorld(true);
    this.updateBounds();
    this.requestRender();
  }

  /** Moves the scan to a new alignment over `ms` milliseconds. */
  animateAlignment(to: THREE.Matrix4, ms = 450) {
    const mesh = this.mesh;
    if (!mesh) return;
    const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
    const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
    mesh.matrix.decompose(p0, q0, s0);
    to.decompose(p1, q1, s1);
    const start = performance.now();
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    const version = ++this.alignVersion;
    this.addTicker((now) => {
      if (version !== this.alignVersion) return false;
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      const e = easeInOut(t);
      if (t < 1) {
        mesh.matrix.compose(p.lerpVectors(p0, p1, e), q.slerpQuaternions(q0, q1, e), s1);
        mesh.updateMatrixWorld(true);
        return true;
      }
      this.applyAlignment(to);
      return false;
    });
  }

  /** World axis that Height shading measures along (the sketch plane's normal). */
  setHeightAxis(axis: THREE.Vector3) {
    this.heightAxis.copy(axis).normalize();
    this.shading.setHeightAxis(this.heightAxis);
    this.updateBounds();
    this.requestRender();
  }

  fit() {
    this.rig.setView(this.rig.fitState());
    this.requestRender();
  }

  home() {
    this.rig.setView(this.rig.fitState(HOME_QUAT));
    this.requestRender();
  }

  setShowVertices(on: boolean) {
    this.showVertices = on;
    if (this.vertices) this.vertices.visible = on;
    this.requestRender();
  }

  setOrtho(ortho: boolean) {
    this.rig.ortho = ortho;
    this.rig.update();
    this.requestRender();
  }

  setMarkers(markers: Marker[]) {
    for (const m of this.markers) m.el.remove();
    this.markers = markers.map((marker) => {
      const el = document.createElement('div');
      el.className = 'pick-marker';
      el.textContent = marker.label;
      this.markerLayer.appendChild(el);
      return { marker, el };
    });
    this.requestRender();
  }

  ndc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  pick(clientX: number, clientY: number): Hit | null {
    if (!this.mesh) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.rig.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.face) return null;
    return {
      point: hit.point.clone(),
      normal: hit.face.normal.clone().transformDirection(this.mesh.matrixWorld),
    };
  }

  /** Track the cursor for the hover marker; null hides it. */
  setHover(clientX: number | null, clientY = 0) {
    this.hoverAt = clientX === null ? null : { x: clientX, y: clientY };
    this.requestRender();
  }

  /** Recomputes view bounds and the height-shading range for the current alignment. */
  private updateBounds() {
    const mesh = this.mesh;
    if (!mesh) return;
    const sphere = mesh.geometry.boundingSphere!.clone().applyMatrix4(mesh.matrix);
    this.rig.setBounds(sphere.center, sphere.radius);

    // Exact height range along the axis: h = p · (Rᵀ axis) + t · axis.
    const local = this.heightAxis.clone().transformDirection(mesh.matrix.clone().invert());
    const offset = new THREE.Vector3().setFromMatrixPosition(mesh.matrix).dot(this.heightAxis);
    const pos = mesh.geometry.attributes.position.array as Float32Array;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const h = pos[i] * local.x + pos[i + 1] * local.y + pos[i + 2] * local.z;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.shading.setHeightBounds(min + offset, max + offset);
  }

  private updateHover() {
    const hit = this.hoverAt ? this.pick(this.hoverAt.x, this.hoverAt.y) : null;
    this.hoverMarker.visible = hit !== null;
    if (hit) {
      const attr = this.hoverMarker.geometry.attributes.position as THREE.BufferAttribute;
      attr.setXYZ(0, hit.point.x, hit.point.y, hit.point.z);
      attr.needsUpdate = true;
    }
    this.onHover(hit);
  }

  private updateMarkers() {
    if (!this.markers.length || !this.mesh) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const v = new THREE.Vector3();
    for (const { marker, el } of this.markers) {
      v.copy(marker.local).applyMatrix4(this.mesh.matrixWorld).project(this.rig.camera);
      el.hidden = v.z > 1;
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    if (this.vertices) {
      const material = this.vertices.material as THREE.ShaderMaterial;
      material.uniforms.halfHeight.value = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y / 2;
    }
    this.rig.setViewport(w, h);
    this.requestRender();
  }

  private frame(now: number) {
    this.frameQueued = false;
    let animating = this.rig.step(now);
    for (const tick of this.tickers) {
      if (tick(now)) animating = true;
      else this.tickers.delete(tick);
    }
    // The cursor's point on the mesh moves with the camera, so re-pick every
    // frame. BVH picking makes this well under a millisecond.
    this.updateHover();
    // Origin arrows stay about 56 px long on screen.
    this.originMarker.visible = !!this.mesh;
    this.originMarker.scale.setScalar(this.rig.worldPerPixel * 56);
    this.renderer.render(this.scene, this.rig.camera);
    this.updateMarkers();
    this.onRender();
    if (animating) this.requestRender();
  }
}
