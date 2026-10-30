import './style.css';
import { PLANES, rotationInPlane, type PlaneName } from './app/alignMath';
import { Session } from './app/Session';
import { units } from './app/units';
import { loadScanFile, type ScanStats } from './io/loadScan';
import { exportAlignedObj } from './io/objExport';
import { PROJECT_EXTENSION, readProject, writeProject, type ProjectState } from './io/project';
import { saveFile, saveFileAs, type SaveHandle } from './io/saveFile';
import { loadSettings, saveSettings, type Settings } from './settings';
import { describeEntity, Sketch } from './sketch/Sketch';
import { SketchEditor } from './sketch/SketchEditor';
import { SnapOverlay, Snapper } from './sketch/Snap';
import { applyDimension } from './sketch/dimensions';
import { DimensionView } from './sketch/DimensionView';
import { DimensionTool } from './tools/DimensionTool';
import { ExportTool } from './tools/ExportTool';
import { Hud } from './ui/Hud';
import { SketchView } from './sketch/SketchView';
import { ConstrainTool } from './tools/constrainTools';
import { ExtendTool, TrimTool } from './tools/modifyTools';
import { OriginTool } from './tools/OriginTool';
import { PlaneTool } from './tools/PlaneTool';
import {
  CenterArcTool, CenterCircleTool, CenterRectTool, CircleTool, copySelection, CornerRectTool, FilletTool, LineTool, PasteTool, PointTool,
  SplineTool, ThreePointArcTool, type Clipboard,
} from './tools/sketchTools';
import { StraightenTool } from './tools/StraightenTool';
import type { Tool, ToolContext } from './tools/Tool';
import { CommandPanel } from './ui/CommandPanel';
import { ICONS } from './ui/icons';
import { Navigation, type NavTool } from './viewer/Navigation';
import type { ShadingMode } from './viewer/ScanShading';
import { ViewCube } from './viewer/ViewCube';
import { Viewer } from './viewer/Viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  el.innerHTML = ICONS[el.dataset.icon!] ?? '';
}

// Keep trackpad pinches from zooming the page itself.
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// The app needs WebGL 2 for the 3D view; explain instead of failing silently.
if (!document.createElement('canvas').getContext('webgl2')) {
  $('empty').querySelector('.empty-card')!.innerHTML =
    '<h2>3D graphics are unavailable</h2><p>Scan Tracer needs WebGL 2. Try a current version of Chrome, Edge, Safari or Firefox, and make sure hardware acceleration is turned on.</p>';
  throw new Error('WebGL 2 is not available');
}

const settings = loadSettings();
const viewport = $('viewport');
const viewer = new Viewer(viewport);
const nav = new Navigation(viewer.canvas, viewer, settings);
const cube = new ViewCube(viewport, viewer.rig, () => viewer.requestRender(), () => viewer.home());
viewer.onRender = () => {
  cube.render();
  sketchView.setDashScale(viewer.rig.worldPerPixel);
  dimView.update();
};
viewer.setOrtho(settings.projection === 'ortho');
const sketch = new Sketch();
const sketchView = new SketchView(Math.min(window.devicePixelRatio, 2));
const session = new Session(viewer, sketch, settings);
const panel = new CommandPanel($('cmd-panel'));
let activeTool: Tool | null = null;
const snapper = new Snapper(viewer, sketch);
const snapOverlay = new SnapOverlay(viewport, viewer);
const hud = new Hud(document.body);
const dimView = new DimensionView(viewport, viewer, sketch);
const editor = new SketchEditor(
  viewer.canvas, viewer, session, sketchView, snapper, snapOverlay,
  () => !activeTool && nav.tool === 'none',
);

// --- Status bar ---------------------------------------------------------------

const prompt = $('prompt');
const coords = $('coords');
let hasScan = false;

function navHelp(): string {
  if (settings.nav === 'mouse') return 'Wheel: zoom · Middle-drag: pan · ⇧ + middle-drag: orbit';
  return settings.swapOrbitPan
    ? 'Swipe: orbit · ⇧ + swipe: pan · Pinch: zoom'
    : 'Swipe: pan · ⇧ or ⌥ + swipe: orbit · Pinch: zoom';
}

function updatePrompt(tool: NavTool = nav.tool) {
  $('nav-hint').textContent = navHelp();
  $('nav-help').textContent = navHelp();
  if (activeTool) return; // the tool writes its own prompt
  const selected = [...sketch.selection].map((id) => sketch.get(id));
  if (!hasScan) prompt.textContent = 'Open a scan to begin';
  else if (selected.length === 1 && selected[0]?.kind === 'spline') {
    prompt.textContent = 'Spline: drag points to reshape · double-click the curve to add a point, or a point to remove it · Delete removes the spline';
  } else if (selected.length === 1 && selected[0]?.kind === 'arc') {
    prompt.textContent = 'Arc: drag the curve to bend it · drag an end to move it · D then click it to add a radius dimension · Delete removes it';
  } else if (selected.length) {
    prompt.textContent = 'Drag a point or a line to move it (Shift locks level/plumb, ⌘ turns off snapping) · drag a circle edge to resize · ⌘C copy · Delete removes the selection';
  }
  else if (session.view2d) prompt.textContent = `2D ${PLANES[session.view2d].label} view: swipe to pan, pinch to zoom · Exit 2D returns to 3D`;
  else if (tool === 'orbit') prompt.textContent = 'Orbit: drag to orbit · Esc to exit';
  else if (tool === 'pan') prompt.textContent = 'Pan: drag to pan · Esc to exit';
  else prompt.textContent = 'Double-click the scan to center on a point';
}

viewer.onHover = (hit) => {
  coords.textContent = hit
    ? `X ${units.num(hit.point.x)}   Y ${units.num(hit.point.y)}   Z ${units.num(hit.point.z)}`
    : '';
};

// --- Opening scans --------------------------------------------------------------

const fileInput = $<HTMLInputElement>('file-input');
let loading = false;

function showError(message: string) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 6000);
}

let scanStats: ScanStats | null = null;

function showScanInfo(s: ScanStats) {
  scanStats = s;
  const fmt = (n: number) => n.toLocaleString();
  const size = `${units.num(s.size.x)} × ${units.num(s.size.y)} × ${units.num(s.size.z)}`;
  const row = (k: string, v: string) => `<div class="kv"><span>${k}</span><b title="${v}">${v}</b></div>`;
  const name = s.name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  $('scan-info').classList.remove('muted');
  $('scan-info').innerHTML =
    row('File', name) +
    row('Triangles', fmt(s.triangles)) +
    row('Vertices', fmt(s.vertices)) +
    row(`Size (${units.unit})`, size) +
    row('Loaded in', `${s.seconds.toFixed(1)} s`);
}

async function openFile(file: File) {
  if (loading) return;
  if (isDirty() && !window.confirm('You have unsaved changes. Open this file anyway and lose them?')) return;
  loading = true;
  $('loading').hidden = false;
  $('loading-name').textContent = file.name;
  const bar = $('loading-bar');
  const stage = $('loading-stage');
  bar.style.width = '0%';
  stage.textContent = 'Reading file';
  try {
    let project: ProjectState | null = null;
    let source: Parameters<typeof loadScanFile>[0] = file;
    if (file.name.toLowerCase().endsWith(PROJECT_EXTENSION)) {
      stage.textContent = 'Reading project';
      const read = await readProject(file);
      project = read.state;
      source = { name: project.scanName, mesh: read.mesh };
    }
    const { geometry, stats } = await loadScanFile(source, (s, f) => {
      stage.textContent = s;
      bar.style.width = `${Math.round(f * 100)}%`;
    });
    endTool(true);
    viewer.setMesh(geometry);
    sketchView.attach(viewer.mesh!);
    session.reset();
    hasScan = true;
    if (project) {
      viewer.setAlignment(project.alignment);
      sketch.restore(project.sketch);
      if (project.unit !== settings.units) changeSettings({ units: project.unit });
      if (project.view2d) session.enter2D(project.view2d, { fit: true });
      else viewer.fit();
    }
    // A project opened from the file dialog can't be written back to directly,
    // so the first save asks where (suggesting the same name).
    projectHandle = null;
    projectName = project ? file.name : null;
    savedRevision = session.revision;
    updateTitle();
    for (const id of ['btn-save', 'btn-export', 'caret-export', 'btn-plane', 'btn-straighten', 'btn-flip', 'btn-origin', 'btn-2d', 'btn-point', 'btn-line', 'btn-rect', 'caret-rect', 'btn-circle', 'caret-circle', 'btn-arc', 'caret-arc', 'btn-spline', 'btn-trim', 'btn-fillet', 'btn-extend',
      'btn-dim', 'btn-hv', 'btn-perp', 'btn-parallel', 'btn-coincident']) {
      $<HTMLButtonElement>(id).disabled = false;
    }
    showScanInfo(stats);
    $('empty').hidden = true;
    $('display-panel').hidden = false;
    $('navbar').hidden = false;
    updatePrompt();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    loading = false;
    $('loading').hidden = true;
  }
}

// --- Saving projects ---------------------------------------------------------------

let projectHandle: SaveHandle | null = null;
/** The project's file name once saved or opened; null for a scan that hasn't been saved as a project. */
let projectName: string | null = null;
let savedRevision = 0;

const isDirty = () => hasScan && session.revision !== savedRevision;

function updateTitle() {
  const name = projectName ?? scanStats?.name;
  document.title = name ? `${isDirty() ? '● ' : ''}${name} — Scan Tracer` : 'Scan Tracer';
  $('btn-save').classList.toggle('dirty', isDirty());
}

/** Saves the scan and everything done to it as one .scantrace file. Save As always asks where. */
async function saveProject(saveAs = false) {
  const mesh = viewer.mesh;
  if (!mesh || loading || !scanStats) return;
  endTool(true);
  const name = projectName ?? `${scanStats.name.replace(/\.[^.]+$/, '')}${PROJECT_EXTENSION}`;
  const revision = session.revision;
  loading = true;
  $('loading').hidden = false;
  $('loading-name').textContent = name;
  $('loading-stage').textContent = 'Saving project';
  $('loading-bar').style.width = '100%';
  try {
    const g = mesh.geometry;
    const blob = await writeProject(
      {
        positions: g.attributes.position.array as Float32Array,
        index: g.index!.array instanceof Uint32Array ? g.index!.array : Uint32Array.from(g.index!.array),
      },
      { scanName: scanStats.name, alignment: viewer.alignment, sketch: sketch.snapshot(), unit: units.unit, view2d: session.view2d },
    );
    $('loading').hidden = true;
    const saved = await saveFileAs(
      name,
      blob,
      { description: 'Scan Tracer project', mime: 'application/x-scantrace', extension: PROJECT_EXTENSION },
      saveAs ? null : projectHandle,
    );
    if (!saved) return;
    if (saved !== 'download') projectHandle = saved;
    projectName = saved === 'download' ? name : saved.name;
    savedRevision = revision;
    updateTitle();
    prompt.textContent = `Saved ${projectName} (${(blob.size / 1e6).toFixed(1)} MB, scan included)`;
  } catch (err) {
    showError(`The project could not be saved (${err instanceof Error ? err.message : String(err)}).`);
  } finally {
    loading = false;
    $('loading').hidden = true;
  }
}

$('btn-save').addEventListener('click', (e) => saveProject(e.shiftKey));
window.addEventListener('beforeunload', (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = ''; // older browsers need this to show the warning
});

const chooseFile = () => fileInput.click();
$('btn-open').addEventListener('click', chooseFile);
$('btn-open-empty').addEventListener('click', chooseFile);
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
  fileInput.value = '';
});

let dragDepth = 0;
viewport.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop-hint').hidden = false; });
viewport.addEventListener('dragover', (e) => e.preventDefault());
viewport.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-hint').hidden = true; } });
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-hint').hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});

// --- Display panel ----------------------------------------------------------------

function setShading(mode: ShadingMode) {
  viewer.shading.setMode(mode);
  for (const b of $('shade-seg').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.value === mode);
  }
  for (const row of $('display-panel').querySelectorAll<HTMLElement>('[data-for]')) {
    row.hidden = row.dataset.for !== mode;
  }
  viewer.requestRender();
}

$('shade-seg').addEventListener('click', (e) => {
  const value = (e.target as HTMLElement).closest('button')?.dataset.value;
  if (value) setShading(value as ShadingMode);
});

const curvGain = $<HTMLInputElement>('curv-gain');
curvGain.addEventListener('input', () => {
  viewer.shading.setCurvatureContrast(Number(curvGain.value));
  viewer.requestRender();
});

const hLow = $<HTMLInputElement>('h-low');
const hHigh = $<HTMLInputElement>('h-high');
const onHeightWindow = () => {
  viewer.shading.setHeightWindow(Number(hLow.value), Number(hHigh.value));
  viewer.requestRender();
};
hLow.addEventListener('input', onHeightWindow);
hHigh.addEventListener('input', onHeightWindow);

const hContour = $<HTMLSelectElement>('h-contour');
hContour.addEventListener('change', () => {
  viewer.shading.setContourStep(Number(hContour.value));
  viewer.requestRender();
});

const showVertices = $<HTMLInputElement>('show-vertices');
showVertices.addEventListener('change', () => viewer.setShowVertices(showVertices.checked));

setShading('clay');

// --- Navigation bar and view buttons -----------------------------------------------

nav.onToolChange = (tool) => {
  $('nav-orbit').classList.toggle('active', tool === 'orbit');
  $('nav-pan').classList.toggle('active', tool === 'pan');
  updatePrompt(tool);
};
$('nav-orbit').addEventListener('click', () => nav.setTool('orbit'));
$('nav-pan').addEventListener('click', () => nav.setTool('pan'));
// In 2D, fitting re-frames the locked plane view instead of leaving it.
function fit() {
  if (session.view2d) session.enter2D(session.view2d, { fit: true });
  else viewer.fit();
}
function home() {
  if (session.view2d) session.enter2D(session.view2d, { fit: true });
  else viewer.home();
}
$('nav-fit').addEventListener('click', fit);
$('nav-home').addEventListener('click', home);
$('btn-fit').addEventListener('click', fit);

// --- Settings ---------------------------------------------------------------------

function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

function syncSettingsUI() {
  for (const seg of document.querySelectorAll<HTMLElement>('[data-setting]')) {
    const key = seg.dataset.setting as keyof Settings;
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('on', b.dataset.value === settings[key]);
    }
  }
  $<HTMLInputElement>('set-swap').checked = settings.swapOrbitPan;
  $('swap-row').hidden = settings.nav !== 'trackpad';
  updatePrompt();
}

function changeSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  saveSettings(settings);
  applyTheme();
  units.set(settings.units);
  if (!session.view2d) viewer.setOrtho(settings.projection === 'ortho');
  syncSettingsUI();
}

for (const seg of document.querySelectorAll<HTMLElement>('[data-setting]')) {
  seg.addEventListener('click', (e) => {
    const value = (e.target as HTMLElement).closest('button')?.dataset.value;
    if (value) changeSettings({ [seg.dataset.setting!]: value } as Partial<Settings>);
  });
}
$<HTMLInputElement>('set-swap').addEventListener('change', (e) => {
  changeSettings({ swapOrbitPan: (e.target as HTMLInputElement).checked });
});

const settingsPop = $('settings');
$('btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPop.hidden = !settingsPop.hidden;
  $('btn-settings').classList.toggle('active', !settingsPop.hidden);
});
document.addEventListener('pointerdown', (e) => {
  if (!settingsPop.hidden && !settingsPop.contains(e.target as Node) && !$('btn-settings').contains(e.target as Node)) {
    settingsPop.hidden = true;
    $('btn-settings').classList.remove('active');
  }
});

units.set(settings.units);
units.onChange(() => {
  $('units-chip').textContent = units.unit;
  if (scanStats) showScanInfo(scanStats);
  renderSketchList();
  viewer.requestRender();
});
$('units-chip').textContent = units.unit;
$('units-chip').addEventListener('click', () => changeSettings({ units: units.unit === 'mm' ? 'in' : 'mm' }));

applyTheme();
syncSettingsUI();

// --- Tools and alignment ---------------------------------------------------------------

const toolContext: ToolContext = {
  session,
  viewer,
  panel,
  sketch,
  sketchView,
  snapper,
  snapOverlay,
  hud,
  setPrompt: (text) => { prompt.textContent = text; },
  setCursorLabel: (text, x = 0, y = 0) => {
    const el = $('cursor-label');
    el.hidden = !text;
    if (text) {
      el.textContent = text;
      el.style.transform = `translate(${x + 16}px, ${y + 16}px)`;
    }
  },
  notify: showError,
  done: () => endTool(false),
};

const toolButtons: Record<string, string> = {
  plane: 'btn-plane',
  straighten: 'btn-straighten',
  origin: 'btn-origin',
  point: 'btn-point',
  line: 'btn-line',
  cornerRect: 'btn-rect',
  centerRect: 'btn-rect',
  centerCircle: 'btn-circle',
  circle: 'btn-circle',
  arc3: 'btn-arc',
  centerArc: 'btn-arc',
  spline: 'btn-spline',
  trim: 'btn-trim',
  fillet: 'btn-fillet',
  extend: 'btn-extend',
  dimension: 'btn-dim',
  export: 'btn-export',
  hv: 'btn-hv',
  perpendicular: 'btn-perp',
  parallel: 'btn-parallel',
  coincident: 'btn-coincident',
};

function startTool(make: (ctx: ToolContext) => Tool) {
  const tool = make(toolContext);
  const same = activeTool?.id === tool.id;
  endTool(true);
  if (same || !viewer.mesh) return; // clicking the active tool's button turns it off
  if (nav.tool !== 'none') nav.setTool(nav.tool);
  activeTool = tool;
  nav.setPicking(tool.picks);
  showVariant(tool.id);
  if (toolButtons[tool.id]) $(toolButtons[tool.id]).classList.add('active');
  tool.start();
}

/** Clears tool UI. With `cancel`, also tells the active tool to undo its preview. */
function endTool(cancel: boolean) {
  const tool = activeTool;
  if (!tool) return;
  activeTool = null; // cleared first: cancel() calls back into done()
  if (cancel) tool.cancel();
  if (toolButtons[tool.id]) $(toolButtons[tool.id]).classList.remove('active');
  nav.setPicking(false);
  panel.hide();
  viewer.setMarkers([]);
  updatePrompt();
}

nav.onClick = (e) => {
  if (activeTool) activeTool.click(viewer.pick(e.clientX, e.clientY), e);
  else {
    dimView.select(null);
    editor.click(e);
  }
};
nav.onMove = (e) => {
  if (activeTool) activeTool.move?.(e);
  else editor.hover(e);
};

$('btn-plane').addEventListener('click', () => startTool((ctx) => new PlaneTool(ctx)));
$('btn-straighten').addEventListener('click', () => startTool((ctx) => new StraightenTool(ctx)));
$('btn-origin').addEventListener('click', () => startTool((ctx) => new OriginTool(ctx)));
const sketchTools = {
  point: (ctx: ToolContext) => new PointTool(ctx),
  line: (ctx: ToolContext) => new LineTool(ctx),
  cornerRect: (ctx: ToolContext) => new CornerRectTool(ctx),
  centerRect: (ctx: ToolContext) => new CenterRectTool(ctx),
  centerCircle: (ctx: ToolContext) => new CenterCircleTool(ctx),
  circle: (ctx: ToolContext) => new CircleTool(ctx),
  arc3: (ctx: ToolContext) => new ThreePointArcTool(ctx),
  centerArc: (ctx: ToolContext) => new CenterArcTool(ctx),
  spline: (ctx: ToolContext) => new SplineTool(ctx),
  trim: (ctx: ToolContext) => new TrimTool(ctx),
  fillet: (ctx: ToolContext) => new FilletTool(ctx),
  extend: (ctx: ToolContext) => new ExtendTool(ctx),
};
$('btn-point').addEventListener('click', () => startTool(sketchTools.point));
$('btn-line').addEventListener('click', () => startTool(sketchTools.line));
// Fusion-style split buttons: the button runs the last-used variant, ▾ lists them all.
interface Variant { id: string; run: () => void; label: string; name: string; icon: string; key: string }
const toolVariant = (id: keyof typeof sketchTools, label: string, name: string, icon: string, key: string): Variant =>
  ({ id, run: () => startTool(sketchTools[id]), label, name, icon, key });
const splits: Record<string, { variants: Variant[]; current: number }> = {
  'btn-export': {
    current: 0,
    variants: [
      { id: 'export', run: () => exportDxf(), label: 'Export', name: 'DXF sketch (2D drawing)', icon: 'export', key: '⌘E' },
      { id: 'exportObj', run: () => void exportObj(), label: 'Export', name: 'OBJ scan (aligned to the sketch axes)', icon: 'exportObj', key: '' },
    ],
  },
  'btn-rect': {
    current: 0,
    variants: [
      toolVariant('cornerRect', 'Rectangle', '2-Point Rectangle', 'rect', 'R'),
      toolVariant('centerRect', 'Center Rect', 'Center Rectangle', 'rectCenter', '⇧R'),
    ],
  },
  'btn-circle': {
    current: 0,
    variants: [
      toolVariant('centerCircle', 'Circle', 'Center Circle', 'circleCenter', 'C'),
      toolVariant('circle', '3-Pt Circle', '3-Point Circle', 'circle3', '⇧C'),
    ],
  },
  'btn-arc': {
    current: 0,
    variants: [
      toolVariant('arc3', 'Arc', '3-Point Arc', 'arc3', 'A'),
      toolVariant('centerArc', 'Center Arc', 'Center Point Arc', 'arcCenter', '⇧A'),
    ],
  },
};

function renderSplit(buttonId: string) {
  const split = splits[buttonId];
  const v = split.variants[split.current];
  const btn = $(buttonId);
  btn.querySelector('i')!.innerHTML = ICONS[v.icon];
  btn.querySelector('span')!.textContent = v.label;
  btn.title = v.key ? `${v.name} (${v.key})` : v.name;
}

/** Shows the variant a tool belongs to on its split button. */
function showVariant(toolId: string) {
  for (const [buttonId, split] of Object.entries(splits)) {
    const i = split.variants.findIndex((v) => v.id === toolId);
    if (i >= 0) {
      split.current = i;
      renderSplit(buttonId);
    }
  }
}

const tbMenu = $('tb-menu');
for (const [buttonId, split] of Object.entries(splits)) {
  renderSplit(buttonId);
  $(buttonId).addEventListener('click', () => split.variants[split.current].run());
  const caret = $(buttonId.replace('btn-', 'caret-'));
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = caret.closest('.tb-split')!.getBoundingClientRect();
    tbMenu.replaceChildren(
      ...split.variants.map((v) => {
        const item = document.createElement('button');
        item.className = 'tb-menu-item';
        item.innerHTML = `${ICONS[v.icon]}<span>${v.name}</span>${v.key ? `<kbd>${v.key}</kbd>` : ''}`;
        item.addEventListener('click', () => {
          tbMenu.hidden = true;
          showVariant(v.id);
          v.run();
        });
        return item;
      }),
    );
    tbMenu.style.left = `${r.left}px`;
    tbMenu.style.top = `${r.bottom + 4}px`;
    tbMenu.hidden = !tbMenu.hidden;
  });
}
document.addEventListener('pointerdown', (e) => {
  if (!tbMenu.hidden && !tbMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest('.tb-caret')) tbMenu.hidden = true;
});
$('btn-spline').addEventListener('click', () => startTool(sketchTools.spline));
$('btn-trim').addEventListener('click', () => startTool(sketchTools.trim));
$('btn-fillet').addEventListener('click', () => startTool(sketchTools.fillet));
$('btn-extend').addEventListener('click', () => startTool(sketchTools.extend));
const dimensionTool = (ctx: ToolContext) => new DimensionTool(ctx, (id) => dimView.edit(id));
const exportTool = (ctx: ToolContext) => new ExportTool(ctx, scanStats?.name ?? 'sketch');

function exportDxf() {
  if (!sketch.entities.length) showError('Nothing drawn yet: draw something to export as a DXF, or choose Export OBJ for the scan.');
  else startTool(exportTool);
}

/** Saves the scan as an OBJ with its alignment applied, so it opens already oriented. */
async function exportObj() {
  if (!viewer.mesh || loading) return;
  endTool(true);
  const name = `${(scanStats?.name ?? 'scan').replace(/\.[^.]+$/, '')}-aligned.obj`;
  loading = true;
  $('loading').hidden = false;
  $('loading-name').textContent = name;
  $('loading-stage').textContent = 'Writing OBJ';
  const bar = $('loading-bar');
  bar.style.width = '0%';
  try {
    const blob = await exportAlignedObj(viewer.mesh, (f) => { bar.style.width = `${Math.round(f * 100)}%`; });
    $('loading').hidden = true;
    const saved = await saveFile(name, blob, { description: 'OBJ mesh', mime: 'model/obj', extension: '.obj' });
    if (saved) prompt.textContent = `Exported ${name} (${(blob.size / 1e6).toFixed(1)} MB, mm, aligned to the sketch axes)`;
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    loading = false;
    $('loading').hidden = true;
  }
}
$('btn-dim').addEventListener('click', () => startTool(dimensionTool));
$('btn-hv').addEventListener('click', () => startTool((ctx) => new ConstrainTool(ctx, 'hv')));

hud.onChange = () => activeTool?.hudChanged?.();
hud.onCommit = () => activeTool?.typedCommit?.();

dimView.onEdit = (dim, value) => {
  session.editSketch('Change dimension', () => {
    applyDimension(sketch, dim, value);
    sketch.touch();
  });
};
$('btn-perp').addEventListener('click', () => startTool((ctx) => new ConstrainTool(ctx, 'perpendicular')));
$('btn-parallel').addEventListener('click', () => startTool((ctx) => new ConstrainTool(ctx, 'parallel')));
$('btn-coincident').addEventListener('click', () => startTool((ctx) => new ConstrainTool(ctx, 'coincident')));

function renderSketchList() {
  const list = $('sketch-list');
  const items = sketch.entities;
  list.classList.toggle('muted', !items.length);
  if (!items.length) {
    list.textContent = 'Nothing drawn yet';
    return;
  }
  list.replaceChildren(
    ...items.map((e, i) => {
      const row = document.createElement('button');
      row.className = 'ent-row';
      row.classList.toggle('sel', sketch.selection.has(e.id));
      const n = document.createElement('span');
      n.textContent = String(i + 1);
      row.append(n, describeEntity(e));
      row.addEventListener('click', (ev) => {
        if (ev.shiftKey || ev.metaKey) {
          const next = new Set(sketch.selection);
          if (next.has(e.id)) next.delete(e.id);
          else next.add(e.id);
          sketch.setSelection(next);
        } else {
          sketch.setSelection([e.id]);
        }
      });
      return row;
    }),
  );
}

sketch.onChange = () => {
  dimView.sync();
  editor.redraw();
  renderSketchList();
  updatePrompt();
};

$('btn-flip').addEventListener('click', () => {
  endTool(true);
  session.applyAlignment('Flip 180°', rotationInPlane(session.plane, Math.PI).multiply(viewer.alignment));
});

function toggle2D() {
  if (session.view2d) session.exit2D();
  else session.enter2D('top');
}
$('btn-2d').addEventListener('click', toggle2D);
$('btn-exit-2d').addEventListener('click', () => session.exit2D());
$('plane-seg').addEventListener('click', (e) => {
  const value = (e.target as HTMLElement).closest('button')?.dataset.value;
  if (value) session.enter2D(value as PlaneName);
});

function undo() { endTool(true); session.undo(); }
function redo() { endTool(true); session.redo(); }
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

session.onChange = () => {
  updateTitle();
  const undoBtn = $<HTMLButtonElement>('btn-undo');
  const redoBtn = $<HTMLButtonElement>('btn-redo');
  undoBtn.disabled = !session.canUndo;
  redoBtn.disabled = !session.canRedo;
  undoBtn.title = session.canUndo ? `Undo ${session.undoLabel} (⌘Z)` : 'Undo (⌘Z)';
  redoBtn.title = session.canRedo ? `Redo ${session.redoLabel} (⌘⇧Z)` : 'Redo (⌘⇧Z)';

  const plane = session.view2d;
  $('view2d-bar').hidden = !plane;
  $('btn-2d').classList.toggle('active', !!plane);
  for (const b of $('plane-seg').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.value === plane);
  }
  cube.setEnabled(!plane);
  nav.orbitLocked = !!plane;
  viewer.requestRender();
  updatePrompt();
};

// --- Keyboard ------------------------------------------------------------------------

let clipboard: Clipboard | null = null;

/** Copies the selected shapes; false if nothing is selected. */
function copy(): boolean {
  if (activeTool) return false;
  const clip = copySelection(sketch, viewer);
  if (!clip) return false;
  clipboard = clip;
  const n = clip.entities.length;
  prompt.textContent = `Copied ${n > 1 ? `${n} items` : clip.entities[0].shape.kind} · ⌘V to paste`;
  return true;
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.matches('input, select, textarea')) return;
  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); chooseFile(); }
    else if (k === 's') { e.preventDefault(); saveProject(e.shiftKey); }
    else if (k === 'e' && hasScan) { e.preventDefault(); exportDxf(); }
    else if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
    else if (k === 'z') { e.preventDefault(); undo(); }
    else if (k === 'c' && copy()) e.preventDefault();
    else if (k === 'x' && copy()) { e.preventDefault(); if (!activeTool) editor.deleteSelection(); }
    else if (k === 'v' && hasScan && clipboard) { e.preventDefault(); startTool((ctx) => new PasteTool(ctx, clipboard!)); }
    else if (k === 'a' && hasScan && !activeTool) {
      // Select everything drawn on the plane being viewed (or all of it in 3D).
      e.preventDefault();
      sketch.setSelection(sketch.entities.filter((ent) => !session.view2d || ent.plane === session.view2d).map((ent) => ent.id));
    }
    return;
  }
  if (e.altKey) return;
  // Numbers typed while drawing go into the on-screen inputs (length, width...).
  if (activeTool?.acceptsTyping?.() && (/^[0-9.]$/.test(e.key) || e.key === 'Tab')) {
    e.preventDefault();
    hud.startTyping(e.key === 'Tab' ? '' : e.key);
    return;
  }
  if (activeTool?.key(e)) { e.preventDefault(); return; }

  switch (e.key) {
    case 'Escape':
      if (!settingsPop.hidden) { settingsPop.hidden = true; $('btn-settings').classList.remove('active'); }
      else if (activeTool) endTool(true);
      else if (nav.tool !== 'none') nav.setTool(nav.tool);
      else editor.clearSelection();
      // Esc never leaves 2D: pressing it twice to finish a tool shouldn't throw you out of the sketch view.
      break;
    case 'Delete':
    case 'Backspace':
      if (activeTool) break;
      if (dimView.selected !== null) {
        const id = dimView.selected;
        session.editSketch('Delete dimension', () => sketch.removeDim(id));
        dimView.select(null);
      } else {
        editor.deleteSelection();
      }
      break;
    case 'd': case 'D': if (hasScan) startTool(dimensionTool); break;
    case 'p': case 'P': if (hasScan) startTool(sketchTools.point); break;
    case 'r': case 'R': if (hasScan) startTool(e.shiftKey ? sketchTools.centerRect : sketchTools.cornerRect); break;
    case 'l': case 'L': if (hasScan) startTool(sketchTools.line); break;
    case 'c': case 'C': if (hasScan) startTool(e.shiftKey ? sketchTools.circle : sketchTools.centerCircle); break;
    case 'a': case 'A': if (hasScan) startTool(e.shiftKey ? sketchTools.centerArc : sketchTools.arc3); break;
    case 's': case 'S': if (hasScan) startTool(sketchTools.spline); break;
    case 't': case 'T': if (hasScan) startTool(sketchTools.trim); break;
    case 'x': case 'X': {
      // Toggle selected geometry between part lines and centerlines (construction).
      const chosen = [...sketch.selection].map((id) => sketch.get(id)).filter((ent) => ent && ent.kind !== 'point');
      if (!chosen.length) break;
      const make = chosen.some((ent) => !ent!.construction);
      session.editSketch(make ? 'Make centerline' : 'Make normal line', () => {
        for (const ent of chosen) ent!.construction = make || undefined;
        sketch.touch();
      });
      break;
    }
    case 'Enter':
      activeTool?.commit();
      break;
    case 'f': case 'F': fit(); break;
    case 'Home': home(); break;
    case 'o': case 'O': nav.setTool('orbit'); break;
    case '1': setShading('clay'); break;
    case '2': setShading('curvature'); break;
    case '3': setShading('height'); break;
    case 'v': case 'V':
      showVertices.checked = !showVertices.checked;
      viewer.setShowVertices(showVertices.checked);
      break;
  }
});

// Development shortcut: ?load=<path served by Vite> opens a scan on startup.
if (import.meta.env.DEV) {
  const path = new URLSearchParams(location.search).get('load');
  if (path) {
    fetch(path)
      .then((r) => r.blob())
      .then((blob) => openFile(new File([blob], path.split('/').pop() ?? 'scan.obj')));
  }
}
