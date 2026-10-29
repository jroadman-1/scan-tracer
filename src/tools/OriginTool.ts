import * as THREE from 'three';
import { PLANES } from '../app/alignMath';
import { units } from '../app/units';
import type { SnapResult } from '../sketch/Snap';
import type { Hit } from '../viewer/Viewer';
import type { Tool, ToolContext } from './Tool';

/**
 * Pick the point that should be the origin (X 0, Y 0) of the sketch plane,
 * e.g. the center of a part. The scan and its drawings shift together within
 * the plane, so the plane stays put and nothing moves relative to the scan.
 */
export class OriginTool implements Tool {
  readonly id = 'origin';
  readonly picks = true;

  constructor(private readonly ctx: ToolContext) {}

  start() {
    this.refresh(null);
  }

  /** Where a click would set the origin: a snapped sketch point, else the point on the scan, else the plane. */
  private targetAt(e: PointerEvent): { local: THREE.Vector3; snap: SnapResult | null } | null {
    const { viewer, snapper, session } = this.ctx;
    const mesh = viewer.mesh;
    if (!mesh) return null;
    const snap = snapper.snap(e.clientX, e.clientY, { plane: session.plane }, e.metaKey);
    if (snap?.kind) return { local: snap.point, snap };
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) return { local: mesh.worldToLocal(hit.point.clone()), snap: null };
    return snap ? { local: snap.point, snap: null } : null;
  }

  move(e: PointerEvent) {
    this.refresh(e);
  }

  click(_hit: Hit | null, e: PointerEvent) {
    const target = this.targetAt(e);
    const { viewer, session } = this.ctx;
    if (!target || !viewer.mesh) return;
    const { right, up } = PLANES[session.plane];
    const world = target.local.clone().applyMatrix4(viewer.mesh.matrixWorld);
    // Shift only within the plane, so the plane itself stays where it is.
    const shift = right.clone().multiplyScalar(-world.dot(right)).addScaledVector(up, -world.dot(up));
    session.applyAlignment('Set origin', new THREE.Matrix4().makeTranslation(shift).multiply(viewer.alignment));
    // Move the view with the scan so the picked point stays put on screen.
    const goal = viewer.rig.goal;
    viewer.rig.setView({ ...goal, target: goal.target.add(shift) }, true, 450);
    this.finish();
  }

  key(): boolean {
    return false;
  }

  commit() {
    this.finish();
  }

  cancel() {
    this.finish();
  }

  private finish() {
    this.ctx.snapOverlay.hide();
    this.ctx.viewer.setMarkers([]);
    this.ctx.setCursorLabel(null);
    this.ctx.done();
  }

  private refresh(e: PointerEvent | null) {
    const target = e ? this.targetAt(e) : null;
    this.ctx.snapOverlay.show(target?.snap ?? null);
    this.ctx.viewer.setMarkers(target ? [{ local: target.local, label: '0' }] : []);
    if (target && e && this.ctx.viewer.mesh) {
      const { right, up } = PLANES[this.ctx.session.plane];
      const w = target.local.clone().applyMatrix4(this.ctx.viewer.mesh.matrixWorld);
      this.ctx.setCursorLabel(`now X ${units.num(w.dot(right))}  Y ${units.num(w.dot(up))}`, e.clientX, e.clientY);
    } else {
      this.ctx.setCursorLabel(null);
    }
    this.ctx.setPrompt('Set Origin: click the point that should be X 0, Y 0 · snaps to circle centers, midpoints and crossings · Esc to cancel');
    this.ctx.panel.show({
      title: 'Set Origin',
      note: 'Click the point that should be the center of the drawing (X 0, Y 0) in the exported DXF, such as a hole center, the middle of a centerline, or where two centerlines cross. The scan and drawings shift together.',
      okEnabled: false,
      okLabel: 'OK',
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}
