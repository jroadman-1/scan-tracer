import * as THREE from 'three';
import { planeNormal, planeToXY } from '../app/alignMath';
import { HOME_QUAT } from '../viewer/CameraRig';
import type { Hit } from '../viewer/Viewer';
import type { Tool, ToolContext } from './Tool';

const ACCENT = 0x1f6feb;

/**
 * Pick three points on a surface that should lie flat. OK rotates the scan so
 * that surface becomes the XY plane (Z = 0), centered on the points.
 */
export class PlaneTool implements Tool {
  readonly id = 'plane';
  readonly picks = true;

  /** Picked points in the scan's own coordinates. */
  private points: THREE.Vector3[] = [];
  /** Which side of the plane faces up: +1 keeps the side that faced the camera when picked. */
  private side = 1;
  private readonly preview = new THREE.Group();

  constructor(private readonly ctx: ToolContext) {}

  start() {
    this.ctx.viewer.helpers.add(this.preview);
    this.refresh();
  }

  click(hit: Hit | null) {
    const mesh = this.ctx.viewer.mesh;
    if (!hit || !mesh || this.points.length >= 3) return;
    this.points.push(mesh.worldToLocal(hit.point.clone()));
    if (this.points.length === 3) {
      const n = this.rawNormal();
      if (!n) {
        this.points.pop();
        this.ctx.notify('Those points are almost in a line. Pick three points spread out across the surface.');
      } else {
        this.side = n.dot(this.ctx.viewer.rig.back) >= 0 ? 1 : -1;
      }
    }
    this.refresh();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      this.points.pop();
      this.refresh();
      return true;
    }
    return false;
  }

  commit() {
    const n = this.upNormal();
    const { viewer, session } = this.ctx;
    if (!n || !viewer.mesh) return;
    const after = planeToXY(this.worldPoints(), n).multiply(viewer.alignment);

    // Frame the result while the scan animates into place.
    const sphere = viewer.mesh.geometry.boundingSphere!.clone().applyMatrix4(after);
    viewer.rig.setBounds(sphere.center, sphere.radius);
    session.applyAlignment('3-Point Plane', after);
    if (session.view2d) session.enter2D(session.view2d, { fit: true });
    else viewer.rig.setView(viewer.rig.fitState(HOME_QUAT));

    this.cleanup();
    this.ctx.done();
  }

  cancel() {
    this.cleanup();
    this.ctx.done();
  }

  private cleanup() {
    this.ctx.viewer.helpers.remove(this.preview);
    this.ctx.viewer.requestRender();
  }

  private worldPoints(): THREE.Vector3[] {
    const m = this.ctx.viewer.mesh!.matrixWorld;
    return this.points.map((p) => p.clone().applyMatrix4(m));
  }

  private rawNormal(): THREE.Vector3 | null {
    if (this.points.length < 3) return null;
    const [a, b, c] = this.worldPoints();
    return planeNormal(a, b, c);
  }

  private upNormal(): THREE.Vector3 | null {
    return this.rawNormal()?.multiplyScalar(this.side) ?? null;
  }

  private refresh() {
    const { viewer, panel } = this.ctx;
    const count = this.points.length;
    viewer.setMarkers(this.points.map((local, i) => ({ local, label: String(i + 1) })));

    this.preview.clear();
    const n = this.upNormal();
    if (n && viewer.mesh) {
      const pts = this.worldPoints();
      const center = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(3);
      const radius = viewer.mesh.geometry.boundingSphere!.radius * 0.75;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);

      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 96),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(
          Array.from({ length: 96 }, (_, i) => {
            const a = (i / 96) * Math.PI * 2;
            return new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0);
          }),
        ),
        new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.7 }),
      );
      for (const o of [disc, ring]) {
        o.position.copy(center);
        o.quaternion.copy(q);
      }
      const arrow = new THREE.ArrowHelper(n, center, radius * 0.45, ACCENT, radius * 0.12, radius * 0.07);
      for (const m of [arrow.line.material, arrow.cone.material] as THREE.Material[]) m.depthTest = false;
      arrow.renderOrder = 5;
      this.preview.add(disc, ring, arrow);
    }
    viewer.requestRender();

    this.ctx.setPrompt(
      count < 3
        ? `3-Point Plane: click point ${count + 1} of 3 on the scan · Backspace removes the last point`
        : '3-Point Plane: the arrow shows which side will face up · Enter to align',
    );
    panel.show({
      title: '3-Point Plane',
      steps: [1, 2, 3].map((i) => ({ label: `Pick point ${i}`, done: count >= i })),
      note: 'Pick three points spread across a surface that should lie flat. It becomes the XY plane, with the side facing you on top.',
      rows: [[{ label: 'Flip side', title: 'Make the other side face up', disabled: !n, onClick: () => this.flip() }]],
      okEnabled: !!n,
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }

  private flip() {
    this.side = -this.side;
    this.refresh();
  }
}
