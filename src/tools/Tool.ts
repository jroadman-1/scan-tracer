import type { Session } from '../app/Session';
import type { Sketch } from '../sketch/Sketch';
import type { SnapOverlay, Snapper } from '../sketch/Snap';
import type { SketchView } from '../sketch/SketchView';
import type { CommandPanel } from '../ui/CommandPanel';
import type { Hud } from '../ui/Hud';
import type { Hit, Viewer } from '../viewer/Viewer';

export interface ToolContext {
  session: Session;
  viewer: Viewer;
  panel: CommandPanel;
  sketch: Sketch;
  sketchView: SketchView;
  snapper: Snapper;
  snapOverlay: SnapOverlay;
  hud: Hud;
  setPrompt(text: string): void;
  /** Small label beside the cursor (lengths, diameters); null hides it. */
  setCursorLabel(text: string | null, clientX?: number, clientY?: number): void;
  notify(message: string): void;
  /** Ends the tool after it committed or cancelled. */
  done(): void;
}

/** An interactive command, active until committed (Enter/OK) or cancelled (Esc). */
export interface Tool {
  readonly id: string;
  /** True if clicks should pick points (crosshair cursor, no double-click centering). */
  readonly picks: boolean;
  start(): void;
  click(hit: Hit | null, e: PointerEvent): void;
  /** Cursor moved over the viewport (not dragging). */
  move?(e: PointerEvent): void;
  /** True when typed numbers should go into on-screen inputs (length, width...). */
  acceptsTyping?(): boolean;
  /** Typed values changed: redraw the preview. */
  hudChanged?(): void;
  /** Enter in the on-screen inputs: place the point using the typed values. */
  typedCommit?(): void;
  /** Returns true if the key was handled. */
  key(e: KeyboardEvent): boolean;
  commit(): void | Promise<void>;
  cancel(): void;
}
