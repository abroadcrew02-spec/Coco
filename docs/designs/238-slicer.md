# #238 Slicer — MVP 設計

Status: **Design only**. Depends on #236 Pivot Table live editing.

## ゴール (再掲)

ピボットテーブル / テーブルの直感的フィルタ UI。チェックボックスリストでフィールド値を on/off すると、連動する pivot / table が即時フィルタされる。

## アーキテクチャ

```
SlicerInsertDialog
  ├ ソース選択: 既存 pivot or table を選ぶ
  └ フィールド選択: pivot/table のカラム1つを選ぶ
        │
        ▼
SlicerPanel (floating, chart panel と同じスタイル)
  ├ フィールド値の unique list を縦に表示
  └ 各値の左にチェックボックス (デフォルト全 checked)
        │
        ▼
変更時: ソース pivot/table に "filteredValues" hint を流す
        │
        ▼
ピボット再構築 / テーブル再フィルタ
```

### 型

```ts
interface SlicerDefinition {
  id: string;
  name: string;          // 「カテゴリ」など UI ラベル
  sourceKind: "pivot" | "table";
  sourceId: string;      // 連動 pivot / table の id
  fieldName: string;     // 連動カラム名
  anchor: { sheetId: string; col: number; row: number };
  width: number;
  height: number;
  // 選択中の値。空配列 = 全選択 (フィルタ無し)。
  selectedValues: string[];
}
```

### 保存

- `_cocoSlicers` root key (新規) に `SlicerDefinition[]`。
- `COCO_ROOT_EXTENSION_KEYS` に追加。
- xlsx export: `cocoExtensions/slicers.json`。**既存 `_preservedParts` の Excel slicer blob には触らない** (xlsx 再 open 時に Excel slicer がそのまま残る)。

### Pivot / Table との連携

- Slicer の `selectedValues` 変更時:
  - 連動 pivot/table に "filterHint" を渡す
  - `buildPivotMatrix(rows, def, { extraFilter: ... })` のように rows を絞る
- 複数 slicer が同じ pivot を見ている場合: **AND 結合**。各 slicer の selectedValues 全てに合致する行のみ残す。

### UI

- 既存 ChartCanvasPanel と同じ floating panel スタイル。
- チェックボックスリスト: 縦スクロール、検索バー (値が多い時)。
- 「すべて選択 / 解除」 / 「複数選択 (Ctrl+クリック)」 / 「フィルタを解除」ボタン。

## MVP スコープ

- [ ] **SlicerInsertDialog**: pivot/table と field を選ぶ
- [ ] **SlicerPanel**: 値リスト + チェック + 全選択ボタン
- [ ] **AND 結合**: 複数 slicer は AND
- [ ] **シート切替時**: アクティブシートにある slicer のみ表示
- [ ] **保存**: `_cocoSlicers` + COCO_ROOT_EXTENSION_KEYS
- [ ] **xlsx round-trip**: cocoExtensions/slicers.json
- [ ] **テスト**: フィルタ AND 結合, 全選択, 値検索

## 非スコープ (follow-up)

- "タイムライン" (日付スライサー、Excel 独自)
- スライサースタイル (色テーマ)
- ピボット連動以外 (Coco chart 連動など)
- Excel-format slicer blob 出力 (既存 `_preservedParts` で round-trip 維持)

## 推定工数

- SlicerPanel + UI: ~16 hrs
- Insert dialog: ~8 hrs
- Pivot/table 連動 (filter API): ~16 hrs
- AND 結合 + 値 unique 抽出: ~8 hrs
- 保存 / xlsx round-trip: ~8 hrs
- テスト + バグ修正: ~12 hrs
- **計**: 60-70 hrs → **L (3-4週)** MVP

## 関連 / 依存

- **依存**: #236 (Pivot live editing) が前提
- 既存: `_preservedParts` slicer blob (Excel slicer round-trip)
- 既存: ChartCanvasPanel のスタイル参考
