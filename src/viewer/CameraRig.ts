import * as THREE from 'three';

const WORLD_UP = new THREE.Vector3(0, 0, 1);

/**
 * A view is a point the camera looks at, an orientation, and how much of the
 * world fits vertically on screen (mm). The same state drives the
 * perspective and orthographic cameras, so switching between them doesn't jump.
 */
export interface ViewState {
  target: THREE.Vector3;
  quat: THREE.Quaternion;
  viewHeight: number;
}

interface Animation {
  from: ViewState;
  to: ViewState;
  start: number;
  duration: number;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Camera orientation looking along -back, with `up` as the screen's up direction. */
export function quatFromBackUp(back: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const b = back.clone().normalize();
  const r = new THREE.Vector3().crossVectors(up, b).normalize();
  const u = new THREE.Vector3().crossVectors(b, r);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, b));
}

/** Looking from the front-right-top corner. */
export const HOME_QUAT = quatFromBackUp(new THREE.Vector3(1, -1, 0.9), WORLD_UP);

export class CameraRig {
  readonly persp = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1000);
  ortho = false;
  readonly target = new THREE.Vector3();
  readonly quat = HOME_QUAT.clone();
  viewHeight = 200;

  private aspect = 1;
  private heightPx = 1;
  private readonly boundsCenter = new THREE.Vector3();
  private boundsRadius = 100;
  private anim: Animation | null = null;
  private readonly raycaster = new THREE.Raycaster();

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.ortho ? this.orthoCam : this.persp;
  }

  get back() { return new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat); }
  get up() { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat); }
  get right() { return new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat); }
  get worldPerPixel() { return this.viewHeight / this.heightPx; }

  private get distance() {
    return this.viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2));
  }

  get state(): ViewState {
    return { target: this.target.clone(), quat: this.quat.clone(), viewHeight: this.viewHeight };
  }

  /** Where the view is heading: the end of a running animation, or the current view. */
  get goal(): ViewState {
    const s = this.anim?.to ?? this;
    return { target: s.target.clone(), quat: s.quat.clone(), viewHeight: s.viewHeight };
  }

  setViewport(width: number, height: number) {
    this.aspect = width / Math.max(height, 1);
    this.heightPx = Math.max(height, 1);
    this.update();
  }

  setBounds(center: THREE.Vector3, radius: number) {
    this.boundsCenter.copy(center);
    this.boundsRadius = Math.max(radius, 1e-3);
    this.update();
  }

  fitState(quat: THREE.Quaternion = this.goal.quat): ViewState {
    return {
      target: this.boundsCenter.clone(),
      quat: quat.clone(),
      viewHeight: this.boundsRadius * 2.2 * Math.max(1, 1 / this.aspect),
    };
  }

  /** Moves the view so content follows a drag of (dx, dy) screen pixels. */
  pan(dx: number, dy: number) {
    this.anim = null;
    const s = this.worldPerPixel;
    this.target.addScaledVector(this.right, -dx * s).addScaledVector(this.up, dy * s);
    this.update();
  }

  /** Turntable orbit about `pivot`, as if the drag of (dx, dy) pixels grabbed the model. */
  orbit(dx: number, dy: number, pivot: THREE.Vector3) {
    this.anim = null;
    const k = 0.006;
    const yaw = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, -dx * k);
    const pitch = new THREE.Quaternion().setFromAxisAngle(this.right, -dy * k);
    this.rotateAbout(yaw.multiply(pitch), pivot);
  }

  /** Scales the view about `pivot`; that point stays fixed on screen. factor < 1 zooms in. */
  zoom(factor: number, pivot: THREE.Vector3) {
    this.anim = null;
    const r = this.boundsRadius;
    const next = THREE.MathUtils.clamp(this.viewHeight * factor, r * 1e-4, r * 40);
    const f = next / this.viewHeight;
    this.target.sub(pivot).multiplyScalar(f).add(pivot);
    this.viewHeight = next;
    this.update();
  }

  private rotateAbout(q: THREE.Quaternion, pivot: THREE.Vector3) {
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    this.quat.premultiply(q).normalize();
    this.update();
  }

  setView(to: ViewState, animate = true, duration = 380) {
    if (!animate) {
      this.anim = null;
      this.target.copy(to.target);
      this.quat.copy(to.quat);
      this.viewHeight = to.viewHeight;
      this.update();
      return;
    }
    this.anim = { from: this.state, to, start: performance.now(), duration };
  }

  cancelAnimation() {
    this.anim = null;
  }

  /** Advances any running animation. Returns true while more frames are needed. */
  step(now: number): boolean {
    const a = this.anim;
    if (!a) return false;
    const t = THREE.MathUtils.clamp((now - a.start) / a.duration, 0, 1);
    const e = easeInOut(t);
    this.target.lerpVectors(a.from.target, a.to.target, e);
    this.quat.slerpQuaternions(a.from.quat, a.to.quat, e);
    this.viewHeight = a.from.viewHeight * Math.pow(a.to.viewHeight / a.from.viewHeight, e);
    if (t >= 1) this.anim = null;
    this.update();
    return this.anim !== null;
  }

  ray(ndc: THREE.Vector2): THREE.Ray {
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  /** Point under the cursor on the plane through the target facing the camera. */
  pointOnTargetPlane(ndc: THREE.Vector2): THREE.Vector3 {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.back, this.target);
    return this.ray(ndc).intersectPlane(plane, new THREE.Vector3()) ?? this.target.clone();
  }

  update() {
    const back = this.back;
    const span = this.target.distanceTo(this.boundsCenter) + this.boundsRadius * 2;

    const d = this.distance;
    const p = this.persp;
    p.position.copy(this.target).addScaledVector(back, d);
    p.quaternion.copy(this.quat);
    p.aspect = this.aspect;
    p.near = Math.max(d * 0.01, 1e-4);
    p.far = d + span * 2;
    p.updateProjectionMatrix();
    p.updateMatrixWorld();

    const o = this.orthoCam;
    const od = span + 1;
    const hh = this.viewHeight / 2;
    o.position.copy(this.target).addScaledVector(back, od);
    o.quaternion.copy(this.quat);
    o.left = -hh * this.aspect;
    o.right = hh * this.aspect;
    o.top = hh;
    o.bottom = -hh;
    o.near = 0;
    o.far = od + span;
    o.updateProjectionMatrix();
    o.updateMatrixWorld();
  }
}
