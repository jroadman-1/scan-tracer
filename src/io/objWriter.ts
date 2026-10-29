// Writes a mesh as OBJ text with a transform applied. No three.js or DOM, so
// it runs in a worker (or on the main thread as a fallback).

export interface ObjInput {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  /** Column-major 4×4 rigid transform (three.js Matrix4.elements). */
  matrix: number[];
}

/** Returns the OBJ as string chunks (for a Blob), reporting progress 0–1. */
export function writeObj({ positions: p, normals: n, index, matrix: m }: ObjInput, onProgress: (f: number) => void): string[] {
  const parts: string[] = ['# Exported by Scan Tracer: scan aligned to the sketch axes, units mm\n'];
  let buf = '';
  const flush = () => {
    parts.push(buf);
    buf = '';
  };
  const vc = p.length / 3;
  const total = vc * 2 + index.length / 3;
  let done = 0;
  const report = () => {
    if (buf.length > 1 << 20) flush();
    if ((++done & 0x3ffff) === 0) onProgress(done / total);
  };

  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    buf += `v ${(m[0] * x + m[4] * y + m[8] * z + m[12]).toFixed(5)} ${(m[1] * x + m[5] * y + m[9] * z + m[13]).toFixed(5)} ${(m[2] * x + m[6] * y + m[10] * z + m[14]).toFixed(5)}\n`;
    report();
  }
  // Normals rotate with the scan (the transform has no scaling).
  for (let i = 0; i < n.length; i += 3) {
    const x = n[i], y = n[i + 1], z = n[i + 2];
    buf += `vn ${(m[0] * x + m[4] * y + m[8] * z).toFixed(4)} ${(m[1] * x + m[5] * y + m[9] * z).toFixed(4)} ${(m[2] * x + m[6] * y + m[10] * z).toFixed(4)}\n`;
    report();
  }
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] + 1, b = index[t + 1] + 1, c = index[t + 2] + 1;
    buf += `f ${a}//${a} ${b}//${b} ${c}//${c}\n`;
    report();
  }
  flush();
  onProgress(1);
  return parts;
}
