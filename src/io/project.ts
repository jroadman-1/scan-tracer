import * as THREE from 'three';
import type { PlaneName } from '../app/alignMath';
import type { Unit } from '../app/units';
import type { Entity, SketchSnapshot } from '../sketch/Sketch';
import type { RawMesh } from './meshData';

// A .scantrace project is one gzip-compressed file holding the scan and the
// work done on it. Uncompressed layout:
//   "SCANTRCE" (8 bytes) · JSON length (uint32 LE) · JSON · padding to 4 bytes
//   · vertex positions (float32 xyz) · triangle corners (uint32)
// The JSON describes everything else; `version` lets later releases read
// older projects.

const MAGIC = 'SCANTRCE';
const VERSION = 1;
export const PROJECT_EXTENSION = '.scantrace';

export interface ProjectState {
  /** The scan's original file name. */
  scanName: string;
  alignment: THREE.Matrix4;
  sketch: SketchSnapshot;
  unit: Unit;
  /** The 2D sketch plane being viewed, or null for 3D. */
  view2d: PlaneName | null;
}

type Xyz = [number, number, number];

interface ProjectJson {
  format: 'scantrace';
  version: number;
  app: string;
  scan: { name: string; vertices: number; triangles: number };
  alignment: number[];
  unit: Unit;
  view2d: PlaneName | null;
  entities: (Omit<Entity, 'pts' | 'tangents'> & { pts: Xyz[]; tangents?: { start?: Xyz; end?: Xyz } })[];
  dims: SketchSnapshot['dims'];
}

const xyz = (v: THREE.Vector3): Xyz => [v.x, v.y, v.z];
const vec = (a: Xyz) => new THREE.Vector3(a[0], a[1], a[2]);

export async function writeProject(mesh: RawMesh, state: ProjectState): Promise<Blob> {
  const json: ProjectJson = {
    format: 'scantrace',
    version: VERSION,
    app: 'Scan Tracer',
    scan: { name: state.scanName, vertices: mesh.positions.length / 3, triangles: mesh.index.length / 3 },
    alignment: state.alignment.elements.slice(),
    unit: state.unit,
    view2d: state.view2d,
    entities: state.sketch.entities.map((e) => ({
      ...e,
      pts: e.pts.map(xyz),
      tangents: e.tangents && {
        start: e.tangents.start && xyz(e.tangents.start),
        end: e.tangents.end && xyz(e.tangents.end),
      },
    })),
    dims: state.sketch.dims,
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const head = new Uint8Array(12 + text.length + ((4 - (text.length % 4)) % 4));
  head.set(new TextEncoder().encode(MAGIC));
  new DataView(head.buffer).setUint32(8, text.length, true);
  head.set(text, 12);
  const stream = new Blob([head, mesh.positions, mesh.index]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function readProject(file: Blob): Promise<{ mesh: RawMesh; state: ProjectState }> {
  let buf: ArrayBuffer;
  try {
    buf = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  } catch {
    throw new Error('This is not a Scan Tracer project, or the file is damaged.');
  }
  const bytes = new Uint8Array(buf);
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new Error('This is not a Scan Tracer project.');
  }
  const jsonLength = new DataView(buf).getUint32(8, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLength))) as ProjectJson;
  if (json.version > VERSION) {
    throw new Error('This project was saved by a newer version of Scan Tracer. Reload the page to update, then open it again.');
  }
  const start = 12 + jsonLength + ((4 - (jsonLength % 4)) % 4);
  const pc = json.scan.vertices * 3;
  const ic = json.scan.triangles * 3;
  if (buf.byteLength < start + (pc + ic) * 4) throw new Error('This project file is incomplete.');
  const mesh: RawMesh = {
    positions: new Float32Array(buf.slice(start, start + pc * 4)),
    index: new Uint32Array(buf.slice(start + pc * 4, start + (pc + ic) * 4)),
  };
  const entities: Entity[] = json.entities.map((e) => ({
    ...e,
    pts: e.pts.map(vec),
    tangents: e.tangents && {
      start: e.tangents.start && vec(e.tangents.start),
      end: e.tangents.end && vec(e.tangents.end),
    },
  }));
  return {
    mesh,
    state: {
      scanName: json.scan.name,
      alignment: new THREE.Matrix4().fromArray(json.alignment),
      sketch: { entities, dims: json.dims },
      unit: json.unit,
      view2d: json.view2d,
    },
  };
}
