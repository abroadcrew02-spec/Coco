# #241 CF live re-paint 再設計 — MVP 設計

Status: **Step 1 shipped** — CfSidecar pure store + 27 unit tests (PR #262).
Remaining steps deferred (L, 残り 3-4週).

## Progress

| Step | Status | Notes |
| --- | --- | --- |
| 1. CfSidecar 実装 (trackWrite / getBaseStyle / clearRule + composeStyle) | ✅ shipped | `src/store/cfSidecar.ts` |
| 2. computeCfRepaint 改造 — sidecar の baseStyle を BASE として使用 | ⏳ next | 現状 `conditionalFormatRender.ts:1276` を改造 |
| 3. range batching — per-cell facade call を矩形単位 setRangeValues に | ⏳ | — |
| 4. iconSet glyph — DOM overlay (cellData は touch しない) | ⏳ | data-corruption bug の根本対策 |
| 5. dataBar overlay — 背景色グラデーション DOM | ⏳ | — |
| 6. live-loop integration test (5 round-trip stability) | ⏳ | — |
| 7. CF dialog 連動 (add/edit/remove → sidecar update) | ⏳ | — |

## 背景: 過去2回の失敗

### PR #211 (REVERTED in v0.4.4)

CF ライブ再描画を試みた最初の attempt。下記2つの **show-stopper** バグで revert。

1. **iconSet データ破壊**:
   `range.setValue("↑ 42")` を呼ぶと glyph + 値が cellData.v に書き込まれる。300ms `syncSnapshot` debounce が走り、その内容を canonical snapshot に永続化。結果、**数値セルが文字列セルに変わる**。
   - `=A1+1` が `#VALUE!`
   - xlsx export 時 glyph + 値が baked
   - 再 open 時 `↑ ↑ 42` のように二重 prefix

2. **CF 除去が stuck**:
   最初の facade 書き込みが `cellData.s.bg` を汚染。CF 除去時の `computeCfRepaint` が BASE / PREV / AFTER 全て同色と判定 → diff が no-op → 色が残る。

### 根本原因

**Facade writes が canonical snapshot を汚染する**。次の `computeCfRepaint` が汚れた BASE を見て誤った判断をする。

## 再設計の方針

### 1. Sidecar map で BASE を分離

CF imperative writes を独立した sidecar map で track。Snapshot は **ユーザー authored state** のみ持つ。

```ts
// 新規 store/cfSidecar.ts
type CellKey = `${string}:${number}:${number}`; // sheetId:row:col

interface CfSidecarEntry {
  /** ユーザー authored の元 style (CF が触れる前). */
  baseStyle: Record<string, unknown>;
  /** 現在 CF が適用している style (最後の facade 書き込み). */
  cfStyle: Record<string, unknown>;
  /** どの CF rule に由来するか. */
  ruleIds: string[];
}

class CfSidecar {
  private map = new Map<CellKey, CfSidecarEntry>();
  trackWrite(cellKey: CellKey, baseStyle, cfStyle, ruleId): void;
  getBaseStyle(cellKey: CellKey): Record<string, unknown> | null;
  clearRule(ruleId: string): CellKey[];  // 影響セル一覧を返す
}
```

`computeCfRepaint` は **sidecar の baseStyle** を BASE として使い、現在の snapshot.cellData.s ではなく汚染前の state を見る。

### 2. iconSet decoration channel の分離

`range.setValue` で glyph を書くと cellData.v が壊れる。代替案:

**Option A: Per-cell DOM overlay**
- Univer の grid 上に絶対座標で `<span>` を被せる
- glyph + value だが cellData は touch しない
- 利点: cellData 完全 untouched
- 欠点: スクロール追従 / フォーカス管理が面倒

**Option B: cell.p (rich-text run) で書く**
- `cell.p` は rich-text 配列で、`cell.v` とは別チャネル
- glyph を rich-text run として書けば、cellData.v は触らない
- 利点: Univer の rendering pipeline で動く
- 欠点: cell.p をユーザーが他の用途で使っている場合 conflict

MVP は **Option A** を採用 (シンプル + 副作用ゼロ)。

### 3. Range batching

`patchCfRenders` は per-cell facade call。全列 sqref に対して呼ぶと `commandService` が大量の mutation を発行。

→ 矩形 range の **単一 `setRangeValues` call** にまとめる。`Univer.FUniver.getRange(rangeRef).setBackground(...)` を矩形単位で1回。

### 4. Live-loop integration test

過去の reverted PR は **facade → syncSnapshot → 次の computeCfRepaint の往復**をテストしていなかった。これを追加:

```ts
// __tests__/cfLiveLoop.test.ts
it("does not destabilise after 5 round-trips of facade + syncSnapshot", () => {
  // 1. snapshot v0 (元データ)
  // 2. applyCf → facade write
  // 3. syncSnapshot (workbook.save() → store)
  // 4. computeCfRepaint with sidecar BASE → should be no-op
  // 5. 2-4 を 5 回繰り返し
  // 6. 最終 snapshot がユーザー authored state と同等であることを assert
});
```

## アーキテクチャ

```
ユーザーが CF rule 追加/編集/削除
      │
      ▼
src/store/cfLiveLoop.ts (新規)
  ├ computeCfDelta(prevRules, nextRules, snapshot) → CellKey[]
  ├ applyCfBatch(delta, cfSidecar, fSheet)
  └ removeCfFromCells(cellKeys, cfSidecar, fSheet)
      │
      ▼
syncSnapshot は touch されない (sidecar が汚染を吸収)
      │
      ▼
xlsx export 時に sidecar から CF style を逆引きせず、_cfRules を見て再生成
```

## MVP スコープ

- [ ] **CfSidecar 実装**: trackWrite / getBaseStyle / clearRule
- [ ] **computeCfRepaint 改造**: sidecar BASE 使用
- [ ] **range batching**: per-cell → 矩形単位
- [ ] **iconSet glyph overlay**: DOM 絶対座標で被せる (cellData は touch しない)
- [ ] **dataBar overlay**: 同様に DOM (背景色グラデーション)
- [ ] **live-loop integration test**: 5 round-trip stability
- [ ] **CF 編集 dialog 連動**: rule add/edit/remove で sidecar 更新

## 非スコープ (follow-up)

- カラースケール / iconSet の **画像エクスポート** (現状は xlsx export 経由で Excel 側でレンダリング)
- カスタム CF formula (`=AND(...)` 等の expression-driven CF) — MVP は cellIs / containsText / top10 などの組み込み型のみ
- フォーマット painter (CF を別 range にコピー)

## 推定工数

- CfSidecar 実装 + tests: ~16 hrs
- computeCfRepaint 改造 + sidecar 統合: ~16 hrs
- DOM overlay (iconSet + dataBar): ~24 hrs
- Range batching: ~8 hrs
- Live-loop integration test: ~8 hrs
- 既存 CF rules との regression 検証: ~16 hrs
- バグ修正 (revert で見えた問題の再発防止): ~16 hrs
- **計**: 100-120 hrs → **L (4-6週)** MVP

## 関連

- 過去の revert: PR #211 (v0.4.4 hot-fix)
- 既存 helper: `src/components/conditionalFormatRender.ts:computeCfRepaint` (一部は revert で残った)
- TODOS.md `high-cf-live-render` (このイシューが置き換える)
