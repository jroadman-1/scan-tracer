import * as THREE from 'three';
import { PLANES, type PlaneName } from '../app/alignMath';
import type { Viewer } from '../viewer/Viewer';

/**
 * Where the cursor meets a sketch plane (through the world origin), in the
 * scan's own coordinates. Null if the view is edge-on to the plane.
 */
export function planePointAt(viewer: Viewer, plane: PlaneName, clientX: number, clientY: number): THREE.Vector3 | null {
  const mesh = viewer.mesh;
  if (!mesh) return null;
  const world = viewer.rig.ray(viewer.ndc(clientX, clientY)).intersectPlane(
    new THREE.Plane(PLANES[plane].n.clone(), 0),
    new THREE.Vector3(),
  );
  return world ? mesh.worldToLocal(world) : null;
}

/** A scan-coordinate point's position on screen, in client pixels. */
export function toScreen(viewer: Viewer, local: THREE.Vector3): THREE.Vector2 {
  const v = local.clone().applyMatrix4(viewer.mesh!.matrixWorld).project(viewer.rig.camera);
  const r = viewer.canvas.getBoundingClientRect();
  return new THREE.Vector2(r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height);
}

/** A plane's in-plane axes expressed in the scan's own coordinates. */
export function planeAxesLocal(viewer: Viewer, plane: PlaneName) {
  const inv = viewer.mesh!.matrixWorld.clone().invert();
  return {
    right: PLANES[plane].right.clone().transformDirection(inv),
    up: PLANES[plane].up.clone().transformDirection(inv),
  };
}
