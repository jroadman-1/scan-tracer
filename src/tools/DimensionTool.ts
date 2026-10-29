import { curveAtCursor } from '../sketch/curves';
import { dimensionKindFor } from '../sketch/dimensions';
import type { Hit } from '../viewer/Viewer';
import type { Tool, ToolContext } from './Tool';

/**
 * Fusion's Sketch Dimension: click a line (length), circle (diameter) or arc
 * (radius) to add a dimension, then type the size you want.
 */
export class DimensionTool implements Tool {
  readonly id = 'dimension';
  readonly picks = true;

  constructor(
    private readonly ctx: ToolContext,
    /** Opens a dimension's value for typing. */
    private readonly editDimension: (dimId: number) => void,
  ) {}

  start() {
    if (!this.ctx.session.view2d) this.ctx.session.enter2D('top');
    this.refresh(null);
  }

  private targetAt(e: PointerEvent) {
    const hit = curveAtCursor(this.ctx.viewer, this.ctx.sketch, e.clientX, e.clientY);
    const kind = hit && dimensionKindFor(hit.param.entity);
    return hit && kind ? { entity: hit.param.entity, kind } : null;
  }

  move(e: PointerEvent) {
    this.refresh(e);
  }

  click(_hit: Hit | null, e: PointerEvent) {
    const target = this.targetAt(e);
    if (!target) return;
    let dimId = -1;
    this.ctx.session.editSketch('Dimension', () => {
      dimId = this.ctx.sketch.addDim(target.kind, target.entity.id).id;
    });
    this.editDimension(dimId);
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
    this.ctx.sketchView.setPreview([]);
    this.ctx.viewer.requestRender();
    this.ctx.done();
  }

  private refresh(e: PointerEvent | null) {
    const target = e && this.targetAt(e);
    this.ctx.sketchView.setPreview(target ? [target.entity.kind === 'line' ? target.entity.pts : []] : []);
    this.ctx.viewer.requestRender();
    this.ctx.setPrompt('Dimension: click a line, circle or arc, then type its size · Esc when done');
    this.ctx.panel.show({
      title: 'Dimension',
      note: 'Click a line for its length, a circle for its diameter, or an arc for its radius, then type the size. Double-click any dimension later to change it.',
      okEnabled: true,
      okLabel: 'Done',
      hideCancel: true,
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}
