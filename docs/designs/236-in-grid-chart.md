# #236 In-grid Chart 自前描画 — MVP 設計

Status: **Step 1 shipped** — cellPixelBounds pixel-bounds helper + 17 tests (PR #263).
Remaining steps deferred (L-XL, 残り 7-11週).

## Progress

| Step | Status | Notes |
| --- | --- | --- |
| 1. cellPixelBounds: range → 絶対 px (col widths / row heights from snapshot) | ✅ shipped | PR #263 — `src/store/cellPixelBounds.ts` |
| 2. inGridChart anchor + box resolution (move/resize/bake helpers) | ✅ shipped | PR #273 — `src/store/inGridChart.ts` |
| 3. CanvasChartOverlay component (absolute positioned canvas) | ⏳ next | DOM zindex + scroll 連動が課題 |
| 3. Chart drawing engine (8 chart types: bar/line/pie/area/...) | ⏳ | 既存 ChartPreviewPanel SVG renderer を流用 |
| 4. ドラッグ/リサイズ ハンドル | ⏳ | mousedown 連携 |
| 5. Source range → 自動再描画 (300ms debounce) | ⏳ | CommandExecuted フック |
| 6. `_cocoCharts` 保存 + COCO_ROOT_EXTENSION_KEYS 追加 | ⏳ | |
| 7. xlsx round-trip via cocoExtensions/charts.json | ⏳ | |

## ゴール (再掲)

`@univerjs/sheets-chart` (Univer Pro) は有償+サーバ依存で採用不可。
現状は `ChartPreviewPanel` (サイドバー) で代替。**グリッド内に直接 canvas overlay でチャートを重ねる**自前実装を作る。

## アーキテクチャ

```
EditorScreen
  └ Univer グリッド
      └ <CanvasChartOverlay> (新規)
          ├ Canvas (DOM 上の絶対座標)
          └ 1つ以上の ChartInstance を描画
              ├ 元 range → 数値抽出
              ├ ChartType に応じた描画 (bar/line/pie/scatter/...)
              └ ドラッグハンドル + リサイズハンドル
```

### Canvas overlay の配置

- Univer のグリッド DOM に `position: absolute` で `<canvas>` を被せる。
- スクロール位置に追従させるため、Univer の `ScrollManagerService` (もしくは pixel coord facade) を購読。
- グリッドの z-index は調整不要 — overlay は別 stacking context にする。

### 型

```ts
type ChartType = "bar" | "stackedBar" | "line" | "stackedLine" | "pie" | "scatter" | "area" | "doughnut";

interface ChartDefinition {
  id: string;
  sourceSheetId: string;
  sourceRange: string;        // 例: "A1:C10"
  type: ChartType;
  title?: string;
  anchor: { sheetId: string; col: number; row: number };
  width: number;              // px
  height: number;             // px
  legend?: "right" | "bottom" | "none";
  // Coco 独自フィールド (Excel chart blob とは独立)
  options?: { xAxisTitle?: string; yAxisTitle?: string; colors?: string[] };
}
```

### 既存 `_charts` との関係

- 既存 `_charts` (chart blob) は **xlsx round-trip 用**にそのまま残す。
- 自前 chart は **新規 `_cocoCharts`** root key (新規) に格納。
- レンダリング側は `_cocoCharts` を優先、無ければ `_charts` の blob を旧 ChartPreviewPanel で表示。
- xlsx export: `_cocoCharts` は `cocoExtensions/charts.json` に書き込み。**既存 `_charts` blob には触らない** ので Excel 互換は維持。

### 描画エンジン

- 純粋 Canvas 2D API。外部ライブラリ (Chart.js / Plotly / D3) は **使わない**:
  - パッケージサイズが膨らむ (~200 KB → ~1 MB)
  - Tauri bundling の負担
  - 自前 ~1500 行で 8 種類のチャートは書ける
- ハンドル DOM (リサイズ・ドラッグ) はキャンバスとは別の `<div>`。

### Drag & Resize

- mousedown on chart → ChartInstance.startDrag
- mousemove → ChartInstance.endX/Y 更新 → re-render
- mouseup → applyMutatedSnapshot で `_cocoCharts` 更新

### Source 変更時の再描画

- syncSnapshot にフックし、`_cocoCharts[i].sourceRange` のセルが変わったら該当チャートを redraw (debounce 100ms)。
- セル変更検知は Univer の `CommandExecuted` イベントを Coco 側で diff 計算。

## MVP スコープ

- [ ] **チャート種別**: bar / line / pie / scatter / stacked-bar / stacked-line / area / doughnut (8種)
- [ ] **挿入**: Ribbon「グラフ → グリッド内に挿入」→ ダイアログで range/type 入力 → canvas に描画
- [ ] **配置**: anchor cell から `width × height` px。ドラッグで移動、ハンドルでリサイズ
- [ ] **データ範囲変更**: 既存チャートの "Source range" を editorial 入力で更新
- [ ] **データ更新時の再描画**: 元データ変更で debounce 再描画
- [ ] **保存**: `_cocoCharts` + COCO_ROOT_EXTENSION_KEYS
- [ ] **xlsx round-trip**: cocoExtensions/charts.json

## 非スコープ (follow-up)

- Combo chart, treemap, waterfall, funnel
- 3D charts
- Trendline 数式 / Error bars
- Excel-format chart blob 出力 (Excel 互換は既存 `_charts` blob で維持)
- ピボットチャート連動 (#236 + #238 完了後)

## 推定工数

- Canvas 描画エンジン (8 chart types): ~40 hrs
- Overlay + 配置/ドラッグ: ~24 hrs
- 挿入 dialog + UI: ~12 hrs
- Source-change → redraw 経路: ~16 hrs
- xlsx round-trip + 統合: ~16 hrs
- テスト + バグ修正: ~24 hrs
- **計**: 130-150 hrs → **L-XL (8-12週)** MVP

## 関連

- 既存: ChartPreviewPanel (サイドバー、サイドフォールバック)
- 既存: `_charts` blob (Excel-format チャート blob)
- 既存: `_cameraLinks` の overlay 機構 (参考実装)
- 既存: `image_drawing_bridge` の `_preservedParts` 周辺 (参考)
