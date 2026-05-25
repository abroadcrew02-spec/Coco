// Coco's Univer locale bundle.
//
// History: in Univer 0.5.x there was no `LocaleType.JA_JP`, so Coco served the
// JA UI from the EN_US slot with a ~700-line hand-written override (see PR #95
// / commit history). Univer 0.10 added `mergeLocales(...)` and Univer 0.12
// shipped a native `ja-JP` locale across `@univerjs/sheets`, `sheets-ui`,
// `ui`, `docs-ui`, `sheets-formula-ui`, `find-replace`, `sheets-find-replace`,
// and `design`. As of the 0.12.4 bump (this file's last big change), the
// EN_US-slot workaround was dropped — the native bundles are used directly
// for both languages.
//
// What we still apply: a thin override on `formula.functionList` covering 245
// Excel functions where Coco prefers shorter / more literal JA strings than
// Univer's native `ja-JP` Microsoft-style phrasing. NOTE: at Univer 0.12+
// `sheets-formula-ui` ships JA `abstract` for every function in our overlay,
// so this is a translation-quality preference, not a gap fill — see the
// header comment in univerFunctionListJa.ts for the team-decision context.

import { mergeLocales, LocaleType, type ILanguagePack, type ILocales } from "@univerjs/core";

import SheetsEnUS from "@univerjs/sheets/locale/en-US";
import SheetsUIEnUS from "@univerjs/sheets-ui/locale/en-US";
import UIEnUS from "@univerjs/ui/locale/en-US";
import DocsUIEnUS from "@univerjs/docs-ui/locale/en-US";
import SheetsFormulaUIEnUS from "@univerjs/sheets-formula-ui/locale/en-US";
import FindReplaceEnUS from "@univerjs/find-replace/locale/en-US";
import SheetsFindReplaceEnUS from "@univerjs/sheets-find-replace/locale/en-US";
// Phase 4b: drawing-ui / sheets-drawing-ui contribute the image-popup
// menu, sidebar panel, and crop / arrange / replace strings. The base
// `@univerjs/drawing` and `@univerjs/sheets-drawing` packages contribute
// no UI text and ship no locale bundle (verified via lib/locale/* dir
// listing and README locale column).
import DrawingUIEnUS from "@univerjs/drawing-ui/locale/en-US";
import SheetsDrawingUIEnUS from "@univerjs/sheets-drawing-ui/locale/en-US";

import SheetsJaJP from "@univerjs/sheets/locale/ja-JP";
import SheetsUIJaJP from "@univerjs/sheets-ui/locale/ja-JP";
import UIJaJP from "@univerjs/ui/locale/ja-JP";
import DocsUIJaJP from "@univerjs/docs-ui/locale/ja-JP";
import SheetsFormulaUIJaJP from "@univerjs/sheets-formula-ui/locale/ja-JP";
import FindReplaceJaJP from "@univerjs/find-replace/locale/ja-JP";
import SheetsFindReplaceJaJP from "@univerjs/sheets-find-replace/locale/ja-JP";
import DrawingUIJaJP from "@univerjs/drawing-ui/locale/ja-JP";
import SheetsDrawingUIJaJP from "@univerjs/sheets-drawing-ui/locale/ja-JP";

import type { Locale } from "../i18n/locale";
import { FUNCTION_LIST_JA_ABSTRACT } from "./univerFunctionListJa";

// Turn the flat `NAME → abstract` map into the nested shape Univer's
// `formula.functionList` expects (`{ NAME: { abstract } }`), so the merge
// only replaces the `abstract` key and leaves `description` /
// `functionParameter` as Univer's stock copy.
function buildFunctionListJaPatch(): ILanguagePack {
  const functionList: ILanguagePack = {};
  for (const [name, abstract] of Object.entries(FUNCTION_LIST_JA_ABSTRACT)) {
    functionList[name] = { abstract };
  }
  return { formula: { functionList } };
}

/**
 * Build the full `locales` map for `new Univer({ locales })`. Both EN_US and
 * JA_JP slots are wired so Coco's app-side `useLocale()` switch (via
 * `swapUniverLocale`) can flip between them at runtime.
 */
export function buildCocoUniverLocales(): ILocales {
  return {
    [LocaleType.EN_US]: mergeLocales(
      SheetsEnUS,
      SheetsUIEnUS,
      UIEnUS,
      DocsUIEnUS,
      SheetsFormulaUIEnUS,
      FindReplaceEnUS,
      SheetsFindReplaceEnUS,
      DrawingUIEnUS,
      SheetsDrawingUIEnUS,
    ),
    [LocaleType.JA_JP]: mergeLocales(
      SheetsJaJP,
      SheetsUIJaJP,
      UIJaJP,
      DocsUIJaJP,
      SheetsFormulaUIJaJP,
      FindReplaceJaJP,
      SheetsFindReplaceJaJP,
      DrawingUIJaJP,
      SheetsDrawingUIJaJP,
      // Coco's JA `abstract` overrides for the most common formula functions.
      buildFunctionListJaPatch(),
    ),
  };
}

/** Coco app-locale → Univer LocaleType. */
export function toUniverLocaleType(locale: Locale): LocaleType {
  return locale === "ja-JP" ? LocaleType.JA_JP : LocaleType.EN_US;
}
