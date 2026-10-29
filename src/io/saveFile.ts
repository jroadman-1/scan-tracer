/**
 * Saves data to a file: a Save As dialog in Chrome and Edge, a download
 * elsewhere. Returns false if the user cancelled.
 */
export async function saveFile(
  name: string,
  data: string | Blob,
  type: { description: string; mime: string; extension: string },
): Promise<boolean> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<{
      createWritable(): Promise<{ write(d: string | Blob): Promise<void>; close(): Promise<void> }>;
    }>;
  }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: type.description, accept: { [type.mime]: [type.extension] } }],
      });
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
      return true;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return false;
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
  return true;
}
