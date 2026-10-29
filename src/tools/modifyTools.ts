import { curveAtCursor, cutsOn, planExtend, planTrim, type TrimPlan } from '../sketch/curves';
import type { Hit } from '../viewer/Viewer';
import type { Tool, ToolContext } from './Tool';

// Dragging this far with the button down switches to trimming everything the cursor crosses.
const DRAG_PX = 4;

abstract class ModifyTool implements Tool {
  abstract readonly id: string;
  readonly picks = true;

  constructor(protected readonly ctx: ToolContext) {}

  start() {
    if (!this.ctx.session.view2d) this.ctx.session.enter2D('top');
    this.refresh(null);
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

  protected finish() {
    this.ctx.sketchView.setPreview([]);
    this.ctx.viewer.requestRender();
    this.ctx.done();
  }

  protected abstract refresh(e: PointerEvent | null): void;
  abstract click(hit: Hit | null, e: PointerEvent): void;
}

/**
 * Fusion-style Trim: hover a piece of a curve to see it in red (up to the
 * nearest crossing or connected end), click to remove it. Drag across several
 * pieces to remove them all. A curve nothing crosses is deleted whole.
 */
export class TrimTool extends ModifyTool {
  readonly id = 'trim';
  private dragFrom: { x: number; y: number } | null = null;

  private planAt(e: PointerEvent): TrimPlan | null {
    const { viewer, sketch } = this.ctx;
    const hit = curveAtCursor(viewer, sketch, e.clientX, e.clientY);
    if (!hit) return null;
    return planTrim(hit.param, cutsOn(viewer, sketch, hit.param), hit.s);
  }

  private apply(plan: TrimPlan) {
    const { session, sketch } = this.ctx;
    session.editSketch('Trim', () => {
      sketch.remove([plan.entity.id]);
      for (const p of plan.pieces) sketch.add(p);
    });
  }

  move(e: PointerEvent) {
    if (e.buttons & 1) {
      this.dragFrom ??= { x: e.clientX, y: e.clientY };
      if (Math.hypot(e.clientX - this.dragFrom.x, e.clientY - this.dragFrom.y) >= DRAG_PX) {
        const plan = this.planAt(e);
        if (plan) this.apply(plan);
      }
    } else {
      this.dragFrom = null;
    }
    this.refresh(e);
  }

  click(_hit: Hit | null, e: PointerEvent) {
    this.dragFrom = null;
    const plan = this.planAt(e);
    if (plan) this.apply(plan);
    this.refresh(e);
  }

  protected refresh(e: PointerEvent | null) {
    const plan = e ? this.planAt(e) : null;
    this.ctx.sketchView.setPreview(plan ? [plan.removed] : [], [], 'remove');
    this.ctx.viewer.requestRender();
    this.ctx.setPrompt('Trim: click the part to remove · drag across several parts to remove them all · Esc when done');
    this.ctx.panel.show({
      title: 'Trim',
      note: 'Hover a curve to see the part that will be removed (red), up to where other shapes cross or meet it. Drag across several parts to trim them in one go. A curve with nothing crossing it is deleted.',
      okEnabled: true,
      okLabel: 'Done',
      hideCancel: true,
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}

/** Extend: lengthen a line from the end nearest the cursor until it meets another shape. */
export class ExtendTool extends ModifyTool {
  readonly id = 'extend';

  private planAt(e: PointerEvent) {
    const { viewer, sketch } = this.ctx;
    const hit = curveAtCursor(viewer, sketch, e.clientX, e.clientY);
    if (!hit || hit.param.entity.kind !== 'line') return null;
    const plan = planExtend(viewer, sketch, hit.param.entity, hit.s);
    return plan && { line: hit.param.entity, ...plan };
  }

  move(e: PointerEvent) {
    this.refresh(e);
  }

  click(_hit: Hit | null, e: PointerEvent) {
    const plan = this.planAt(e);
    if (plan) {
      this.ctx.session.editSketch('Extend', () => {
        plan.line.pts[plan.end].copy(plan.to);
        this.ctx.sketch.touch();
      });
    } else if (curveAtCursor(this.ctx.viewer, this.ctx.sketch, e.clientX, e.clientY)) {
      this.ctx.notify('Nothing to extend to: no other shape lies straight ahead of that end of the line.');
    }
    this.refresh(e);
  }

  protected refresh(e: PointerEvent | null) {
    const plan = e ? this.planAt(e) : null;
    this.ctx.sketchView.setPreview(plan ? [[plan.line.pts[plan.end], plan.to]] : [], plan ? [plan.to] : []);
    this.ctx.viewer.requestRender();
    this.ctx.setPrompt('Extend: click near the end of a line to lengthen it to the next shape · Esc when done');
    this.ctx.panel.show({
      title: 'Extend',
      note: 'Hover near the end of a line to preview it extended straight on to the next shape it would meet.',
      okEnabled: true,
      okLabel: 'Done',
      hideCancel: true,
      onOk: () => this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}
