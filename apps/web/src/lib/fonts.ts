/**
 * The two font sets the app loads through `next/font`, exposed as CSS
 * variable class strings the root layout puts on `<html>`. Which family a
 * surface uses is decided in CSS (`globals.css`), not here.
 *
 * The files are vendored in `src/fonts/` (latin subset, variable woff2,
 * SIL Open Font License — see `src/fonts/README.md`) and loaded with
 * `next/font/local`. `next/font/google` downloaded them from Google at build
 * time, which made `next build` (CI and the self-hosted image build) fail
 * whenever Google Fonts answered slowly or oddly, and made every
 * self-hosted build call Google. Must not break: the CSS variable names,
 * which `globals.css` reads.
 */
import localFont from "next/font/local";

/**
 * The field type system, shared with the landing:
 *   display  Bricolage Grotesque (--f-bricolage)
 *   body     Figtree             (--f-figtree)
 *   micro    Martian Mono        (--f-martian-mono)
 * Loaded once in the root layout; surfaces adopt them progressively.
 */

const bricolage = localFont({
  src: "../fonts/bricolage-grotesque-latin.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--f-bricolage",
  display: "swap",
});

const figtree = localFont({
  src: "../fonts/figtree-latin.woff2",
  weight: "400 600",
  style: "normal",
  variable: "--f-figtree",
  display: "swap",
});

const martianMono = localFont({
  src: "../fonts/martian-mono-latin.woff2",
  weight: "400 500",
  style: "normal",
  variable: "--f-martian-mono",
  display: "swap",
});

export const fieldFontVars = `${bricolage.variable} ${figtree.variable} ${martianMono.variable}`;

/**
 * The auth type system, shared with the landing's home page: one
 * superfamily, IBM Plex Sans for everything and the serif italic for the
 * highlighted word in a title.
 */

const plexSans = localFont({
  src: "../fonts/ibm-plex-sans-latin.woff2",
  weight: "400 500",
  style: "normal",
  variable: "--f-plex-sans",
  display: "swap",
});

const plexSerif = localFont({
  src: "../fonts/ibm-plex-serif-latin.woff2",
  weight: "400",
  style: "italic",
  variable: "--f-plex-serif",
  display: "swap",
});

export const authFontVars = `${plexSans.variable} ${plexSerif.variable}`;
