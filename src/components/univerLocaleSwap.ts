// Hot-swap Univer's locale without re-mounting the editor.
//
// History: under Univer 0.5.x, Coco served its locale from the EN_US slot
// (Univer 0.5 had no JA_JP) and this helper re-loaded the full override
// bundle on every flip. After the 0.12.4 bump (Phase 3 of the staged Univer
// migration in docs/UNIVER_0_6_MIGRATION.md), Univer ships a native ja-JP
// locale, so the swap is now a one-liner: tell `LocaleService` to switch to
// the new `LocaleType`. The locales themselves are wired once at mount via
// `buildCocoUniverLocales()`.

import { LocaleService, type Univer } from "@univerjs/core";
import type { Locale } from "../i18n/locale";
import { toUniverLocaleType } from "./cocoUniverLocale";

/**
 * Apply `locale` to a live Univer instance. Returns true on success, false
 * if the LocaleService could not be resolved (the caller should then fall
 * back to advising a reload).
 */
export function swapUniverLocale(univer: Univer, locale: Locale): boolean {
  let service: LocaleService | null = null;
  try {
    service = univer.__getInjector().get(LocaleService);
  } catch {
    service = null;
  }
  if (!service) return false;

  try {
    service.setLocale(toUniverLocaleType(locale));
    return true;
  } catch {
    return false;
  }
}
