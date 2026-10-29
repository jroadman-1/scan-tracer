import { PLANES, type PlaneName } from '../app/alignMath';
import { units, type Unit } from '../app/units';
import { buildDxf } from '../io/dxfExport';
import { saveFile } from '../io/saveFile';
import type { Tool, ToolContext } from './Tool';

/** The Export DXF dialog: choose units, plane and layers, then save. */
export class ExportTool implements Tool {
  readonly id = 'export';
  readonly picks = false;

  private unit: Unit = units.unit;
  private plane: PlaneName;
  private includeCenterlines = true;
  private includePoints = false;

  constructor(
    private readonly ctx: ToolContext,
    /** Base name for the file, e.g. the scan's file name. */
    private readonly baseName: string,
  ) {
    // Start on the plane being viewed, or the plane with the most geometry.
    const planes = this.planesInUse();
    const current = ctx.session.plane;
    this.plane = planes.has(current) ? current : [...planes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'top';
  }

  private planesInUse(): Map<PlaneName, number> {
    const used = new Map<PlaneName, number>();
    for (const e of this.ctx.sketch.entities) used.set(e.plane, (used.get(e.plane) ?? 0) + 1);
    return used;
  }

  start() {
    this.refresh();
  }

  click() {}

  key(): boolean {
    return false;
  }

  async commit() {
    const { viewer, sketch } = this.ctx;
    if (!viewer.mesh) return;
    const { text, counts } = buildDxf(sketch, viewer.mesh.matrixWorld, {
      plane: this.plane,
      unit: this.unit,
      includeCenterlines: this.includeCenterlines,
      includePoints: this.includePoints,
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!total) {
      this.ctx.notify('Nothing to export on that plane with these options.');
      return;
    }
    const name = `${this.baseName.replace(/\.[^.]+$/, '')}-${this.plane}.dxf`;
    const saved = await saveFile(name, text, { description: 'DXF drawing', mime: 'application/dxf', extension: '.dxf' });
    if (!saved) return; // cancelled in the save dialog: leave the dialog open
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    this.ctx.done();
    this.ctx.setPrompt(`Exported ${name}: ${summary} (${this.unit})`);
  }

  cancel() {
    this.ctx.done();
  }

  private refresh() {
    const used = this.planesInUse();
    const set = (fn: () => void) => () => {
      fn();
      this.refresh();
    };
    this.ctx.setPrompt('Export DXF: choose units and the sketch plane, then Export');
    this.ctx.panel.show({
      title: 'Export DXF',
      note: 'Writes the sketch as a flat 2D drawing for Fusion or CAD. X and Y follow the sketch plane, measured from the origin set by 3-Point Plane. Curves are exported exactly, not as short line segments.',
      rows: [
        [
          { label: 'Millimeters', on: this.unit === 'mm', onClick: set(() => (this.unit = 'mm')) },
          { label: 'Inches', on: this.unit === 'in', onClick: set(() => (this.unit = 'in')) },
        ],
        (['top', 'front', 'right'] as PlaneName[]).map((p) => ({
          label: `${PLANES[p].label}${used.get(p) ? ` (${used.get(p)})` : ''}`,
          title: `Sketch geometry on the ${PLANES[p].label} plane`,
          on: this.plane === p,
          disabled: !used.get(p),
          onClick: set(() => (this.plane = p)),
        })),
        [
          {
            label: 'Centerlines',
            title: 'Include centerlines on their own CENTERLINE layer',
            on: this.includeCenterlines,
            onClick: set(() => (this.includeCenterlines = !this.includeCenterlines)),
          },
          {
            label: 'Points',
            title: 'Include sketch points on a POINTS layer',
            on: this.includePoints,
            onClick: set(() => (this.includePoints = !this.includePoints)),
          },
        ],
      ],
      okEnabled: used.size > 0,
      okLabel: 'Export…',
      onOk: () => void this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}
