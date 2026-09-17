// @vitest-environment jsdom
/** Inert parsing precedes the restrictive policy so source markup cannot navigate or load frames. */
import { expect, it } from 'vitest'
import { createBasicHtmlDocument } from '../src/client/html/basic-document.ts'

it('preserves static content and removes navigation, policy overrides and active documents', () => {
  const html = createBasicHtmlDocument(new TextEncoder().encode(`<!doctype html><html><head>
    <meta http-equiv="refresh" content="0;url=https://example.invalid">
    <meta http-equiv="Content-Security-Policy" content="default-src *">
    <base href="https://example.invalid"><style>p {color: red}</style>
    </head><body><p>Static</p><script>alert(1)</script><iframe src="https://example.invalid"></iframe>
    <object data="https://example.invalid"></object><embed src="https://example.invalid">
    <a href="https://example.invalid">Link</a><svg><a xlink:href="https://example.invalid">SVG</a></svg>
    <img src="data:image/png;base64,AA=="></body></html>`))
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  expect(parsed.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  expect(parsed.querySelector('meta')?.getAttribute('content')).toContain("connect-src 'none'")
  expect(parsed.querySelectorAll('script, iframe, object, embed, base, a[href], a[xlink\\:href]')).toHaveLength(0)
  expect(parsed.querySelectorAll('meta[http-equiv]')).toHaveLength(1)
  expect(parsed.querySelector('p')?.textContent).toBe('Static')
  expect(parsed.querySelector('style')?.textContent).toContain('color: red')
  expect(parsed.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
})
