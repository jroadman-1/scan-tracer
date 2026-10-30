/** A file chosen in a Save As dialog, which can be written again without asking. */
export interface SaveHandle {
  readonly name: string;
  createWritable(): Promise<{ write(d: string | Blob): Promise<void>; close(): Promise<void> }>;
}

type FileType = { description: string; mime: string; extension: string };

/**
 * Saves data to a file: a Save As dialog in Chrome and Edge, a download
 * elsewhere. Returns false if the user cancelled.
 */
export async function saveFile(name: string, data: string | Blob, type: FileType): Promise<boolean> {
  return (await saveFileAs(name, data, type)) !== null;
}

/**
 * Like saveFile, but writes straight to `handle` when given (no dialog) and
 * returns the handle chosen so later saves can reuse it: 'download' when the
 * browser can only download, null if the user cancelled.
 */
export async function saveFileAs(
  name: string,
  data: string | Blob,
  type: FileType,
  handle?: SaveHandle | null,
): Promise<SaveHandle | 'download' | null> {
  const picker = (window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
  if (handle || picker) {
    try {
      const target = handle ?? (await picker!({
        suggestedName: name,
        types: [{ description: type.description, accept: { [type.mime]: [type.extension] } }],
      }));
      const w = await target.createWritable();
      await w.write(data);
      await w.close();
      return target;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      // Fall through to a plain download if the picker isn't allowed here.
    }
  }
  const blob = typeof data === 'string' ? new Blob([data], { type: type.mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'download';
}
