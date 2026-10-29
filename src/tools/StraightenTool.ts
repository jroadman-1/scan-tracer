import * as THREE from 'three';
import { nearestDirection, PLANES, rotationInPlane, straightenAngle, type LineDirection } from '../app/alignMath';
import type { Hit } from '../viewer/Viewer';
import type { Tool, ToolContext } from './Tool';

/**
 * Pick two points; the scan turns within the sketch plane so the line between
 * them runs horizontal or vertical. The turn previews live on the scan.
 */
export class StraightenTool implements Tool {
  readonly id = 'straighten';
  readonly picks = true;

  /** Picked points in the scan's own coordinates. */
  private points: THREE.Vector3[] = [];
  private dir: LineDirection = 'horizontal';
  private flipped = false;
  private base = new THREE.Matrix4();
  private line: THREE.Line | null = null;

  constructor(private readonly ctx: ToolContext) {}

  start() {
    this.base = this.ctx.viewer.alignment;
    this.refresh();
  }

  click(hit: Hit | null) {
    const mesh = this.ctx.viewer.mesh;
    if (!hit || !mesh || this.points.length >= 2) return;
    this.points.push(mesh.worldToLocal(hit.point.clone()));
    if (this.points.length === 2) {
      const [a, b] = this.basePoints();
      const { n } = PLANES[this.ctx.session.plane];
      const d = b.clone().sub(a);
      if (d.sub(n.clone().multiplyScalar(d.dot(n))).length() < 1e-3) {
        this.points.pop();
        this.ctx.notify('Those points line up with the view direction. Pick two points farther apart across the plane.');
      } else {
        this.dir = nearestDirection(a, b, this.ctx.session.plane);
        this.flipped = false;
      }
    }
    this.refresh();
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'backspace' || k === 'delete') {
      this.points.pop();
      this.refresh();
      return true;
    }
    if ((k === 'h' || k === 'v') && this.points.length === 2) {
      this.setDir(k === 'h' ? 'horizontal' : 'vertical');
      return true;
    }
    return false;
  }

  commit() {
    if (this.points.length < 2) return;
    this.removeLine();
    this.ctx.session.applyAlignment('Straighten', this.target(), { before: this.base });
    this.ctx.done();
  }

  cancel() {
    this.removeLine();
    this.ctx.viewer.animateAlignment(this.base, 250);
    this.ctx.done();
  }

  /** The picked points under the alignment the tool started from. */
  private basePoints(): THREE.Vector3[] {
    return this.points.map((p) => p.clone().applyMatrix4(this.base));
  }

  private target(): THREE.Matrix4 {
    if (this.points.length < 2) return this.base.clone();
    const [a, b] = this.basePoints();
    const plane = this.ctx.session.plane;
    const angle = straightenAngle(a, b, plane, this.dir) + (this.flipped ? Math.PI : 0);
    return rotationInPlane(plane, angle).multiply(this.base);
  }

  private setDir(dir: LineDirection) {
    this.dir = dir;
    this.refresh();
  }

  private flip() {
    this.flipped = !this.flipped;
    this.refresh();
  }

  private removeLine() {
    if (this.line) {
      this.line.removeFromParent();
      this.line.geometry.dispose();
      this.line = null;
    }
  }

  private refresh() {
    const { viewer, panel, session } = this.ctx;
    const count = this.points.length;
    viewer.setMarkers(this.points.map((local, i) => ({ local, label: i === 0 ? 'A' : 'B' })));

    // The line is parented to the scan so it turns with the preview.
    this.removeLine();
    if (count === 2 && viewer.mesh) {
      this.line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(this.points),
        new THREE.LineBasicMaterial({ color: 0x1f6feb, depthTest: false }),
      );
      this.line.renderOrder = 5;
      viewer.mesh.add(this.line);
    }
    viewer.animateAlignment(this.target(), 250);

    const plane = PLANES[session.plane].label;
    this.ctx.setPrompt(
      count < 2
        ? `Straighten: click point ${count === 0 ? 'A' : 'B'} on the scan · Backspace removes the last point`
        : 'Straighten: H or V to choose the direction · Enter to apply',
    );
    panel.show({
      title: 'Straighten',
      steps: [
        { label: 'Pick point A', done: count >= 1 },
        { label: 'Pick point B', done: count >= 2 },
      ],
      note: `Turns the scan within the ${plane} plane so the line from A to B runs straight.`,
      rows: [
        [
          { label: 'Horizontal', title: 'H', on: this.dir === 'horizontal', disabled: count < 2, onClick: () => this.setDir('horizontal') },
          { label: 'Vertical', title: 'V', on: this.dir === 'vertical', disabled: count < 2, onClick: () => this.setDir('vertical') },
        ],
        [{ label: 'Flip 180°', title: 'Turn the result end for end', on: this.flipped, disabled: count < 2, onClick: () => this.flip() }],
      ],
      okEnabled: count === 2,
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}
