// #193: dark-theme support for the Univer grid canvas.
//
// The shell chrome (issue #191) restyles via CSS tokens on a `data-theme`
// attribute flip, but Univer paints its grid, row/column headers and gridlines
// on a <canvas>, so CSS tokens never reach them. This module supplies the
// pieces Univer needs to honor the dark theme:
//
//  * `darkUniverTheme` — `defaultTheme` cloned with the background / text /
//    border / scrollbar keys overridden to the Coco dark palette. Fed to
//    `themeInstance.setTheme()`, which swaps Univer's UI-chrome CSS vars *and*
//    the empty-cell `bgColorSecondary` background.
//  * `darkHeaderStyle` / `lightHeaderStyle` — `customizeRowHeader` /
//    `customizeColumnHeader` payloads for the row/column gutter.
//  * `DARK_GRIDLINE_COLOR` — passed to `FWorksheet.setGridLinesColor()`.
//
// All color values are kept in lock step with the dark palette in
// src/styles/theme.css so the grid matches the surrounding shell chrome.

import { defaultTheme } from "@univerjs/design";

/** Coco dark palette — mirrors the `[data-theme="dark"]` block of theme.css. */
const DARK = {
  bg: "#1e1e1e", // --coco-bg
  bgElevated: "#2a2a2a", // --coco-bg-elevated
  surfaceHover: "#3d3d3d", // --coco-surface-hover
  text: "#e8e8e8", // --coco-text
  textMuted: "#a0a0a0", // --coco-text-muted
  textFaint: "#7a7a7a", // --coco-text-faint
  border: "#3d3d3d", // --coco-border
  borderStrong: "#525252", // --coco-border-strong
} as const;

/** Gridline color for dark mode (mid-dark grey). Light mode resets to Univer's
 *  default by passing `undefined` to `setGridLinesColor`. */
export const DARK_GRIDLINE_COLOR = DARK.border;

/**
 * Univer theme object for dark mode: `defaultTheme` with the background, text,
 * border and scrollbar keys overridden to the Coco dark palette. Every other
 * key (the color-ramp palette, spacing, font sizes, brand colors) is inherited
 * unchanged. `themeInstance.setTheme()` applies this as a flat CSS-var map and
 * also drives the empty-cell `bgColorSecondary` background.
 */
export const darkUniverTheme: Record<string, string> = {
  ...defaultTheme,
  colorBlack: DARK.text,
  bgColor: DARK.bgElevated,
  bgColorHover: DARK.surfaceHover,
  bgColorSecondary: DARK.bg,
  bgColorOverlay: DARK.bgElevated,
  textColor: DARK.text,
  textColorSecondary: DARK.textMuted,
  textColorSecondaryDarker: "#c0c0c0",
  textColorTertiary: DARK.textFaint,
  borderColor: DARK.border,
  scrollbarColor: DARK.borderStrong,
  scrollbarColorHover: "#656565",
  scrollbarColorActive: DARK.textFaint,
};

/** Light Univer theme — Univer's stock `defaultTheme`, unchanged. */
export const lightUniverTheme: Record<string, string> = defaultTheme;

/** Row/column header style for dark mode (dark grey gutter, muted text). */
export const darkHeaderStyle = {
  backgroundColor: DARK.bgElevated,
  fontColor: DARK.textMuted,
  borderColor: DARK.border,
} as const;

/** Row/column header style for light mode — Univer's stock header colors
 *  (`DefaultColumnHeaderLayoutExtension` / `DefaultRowHeaderLayoutExtension`),
 *  re-asserted explicitly so a dark→light toggle restores the default look. */
export const lightHeaderStyle = {
  backgroundColor: "#f8f9fa",
  fontColor: "#000000",
  borderColor: "#d9d9d9",
} as const;
