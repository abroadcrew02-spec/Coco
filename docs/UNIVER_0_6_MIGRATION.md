# Univer 0.6+ migration feasibility (Coco)

Branch `claude/univer-06-feasibility`. Snapshot date 2026-05-25.

This report exists because three open Coco issues all bottom out on Univer
0.5.x limitations:

- **#193** — dark theme for the grid canvas (row/col headers, gridlines)
- **high-chart-live** — in-grid chart rendering (no `@univerjs/sheets-chart`)
- **high-image-live** — in-grid image rendering (no `@univerjs/sheets-drawing`)

…and the deprecation warning `@univerjs/facade ... will be removed in v0.6.0`
fires on every boot.

The user asked for a feasibility report to decide between upgrading and
deeper engine hacks. **Headline finding before you read the rest: the
"0.5.5 vs 0.6.0" framing in the original tasking is outdated.** Univer
shipped 0.6.0 in Feb 2025 and is now on **0.24.0** (May 23, 2026, npm
`latest`). We are roughly 19 minor versions behind, not one. That changes
the calculus significantly.

## Section 1 — Coco's current Univer footprint (0.5.x)

### 1.1 Packages

From `package.json` (lines 22–36):

| Package | Version | Used for | Surface area |
| ------- | ------- | -------- | ------------ |
| `@univerjs/core` | ^0.5.3 | `Univer` ctor, `LocaleType`, `UniverInstanceType`, `IWorkbookData`, `ICommandService`, `LocaleService`, `IUndoRedoService`, all common types | **Large** |
| `@univerjs/design` | ^0.5.3 | `defaultTheme` only (single import) | Small |
| `@univerjs/docs` | ^0.5.3 | `UniverDocsPlugin` registration | Small |
| `@univerjs/docs-ui` | ^0.5.3 | `UniverDocsUIPlugin` registration + locale | Small |
| `@univerjs/engine-formula` | ^0.5.3 | `UniverFormulaEnginePlugin` | Small |
| `@univerjs/engine-render` | ^0.5.3 | `UniverRenderEnginePlugin` | Small |
| `@univerjs/facade` | ^0.5.3 | `FUniver.newAPI`, every facade call site (workbook, sheet, range) — **deprecated package** | **Large** |
| `@univerjs/find-replace` | ^0.5.5 | `UniverFindReplacePlugin` + locale | Small |
| `@univerjs/sheets` | ^0.5.3 | `UniverSheetsPlugin`, plus `BEFORE_CELL_EDIT` / `AFTER_CELL_EDIT` / `INTERCEPTOR_POINT` / `SheetInterceptorService` for normalizer (`univerFormulaNormalizer.ts`) | Medium |
| `@univerjs/sheets-filter` | ^0.5.5 | `UniverSheetsFilterPlugin` (FR-009) | Small |
| `@univerjs/sheets-find-replace` | ^0.5.5 | `UniverSheetsFindReplacePlugin` + locale | Small |
| `@univerjs/sheets-formula` | ^0.5.3 | `UniverSheetsFormulaPlugin` | Small |
| `@univerjs/sheets-formula-ui` | ^0.5.3 | `UniverSheetsFormulaUIPlugin` + locale + 527-function JA name list (`univerFunctionListJa.ts`) | Medium |
| `@univerjs/sheets-ui` | ^0.5.3 | `UniverSheetsUIPlugin` + locale + `setActiveSheet`/`getRange` facade extensions auto-imported via `@univerjs/facade` | **Large** |
| `@univerjs/ui` | ^0.5.3 | `UniverUIPlugin`, `IMenuService`, `MenuPosition`, `RibbonStartGroup`, etc. for the Coco-side context-menu wiring (`univerContextMenu.ts`) | Medium |

Not currently installed but referenced as "would solve X" in code comments:

- `@univerjs/sheets-chart` — referenced at `EditorScreen.tsx:5462`
  ("…isn't in this build, so the…"). Charts sidebar (`ChartPreviewPanel`)
  was the agreed substitute (COVERAGE.md Phase 2).
- `@univerjs/sheets-drawing` — referenced at `chartPreviewData.ts:4`.
  Images sidebar (`ImagePreviewPanel`) is the agreed substitute.
- `@univerjs/sheets-numfmt` — referenced at `EditorScreen.tsx:4737`,
  `:4867`, `:5580`. Coco uses snapshot-level `_fmt` writes instead.
- `@univerjs/sheets-sort` — referenced at `EditorScreen.tsx:7570`.
  Coco's `SortDialog` writes sorted rows into the snapshot.

### 1.2 Mount block (the surface that changes most on upgrade)

`src/components/EditorScreen.tsx:7497–7689` — single `useEffect`:

```ts
univer = new Univer({
  theme: defaultTheme,
  locale: LocaleType.EN_US,
  locales: { [LocaleType.EN_US]: buildCocoUniverLocale(getLocale()) },
  override: undoRedoOverride,                    // FR-011, caps undo at 100
});

univer.registerPlugin(UniverRenderEnginePlugin);
univer.registerPlugin(UniverFormulaEnginePlugin);
univer.registerPlugin(UniverUIPlugin, {
  container: "univer-container", header: true, footer: true,
});
univer.registerPlugin(UniverDocsPlugin, { hasScroll: false });
univer.registerPlugin(UniverDocsUIPlugin);
univer.registerPlugin(UniverSheetsPlugin);
univer.registerPlugin(UniverSheetsUIPlugin);
univer.registerPlugin(UniverSheetsFormulaPlugin);
univer.registerPlugin(UniverSheetsFormulaUIPlugin);
univer.registerPlugin(UniverFindReplacePlugin);
univer.registerPlugin(UniverSheetsFindReplacePlugin);
univer.registerPlugin(UniverSheetsFilterPlugin);

univer.createUnit(UniverInstanceType.UNIVER_SHEET, initialData as IWorkbookData);
fUniverRef.current = FUniver.newAPI(univer);     // the deprecated package
```

Three things make this fragile:

1. **`FUniver.newAPI(univer)`** is from the deprecated `@univerjs/facade`
   package — every facade-call site through the app indirects through this
   single ref. Total `as unknown as ...` / `as any` casts touching Univer
   types in `EditorScreen.tsx` alone: ~90 (Grep). Most are because Coco
   bypasses the facade for the data-validation, conditional-formatting,
   chart, image, comment, hyperlink, table, sparkline, outline, slicer,
   pivot, scenario, sheet-protection, named-range, and named-style
   pipelines — each of those features writes through `_underscored`
   snapshot fields and re-creates the unit via `applyMutatedSnapshot`.

2. **The deferred-dispose dance** (`univerStashRef`, `EditorScreen.tsx:577–
   590` and `:7497–7526`) was added in `39139c5` to work around a
   StrictMode×Univer race: React 18 StrictMode runs effect → cleanup → 
   effect synchronously. Disposing Univer in the cleanup tears down its
   `redi` injector while `createUnit`'s async `_initWorkbookListener` is
   still pending, surfacing `[redi]: Injector ... disposed` and a blank
   grid (see `reference_verify_app.md` memory note).

3. **Snapshot-patch boot pipeline** (`:7585–:7608`) — every render passes
   the snapshot through 11 patch functions
   (`patchHyperlinkRenders`, `patchOutlineRenders`, `patchCheckboxRenders`,
   `patchFormControlRenders`, `patchSlicerFilters`, `patchTableRenders`,
   `patchSparklineRenders`, `patchCfRenders`, `patchErrorIndicators`,
   `patchShowAllCommentsView`, `patchShowFormulasView`). Each exists
   because Univer 0.5.x has no facade equivalent for the underlying
   feature. They run **only at `createUnit` time** — that's why we have
   imperative restyle calls like `applyHyperlink` (line 1396) and live
   patch-and-remount sequences sprinkled through 9,500-line
   `EditorScreen.tsx`.

### 1.3 Out-of-mount Univer touch points

- `src/components/univerContextMenu.ts` — registers cell context-menu
  items via `ICommandService` + `IMenuService`.
- `src/components/univerFormulaNormalizer.ts` — `SheetInterceptorService`
  intercept around `BEFORE_CELL_EDIT` / `AFTER_CELL_EDIT` to rewrite
  Japanese function names (`=合計(...)` → `=SUM(...)`).
- `src/components/univerLocaleSwap.ts` — hot-swap of `LocaleService`.
- `src/components/univerUndoRedoOverride.ts` — `IUndoRedoService` 
  override constant for FR-011.
- `src/components/cocoUniverLocale.ts` — locale bundle (5 packages).
- `src/components/conditionalFormatRender.ts`, `hyperlinkRender.ts`,
  `errorIndicatorRender.ts`, `outlineRender.ts`, `showFormulasRender.ts`,
  `showAllCommentsRender.ts`, `renderGlyphs.ts`, etc. — snapshot patchers
  that decorate cell `s` (style id) inline.
- `src/store/scriptRuntime.ts`, `src/components/ScriptEditorDialog.tsx`
  — typed `FUniver` ref for the user script runtime.
- `src/store/splitPane.ts` — references `IFreeze` shape from
  `@univerjs/core` typedef.

## Section 2 — What Univer ships today

### 2.1 Latest is 0.24.0, not 0.6

`gh api repos/dream-num/univer/releases` (May 25 2026):

| Version | Date | Note |
| ------- | ---- | ---- |
| **0.24.0** | 2026-05-23 | npm `latest` |
| 0.23.0 | 2026-05-18 | |
| 0.22.1 | 2026-05-13 | |
| 0.20.0 | 2026-04-03 | drawing/chart/shape facade paths moved to OSS namespace |
| 0.16.1 | 2026-03-03 | shape (`@univerjs-pro/sheets-shape`) |
| 0.12.0 | 2025-11-15 | **table formulas, ja-JP locale**, ribbon `classic` mode |
| 0.10.0 | 2025-07-29 | `mergeLocales`, batch `registerPlugin` |
| 0.8.0 | 2025-06-07 | **dark mode**, refined ribbon toolbar |
| 0.7.0 | 2025-05-14 | TailwindCSS refactor, table beta, note beta |
| 0.6.10 | 2025-04-18 | last 0.6.x — bubble/relation charts, `FRange.showDropdown` |
| **0.6.0** | 2025-02-14 | **`@univerjs/facade` removed**, React 19, multi-sheet loading |
| 0.5.5 (Coco) | 2025-01-20 | current |

(Source: `gh api repos/dream-num/univer/releases`; `npm view @univerjs/core dist-tags.latest` = 0.24.0.)

So upgrading isn't "go to 0.6" — it's a decision about which of 18
minor versions of breakage and feature gain to absorb.

### 2.2 Does the latest Univer fix the three issues?

#### #193 (dark theme for the grid canvas)

**Fixed.** v0.8.0 release notes (2025-06-07):

> "### 🌓 Dark Mode
> We have introduced the highly anticipated dark mode support. For usage,
> see [Themes and Dark Mode](https://docs.univer.ai/guides/sheets/advanced/custom-theme)."

Plus the v0.7.0 changelog has the building blocks — commits
`add dark mode on Univer Rendering Engine` (#5041), `core: add darkMode
configuration` (#5161), `support theme switcher` (#5154), `sidepanel: add
dark mode support` (#5114). The grid canvas, including row/col headers
and gridlines, is recolored by the engine-render dark theme — what 0.5.x
couldn't do via `customizeColumnHeader` is now built-in.

#### high-chart-live (in-grid chart rendering)

**Partially fixed, with a catch.** Chart support exists, but in the
**`@univerjs-pro/sheets-chart` + `@univerjs-pro/sheets-chart-ui`**
packages. The Pro package's `package.json` (`curl
https://registry.npmjs.org/@univerjs-pro/sheets-chart/latest`) shows:

```json
"dependencies": {
  "@univerjs-pro/license": "0.24.0",
  ...
}
```

`@univerjs-pro/license` is a license-gate dependency. The Pro package
omits any `license` field in `package.json` — it is **not Apache-2.0**.
The v0.20.0 release notes confirm the boundary: charts/shapes are Pro
modules. The shape OSS facade path rename (`@univerjs-pro/sheets-chart-ui/
facade` → `@univerjs/sheets-chart/facade`) is a *re-export* of the same
Pro module under an OSS-namespaced facade path; the underlying chart
runtime still requires `@univerjs-pro/license` at install time. As of
2026-05-25 there is **no `@univerjs/sheets-chart` package on npm**
(`curl https://registry.npmjs.org/@univerjs/sheets-chart/latest` →
`"Not Found"`).

Implications:

- If Coco is willing to take a commercial Univer Pro license, charts are
  a drop-in plugin.
- If Coco must stay Apache-2.0 / serverless / no-vendor-license, in-grid
  charts remain blocked — the sidebar `ChartPreviewPanel` stays the
  shipping answer.

#### high-image-live (in-grid image rendering)

**Fixed.** `@univerjs/sheets-drawing` v0.24.0 **is** on npm and **is**
Apache-2.0:

```json
{
  "name": "@univerjs/sheets-drawing",
  "version": "0.24.0",
  "license": "Apache-2.0",
  "dependencies": {
    "@univerjs/core": "0.24.0",
    "@univerjs/drawing": "0.24.0",
    "@univerjs/engine-render": "0.24.0",
    "@univerjs/sheets": "0.24.0"
  }
}
```

Paired with `@univerjs/sheets-drawing-ui` (also Apache-2.0). v0.6.0
release highlights it: "Added external image paste functionality and
optimized image processing logic #3617". v0.15.0 fixes image flip,
auto-row-height triggering re-position, etc. — image rendering is
mature.

There's also an **`@univerjs/sheets-graphics`** package (v0.24.0, MIT-
style "In-cell graphics rendering support") that's the lower-level
graphics primitive shared by charts/drawings.

#### Deprecation: `@univerjs/facade`

**The package is gone**, removed in v0.6.0 (2025-02-14). Release notes:

> "Package `@univerjs/facade` has been removed, please migrate to the
> new Facade usage."

The new pattern is:

```js
// BEFORE (Coco today)
import { FUniver } from '@univerjs/facade';
const api = FUniver.newAPI(univer);

// AFTER
import { FUniver } from '@univerjs/core/facade';
const api = FUniver.newAPI(univer);
```

Sheet-facade extensions like `FRange.attachRangePopup` (added in 0.6.0,
#4489) live in `@univerjs/sheets-ui/facade` and need to be imported as
side-effect modules — they auto-extend the FUniver/FRange prototypes:

```js
import '@univerjs/sheets-ui/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-drawing-ui/facade';
// ... per plugin
```

This is mechanical but per-plugin and per-call-site.

### 2.3 Sources

- `gh api repos/dream-num/univer/releases` (full release-tag list)
- `gh api repos/dream-num/univer/releases/tags/v0.6.0` (breaking changes)
- `gh api repos/dream-num/univer/releases/tags/v0.8.0` (dark mode)
- `gh api repos/dream-num/univer/releases/tags/v0.20.0` (drawing/chart
  facade path moves)
- `gh api repos/dream-num/univer/releases/tags/v0.24.0` (latest)
- `https://registry.npmjs.org/@univerjs/core` (latest dist-tag)
- `https://registry.npmjs.org/@univerjs/sheets-drawing` (Apache-2.0)
- `https://registry.npmjs.org/@univerjs-pro/sheets-chart` (commercial,
  license-gated)
- `https://registry.npmjs.org/@univerjs/sheets-chart` → 404
- `https://github.com/dream-num/univer/blob/dev/LICENSE` (Apache-2.0
  for the main repo)
- Docs page `https://docs.univer.ai/en-US/guides/sheets/getting-started/
  facade` (modern FUniver init pattern)
- Docs page `https://univer.ai/` (OSS vs Pro positioning; pricing page
  404, no public pricing)

The migration page hinted at in the deprecation warning
(`docs.univer.ai/guides/sheet/getting-started/migration`) returns 404 —
**there is no published 0.5→0.6 migration guide page**. The release notes
themselves are the canonical migration document, which is why this report
quotes them verbatim.

## Section 3 — Breaking-change impact map for Coco

Cross-referencing release notes from 0.6.0 → 0.24.0 against Section 1.

| # | Change | Origin | Coco call sites affected | Impact |
| - | ------ | ------ | ------------------------ | ------ |
| 1 | `@univerjs/facade` removed; `FUniver` re-exported from `@univerjs/core/facade` | 0.6.0 | `EditorScreen.tsx:25`, `ScriptEditorDialog.tsx:18`, `store/scriptRuntime.ts:19` (`import type { FUniver }`) | **Low** (3 import-path renames + drop the dep) |
| 2 | Per-plugin facade extensions (`import '@univerjs/sheets-ui/facade'`, `…/sheets-formula/facade`, etc.) | 0.6.0 | New side-effect imports needed wherever facade extensions are used: `getRange`, `getActiveSheet`, `setActiveSheet`, `setFontColor`, `setFontLine`, `setValue`, `insertDefinedName`, `deleteDefinedName`, etc. (~30 sites in `EditorScreen.tsx`) | **Low** (one-time addition; sites unchanged) |
| 3 | Redi DI view APIs (`useDependency`, `RediContext`, `useObservable`) moved from `@univerjs/core` → `@univerjs/ui` | 0.6.0 | Coco doesn't use these directly | None |
| 4 | React 19 compat refactor; "core no longer depends on React" | 0.6.0 | Coco is on React 18.3.1 — works on Univer 0.6+, but to stay forward-compatible we should plan a React 19 hop in parallel | **Low** |
| 5 | TailwindCSS refactor; `data-u-comp` attributes replace some class-name selectors | 0.7.0 | Check `src/components/EditorScreen.css` for any `.univer-*` selectors. `:313` has `.univer-formula-box` mentioned — needs re-verification | **Low** (1 known DOM-selector hook) |
| 6 | Dark mode; `core.darkMode` config, `ThemeService` switcher | 0.7.0–0.8.0 | New: we need to wire Coco's existing dark-mode toggle (already used for the chrome) to `univer.setDarkMode(true)` or via `ThemeService` | **Low–Medium** (new wiring, replaces #193 hacks) |
| 7 | `mergeLocales(...)` helper + batch `registerPlugin([...])` | 0.10.0 | `cocoUniverLocale.ts` could simplify; mount block could collapse 12 registerPlugin lines into one array | **Low** (optional refactor) |
| 8 | Permission-control API restructured | 0.12.0 | Coco has no permission-API call sites today (sheet-protection goes through `_protection` snapshot field + `onBeforeCommandExecute` block at I3). No-op unless we want to switch to native permission system | None |
| 9 | Native `ja-JP` locale | 0.12.0 | **Wins us a deletion**: the `cocoUniverLocale.ts` JA override + `univerLocaleSwap.ts` workaround for the "Univer 0.5.x doesn't ship LocaleType.JA_JP" gap (commented at `EditorScreen.tsx:7535–7540`) becomes unnecessary. Switch `LocaleType.EN_US` → `LocaleType.JA_JP` | **Low** (net code reduction) |
| 10 | History feature refactor (richer history info) | 0.16.1 | Coco overrides `IUndoRedoService` (FR-011). History API surface may have moved — needs re-verification on a sandbox | **Medium** (touches FR-011 override) |
| 11 | Context-menu refactor (`contextMenuHostService`); `DropdownLegacy` removed | 0.16.1 | `univerContextMenu.ts` registers via `ICommandService` + `IMenuService` (`MenuPosition`, `RibbonStartGroup`) — these APIs may have shifted | **Medium** (one ~250-line file to re-port) |
| 12 | `IGlobalZoneService` removed; use `IUIPartsService` + `BuiltInUIPart.GLOBAL` | 0.24.0 | Coco doesn't reference `IGlobalZoneService` | None |
| 13 | `FWorksheet.onCellDataChange` / `onBeforeCellDataChange` removed → `univerAPI.addEvent(univerAPI.Event.*)` | 0.24.0 | Coco wires `(workbook as unknown as { onCellClick? })` and `onCellHover` ad-hoc (`EditorScreen.tsx:8093`, `:8207`). The 0.6.0 event refactor (FEventRegistry, #4616) already changed these — Coco's pattern will need to be replaced with `univerAPI.addEvent(univerAPI.Event.CellClicked, …)` etc. | **Medium** (~5 event handlers) |
| 14 | `FWorksheet.getLastColumns` → `getLastColumn` | 0.24.0 | Not used in Coco source (grep clean) | None |
| 15 | `customizeColumnHeader` superseded by per-header facade APIs (PR #4549 "better col header facade", PR #4526 "customize column header height") | 0.6.0 | Coco doesn't currently call `customizeColumnHeader`; this resolves the #193 blocker via dark mode (#6) | N/A (gain, not breakage) |
| 16 | `appVersion` field meaning unchanged; `IWorkbookData` shape mostly stable but `styles` interning has new constraints in 0.10+ | various | Snapshot writers in `xlsx_io.rs` produce styles; verify `_fmt` cells still load. Round-trip tests should catch regressions | **Medium** (run the 10-fixture compat suite) |
| 17 | Drawing/chart/shape facade path migration from UI package to core package | 0.20.0 | Affects future chart/drawing facade imports; if Coco adopts drawings, must use the new paths | N/A until adopt |
| 18 | Plugin pre-registered via preset now throws an explicit error if registered again | 0.6.10 | Coco builds without presets — no conflict | None |

**Aggregate**: ~6 Low / ~4 Medium / 0 High changes. The "redi injector
disposed" StrictMode race that Coco fixed in `39139c5` is **probably no
longer needed on 0.6+** — release v0.6.0 #4596 "split skeleton into core
and render-engine" and the v0.8.0 dispose fixes (#5328 "sheets-ui:
dispose univer error") together suggest the underlying lifecycle is
calmer. **But** that needs sandbox verification — keep the deferred-
dispose code path as a guard rail through the upgrade, drop it only
after a confirmed clean run on the target version.

## Section 4 — Three blockers, after the upgrade

| Issue | After upgrading to Univer 0.24 OSS | After upgrading + Univer Pro |
| ----- | ---------------------------------- | ---------------------------- |
| **#193 dark theme** | **Fully fixed**. `core.darkMode` config + engine-render dark mode handles row/col headers, gridlines, cells. The 0.5.x `customizeColumnHeader` infeasibility is moot — we don't need it anymore. | Same. |
| **high-image-live** | **Fully fixed**. `@univerjs/sheets-drawing` + `@univerjs/sheets-drawing-ui` (Apache-2.0, on npm) render images on-canvas with anchors. The current `ImagePreviewPanel` sidebar can be retired. Round-trip already preserved (E1, `_preservedParts`). | Same. |
| **high-chart-live** | **Still blocked** on OSS. `@univerjs/sheets-chart` is not on npm; the actual chart runtime is `@univerjs-pro/sheets-chart` which depends on `@univerjs-pro/license` (commercial). Sidebar `ChartPreviewPanel` remains the shipping answer. | **Fully fixed**. Pro chart plugin renders in-grid. But adds commercial license + server dependency considerations that conflict with the project's serverless / local-first stance (see memory `feedback_serverless_preference.md`). |

Net: upgrading the OSS stack closes **2 of 3** blockers cleanly (#193,
high-image-live). high-chart-live remains a sidebar feature unless we
adopt Univer Pro.

## Section 5 — Effort estimate

### Breakdown

| Bucket | Hours | Notes |
| ------ | ----- | ----- |
| Bump package versions + side-effect facade imports (changes #1, #2) | 2–3 | Mechanical |
| Re-run typecheck against new types; fix `as unknown as` casts that drift | 4–8 | ~90 cast sites, most will type-check unchanged; the painful ones touch the boutique snapshot fields |
| Locale: switch to native `LocaleType.JA_JP`; delete the override workaround (#9) | 1–2 | Net deletion |
| Dark mode wiring (#6) — replace #193's grid-canvas dark-theme effort | 2–4 | Read `ThemeService` docs, wire Coco's existing theme toggle |
| Context-menu re-port (#11) — `IMenuService` / `MenuPosition` API shifts | 4–8 | One file (`univerContextMenu.ts`, ~250 lines) |
| Event-handler refactor (#13) — `addEvent(Event.CellClicked, …)` pattern | 2–4 | ~5 handlers |
| FR-011 undo-redo override re-verify against history refactor (#10) | 4 | Verify the override still applies; tests already exist (`univerUndoRedoOverride.test.ts`) |
| StrictMode deferred-dispose: verify whether still needed, possibly delete | 2 | Behavioral test in dev mode |
| Re-build all 11 boot-time patch functions against new snapshot lifecycle | 6–12 | Most patches operate on raw snapshot JSON — should be unaffected; one or two may catch on style-id interning changes (#16) |
| Adopt `@univerjs/sheets-drawing` + `-ui` for in-grid images (high-image-live) | 8–16 | New plugin registration + delete `ImagePreviewPanel`; round-trip stays via existing `_preservedParts` |
| Verify on 10-fixture xlsx round-trip suite (`xlsx_p0_compat.rs`) | 2 | CI-driven |
| Fix what verification turns up | 8–24 | Honest contingency for one regression per blue-moon plugin (slicer, pivot, named-style) |
| **Subtotal** | **~45–87 hrs** | One sprint to two sprints |

That's an **L–XL** for the OSS-only upgrade (which closes #193 and high-
image-live). Add **+24 hrs** for an in-grid chart rewrite if we adopt
Univer Pro.

### Risk callouts

- **StrictMode×Univer race (`39139c5`)** — likely fixed upstream by 0.8;
  needs verification on the target version. Keep the deferred-dispose
  guard until proven unnecessary, then delete.
- **Imperative facade calls (`applyHyperlink` at `EditorScreen.tsx:1396`,
  the imperative `setFontColor` / `setFontLine` / `setValue` chain)** —
  these go through the facade and will need their import paths updated
  (#2), but the call shape itself is stable across 0.6+.
- **`as unknown as ...` blast radius** — `EditorScreen.tsx` alone has ~90
  casts that prove the team has been routing around Univer's public
  types. Most are `.save() as unknown as { ... }` shape assertions and
  should be unaffected by Univer upgrades (we own the snapshot shape via
  `xlsx_io.rs`). The risky ones are the `(range as unknown as { getWidth?
  })` defensive shims — those exist because the facade's range type
  doesn't expose all the methods Coco needs; if 0.6+ exposed them
  properly, the casts could be deleted.
- **TailwindCSS refactor (0.7.0)** — Coco's `EditorScreen.css` includes
  `.univer-formula-box` (`:313`). If that class no longer exists or
  changed shape, layout regressions until we update the selector to
  `[data-u-comp="…"]`.
- **No published migration guide page** — the `docs.univer.ai/.../
  migration` URL is 404. We'll work from per-release notes, which is
  fine but means more triage time when a behavioral diff surfaces in
  testing.

## Section 6 — Recommendation

**Migrate to Univer 0.24.x (OSS) now. Stage it.**

The original "0.5.x vs 0.6" framing understates the gap by ~18 minor
versions. We are already on a deprecated package (`@univerjs/facade`)
that was removed in Feb 2025; every boot-time deprecation warning is a
reminder we're on borrowed time. Upgrading closes **#193 outright** (via
v0.8 dark mode) and **high-image-live outright** (via Apache-2.0
`@univerjs/sheets-drawing`), which together unblock the two highest-
leverage Coco items on the queue. high-chart-live remains sidebar-only
in OSS — that's an acceptable steady state per existing project policy
(`feedback_serverless_preference.md`); adopting Univer Pro for charts
would conflict with the local-first / no-vendor-license stance.

Effort is **L (≈45 hrs) to XL (≈87 hrs)** with no High-impact breaking
changes. Stage it as: (1) bump to 0.6.x and validate the facade rename,
(2) jump to the latest 0.10+ for dark mode and ja-JP locale, (3) add
sheets-drawing for in-grid images, (4) delete the `customizeColumnHeader`
investigation in #193 as obsolete.

Open questions that need a sandbox to settle (not in scope of this doc):

- Is the deferred-dispose `univerStashRef` workaround still needed on
  0.24? Verify by reverting it on a 0.24 sandbox and running the dev
  build under StrictMode.
- Does Coco's snapshot-patch pipeline (the 11 `patchX` functions) still
  produce a renderable workbook on 0.24's stricter style-id interning?
  The `xlsx_p0_compat.rs` 10-fixture suite is the canary.
- Does `IMenuService` / `MenuPosition` / `RibbonStartGroup` survive the
  0.16.1 context-menu refactor unchanged, or does `univerContextMenu.ts`
  need a port?
