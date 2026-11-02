import { z } from 'zod'
import type { WidgetInstance } from '../types'

export const renderWorkerCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
export type RenderWorkerCount = z.infer<typeof renderWorkerCountSchema>
export const DEFAULT_RENDER_WORKERS: RenderWorkerCount = 2

export const overlayExportRequestSchema = z.object({
  format: z.enum(['video', 'qtrle', 'prores4444']).default('video'),
  widgetIds: z.array(z.string()).optional(),
  renderWorkers: renderWorkerCountSchema.optional()
})
export type OverlayExportRequest = z.infer<typeof overlayExportRequestSchema>
export type ExportFormat = OverlayExportRequest['format']

export function exportWidgets(widgets: WidgetInstance[], request: OverlayExportRequest): WidgetInstance[] {
  if (request.format === 'video' || request.widgetIds === undefined) return widgets
  const ids = new Set(request.widgetIds)
  const chosen = widgets.filter((widget) => ids.has(widget.id))
  if (!chosen.length || chosen.length !== ids.size) throw new Error('Select at least one existing widget for the transparent export.')
  return chosen
}
