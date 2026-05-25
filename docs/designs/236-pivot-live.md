# #236 Pivot Table ライブ編集 — MVP 設計

Status: **Design only**. Implementation deferred (L, 4-8週).

## ゴール (再掲)

Coco は xlsx pivot を byte-perfect 保持しているが、**Coco UI から新規作成 / 編集する手段が無い**。Excel 並みのドラッグでフィールド配置できる UI を提供する。

## アーキテクチャ

```
PivotInsertDialog ─── 元 range 選択 + 新シート作成
        │
PivotEditorPanel (シート横の floating panel)
        │
        ├ FieldsList (元データの列一覧)
        ├ DropZone[] × 4 (行 / 列 / 値 / フィルター)
        └ AggFunctionPicker (sum/count/avg/min/max/...)
        │
        ▼
buildPivotMatrix(rows, def): Matrix
        │
        ▼
applyPivotToSheet(snapshot, sheetId, matrix)
        │
        ▼
applyMutatedSnapshot (Coco undo 入り)
```

### 型

```ts
type AggFn = "sum" | "count" | "average" | "min" | "max" | "countNumeric" | "stdev" | "var";

interface PivotField {
  source: string;  // 元データのカラム名
  alias?: string;
}

interface PivotValue extends PivotField {
  agg: AggFn;
  showAs?: "value" | "percentOfTotal" | "percentOfRow" | "percentOfColumn" | "runningTotal";
}

interface PivotDefinition {
  id: string;
  name: string;
  sourceRange: string;  // 例: "Sheet1!A1:D100"
  rows: PivotField[];
  columns: PivotField[];
  values: PivotValue[];
  filters: Array<PivotField & { selected?: string[] }>;
  showRowTotal: boolean;
  showColumnTotal: boolean;
  showGrandTotal: boolean;
  layout: "compact" | "outline" | "tabular";
}
```

### 保存

- `_cocoPivots` という workbook-root 拡張キー (新規) に `PivotDefinition[]` を格納。
- `COCO_ROOT_EXTENSION_KEYS` に追加して syncSnapshot で再 graft。
- xlsx export: 既存 `_preservedParts` の Excel pivot blob はそのまま (上書きしない)。Coco-pivot は `cocoExtensions/pivots.json` パートとして書き込み。
- xlsx 再 import: Coco-pivot が存在すればそれを使い、無ければ既存 `_preservedParts` の Excel pivot を保持。

### レンダリング

1. `PivotDefinition` を `buildPivotMatrix(sourceRows, def)` でセル行列に変換 (純粋関数)。
2. 出力シートの cellData に直接書き込み (ヘッダーセル + 集計セル + 小計セル + 総計セル)。
3. ピボット編集中はリアクティブに再構築 (300ms debounce)。
4. シート切替時はピボットがあるシートで PivotEditorPanel を自動表示。

### Drag & Drop

- `react-dnd` 等の外部依存は **避ける** (パッケージ追加最小化)。
- ネイティブ HTML5 drag API + zustand 状態管理で実装。
- 既存 ChartCanvasPanel と同じスタイル の floating panel。

## MVP スコープ

- [ ] **PivotInsertDialog**: 元 range 入力 → 新シート (`ピボット_1`) 作成
- [ ] **PivotEditorPanel**: 4ゾーンに DnD でフィールド配置
- [ ] **集計**: sum/count/average/min/max/countNumeric/stdev/var の8種
- [ ] **小計/総計**: 行ごと / 列ごと / 総計 のチェックボックス
- [ ] **showAs**: value / percentOfTotal / percentOfRow / percentOfColumn (基本4種)
- [ ] **保存**: `_cocoPivots` + COCO_ROOT_EXTENSION_KEYS
- [ ] **xlsx round-trip**: cocoExtensions/pivots.json
- [ ] **テスト**: buildPivotMatrix の入力 → 期待行列マッピング ~10 ケース

## 非スコープ (follow-up)

- スライサー (#238 で別 issue)
- Calculated field / calculated item
- データモデル / DAX (#240 で別 issue)
- ピボットチャート (#237 在グリッドチャート完了後)
- "Show in tabular form" / Outline form (compact のみ)

## 推定工数

- buildPivotMatrix 純粋関数: ~16 hrs
- PivotEditorPanel + DnD: ~24 hrs
- Insert dialog + integration: ~8 hrs
- xlsx round-trip wiring: ~8 hrs
- テスト + バグ修正: ~16 hrs
- **計**: 70-80 hrs → **L (3-4週)** MVP

## 関連

- 既存: `_preservedParts` Excel pivot blob round-trip
- 既存: `snapshotSync.COCO_ROOT_EXTENSION_KEYS` (拡張ポイント)
- 既存: ChartPreviewPanel (floating panel のスタイル参考)
