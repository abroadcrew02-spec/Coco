# #238 Power Query 風 Get & Transform — MVP 設計

Status: **Step 1 shipped** — pure pipeline engine (6 transforms) + 31 tests (PR #264).
Remaining steps deferred (XL, 残り 3-5週).

## Progress

| Step | Status | Notes |
| --- | --- | --- |
| 1. Pipeline engine (selectColumns / dropColumns / filterRows / sort / rename / groupBy) | ✅ shipped | `src/store/getAndTransform.ts` |
| 2. JSON / JSONL ソース → rows[] | ✅ shipped (PR #247) | 既存 `jsonImport.ts` |
| 3. CSV ソース → rows[] | ✅ shipped | 既存 `workbook_import_csv` (Rust) |
| 4. SQLite ソース → rows[] | ✅ 既存 shipped | `data_connection_load_sqlite` (Rust + `rusqlite`) |
| 4b. xlsx round-trip: queryTables byte-preserve | ✅ shipped | PR #270 — PRESERVED_PREFIXES に追加 |
| 5. `_cocoQueries` 保存 + CRUD helpers | ✅ shipped | PR #272 — pure helpers + 24 tests |
| 5. GetAndTransformDialog UI (ソース選択 + ステップ追加 + プレビュー) | ⏳ | |
| 6. `_cocoQueries` 保存 + COCO_ROOT_EXTENSION_KEYS | ⏳ | |
| 7. xlsx round-trip via cocoExtensions/queries.json | ⏳ | |
| 8. Refresh query (既存 query を再実行) | ⏳ | |

## ゴール (再掲)

Excel の Power Query に相当する **データ取得 + 変換パイプライン**。フル M 言語パーサは扱わないが、ローカル CSV / JSON / SQLite から取り込み、選択列・フィルタ・並べ替え・グループ集計を行ったうえで grid に展開できる UI を提供する。

## アーキテクチャ

### コンポーネント図

```
┌──────────────────────────────────────────────────┐
│  GetAndTransformDialog (新規)                    │
│   ├ ソースペイン (csv/json/sqlite ファイル選択)   │
│   ├ プレビューペイン (上位 100 行サンプル表示)    │
│   ├ ステップリスト (縦に積み重ね)                 │
│   └ "シートに展開" ボタン                         │
└────────────┬─────────────────────────────────────┘
             │
       ┌─────▼───────────────┐
       │ src/store/getAndTransform.ts │  純粋ロジック
       │ ├ DataSource (型 union)      │
       │ ├ TransformStep (型 union)   │
       │ ├ runPipeline(rows, steps)   │
       │ └ stepDescription(step) → JA │
       └──────────────────────────────┘
                  │
        ┌─────────▼──────────┐
        │ Rust 側コマンド    │
        │ workbook_query_sqlite (新規) │
        │ (csv/json は既存路を再利用)   │
        └──────────────────────────────┘
```

### 型 (TypeScript)

```ts
// データソース
type DataSource =
  | { kind: "csv"; path: string; encoding?: "auto" | "utf8" | "sjis" }
  | { kind: "json"; path: string }
  | { kind: "jsonl"; path: string }
  | { kind: "sqlite"; path: string; query: string };

// 変換ステップ (MVP は 6 種)
type TransformStep =
  | { kind: "selectColumns"; columns: string[] }
  | { kind: "dropColumns"; columns: string[] }
  | { kind: "filterRows"; column: string; op: ">" | "<" | "==" | "!=" | "contains" | "startsWith" | "endsWith" | "regex"; value: string }
  | { kind: "sort"; column: string; descending: boolean }
  | { kind: "rename"; from: string; to: string }
  | { kind: "groupBy"; key: string; agg: Array<{ column: string; fn: "sum" | "avg" | "min" | "max" | "count" | "first" }> };

// クエリ全体
interface SavedQuery {
  id: string;
  name: string;
  source: DataSource;
  steps: TransformStep[];
  createdAt: string;
  outputSheet: string;  // 展開先シート名
}
```

### 保存

- `IWorkbookData.resources` に **新規 plugin name `COCO_QUERIES`** で `SavedQuery[]` を JSON-stringify して書き込む。
- 既存の `_preservedParts` には触らない (Excel と完全に independent)。
- xlsx export 時には Coco 独自の `cocoExtensions/queries.json` パートにフォールバック (xlsx_io.rs の既存 cocoExtensions 拡張機構を流用)。

### 実行フロー

1. ユーザー source を選ぶ → Rust 側 (csv/json/sqlite) で生 rows を取得。
2. ステップを順に適用 → 結果 rows + 変換後 columns。
3. プレビュー: 上位 100 行を grid に表示。
4. OK → `buildSnapshotFromTransform(result)` で新シートに展開。`applyMutatedSnapshot` で Coco-undo フックされる。
5. 再実行: クエリ ID から SavedQuery を取り、 同じ source を再 fetch、steps を再適用。

## MVP スコープ

- [ ] **データソース** (4): csv, json, jsonl, sqlite (`SELECT` のみ)
- [ ] **変換** (6): selectColumns / dropColumns / filterRows / sort / rename / groupBy
- [ ] **UI**: 単一ダイアログ。ステップは追加/削除/順序入れ替え。プレビュー 100 行。
- [ ] **保存**: `COCO_QUERIES` resource エントリ。Coco↔Coco round-trip。
- [ ] **再実行**: 既存クエリを開いて再展開 (「データ → クエリの更新」)
- [ ] **テスト**: 6 ステップ各2-3 ケース。pipelineの順序付き合成テスト1つ。Rust 側 SQLite 経路の integration test 1つ。

## 非スコープ (follow-up)

- M 言語ファイル parse/serialize (Excel の `connections.xml`) — Coco 独自フォーマットで十分
- Web API / OData / Active Directory data sources — local-first 方針に反する
- カスタム関数 / pivot 結合 / merge query
- Refresh-on-open (起動時の自動再取得)

## 推定工数

- Rust (SQLite query command + 軽い JSON streaming): ~16 hrs
- Frontend (Dialog + pipeline engine + tests): ~24 hrs
- xlsx round-trip wiring (cocoExtensions): ~8 hrs
- リサーチ + 統合 + バグ修正: ~16 hrs
- **計**: 60-70 hrs → **L (2-3週)** MVP

## 関連

- 既存 csv import (`workbook_import_csv`) — Rust 側のテンプレート流用
- 既存 JSON import (#248, このバッチ PR で shipped) — JS 側のパーサ流用
- `rusqlite` (Cargo.toml に既存) — SQLite 接続済み
- メモリ `feedback_serverless_preference` — ローカルファースト方針と整合
