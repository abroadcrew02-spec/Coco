// #179 (area E): hot-swap Univer's locale without re-mounting the editor.
//
// Coco serves its locale from Univer's EN_US slot (Univer 0.5.x ships no
// JA_JP). `buildCocoUniverLocale(locale)` returns the *full* bundle for the
// target locale, so re-loading it and re-firing the locale-changed signal
// updates Univer's chrome (ribbon, menus, formula helper) in place.
//
// Univer's `LocaleService.load()` deep-merges into its existing locale store.
// Because `buildCocoUniverLocale` always returns the complete bundle, merging
// the target bundle over the previous one yields the correct result in both
// directions: ja→en re-asserts every English string over the JA overrides,
// and en→ja layers the JA overrides back on.

import { LocaleService, LocaleType, type Univer } from "@univerjs/core";
import type { Locale } from "../i18n/locale";
import { buildCocoUniverLocale } from "./cocoUniverLocale";

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
    service.load({ [LocaleType.EN_US]: buildCocoUniverLocale(locale) });
    // Re-fire `localeChanged$`; the locale type itself stays EN_US.
    service.setLocale(LocaleType.EN_US);
    return true;
  } catch {
    return false;
  }
}
