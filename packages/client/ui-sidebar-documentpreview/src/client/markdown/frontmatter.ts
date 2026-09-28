/** Leading YAML frontmatter split from a Markdown document before Markdown parsing. */

/** Frontmatter source between its delimiters and the Markdown body after the closing delimiter. */
export interface FrontmatterSplit {
  source: string
  body: string
}

// Opening `---` on the first line, then the first closing `---` or `...` line; `??` lets an
// empty block close on the line right after the opening.
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u

/**
 * Split a leading YAML frontmatter block from Markdown text without parsing its YAML.
 * @param text - Markdown source; an unterminated block is not frontmatter.
 * @returns frontmatter source and the remaining body, or `undefined` when the text has none.
 */
export function splitFrontmatter(text: string): FrontmatterSplit | undefined {
  const match = FRONTMATTER.exec(text)
  if (match === null) return undefined
  return { source: match[1] ?? '', body: text.slice(match[0].length) }
}
