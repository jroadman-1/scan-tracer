import type * as THREE from 'three';
import { writeObj, type ObjInput } from './objWriter';

/** The scan as an OBJ with its alignment applied, built in a background thread when possible. */
export function exportAlignedObj(mesh: THREE.Mesh, onProgress: (fraction: number) => void): Promise<Blob> {
  const g = mesh.geometry;
  const input: ObjInput = {
    positions: (g.attributes.position.array as Float32Array).slice(),
    normals: (g.attributes.normal.array as Float32Array).slice(),
    index: (g.index!.array as Uint32Array).slice(),
    matrix: mesh.matrixWorld.elements.slice(),
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./objExportWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') return onProgress(msg.fraction);
      worker.terminate();
      if (msg.type === 'done') resolve(msg.blob);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      // The worker couldn't start: build it here instead (the page pauses meanwhile).
      e.preventDefault();
      worker.terminate();
      setTimeout(() => resolve(new Blob(writeObj(input, onProgress), { type: 'text/plain' })), 0);
    };
    worker.postMessage(input);
  });
}
