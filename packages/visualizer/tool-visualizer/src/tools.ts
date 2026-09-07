import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  composeGuidelines, WIDGET_GUIDELINE_MODULES, type WidgetGuidelineModule,
} from './guidelines.ts'
import type { WidgetKind } from './types.ts'

const WIDGET_CODE_FENCE = /^\s*(?:`{3,}|~{3,})/
const HTML_DOCUMENT_WRAPPER = /^(?:<!--[\s\S]*?-->\s*)*<(?:!doctype|html|head|body)(?=[\s/>])/i

function widgetKind(source: string): WidgetKind {
  const trimmed = source.trimStart()
  if (/^<svg(?=[\s/>])/i.test(trimmed)) return 'svg'
  return 'html'
}

function validateWidgetArgs(
  title: string,
  source: string,
  limits: { readonly maxTitleBytes: number; readonly maxWidgetBytes: number },
): WidgetKind {
  if (title.trim() === '') throw new Error('visualizer: title must be non-empty')
  const titleBytes = Buffer.byteLength(title, 'utf8')
  if (titleBytes > limits.maxTitleBytes) {
    throw new Error(`visualizer: title is ${titleBytes} UTF-8 bytes; limit is ${limits.maxTitleBytes}`)
  }
  const bytes = Buffer.byteLength(source, 'utf8')
  if (source.trim() === '') throw new Error('visualizer: widget_code must be non-empty')
  if (bytes > limits.maxWidgetBytes) {
    throw new Error(`visualizer: widget_code is ${bytes} UTF-8 bytes; limit is ${limits.maxWidgetBytes}`)
  }
  if (WIDGET_CODE_FENCE.test(source)) {
    throw new Error('visualizer: widget_code must be raw source without Markdown code fences')
  }
  const trimmed = source.trimStart()
  if (HTML_DOCUMENT_WRAPPER.test(trimmed)) {
    throw new Error('visualizer: widget_code must be a fragment without document wrappers')
  }
  return widgetKind(source)
}

/**
 * Register the stable model-visible Visualizer surface.
 * @param ctx - Host Cordis context that owns the Tool contributions.
 * @param limits - Host limits applied to model-provided widget arguments.
 */
export function registerVisualizerTools(
  ctx: Context,
  limits: { readonly maxTitleBytes: number; readonly maxWidgetBytes: number },
): void {
  const sourceDescription = 'For HTML: one fragment. Put any inline <style> first, content next (semantic HTML, inline <svg>, <canvas> using 2D or WebGL, or native controls), and any inline <script> last. For SVG: raw SVG beginning with <svg>, with a viewBox that declares its aspect ratio. Keep the widget self-contained: include all required styles, scripts, data, and assets in the source.'

  ctx.tools.register(defineTool({
    name: 'widget_guidelines',
    description: 'Load request-matched construction guidance for a widget response.',
    parameters: {
      modules: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: WIDGET_GUIDELINE_MODULES },
        description: 'Choose every module that fits the requested result. diagram: a fixed view of nodes and relationships. chart: quantitative data. illustration: a scene or image. interactive: an adjustable calculation, simulation, or animated demonstration. mockup: a product surface shown to explain one interaction.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec): Promise<string> {
      const canShowWidget = ctx.tools.get('show_widget', exec.agent) !== undefined
      return Promise.resolve(composeGuidelines(args.modules as readonly WidgetGuidelineModule[], canShowWidget))
    },
    presentCall: args => ({ card: 'generic', kind: 'read', title: `Load widget guidance: ${args.modules.join(', ')}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'show_widget',
    description: 'Render one temporary inline graphic or interactive widget from conversation content or completed tool results. Source beginning with <svg uses SVG; anything else uses HTML. Pass one small, complete source in this call; validation occurs after submission.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short user-facing title in the user\'s language.' },
      widget_code: { type: 'string', required: true, description: sourceDescription },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['svg', 'html'] },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Widget "${args.title}" accepted (${value.kind}). It is final for this response; finish with brief supporting prose.`,
      }],
      presentationMeta: (_args, value) => ({ kind: value.kind }),
    },
    isConcurrencySafe: () => true,
    execute(args): Promise<{ kind: WidgetKind }> {
      return Promise.resolve({ kind: validateWidgetArgs(args.title, args.widget_code, limits) })
    },
    presentCall: args => ({ card: 'generic', kind: 'execute', title: `Widget: ${args.title}` }),
  }))
}
