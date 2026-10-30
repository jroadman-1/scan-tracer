// Pure mesh parsing and analysis. No three.js or DOM here so it runs in a
// worker and can be benchmarked from Node.

/** Indexed triangle mesh: xyz positions and three vertex indices per triangle. */
export interface RawMesh {
  positions: Float32Array;
  index: Uint32Array;
}

export type ProgressFn = (fraction: number) => void;

// ---------------------------------------------------------------------------
// Byte-level number reading. Parsing bytes directly avoids building millions
// of strings, which is what makes text OBJ loading slow.

let cur = 0;
const POW10 = Array.from({ length: 16 }, (_, i) => 10 ** i);

function readFloat(b: Uint8Array): number {
  let c = b[cur];
  while (c === 32 || c === 9) c = b[++cur];
  let sign = 1;
  if (c === 45) { sign = -1; c = b[++cur]; } else if (c === 43) c = b[++cur];
  let value = 0;
  while (c >= 48 && c <= 57) { value = value * 10 + (c - 48); c = b[++cur]; }
  if (c === 46) {
    c = b[++cur];
    let frac = 0;
    let digits = 0;
    while (c >= 48 && c <= 57) {
      if (digits < 15) { frac = frac * 10 + (c - 48); digits++; }
      c = b[++cur];
    }
    value += frac / POW10[digits];
  }
  if (c === 101 || c === 69) {
    c = b[++cur];
    let esign = 1;
    if (c === 45) { esign = -1; c = b[++cur]; } else if (c === 43) c = b[++cur];
    let exp = 0;
    while (c >= 48 && c <= 57) { exp = exp * 10 + (c - 48); c = b[++cur]; }
    value *= Math.pow(10, esign * exp);
  }
  return sign * value;
}

function grow<T extends Float32Array | Uint32Array>(a: T, need: number): T {
  const out = new (a.constructor as new (n: number) => T)(Math.max(need, a.length * 2));
  out.set(a);
  return out;
}

function skipToNextLine(b: Uint8Array, n: number) {
  while (cur < n && b[cur] !== 10) cur++;
  cur++;
}

// ---------------------------------------------------------------------------
// OBJ

export function parseOBJ(b: Uint8Array, onProgress: ProgressFn): RawMesh {
  const n = b.length;
  let pos = new Float32Array(Math.max(1024, Math.floor(n / 40)));
  let idx = new Uint32Array(Math.max(1024, Math.floor(n / 20)));
  let pc = 0;
  let ic = 0;
  const poly: number[] = [];
  const reportStep = Math.max(1, Math.floor(n / 100));
  let nextReport = 0;

  cur = 0;
  while (cur < n) {
    if (cur >= nextReport) { onProgress(cur / n); nextReport = cur + reportStep; }
    let c = b[cur];
    while (c === 32 || c === 9) c = b[++cur];
    const next = b[cur + 1];

    if (c === 118 && (next === 32 || next === 9)) {          // "v "
      cur += 2;
      if (pc + 3 > pos.length) pos = grow(pos, pc + 3);
      pos[pc++] = readFloat(b);
      pos[pc++] = readFloat(b);
      pos[pc++] = readFloat(b);
    } else if (c === 102 && (next === 32 || next === 9)) {   // "f "
      cur += 2;
      poly.length = 0;
      const vcount = pc / 3;
      for (;;) {
        c = b[cur];
        while (c === 32 || c === 9) c = b[++cur];
        if (cur >= n || c === 10 || c === 13 || c === 35) break;
        let neg = false;
        if (c === 45) { neg = true; c = b[++cur]; }
        let v = 0;
        while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); c = b[++cur]; }
        // Skip the /vt/vn part of the token.
        while (cur < n && c !== 32 && c !== 9 && c !== 10 && c !== 13) c = b[++cur];
        poly.push(neg ? vcount - v : v - 1);
      }
      if (poly.length >= 3) {
        const need = ic + (poly.length - 2) * 3;
        if (need > idx.length) idx = grow(idx, need);
        for (let k = 1; k < poly.length - 1; k++) {
          idx[ic++] = poly[0];
          idx[ic++] = poly[k];
          idx[ic++] = poly[k + 1];
        }
      }
    }
    skipToNextLine(b, n);
  }
  onProgress(1);

  const positions = pos.slice(0, pc);
  return { positions, index: dropInvalidTriangles(idx.subarray(0, ic), pc / 3) };
}

function dropInvalidTriangles(idx: Uint32Array, vcount: number): Uint32Array {
  // Negative OBJ indices resolve below zero and wrap to huge values in a
  // Uint32Array, so one range check catches both bad and forward references.
  let bad = false;
  for (let i = 0; i < idx.length; i++) if (idx[i] >= vcount) { bad = true; break; }
  if (!bad) return idx.slice();
  const out = new Uint32Array(idx.length);
  let o = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a < vcount && b < vcount && c < vcount) { out[o++] = a; out[o++] = b; out[o++] = c; }
  }
  return out.slice(0, o);
}

// ---------------------------------------------------------------------------
// STL (binary and ASCII). STL stores every triangle's corners separately, so
// shared corners are merged afterwards to get a connected mesh.

export function parseSTL(b: Uint8Array, onProgress: ProgressFn): RawMesh {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 84) {
    const count = dv.getUint32(80, true);
    if (84 + count * 50 === b.length) {
      const raw = new Float32Array(count * 9);
      for (let t = 0; t < count; t++) {
        const o = 84 + t * 50 + 12;
        for (let k = 0; k < 9; k++) raw[t * 9 + k] = dv.getFloat32(o + k * 4, true);
        if ((t & 0xffff) === 0) onProgress((0.5 * t) / count);
      }
      return weld(raw, (f) => onProgress(0.5 + 0.5 * f));
    }
  }

  const n = b.length;
  let raw = new Float32Array(Math.max(1024, Math.floor(n / 25)));
  let rc = 0;
  cur = 0;
  while (cur < n) {
    let c = b[cur];
    while (c === 32 || c === 9) c = b[++cur];
    // "vertex"
    if (c === 118 && b[cur + 1] === 101 && b[cur + 2] === 114 && b[cur + 3] === 116 &&
        b[cur + 4] === 101 && b[cur + 5] === 120) {
      cur += 6;
      if (rc + 3 > raw.length) raw = grow(raw, rc + 3);
      raw[rc++] = readFloat(b);
      raw[rc++] = readFloat(b);
      raw[rc++] = readFloat(b);
    }
    skipToNextLine(b, n);
  }
  onProgress(0.5);
  return weld(raw.slice(0, rc - (rc % 9)), (f) => onProgress(0.5 + 0.5 * f));
}

// ---------------------------------------------------------------------------
// PLY (ASCII and binary, either byte order). Scanners often add colors,
// normals or confidence values per vertex; only positions and faces are read.

type PlyRead = (dv: DataView, o: number, le: boolean) => number;
const PLY_TYPES: Record<string, [size: number, read: PlyRead]> = {
  int8: [1, (d, o) => d.getInt8(o)],
  uint8: [1, (d, o) => d.getUint8(o)],
  int16: [2, (d, o, le) => d.getInt16(o, le)],
  uint16: [2, (d, o, le) => d.getUint16(o, le)],
  int32: [4, (d, o, le) => d.getInt32(o, le)],
  uint32: [4, (d, o, le) => d.getUint32(o, le)],
  float32: [4, (d, o, le) => d.getFloat32(o, le)],
  float64: [8, (d, o, le) => d.getFloat64(o, le)],
};
const PLY_ALIASES: Record<string, string> = {
  char: 'int8', uchar: 'uint8', short: 'int16', ushort: 'uint16',
  int: 'int32', uint: 'uint32', float: 'float32', double: 'float64',
};

interface PlyProperty { name: string; type: string; countType?: string }
interface PlyElement { name: string; count: number; props: PlyProperty[] }

function plyType(name: string): string {
  const t = PLY_ALIASES[name] ?? name;
  if (!PLY_TYPES[t]) throw new Error(`This PLY file uses an unknown value type "${name}".`);
  return t;
}

function readPlyHeader(b: Uint8Array): { format: string; elements: PlyElement[]; start: number } {
  const text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 1 << 16)));
  if (!/^ply\r?\n/.test(text)) throw new Error('This is not a PLY file (the "ply" header is missing).');
  const end = /end_header[ \t]*\r?\n/.exec(text);
  if (!end) throw new Error('This PLY file has no end_header line.');
  let format = '';
  const elements: PlyElement[] = [];
  for (const line of text.slice(0, end.index).split(/\r?\n/)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'format') format = w[1];
    else if (w[0] === 'element') elements.push({ name: w[1], count: parseInt(w[2], 10) || 0, props: [] });
    else if (w[0] === 'property' && elements.length) {
      const props = elements[elements.length - 1].props;
      if (w[1] === 'list') props.push({ name: w[4], type: plyType(w[3]), countType: plyType(w[2]) });
      else props.push({ name: w[2], type: plyType(w[1]) });
    }
  }
  return { format, elements, start: end.index + end[0].length };
}

export function parsePLY(b: Uint8Array, onProgress: ProgressFn): RawMesh {
  const { format, elements, start } = readPlyHeader(b);
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex || vertex.count === 0) throw new Error('This PLY file has no vertices.');
  const axes = ['x', 'y', 'z'].map((n) => vertex.props.findIndex((p) => p.name === n && !p.countType));
  if (axes.includes(-1)) throw new Error('This PLY file has no x, y, z vertex positions.');

  const pos = new Float32Array(vertex.count * 3);
  let idx = new Uint32Array(Math.max(1024, vertex.count * 6));
  let ic = 0;
  const poly: number[] = [];
  const addFace = () => {
    if (poly.length < 3) return;
    const need = ic + (poly.length - 2) * 3;
    if (need > idx.length) idx = grow(idx, need);
    for (let k = 1; k < poly.length - 1; k++) {
      idx[ic++] = poly[0];
      idx[ic++] = poly[k];
      idx[ic++] = poly[k + 1];
    }
  };
  const faceList = (el: PlyElement) => {
    if (el.name !== 'face') return -1;
    const named = el.props.findIndex((p) => p.countType && (p.name === 'vertex_indices' || p.name === 'vertex_index'));
    return named >= 0 ? named : el.props.findIndex((p) => p.countType);
  };
  const truncated = () => new Error('This PLY file ends early; it may be incomplete.');
  const total = elements.reduce((s, e) => s + e.count, 0);
  let done = 0;

  if (format === 'ascii') {
    const n = b.length;
    cur = start;
    for (const el of elements) {
      const fi = faceList(el);
      for (let i = 0; i < el.count; i++) {
        if (cur >= n) throw truncated();
        for (let k = 0; k < el.props.length; k++) {
          if (el.props[k].countType) {
            const m = readFloat(b);
            if (k === fi) {
              poly.length = 0;
              for (let j = 0; j < m; j++) poly.push(readFloat(b));
              addFace();
            } else for (let j = 0; j < m; j++) readFloat(b);
          } else {
            const v = readFloat(b);
            const a = el === vertex ? axes.indexOf(k) : -1;
            if (a >= 0) pos[i * 3 + a] = v;
          }
        }
        skipToNextLine(b, n);
        if ((++done & 0xffff) === 0) onProgress(done / total);
      }
    }
  } else {
    const le = format === 'binary_little_endian';
    if (!le && format !== 'binary_big_endian') throw new Error(`This PLY file has an unknown format "${format}".`);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = start;
    for (const el of elements) {
      if (el.props.every((p) => !p.countType)) {
        // Fixed-size records: jump straight to the values needed.
        const offsets: number[] = [];
        let stride = 0;
        for (const p of el.props) { offsets.push(stride); stride += PLY_TYPES[p.type][0]; }
        if (o + stride * el.count > b.length) throw truncated();
        if (el === vertex) {
          const [ox, oy, oz] = axes.map((k) => offsets[k]);
          const [rx, ry, rz] = axes.map((k) => PLY_TYPES[el.props[k].type][1]);
          for (let i = 0; i < el.count; i++) {
            const base = o + i * stride;
            pos[i * 3] = rx(dv, base + ox, le);
            pos[i * 3 + 1] = ry(dv, base + oy, le);
            pos[i * 3 + 2] = rz(dv, base + oz, le);
            if ((i & 0xfffff) === 0) onProgress((done + i) / total);
          }
        }
        o += stride * el.count;
        done += el.count;
        continue;
      }
      const fi = faceList(el);
      for (let i = 0; i < el.count; i++) {
        for (let k = 0; k < el.props.length; k++) {
          const p = el.props[k];
          const [size, read] = PLY_TYPES[p.type];
          if (p.countType) {
            const [csize, cread] = PLY_TYPES[p.countType];
            if (o + csize > b.length) throw truncated();
            const m = cread(dv, o, le);
            o += csize;
            if (o + m * size > b.length) throw truncated();
            if (k === fi) {
              poly.length = 0;
              for (let j = 0; j < m; j++) poly.push(read(dv, o + j * size, le));
              addFace();
            }
            o += m * size;
          } else {
            if (o + size > b.length) throw truncated();
            const a = el === vertex ? axes.indexOf(k) : -1;
            if (a >= 0) pos[i * 3 + a] = read(dv, o, le);
            o += size;
          }
        }
        if ((++done & 0xffff) === 0) onProgress(done / total);
      }
    }
  }

  if (ic === 0) {
    throw new Error('This PLY file is a point cloud (points only, no faces). Turn it into a mesh in your scanner software and export again.');
  }
  // Some exporters write every face's corners separately; merge them so the
  // surface is connected and shades smoothly.
  if (vertex.count >= ic) {
    const raw = new Float32Array(ic * 3);
    for (let i = 0; i < ic; i++) {
      const v = idx[i];
      if (v >= vertex.count) continue;
      raw[i * 3] = pos[v * 3]; raw[i * 3 + 1] = pos[v * 3 + 1]; raw[i * 3 + 2] = pos[v * 3 + 2];
    }
    return weld(raw, (f) => onProgress(0.9 + 0.1 * f));
  }
  onProgress(1);
  return { positions: pos, index: dropInvalidTriangles(idx.subarray(0, ic), vertex.count) };
}

/** The parser for a scan file, chosen by its extension, or null if unsupported. */
export function parserFor(fileName: string): ((b: Uint8Array, onProgress: ProgressFn) => RawMesh) | null {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'obj' ? parseOBJ : ext === 'stl' ? parseSTL : ext === 'ply' ? parsePLY : null;
}

export const UNSUPPORTED_FILE = 'Unsupported file type. Open an .obj, .stl or .ply scan.';

function weld(raw: Float32Array, onProgress: ProgressFn): RawMesh {
  const count = raw.length / 3;
  const bits = new Uint32Array(raw.buffer, raw.byteOffset, raw.length);
  let size = 1;
  while (size < count * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const out = new Uint32Array(raw.length);
  const index = new Uint32Array(count);
  let unique = 0;

  for (let i = 0; i < count; i++) {
    const x = bits[3 * i], y = bits[3 * i + 1], z = bits[3 * i + 2];
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const s = table[h];
      if (s < 0) {
        table[h] = unique;
        out[3 * unique] = x; out[3 * unique + 1] = y; out[3 * unique + 2] = z;
        index[i] = unique++;
        break;
      }
      if (out[3 * s] === x && out[3 * s + 1] === y && out[3 * s + 2] === z) { index[i] = s; break; }
      h = (h + 1) & mask;
    }
    if ((i & 0xfffff) === 0) onProgress(i / count);
  }
  onProgress(1);
  return { positions: new Float32Array(out.buffer.slice(0, unique * 12)), index };
}

// ---------------------------------------------------------------------------
// Analysis

/** Area-weighted smooth vertex normals. */
export function computeNormals(p: Float32Array, idx: Uint32Array): Float32Array {
  const nrm = new Float32Array(p.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
    if (l > 0) { nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; } else nrm[i + 2] = 1;
  }
  return nrm;
}

/**
 * Per-vertex convexity: positive on ridges and edges, negative in valleys.
 * Estimated from how far each neighbor drops below the vertex's tangent plane,
 * smoothed to suppress scan noise, then scaled so the 90th percentile of
 * |curvature| is 1.
 */
export function computeCurvature(p: Float32Array, nrm: Float32Array, idx: Uint32Array): Float32Array {
  const vc = p.length / 3;
  let k = new Float32Array(vc);
  const cnt = new Float32Array(vc);

  const edge = (i: number, j: number) => {
    const i3 = i * 3, j3 = j * 3;
    const dx = p[j3] - p[i3], dy = p[j3 + 1] - p[i3 + 1], dz = p[j3 + 2] - p[i3 + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 0) {
      k[i] -= (2 * (nrm[i3] * dx + nrm[i3 + 1] * dy + nrm[i3 + 2] * dz)) / d2;
      cnt[i]++;
    }
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    edge(a, b); edge(b, a); edge(b, c); edge(c, b); edge(c, a); edge(a, c);
  }
  for (let i = 0; i < vc; i++) if (cnt[i] > 0) k[i] /= cnt[i];

  for (let pass = 0; pass < 2; pass++) {
    const acc = new Float32Array(k);
    cnt.fill(1);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      acc[a] += k[b] + k[c]; acc[b] += k[a] + k[c]; acc[c] += k[a] + k[b];
      cnt[a] += 2; cnt[b] += 2; cnt[c] += 2;
    }
    for (let i = 0; i < vc; i++) acc[i] /= cnt[i];
    k = acc;
  }

  const stride = Math.max(1, Math.floor(vc / 200_000));
  const sample: number[] = [];
  for (let i = 0; i < vc; i += stride) sample.push(Math.abs(k[i]));
  sample.sort((x, y) => x - y);
  const p90 = sample[Math.floor(sample.length * 0.9)] || 1;
  for (let i = 0; i < vc; i++) k[i] = Math.max(-4, Math.min(4, k[i] / p90));
  return k;
}

/**
 * Assigns each vertex a level for zoom-dependent thinning. Level L vertices
 * are one-per-cell on a grid of spacing·2^L, and each coarser level is a
 * subset of the finer one, so showing levels ≥ L gives evenly spaced points
 * about spacing·2^L apart. `spacing` is the mean edge length.
 */
export function computeVertexLevels(p: Float32Array, idx: Uint32Array): { levels: Uint8Array; spacing: number } {
  const tris = idx.length / 3;
  const step = Math.max(1, Math.floor(tris / 50_000));
  let sum = 0;
  let n = 0;
  for (let t = 0; t < tris; t += step) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3;
    sum += Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    n++;
  }
  const spacing = n > 0 && sum > 0 ? sum / n : 1;

  const vc = p.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }

  const levels = new Uint8Array(vc);
  let survivors = new Uint32Array(vc);
  for (let i = 0; i < vc; i++) survivors[i] = i;

  for (let level = 1; survivors.length > 1 && level < 255; level++) {
    const cell = spacing * 2 ** level;
    const nx = Math.floor((max[0] - min[0]) / cell) + 1;
    const ny = Math.floor((max[1] - min[1]) / cell) + 1;
    const seen = new Set<number>();
    const next = new Uint32Array(survivors.length);
    let count = 0;
    for (let s = 0; s < survivors.length; s++) {
      const v = survivors[s];
      const ix = Math.floor((p[v * 3] - min[0]) / cell);
      const iy = Math.floor((p[v * 3 + 1] - min[1]) / cell);
      const iz = Math.floor((p[v * 3 + 2] - min[2]) / cell);
      const key = ix + nx * (iy + ny * iz);
      if (seen.has(key)) continue;
      seen.add(key);
      levels[v] = level;
      next[count++] = v;
    }
    survivors = next.subarray(0, count);
  }
  return { levels, spacing };
}
