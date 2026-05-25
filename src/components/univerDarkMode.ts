// #193 (Univer 0.8 path): wire Coco's effective theme to Univer's native
// dark-mode switch.
//
// Univer 0.8 introduced first-class dark mode (`IUniverConfig.darkMode` for the
// initial config + `ThemeService.setDarkMode(boolean)` for live toggling; the
// facade exposes the same as `univerAPI.toggleDarkMode(isDarkMode)`). This
// replaces the 0.5.x `customizeColumnHeader` workaround that was reverted in
// commit 39139c5 — the engine-render dark theme now repaints the grid canvas
// (row/col headers, gridlines, empty cells) without per-cell tinting.
//
// The helper is pure / framework-free so it can be unit-tested against a
// minimal stub. The caller (EditorScreen) owns the wiring to the theme store.
//
// API choice rationale: we go through the redi injector → ThemeService rather
// than the facade's `toggleDarkMode`, because the facade method internally
// calls the same service and a facade exception (e.g. no active workbook yet)
// would prevent the dark-mode flip. The injector path works even before the
// first workbook is created.

import { ThemeService, type Univer } from "@univerjs/core";
import type { EffectiveTheme } from "../store/theme";

/**
 * Apply `theme` to a live Univer instance. Returns true on success, false if
 * the ThemeService could not be resolved (e.g. injector not yet ready or the
 * service was disposed). Failure is silent — the caller's next theme change
 * re-applies.
 */
export function setUniverDarkMode(univer: Univer, theme: EffectiveTheme): boolean {
  let service: ThemeService | null = null;
  try {
    service = univer.__getInjector().get(ThemeService);
  } catch {
    service = null;
  }
  if (!service) return false;

  try {
    service.setDarkMode(theme === "dark");
    return true;
  } catch {
    return false;
  }
}
