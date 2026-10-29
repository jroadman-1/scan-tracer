// Builds the aligned OBJ off the main thread and hands back a Blob.
import { writeObj, type ObjInput } from './objWriter';

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent<ObjInput>) => void) | null;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  try {
    const parts = writeObj(e.data, (fraction) => scope.postMessage({ type: 'progress', fraction }));
    scope.postMessage({ type: 'done', blob: new Blob(parts, { type: 'text/plain' }) });
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
