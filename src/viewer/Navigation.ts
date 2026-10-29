import * as THREE from 'three';
import type { Settings } from '../settings';
import type { Viewer } from './Viewer';

export type NavTool = 'none' | 'orbit' | 'pan';

/** Safari's pinch gesture event (not in the standard DOM typings). */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

// A pause this long between wheel events starts a new gesture.
const GESTURE_GAP_MS = 250;
// A left press that moves less than this is a click.
const CLICK_SLOP_PX = 4;

/**
 * Trackpad (Fusion-style): swipe pans, Shift/Option + swipe orbits, pinch zooms.
 * Mouse: wheel zooms, middle-drag pans, Shift + middle-drag orbits.
 * Either: the Orbit/Pan tools make a plain left-drag orbit or pan.
 */
export class Navigation {
  tool: NavTool = 'none';
  onToolChange: (tool: NavTool) => void = () => {};
  /** Plain left clicks (not drags), for picking. */
  onClick: (e: PointerEvent) => void = () => {};
  /** Cursor moved over the canvas while not dragging the view. */
  onMove: (e: PointerEvent) => void = () => {};
  /** In 2D the view stays square to the sketch plane, so orbit gestures pan instead. */
  orbitLocked = false;
  private picking = false;
  private press: { x: number; y: number } | null = null;

  private lastWheel = 0;
  private orbitPivot: THREE.Vector3 | null = null;
  private gestureScale = 1;
  private drag: { mode: 'orbit' | 'pan'; x: number; y: number; pivot: THREE.Vector3 } | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly viewer: Viewer,
    private readonly settings: Settings,
  ) {
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('gesturestart', this.onGestureStart as EventListener);
    el.addEventListener('gesturechange', this.onGestureChange as EventListener);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('pointerleave', () => { if (!this.drag) viewer.setHover(null); });
    el.addEventListener('dblclick', this.onDoubleClick);
    // Stop the browser's middle-click autoscroll.
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  }

  setTool(tool: NavTool) {
    this.tool = this.tool === tool ? 'none' : tool;
    this.el.dataset.navTool = this.tool;
    this.onToolChange(this.tool);
  }

  /** While a pick tool is active: crosshair cursor, and double-click doesn't re-center. */
  setPicking(on: boolean) {
    this.picking = on;
    this.el.classList.toggle('picking', on);
  }

  private get rig() {
    return this.viewer.rig;
  }

  private pivotAt(x: number, y: number): THREE.Vector3 {
    return this.viewer.pick(x, y)?.point ?? this.rig.pointOnTargetPlane(this.viewer.ndc(x, y));
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= 400; dy *= 400; }

    const now = performance.now();
    const newGesture = now - this.lastWheel > GESTURE_GAP_MS;
    this.lastWheel = now;

    if (e.ctrlKey) {
      // Chrome, Edge and Firefox report a trackpad pinch as ctrl + wheel.
      this.rig.zoom(Math.exp(dy * 0.01), this.pivotAt(e.clientX, e.clientY));
    } else if (this.settings.nav === 'mouse' || e.deltaMode !== 0) {
      this.rig.zoom(Math.exp((dy || dx) * 0.0015), this.pivotAt(e.clientX, e.clientY));
    } else {
      const modifier = e.shiftKey || e.altKey;
      if (modifier !== this.settings.swapOrbitPan && !this.orbitLocked) {
        if (newGesture || !this.orbitPivot) this.orbitPivot = this.pivotAt(e.clientX, e.clientY);
        this.rig.orbit(-dx, -dy, this.orbitPivot);
      } else {
        this.rig.pan(-dx, -dy);
      }
    }
    this.viewer.requestRender();
  };

  private onGestureStart = (e: GestureEvent) => {
    e.preventDefault();
    this.gestureScale = 1;
  };

  private onGestureChange = (e: GestureEvent) => {
    e.preventDefault();
    const factor = this.gestureScale / e.scale;
    this.gestureScale = e.scale;
    this.rig.zoom(factor, this.pivotAt(e.clientX, e.clientY));
    this.viewer.requestRender();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 0 && this.tool === 'none') {
      this.press = { x: e.clientX, y: e.clientY };
      return;
    }
    let mode: 'orbit' | 'pan' | null = null;
    if (e.button === 1) mode = e.shiftKey ? 'orbit' : 'pan';
    else if (e.button === 0) mode = this.tool === 'none' ? null : this.tool;
    if (!mode) return;
    if (this.orbitLocked) mode = 'pan';

    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    this.rig.cancelAnimation();
    this.drag = { mode, x: e.clientX, y: e.clientY, pivot: this.pivotAt(e.clientX, e.clientY) };
    this.el.classList.add('dragging');
    this.viewer.setHover(null);
  };

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) {
      this.viewer.setHover(e.clientX, e.clientY);
      this.onMove(e);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.mode === 'orbit') this.rig.orbit(dx, dy, d.pivot);
    else this.rig.pan(dx, dy);
    this.viewer.requestRender();
  };

  private onPointerUp = (e: PointerEvent) => {
    const press = this.press;
    this.press = null;
    if (press && e.button === 0 && Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_SLOP_PX) {
      this.onClick(e);
    }
    if (!this.drag) return;
    this.drag = null;
    this.el.classList.remove('dragging');
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
  };

  /** Double-click the scan to re-center the view on that point. */
  private onDoubleClick = (e: MouseEvent) => {
    if (this.picking) return;
    const hit = this.viewer.pick(e.clientX, e.clientY);
    if (!hit) return;
    const goal = this.rig.goal;
    this.rig.setView({ ...goal, target: hit.point });
    this.viewer.requestRender();
  };
}
