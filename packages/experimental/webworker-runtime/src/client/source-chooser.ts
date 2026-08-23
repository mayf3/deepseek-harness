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
  [data-preview-source-chooser] {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    overflow: auto;
    padding: 24px;
    box-sizing: border-box;
    color: #0f1115;
    background: #fff;
    font-size: 14px;
    line-height: 22px;
  }
  #root:has(> [data-preview-source-chooser]) > [data-dsh-boot] { display: none; }
  [data-preview-source-card] {
    width: min(600px, 100%);
    max-height: calc(100dvh - 48px);
    box-sizing: border-box;
    padding: 28px;
    overflow-y: auto;
    border: 1px solid transparent;
    border-radius: 24px;
    background: #fff;
    box-shadow: 0 0 1px rgb(0 0 0 / 20%), 0 12px 32px rgb(0 0 0 / 8%);
  }
  [data-preview-source-card] h1 {
    margin: 0;
    font-size: 20px;
    line-height: 28px;
    font-weight: 500;
  }
  [data-preview-source-card] > p {
    margin: 8px 0 0;
    color: #61666b;
  }
  [data-preview-source-card] fieldset {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 24px 0 0;
    padding: 0;
    border: 0;
  }
  [data-preview-source-card] legend {
    margin: 0 0 8px;
    padding: 0 4px;
    color: #61666b;
    font-size: 13px;
    line-height: 20px;
    font-weight: 500;
  }
  [data-preview-source-option] {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-height: 56px;
    padding: 8px 12px 8px 8px;
    box-sizing: border-box;
    border: 1px solid transparent;
    border-radius: 12px;
    background: transparent;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  [data-preview-source-option]:hover:not(:has(input:disabled)),
  [data-preview-source-option]:has(input:checked) {
    background: rgb(38 49 72 / 6%);
  }
  [data-preview-source-option]:has(input:checked) {
    border-color: rgb(0 0 0 / 10%);
  }
  [data-preview-source-option]:has(input:disabled) {
    cursor: default;
    opacity: 0.4;
  }
  [data-preview-source-option] input {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 4px 0 0;
    accent-color: #0f1115;
  }
  [data-preview-source-option] > span { flex: 1; min-width: 0; }
  [data-preview-source-option] strong {
    display: block;
    font-size: 14px;
    line-height: 24px;
    font-weight: 500;
  }
  [data-preview-source-option] strong + span {
    display: block;
    color: #81858c;
    font-size: 14px;
    line-height: 24px;
  }
  [data-preview-source-submit] {
    display: block;
    min-width: 120px;
    height: 36px;
    margin: 24px 0 0 auto;
    padding: 0 14px;
    border: 0;
    border-radius: 18px;
    color: #fff;
    background: #0f1115;
    font-size: 14px;
    line-height: 22px;
    cursor: pointer;
    transition: background-color 120ms ease;
  }
  [data-preview-source-submit]:hover:not(:disabled) {
    background: #43454a;
  }
  [data-preview-source-submit]:focus-visible {
    outline: 2px solid rgb(0 0 0 / 16%);
    outline-offset: 2px;
  }
  [data-preview-source-submit]:disabled { cursor: not-allowed; opacity: 0.5; }
  @media (prefers-color-scheme: dark) {
    [data-preview-source-chooser] {
      color: #f9fafb;
      background: #151517;
    }
    [data-preview-source-card] { border-color: rgb(255 255 255 / 6%); background: #2c2c2e; }
    [data-preview-source-card] > p, [data-preview-source-card] legend { color: #cfd3d6; }
    [data-preview-source-option] strong + span { color: #adb2b8; }
    [data-preview-source-option]:hover:not(:has(input:disabled)),
    [data-preview-source-option]:has(input:checked) { background: rgb(255 255 255 / 8%); }
    [data-preview-source-option]:has(input:checked) { border-color: rgb(255 255 255 / 12%); }
    [data-preview-source-option] input { accent-color: #f9fafb; }
    [data-preview-source-submit] { color: #0f1115; background: #f9fafb; }
    [data-preview-source-submit]:hover:not(:disabled) { background: #ebeef2; }
    [data-preview-source-submit]:focus-visible { outline-color: rgb(255 255 255 / 20%); }
  }
  @media (max-width: 560px) {
    [data-preview-source-card] { padding: 24px; }
    [data-preview-source-submit] { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-preview-source-option], [data-preview-source-submit] { transition: none; }
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
    <span>
      <strong>${escapeMarkup(choice.label)}</strong>
      <span>${escapeMarkup(choice.description)}</span>
    </span>
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
