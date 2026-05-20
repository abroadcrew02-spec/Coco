// #179 (area E): re-render a component when the app locale changes.
//
// `t()` reads localStorage on every call, so a component that calls `t()`
// only needs a re-render to pick up the new strings. This hook subscribes to
// `subscribeLocale` and bumps local state on a change, forcing that re-render
// without a page reload. Components that render localized text should call
// `useLocale()` once so a language switch reflects immediately.

import { useEffect, useState } from "react";
import { getLocale, subscribeLocale, type Locale } from "../i18n/locale";

/**
 * Returns the current locale and re-renders the calling component whenever
 * the locale changes (via `setLocale`).
 */
export function useLocale(): Locale {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  useEffect(() => subscribeLocale(setLocaleState), []);
  return locale;
}
