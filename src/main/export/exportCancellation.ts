/** A deliberate user cancellation, shared by the encoder and output-publication stages. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelledError'
  }
}

export function throwIfExportCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError()
}
