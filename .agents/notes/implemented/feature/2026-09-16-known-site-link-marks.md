# Agent Note: Known-site link marks

Status: implemented

English | [中文](2026-09-16-known-site-link-marks.zh.md)

## Problem

Every transcribed anchor led with the same globe, so a transcript full of GitHub, npm, and documentation links gave no signal about where a link goes until the reader parsed its label. The [clickable-link vocabulary](2026-09-04-web-clickable-link-styles.md) reserved that leading seat for one category glyph and left per-site marks as a possible later extension of the `url` category.

## Decision

`LinkIcon` takes an optional `href`. For the `url` category, a destination whose host is a well-known site draws that site's own mark; every other `url` destination keeps the globe, and the file categories ignore `href` because their destination is a path, not a site.

`SiteGlyph.tsx` in ui-primitives owns the mapping: eighteen host suffixes resolve to fourteen marks — GitHub (`github.com`, `github.io`, `raw.githubusercontent.com`), GitLab, npm, PyPI, Stack Overflow, MDN, Wikipedia, Hacker News, YouTube (`youtube.com`, `youtu.be`), X (`x.com`, `twitter.com`), Bilibili, Zhihu, Juejin, and CSDN. A host matches a suffix when it equals it or is a subdomain of it, after `www.` is stripped, so `gist.github.com` and `en.wikipedia.org` resolve without their own entries. Only absolute `http:` and `https:` destinations can match; anything else falls back to the globe.

The marks are the single-path form of the [Simple Icons](https://simpleicons.org) set (CC0-1.0), drawn on that set's 24×24 viewBox and filled with `currentColor` like every other link glyph, so they follow the link color in both themes, hover, and focus. Every mark is `aria-hidden`; the anchor's own text remains the accessible name.

Two consumers pass their destination: the markdown renderer's `renderSafeLink`, which covers authored anchors, reference links, and URL-promoted inline code, and the web card's source and fetch links. Both already hold the sanitized destination.

## Alternatives considered

- **Fetching each site's favicon** from the site itself or a favicon service. This covers arbitrary sites, but rendering a transcript would issue network requests to every linked host, which discloses reading activity and turns a text render into a network operation; it also fails offline and behind a strict `img-src` policy, and needs a new external dependency. Rejected: a fixed local vocabulary keeps rendering deterministic and private, and the globe remains the honest fallback.
- **Filling the mark with the site's brand color.** Rejected: the link glyphs are `currentColor`-only so they follow the link alias, dark mode, and hover; a fixed fill would be the first exception and would fight the link's own hover color.
- **Adding site values to `LinkIconKind`.** Rejected: the kind is the category the consumer states, while the site is derived from the destination; folding both into one union would make every consumer spell out a site it does not know.
- **A monogram tile for every unmapped host.** Rejected as noise: a generated letter capsule claims a site identity without carrying one, and 14px leaves no room for readable initials.

## Consequences

- Adding a site is one path entry and one host entry in `SiteGlyph.tsx`; the `link-icon` spec pins one host per mapped site and requires their marks to be distinct, so a dropped or duplicated path fails the suite.
- Unknown hosts, non-http schemes, unparseable destinations, and file categories keep the existing globe or category glyph; the `mailto` link in a transcript still shows the globe.
- The vocabulary is deliberately finite. Sites such as `example.com` never get a mark from this mechanism; recognizing them would require the network fetching the alternatives reject.
- Coverage: the LinkIcon spec covers aliases, the fallback branches, and the sizing seat; the markdown spec pins one known and one unknown anchor; the web-card spec pins a source and a fetch link against the same marks.
