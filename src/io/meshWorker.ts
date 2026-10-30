// Loads a scan file off the main thread: parse, normals, curvature, and the
// BVH pick index. Results come back as transferable buffers, so nothing is copied.

import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { computeCurvature, computeNormals, computeVertexLevels, parserFor, UNSUPPORTED_FILE, type RawMesh } from './meshData';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<{ file?: File; mesh?: RawMesh }>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let lastStage = '';
let lastFraction = -1;
function progress(stage: string, fraction: number) {
  if (stage === lastStage && fraction - lastFraction < 0.01) return;
  lastStage = stage;
  lastFraction = fraction;
  scope.postMessage({ type: 'progress', stage, fraction });
}

scope.onmessage = async (e) => {
  const { file, mesh: given } = e.data;
  try {
    let mesh: RawMesh;
    if (given) {
      // Already read, e.g. from a project file.
      mesh = given;
    } else {
      progress('Reading file', 0);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file!.arrayBuffer());
      } catch (err) {
        throw new Error(`The file could not be read (${err instanceof Error ? err.message : err}).`);
      }
      const parse = parserFor(file!.name);
      if (!parse) throw new Error(UNSUPPORTED_FILE);

      mesh = parse(bytes, (f) => progress('Reading geometry', 0.03 + 0.6 * f));
      if (mesh.index.length === 0) throw new Error('No triangles were found in this file.');
    }

    progress('Computing normals', 0.64);
    const normals = computeNormals(mesh.positions, mesh.index);
    progress('Analyzing surface', 0.7);
    const curvature = computeCurvature(mesh.positions, normals, mesh.index);
    const { levels, spacing } = computeVertexLevels(mesh.positions, mesh.index);

    progress('Building pick index', 0.8);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geometry.setIndex(new BufferAttribute(mesh.index, 1));
    const bvh = new MeshBVH(geometry, {
      onProgress: (p: number) => progress('Building pick index', 0.8 + 0.2 * p),
    });
    const bvhData = MeshBVH.serialize(bvh, { cloneBuffers: false });

    const transfer = new Set<ArrayBuffer>([
      mesh.positions.buffer as ArrayBuffer,
      normals.buffer as ArrayBuffer,
      curvature.buffer as ArrayBuffer,
      levels.buffer as ArrayBuffer,
      bvhData.index.buffer as ArrayBuffer,
      ...(bvhData.roots as ArrayBuffer[]),
    ]);
    scope.postMessage(
      { type: 'done', positions: mesh.positions, normals, curvature, levels, spacing, bvh: bvhData },
      [...transfer],
    );
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
