/**
 * File-extension vocabularies shared by the glyph pickers (`classifyLinkPath`,
 * `classifyFileType`), so a path classifies the same way on a link and on a
 * file-type icon.
 *
 * TODO: this is an interim rule. The product will settle one extension
 * standard for every place a file is drawn — an upload in the input bar, a
 * sent attachment, an artifact, the Sidebar's tree rows, the Sidebar's tab
 * chips and pane headers — and these sets, the glyph pickers over them, and
 * the sheets in `FileTypeIcon` are to be replaced by it. Until then the
 * surfaces differ: the Sidebar classifies by these sets, the conversation's
 * links fold the four office types into `document` (`LinkIcon`), and the
 * attachment cards (`ui-attachment` `FileCard`) draw one generic glyph with no
 * classification at all.
 */

/** Code, web, and data extensions. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'cts', 'mts', 'css', 'scss', 'sass', 'less',
  'html', 'htm', 'vue', 'svelte', 'astro', 'json', 'jsonc', 'json5', 'yaml', 'yml',
  'toml', 'xml', 'ini', 'env', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'py', 'pyi', 'rb', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'cxx',
  'h', 'hh', 'hpp', 'cs', 'php', 'swift', 'sql', 'csv', 'tsv', 'proto', 'graphql',
  'gql', 'lua', 'r', 'pl', 'scala', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hs', 'dart',
])

/** Raster and vector image extensions. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif',
])

/** Web page extensions; a subset of {@link CODE_EXTENSIONS} with its own file-type glyph. */
export const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm'])

/** Markdown extensions. */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'mdx', 'markdown'])

/** PDF. */
export const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['pdf'])

/** Spreadsheet extensions; `csv`/`tsv` also sit in {@link CODE_EXTENSIONS}. */
export const SHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'numbers'])

/** Slide-deck extensions. */
export const SLIDES_EXTENSIONS: ReadonlySet<string> = new Set(['ppt', 'pptx', 'key'])

/** Word-processor document extensions. */
export const WORD_EXTENSIONS: ReadonlySet<string> = new Set(['doc', 'docx', 'rtf', 'odt', 'pages'])

/**
 * A path's lowercase extension without the dot, taken from its last segment.
 * @param path - File path with either separator.
 * @returns The extension, or `''` for a name without a dot.
 */
export function fileExtension(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}
