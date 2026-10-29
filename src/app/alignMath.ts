import * as THREE from 'three';

export type PlaneName = 'top' | 'front' | 'right';

/**
 * Sketch planes, matching the ViewCube faces. `n` points toward the viewer
 * looking straight at the plane; `right` and `up` are the screen directions,
 * so (right, up, n) is right-handed and positive angles turn right toward up.
 */
export const PLANES: Record<PlaneName, { label: string; n: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3 }> = {
  top: { label: 'Top', n: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0) },
  front: { label: 'Front', n: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0) },
  right: { label: 'Right', n: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(0, 1, 0) },
};

/** Unit normal of the plane through three points, or null if they're nearly in a line. */
export function planeNormal(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): THREE.Vector3 | null {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  // Area relative to the longest side squared: tiny means the points are collinear.
  const scale = Math.max(ab.lengthSq(), ac.lengthSq(), b.distanceToSquared(c));
  if (scale === 0 || n.length() / scale < 0.02) return null;
  return n.normalize();
}

/**
 * Rigid transform taking the plane through `points` (world) to Z = 0, with
 * `up` (the plane's normal) becoming +Z and the points' centroid becoming
 * the origin. Uses the smallest rotation, so the scan keeps its heading.
 */
export function planeToXY(points: THREE.Vector3[], up: THREE.Vector3): THREE.Matrix4 {
  const centroid = points.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(points.length);
  const q = new THREE.Quaternion().setFromUnitVectors(up.clone().normalize(), new THREE.Vector3(0, 0, 1));
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const t = centroid.applyQuaternion(q).negate();
  return m.setPosition(t);
}

export type LineDirection = 'horizontal' | 'vertical';

/**
 * Angle (radians, about the plane normal) that turns the line from `a` to `b`
 * horizontal or vertical within `plane`, choosing whichever end-for-end
 * direction needs the smaller turn (always within ±90°).
 */
export function straightenAngle(a: THREE.Vector3, b: THREE.Vector3, plane: PlaneName, dir: LineDirection): number {
  const { right, up } = PLANES[plane];
  const d = b.clone().sub(a);
  const angle = Math.atan2(d.dot(up), d.dot(right));
  let turn = (dir === 'horizontal' ? 0 : Math.PI / 2) - angle;
  while (turn > Math.PI / 2) turn -= Math.PI;
  while (turn <= -Math.PI / 2) turn += Math.PI;
  return turn;
}

/** The direction that needs the smaller turn. */
export function nearestDirection(a: THREE.Vector3, b: THREE.Vector3, plane: PlaneName): LineDirection {
  const h = Math.abs(straightenAngle(a, b, plane, 'horizontal'));
  const v = Math.abs(straightenAngle(a, b, plane, 'vertical'));
  return h <= v ? 'horizontal' : 'vertical';
}

/** Rotation by `angle` about the plane's normal through the world origin. */
export function rotationInPlane(plane: PlaneName, angle: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationAxis(PLANES[plane].n, angle);
}
