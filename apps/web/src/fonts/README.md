# Fonts

Vendored so `next build` never reaches the network (`src/lib/fonts.ts` loads
them with `next/font/local`). Each file is the latin subset of the variable
font, as served by Google Fonts in November 2026.

| File | Family | Axes used |
|---|---|---|
| `bricolage-grotesque-latin.woff2` | Bricolage Grotesque | wght 400–700 |
| `figtree-latin.woff2` | Figtree | wght 400–600 |
| `martian-mono-latin.woff2` | Martian Mono | wght 400–500 |
| `ibm-plex-sans-latin.woff2` | IBM Plex Sans | wght 400–500 |
| `ibm-plex-serif-latin.woff2` | IBM Plex Serif | italic, wght 400 |

All five are licensed under the SIL Open Font License 1.1
(https://openfontlicense.org), which allows bundling and redistribution with
software. To add a weight or subset, download the matching woff2 from
Google Fonts' CSS API and update the table above.
