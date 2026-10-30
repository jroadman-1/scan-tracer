# Scan Tracer

Trace 3D scans into accurate 2D drawings, right in your browser.

Open an OBJ, STL or PLY scan, level and square it, draw over it with Fusion-style
sketch tools, and export a DXF (and the aligned scan as an OBJ). Everything runs
on your own computer: scans are never uploaded.

**Use it:** https://jroadman-1.github.io/scan-tracer/

## Workflow

1. **Open** an OBJ, STL or PLY scan (units: mm).
2. **3-Pt Plane:** click three points on a surface that should lie flat.
3. **2D View**, then **Straighten** (and **Flip 180°** if needed).
4. Draw a **centerline** and use **Set Origin** to put X 0, Y 0 where you want it.
5. Trace with **Line**, **Rectangle**, **Circle**, **Spline**; tidy up with **Trim**,
   **Extend**, the **Constrain** tools and **Dimensions** (type values while drawing).
6. **Export** a DXF of the sketch, or the aligned scan as an OBJ.

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # production build in dist/
```

Built with TypeScript, [Vite](https://vitejs.dev), [three.js](https://threejs.org),
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) and
[dxf-writer](https://github.com/tarikjabiri/dxf). Pushing to `main` publishes the
site through GitHub Actions.
