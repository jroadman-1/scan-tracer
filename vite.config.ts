import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the built app can be hosted from any folder.
  base: './',
  worker: { format: 'es' },
  // Pre-bundle the thick-line modules with three itself; otherwise the dev
  // server loads a second copy of three for them.
  optimizeDeps: {
    include: [
      'three',
      'three/examples/jsm/lines/LineMaterial.js',
      'three/examples/jsm/lines/LineSegments2.js',
      'three/examples/jsm/lines/LineSegmentsGeometry.js',
    ],
  },
  server: {
    // NO_OPEN=1 starts the server without opening a browser tab (automated testing).
    open: !(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.NO_OPEN,
    // No live-reload connection: code changes apply when the page is refreshed
    // by hand, so an edit or server restart never wipes a loaded scan.
    hmr: false,
    ws: false,
    // Lets the dev-only ?load= shortcut read scans from the parent scan_tool folder.
    fs: { allow: ['..'] },
  },
});
