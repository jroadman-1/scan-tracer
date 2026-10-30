import * as THREE from 'three';
import type { Settings } from '../settings';
import type { Sketch, SketchSnapshot } from '../sketch/Sketch';
import { quatFromBackUp, type ViewState } from '../viewer/CameraRig';
import type { Viewer } from '../viewer/Viewer';
import { PLANES, type PlaneName } from './alignMath';

interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

/**
 * The working state around the viewer: the scan's alignment and the sketch,
 * with one undo/redo history for both, and whether the view is locked to a
 * 2D sketch plane.
 */
export class Session {
  /** The 2D sketch plane being viewed, or null in free 3D. */
  view2d: PlaneName | null = null;
  onChange: () => void = () => {};

  /** Changes with every edit, undo and redo, so callers can tell whether there are unsaved changes. */
  revision = 0;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private saved3d: { view: ViewState; ortho: boolean } | null = null;

  constructor(
    readonly viewer: Viewer,
    readonly sketch: Sketch,
    private readonly settings: Settings,
  ) {}

  /** The plane that alignment tools work in: the 2D plane, or Top in 3D. */
  get plane(): PlaneName {
    return this.view2d ?? 'top';
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label; }
  get redoLabel() { return this.redoStack.at(-1)?.label; }

  /** Starts fresh for a newly loaded scan. */
  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.sketch.clear();
    if (this.view2d) this.exit2D(false);
    this.viewer.setHeightAxis(PLANES.top.n);
    this.onChange();
  }

  /**
   * Records an alignment change. `before` defaults to the current alignment;
   * pass it when a tool has already been previewing on the live scan.
   */
  applyAlignment(label: string, after: THREE.Matrix4, opts: { animate?: boolean; before?: THREE.Matrix4 } = {}) {
    const before = opts.before ?? this.viewer.alignment;
    const target = after.clone();
    this.moveTo(target, opts.animate ?? true);
    this.push({ label, undo: () => this.moveTo(before, true), redo: () => this.moveTo(target, true) });
  }

  /** Runs a sketch change as one undoable step. */
  editSketch(label: string, change: () => void) {
    const before = this.sketch.snapshot();
    change();
    this.recordSketchEdit(label, before);
  }

  /** Records a sketch change that already happened (e.g. a finished drag), given the state before it. */
  recordSketchEdit(label: string, before: SketchSnapshot) {
    const after = this.sketch.snapshot();
    this.push({ label, undo: () => this.sketch.restore(before), redo: () => this.sketch.restore(after) });
  }

  private push(entry: HistoryEntry) {
    this.revision++;
    this.undoStack.push(entry);
    this.redoStack = [];
    this.onChange();
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    entry.undo();
    this.revision++;
    this.redoStack.push(entry);
    this.onChange();
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    entry.redo();
    this.revision++;
    this.undoStack.push(entry);
    this.onChange();
  }

  private moveTo(m: THREE.Matrix4, animate: boolean) {
    if (animate) this.viewer.animateAlignment(m);
    else this.viewer.setAlignment(m);
  }

  /**
   * Looks straight at a sketch plane in orthographic view, with orbit locked.
   * Keeps the current zoom and center unless `fit` asks to frame the whole scan.
   */
  enter2D(plane: PlaneName, opts: { fit?: boolean } = {}) {
    const rig = this.viewer.rig;
    if (!this.view2d) this.saved3d = { view: rig.goal, ortho: rig.ortho };
    this.view2d = plane;
    const { n, up } = PLANES[plane];
    const quat = quatFromBackUp(n, up);
    rig.ortho = true;
    rig.setView(opts.fit ? rig.fitState(quat) : { ...rig.goal, quat });
    this.viewer.setHeightAxis(n);
    this.onChange();
  }

  /** Returns to the 3D view that was showing before 2D. */
  exit2D(animate = true) {
    if (!this.view2d) return;
    const rig = this.viewer.rig;
    this.view2d = null;
    rig.ortho = this.saved3d?.ortho ?? this.settings.projection === 'ortho';
    if (this.saved3d) rig.setView(this.saved3d.view, animate);
    else rig.setView(rig.fitState(), animate);
    this.saved3d = null;
    rig.update();
    this.viewer.setHeightAxis(PLANES.top.n);
    this.onChange();
  }
}
