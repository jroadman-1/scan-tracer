import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { computeCurvature, computeNormals, computeVertexLevels, parserFor, UNSUPPORTED_FILE } from './meshData';

export interface ScanStats {
  name: string;
  vertices: number;
  triangles: number;
  size: THREE.Vector3;
  seconds: number;
}

export interface LoadedScan {
  geometry: THREE.BufferGeometry;
  stats: ScanStats;
}

type Progress = (stage: string, fraction: number) => void;

interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  curvature: Float32Array;
  levels: Uint8Array;
  spacing: number;
}

/** Errors the worker reported about the file itself, as opposed to the worker failing to run. */
class FileError extends Error {}

export async function loadScanFile(file: File, onProgress: Progress): Promise<LoadedScan> {
  const t0 = performance.now();
  let geometry: THREE.BufferGeometry;
  try {
    geometry = await loadInWorker(file, onProgress);
  } catch (err) {
    if (err instanceof FileError) throw err;
    // The worker couldn't start (for example, its script failed to load).
    // Do the same work here; the page is unresponsive meanwhile, but it loads.
    console.warn('Background loader failed, loading on the main thread instead:', err);
    geometry = await loadOnMainThread(file, onProgress);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    geometry,
    stats: {
      name: file.name,
      vertices: geometry.attributes.position.count,
      triangles: geometry.index!.count / 3,
      size: geometry.boundingBox!.getSize(new THREE.Vector3()),
      seconds: (performance.now() - t0) / 1000,
    },
  };
}

function buildGeometry({ positions, normals, curvature, levels, spacing }: MeshArrays): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('curv', new THREE.BufferAttribute(curvature, 1));
  geometry.setAttribute('level', new THREE.BufferAttribute(levels, 1));
  geometry.userData.vertexSpacing = spacing;
  return geometry;
}

function loadInWorker(file: File, onProgress: Progress): Promise<THREE.BufferGeometry> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress(msg.stage, msg.fraction);
        return;
      }
      worker.terminate();
      if (msg.type === 'error') {
        reject(new FileError(msg.message));
        return;
      }
      const geometry = buildGeometry(msg);
      // Restores the worker-built BVH and its reordered triangle index.
      geometry.boundsTree = MeshBVH.deserialize(msg.bvh, geometry, { setIndex: true });
      resolve(geometry);
    };

    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new Error(e.message || 'worker failed to start'));
    };

    worker.postMessage({ file });
  });
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function loadOnMainThread(file: File, onProgress: Progress): Promise<THREE.BufferGeometry> {
  const parse = parserFor(file.name);
  if (!parse) throw new Error(UNSUPPORTED_FILE);

  onProgress('Reading file', 0);
  await nextFrame();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    throw new Error(`The file could not be read (${err instanceof Error ? err.message : err}).`);
  }

  onProgress('Reading geometry', 0.05);
  await nextFrame();
  const mesh = parse(bytes, () => {});
  if (mesh.index.length === 0) throw new Error('No triangles were found in this file.');

  onProgress('Analyzing surface', 0.65);
  await nextFrame();
  const normals = computeNormals(mesh.positions, mesh.index);
  const curvature = computeCurvature(mesh.positions, normals, mesh.index);
  const { levels, spacing } = computeVertexLevels(mesh.positions, mesh.index);

  onProgress('Building pick index', 0.8);
  await nextFrame();
  const geometry = buildGeometry({ positions: mesh.positions, normals, curvature, levels, spacing });
  geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  geometry.boundsTree = new MeshBVH(geometry);
  return geometry;
}
