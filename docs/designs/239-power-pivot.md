# #239 Power Pivot / Data Model — MVP 設計

Status: **Step 1 shipped** — DAX engine foundation (9 functions) + 33 tests (PR #265).
Remaining steps deferred (XL, 残り 5-7週 MVP).

## Progress

| Step | Status | Notes |
| --- | --- | --- |
| 1. DAX engine: parser + evaluator (SUM/AVG/MIN/MAX/COUNT/COUNTROWS/DISTINCTCOUNT/IF/ALL) | ✅ shipped | PR #265, `src/store/daxEngine.ts` |
| 2. RELATED + SUMX/AVERAGEX/MINX/MAXX/COUNTX (row context + M:1 lookup) | ✅ shipped | PR #266 — 6 関数追加 |
| 3. FILTER / CALCULATE — filter context propagation | ⏳ next | |
| 4. xlsx round-trip: `xl/model/item.data` 経路の preserve (Coco は触らない) | ⏳ | |
| 5. `_cocoDataModel` 保存 + Coco-native measure 定義 | ⏳ | |
| 6. DataModelDialog UI (テーブル一覧 + measure 編集) | ⏳ | |
| 7. Pivot 統合 (PR #237 と連動) | ⏳ | |

## ゴール (再掲)

Excel の Data Model + DAX エンジン MVP。フル実装は数ヶ月かかるため、**読み取り round-trip + 限定的な DAX 関数実行**から始める。

## アーキテクチャ

```
xlsx import → parse xl/model/item.data → ModelDefinition
                                            │
                                            ▼
                              src/store/dataModel.ts (新規)
                                ├ Tables[]
                                ├ Relationships[]
                                ├ Measures[]            (DAX expression)
                                └ CalculatedColumns[]   (DAX expression)
                                            │
                                            ▼
                              DAX evaluator (新規, 限定実装)
                                ├ SUM/AVG/COUNTROWS の純粋関数
                                ├ FILTER / CALCULATE (簡易フィルタのみ)
                                └ RELATED (joined 列を1行で取得)
                                            │
                                            ▼
                              Pivot 表に measure として参照可能
```

### 型

```ts
interface ModelTable {
  id: string;
  name: string;
  // 列定義 (型情報込み: number/string/boolean/date)
  columns: Array<{ name: string; type: "number" | "string" | "boolean" | "date" }>;
  // 行データ (in-memory). 大規模ワークブックでは parquet 圧縮を検討 (follow-up)。
  rows: Array<Record<string, unknown>>;
}

interface ModelRelationship {
  id: string;
  fromTable: string;  // many side
  fromColumn: string;
  toTable: string;    // one side
  toColumn: string;
  active: boolean;
  cardinality: "manyToOne" | "oneToMany" | "oneToOne";
}

interface ModelMeasure {
  id: string;
  name: string;
  tableId: string;    // 所属テーブル
  expression: string; // DAX 文字列
  format?: string;
}

interface DataModel {
  tables: ModelTable[];
  relationships: ModelRelationship[];
  measures: ModelMeasure[];
  calculatedColumns: Array<ModelMeasure & { columnName: string }>;
}
```

### サポートする DAX 関数 (MVP)

| 関数 | 振る舞い | 実装メモ |
|---|---|---|
| `SUM(table[column])` | 列の合計 | rows を walk |
| `AVERAGE(table[column])` | 列の平均 | |
| `COUNTROWS(table)` | 行数 | rows.length |
| `COUNT(table[column])` | 非空セル数 | |
| `DISTINCTCOUNT(table[column])` | ユニーク値数 | Set |
| `MIN(table[column])` | 最小値 | |
| `MAX(table[column])` | 最大値 | |
| `RELATED(table[column])` | リレーション経由で値取得 | relationships を辿って lookup |
| `FILTER(table, condition)` | 条件にマッチする行を返す | condition は単純な比較式のみ |
| `CALCULATE(expr, filter)` | filter context を変更して expr 評価 | filter は単純な FILTER 結果のみ |
| `SUMX(table, expr)` | 各行で expr 評価して合計 | |
| `AVERAGEX(table, expr)` | 各行で expr 評価して平均 | |
| `ALL(table)` | 全行 (フィルタ無視) | |
| `IF(cond, then, else)` | 既存 Excel IF |

### DAX 評価器

- 単純な expression parser (recursive descent, ~500 行)
- AST: `BinaryOp` / `Func` / `ColumnRef` / `TableRef` / `Literal`
- 評価コンテキスト: `{ table: ModelTable, currentRowIndex?: number, filterMask?: boolean[] }`
- 最適化: なし (MVP は naive 実装、行数 10万まで)

### 保存

- 読み取り: xlsx import 時に `xl/model/item.data` (Microsoft 独自 binary format) は **読み取れない** (XML 形式ではない)。
- 書き出し: 既存 `_preservedParts` の `xl/model/*` を byte-for-byte round-trip。Coco は **触らない**。
- Coco 独自の measure 定義は `_cocoDataModel` (新規 root key) + `COCO_ROOT_EXTENSION_KEYS` で保持。
- xlsx export: `cocoExtensions/dataModel.json` パートに書き込み。

### UI

- **DataModelDialog**: テーブル一覧 + リレーションシップ表示 (グラフレイアウト)
- **MeasureEditor**: DAX 式エディタ + プレビュー結果
- **CalculatedColumnEditor**: 同上
- **DAXAutocomplete**: 関数 + テーブル名 + 列名

### Pivot 統合 (#236 連動)

- PivotEditor の "値" ゾーンに measure をドラッグできる
- `buildPivotMatrix(rows, def, { measures })` を拡張

## MVP スコープ

- [ ] **xlsx round-trip**: 既存 `_preservedParts` で Excel data model を破壊しない (検証 only)
- [ ] **Coco-side data model**: テーブル定義 + リレーションシップ + measure
- [ ] **DAX evaluator**: 上記 14 関数の限定実装
- [ ] **DataModelDialog**: テーブル一覧 + measure 編集
- [ ] **Pivot 統合**: PivotEditor で measure を value として使える
- [ ] **保存**: `_cocoDataModel` + cocoExtensions
- [ ] **テスト**: 各 DAX 関数 1-2 ケース + 統合テスト

## 非スコープ (follow-up)

- フル DAX (200+ 関数)
- Time Intelligence (TOTALYTD, SAMEPERIODLASTYEAR 等)
- VertiPaq エンジン (column-oriented compressed storage)
- KPI 定義
- Excel Data Model の binary format をネイティブに書き込む

## 推定工数

- DataModel 型 + parser: ~16 hrs
- DAX evaluator (14 関数): ~40 hrs
- DataModelDialog UI: ~24 hrs
- MeasureEditor + autocomplete: ~16 hrs
- Pivot 統合 (#236 への hook): ~16 hrs
- 保存 / xlsx round-trip: ~16 hrs
- テスト + バグ修正: ~32 hrs
- **計**: 160-180 hrs → **XL (6-8週)** MVP

## 関連 / 依存

- **依存**: #236 (Pivot live editing) が連動
- 既存: `_preservedParts` の `xl/model/*` round-trip
- メモリ `feedback_serverless_preference` — ローカル実装で対応 (server なし)
