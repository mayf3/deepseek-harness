/** Pre-boot filesystem-source chooser for static WebWorker previews. */

import {
  parsePreviewFixtureManifest, type PreviewFixtureManifestEntry,
} from '../fixture-manifest.ts'

const EMPTY_SOURCE = 'none'
const WEBFS_SOURCE = 'webfs'
const PREVIEW_FIXTURE_QUERY = 'preview-fixture'

interface PreviewSourceChoice {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly overlays: readonly URL[]
  readonly disabled?: boolean
}

const CHOOSER_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; }
  [data-preview-source-chooser] {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    box-sizing: border-box;
    color: #171717;
    background: radial-gradient(circle at 50% 35%, #eef4ff 0, #f8fafc 42%, #f3f4f6 100%);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  [data-preview-source-card] {
    width: min(560px, 100%);
    box-sizing: border-box;
    padding: 28px;
    border: 1px solid #d8dee9;
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.94);
    box-shadow: 0 20px 60px rgba(15, 23, 42, 0.12);
  }
  [data-preview-source-card] h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.25; }
  [data-preview-source-card] > p { margin: 0 0 22px; color: #5b6472; }
  [data-preview-source-card] fieldset { display: grid; gap: 10px; margin: 0; padding: 0; border: 0; }
  [data-preview-source-card] legend { margin-bottom: 10px; font-weight: 650; }
  [data-preview-source-option] {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    padding: 14px;
    border: 1px solid #d8dee9;
    border-radius: 12px;
    cursor: pointer;
  }
  [data-preview-source-option]:has(input:checked) { border-color: #4777df; background: #edf3ff; }
  [data-preview-source-option]:has(input:disabled) { cursor: not-allowed; opacity: 0.55; }
  [data-preview-source-option] input { grid-row: 1 / span 2; margin: 4px 0 0; }
  [data-preview-source-option] strong { font-size: 15px; }
  [data-preview-source-option] span { color: #667085; }
  [data-preview-source-submit] {
    width: 100%;
    margin-top: 20px;
    padding: 11px 16px;
    border: 0;
    border-radius: 10px;
    color: white;
    background: #315fc7;
    font: inherit;
    font-weight: 650;
    cursor: pointer;
  }
  [data-preview-source-submit]:disabled { cursor: not-allowed; opacity: 0.5; }
  @media (prefers-color-scheme: dark) {
    [data-preview-source-chooser] { color: #f4f4f5; background: radial-gradient(circle at 50% 35%, #172554 0, #111827 45%, #09090b 100%); }
    [data-preview-source-card] { border-color: #374151; background: rgba(24, 24, 27, 0.96); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35); }
    [data-preview-source-card] > p, [data-preview-source-option] span { color: #a1a1aa; }
    [data-preview-source-option] { border-color: #3f3f46; }
    [data-preview-source-option]:has(input:checked) { border-color: #7aa2ff; background: #172554; }
  }
`

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}

function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, character => ENTITIES[character] ?? character)
}

function optionMarkup(choice: PreviewSourceChoice, selected: string): string {
  return `<label data-preview-source-option>
    <input type="radio" name="preview-source" value="${choice.id}"${choice.id === selected ? ' checked' : ''}${choice.disabled === true ? ' disabled' : ''}>
    <strong>${escapeMarkup(choice.label)}</strong>
    <span>${escapeMarkup(choice.description)}</span>
  </label>`
}

function fixtureChoices(entries: readonly PreviewFixtureManifestEntry[], manifestUrl: URL): PreviewSourceChoice[] {
  return entries.map(entry => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    overlays: entry.overlays.map(overlay => new URL(overlay, manifestUrl)),
  }))
}

/**
 * Render the source chooser and wait for an enabled selection.
 * @param manifestUrl - Built-in fixture catalog URL.
 * @returns Ordered overlay URLs selected for the Worker mount.
 */
export async function choosePreviewSource(manifestUrl: URL): Promise<readonly URL[]> {
  const requested = new URL(location.href).searchParams.get(PREVIEW_FIXTURE_QUERY)
  if (requested === EMPTY_SOURCE) return []

  const response = await fetch(manifestUrl)
  if (!response.ok) {
    throw new Error(`preview source chooser: fixture manifest returned ${String(response.status)}`)
  }
  const manifest = parsePreviewFixtureManifest(await response.json())
  const choices: PreviewSourceChoice[] = [
    {
      id: EMPTY_SOURCE,
      label: '空白环境',
      description: '只加载基础运行时，用于验证首次启动与新建 Workspace。',
      overlays: [],
    },
    ...fixtureChoices(manifest.fixtures, manifestUrl),
    {
      id: WEBFS_SOURCE,
      label: 'WebFS 目录',
      description: '需要用户授权的目录来源，将在 WebFS provider 接入后开放。',
      overlays: [],
      disabled: true,
    },
  ]
  if (requested !== null) {
    const requestedChoice = choices.find(choice => choice.id === requested && choice.disabled !== true)
    if (requestedChoice === undefined) {
      throw new Error(`preview source chooser: unknown or interactive source "${requested}"`)
    }
    return requestedChoice.overlays
  }

  const root = document.getElementById('root')
  if (root === null) throw new Error('preview source chooser: missing #root')
  const selected = manifest.defaultFixture ?? EMPTY_SOURCE
  const style = document.createElement('style')
  style.dataset.previewSourceStyle = ''
  style.textContent = CHOOSER_STYLE
  document.head.append(style)

  root.innerHTML = `<main data-preview-source-chooser>
    <form data-preview-source-card aria-labelledby="preview-source-title">
      <h1 id="preview-source-title">选择 Preview 数据源</h1>
      <p>数据会在 Worker 和应用启动前挂载；刷新页面可重新选择。</p>
      <fieldset>
        <legend>文件系统来源</legend>
        ${choices.map(choice => optionMarkup(choice, selected)).join('')}
      </fieldset>
      <button data-preview-source-submit type="submit">启动 Preview</button>
    </form>
  </main>`
  const form = root.querySelector<HTMLFormElement>('[data-preview-source-card]')
  if (form === null) throw new Error('preview source chooser: form was not rendered')
  const sourceId = await new Promise<string>((resolve, reject) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = new FormData(form).get('preview-source')
      if (typeof value === 'string') resolve(value)
      else reject(new Error('preview source chooser: no source selected'))
    }, { once: true })
  })
  const choice = choices.find(candidate => candidate.id === sourceId && candidate.disabled !== true)
  if (choice === undefined) throw new Error(`preview source chooser: unavailable source "${sourceId}"`)
  root.replaceChildren()
  style.remove()
  return choice.overlays
}
