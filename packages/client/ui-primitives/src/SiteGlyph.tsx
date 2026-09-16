/**
 * Site marks for well-known external link hosts. {@link LinkIcon} renders one in
 * the leading glyph seat, so a familiar destination leads with its own mark
 * instead of the generic globe. The marks are the `simple-icons` artwork set
 * (CC0-1.0), pinned by this package's dependency on it; each mark takes the
 * link's `currentColor` rather than the brand fill that set records.
 */
import type { ReactElement } from 'react'
import {
  siBilibili,
  siCsdn,
  siGithub,
  siGitlab,
  siJuejin,
  siMdnwebdocs,
  siNpm,
  siPypi,
  siStackoverflow,
  siWikipedia,
  siX,
  siYcombinator,
  siYoutube,
  siZhihu,
} from 'simple-icons'
import type { SimpleIcon } from 'simple-icons'

/**
 * Host suffix to site mark. A host matches a suffix when it equals it or is a
 * subdomain of it, so `gist.github.com` and `en.wikipedia.org` resolve without
 * their own entries.
 */
const SITE_HOSTS: Readonly<Record<string, SimpleIcon>> = {
  'github.com': siGithub,
  'github.io': siGithub,
  'raw.githubusercontent.com': siGithub,
  'gitlab.com': siGitlab,
  'npmjs.com': siNpm,
  'pypi.org': siPypi,
  'stackoverflow.com': siStackoverflow,
  'developer.mozilla.org': siMdnwebdocs,
  'wikipedia.org': siWikipedia,
  'news.ycombinator.com': siYcombinator,
  'youtube.com': siYoutube,
  'youtu.be': siYoutube,
  'x.com': siX,
  'twitter.com': siX,
  'bilibili.com': siBilibili,
  'zhihu.com': siZhihu,
  'juejin.cn': siJuejin,
  'csdn.net': siCsdn,
}

/**
 * Resolve the mark named by an external destination.
 * @param href - The link destination; only an absolute http(s) URL can name a host.
 * @returns The matched site mark, or undefined when the host is unknown or not http(s).
 */
function siteIcon(href: string): SimpleIcon | undefined {
  let host: string
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    host = url.hostname.toLowerCase()
  } catch {
    // Not an absolute URL: nothing here can name a host.
    return undefined
  }
  for (const [suffix, icon] of Object.entries(SITE_HOSTS)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return icon
  }
  return undefined
}

/** Props for {@link siteGlyph}: the destination plus the shared icon sizing seat. */
interface SiteGlyphProps {
  /** The link destination; only an absolute http(s) URL can name a host. */
  href: string | undefined
  /** Square edge in px. */
  size: number
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * Render the site mark for a known external destination.
 * @param props - The destination and the icon sizing seat.
 * @returns The site's mark riding currentColor, or undefined for an unknown site.
 */
export function siteGlyph({ href, size, className }: SiteGlyphProps): ReactElement | undefined {
  const icon = href === undefined ? undefined : siteIcon(href)
  if (icon === undefined) return undefined
  return (
    // Simple Icons fill their 24-unit box edge to edge; the -2 inset leaves the
    // same ~8% margin the 20-unit ic_ds_* glyphs draw inside their own box.
    <svg width={size} height={size} className={className} viewBox="-2 -2 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d={icon.path} fill="currentColor" />
    </svg>
  )
}
