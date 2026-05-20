
# 要件定義書 — Coco（社内スプレッドシートツール）

**バージョン**: 1.1
**作成日**: 2026-05-12
**最終更新日**: 2026-05-15
**ステータス**: Phase 0 完了 / Phase 1 MVP (FR-001..FR-014, FR-101..FR-105, FR-201..FR-204, FR-301..FR-304) リリース済み (v0.1.0) / Phase 2 オーサリング UI プレビュー実装中

> **2026-05-15 revision (v1.1)**: 実装が v0.1.0 リリースに到達したのに伴い、本書を実装実態に合わせて更新した。主な変更点:
>
> - **AD-02 方針確定**: `.coco` はユーザー選択可能な保存形式として提供しない。xlsx が唯一のユーザー保存形式。SQLite は自動保存・クラッシュ復旧スナップショットおよび既存 `.coco` 互換読み込みのために内部的に残す（[CHANGELOG.md](./CHANGELOG.md) Unreleased を参照）。
> - **xlsx I/O 方式確定 (DG-01 / AD-05)**: Rust 実装で確定。インポートは `calamine` (Apache-2.0)、エクスポートは `rust_xlsxwriter` (MIT)。SheetJS / Univer Pro local server は採用しない。
> - **xlsx 互換性の大幅拡張**: §10 マトリクスを更新。条件付き書式（typed + raw 両方）、データ検証、名前付き範囲、ハイパーリンク、コメント、グラフ／ピボット／画像（blob 保持）、印刷設定、フリーズ／スプリットペイン、シートタブ色、オートフィルター、シート保護、リッチテキスト、外部リンクキャッシュを往復保持。
> - **Phase 2 オーサリング UI プレビュー**: §3.3 で「P1/P2」だった条件付き書式・グラフ・名前付き範囲・データバリデーション・ハイパーリンク・コメント・画像の編集 UI が v0.1.0 でプレビュー実装済み。§3.2 / §3.3 / §10 / §15.3 を更新。
> - **追加 UI**: コマンドパレット (Ctrl+Shift+P)、AutoSum (Alt+=)、Format Painter、最近使ったファイルのピン留め／ドラッグ並べ替え、HomeScreen ウェルカム／ヒント、スナップショット履歴ダイアログを追加。§4.6 ショートカット表を拡充。
> - **i18n**: ja-JP / en-US 二言語の最小バンドルを提供。OI-07 は「両対応・初期言語は OS ロケールから自動判定」で実装解決。
> - **ゲート進捗**: DG-01 / DG-05 合格、DG-02 / DG-03 / DG-04 は実装は先行したが正式判定未完。§0.2 / §17 にステータスを明記。

---

## 0. 本書の目的と開発着手条件

本書は、社内業務向けのローカルファースト表計算デスクトップアプリ「Coco」を開発するための要件、技術方針、受入基準、テスト方針を定義する。

### 0.1 開発着手可能な範囲

| 範囲                            | 状態     | 備考                                |
| ------------------------------- | -------- | ----------------------------------- |
| Phase 0: 技術検証・基盤実装     | 完了     | DG-01 / DG-05 合格。残る DG-02 / DG-03 / DG-04 は §0.2 参照 |
| MVP-1: ワークブック作成・編集・保存（xlsx 既定。`.coco` はユーザー選択肢から非露出） | 完了 (v0.1.0) | AD-02 確定により Save As の選択肢は xlsx のみ。SQLite は内部用途のみに残置 |
| MVP-2: xlsxインポート           | 完了 (v0.1.0) | calamine ベースで実装。FR-105 代表10ファイルスイート合格 |
| MVP-3: xlsxエクスポート         | 完了 (v0.1.0) | rust_xlsxwriter ベースで実装。CHANGELOG「xlsx round-trip」節参照 |
| Phase 2 オーサリング UI         | プレビュー実装中 | 条件付き書式 / グラフ / データ検証 / 名前付き範囲 / ハイパーリンク / コメント / 画像 / 数値書式 / 書式コピーを v0.1.0 でプレビュー出荷。CHANGELOG「xlsx authoring UI (Phase 2)」節参照 |

### 0.2 Phase 1開始ゲート

| ID    | ゲート               | 合格条件                                                                                                      | 担当                  | 状態 (2026-05-15) |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------- |
| DG-01 | xlsx I/O方式決定     | 完全オフライン環境で代表3ファイルのインポート/エクスポート/CSV 出力 PoC が成功し、方式（calamine + rust_xlsxwriter）・ライセンス（Apache-2.0/MIT）・制約が記録されている | 開発チーム / 法務     | ✅ 合格 (代表10ファイル互換性スイートで本実装も検証済み) |
| DG-02 | `.coco` スキーマ確定 | 本書8章のDDLをもとにマイグレーション方針、破損復旧方針、保存責務が確定している                                | 開発チーム            | ⚠️ 実装は完了しているが、マイグレーション方針・破損復旧方針の正式文書化が未完 (OI-01) |
| DG-03 | Univer利用範囲確定   | OSS/Pro機能の境界、商用利用条件、同梱ライセンス表記が確認済み                                                 | 開発チーム / 法務     | ⚠️ Univer 0.5.x OSS パッケージのみを採用済み（Pro 機能不使用）。法務レビューの正式承認は未完 (OI-02) |
| DG-04 | セキュリティ方針確定 | 暗号化・監査ログ・自動更新・クラッシュレポートのMVP要否が決定している                                         | PO / セキュリティ担当 | ❌ 未判定。MVP では非暗号化／監査ログなし／自動更新なしで出荷。判定は機密区分 A/B 確定時 (OI-04..06) |
| DG-05 | 保存/復旧UX確定      | 新規、xlsx由来、保存失敗、クラッシュ復元、マイグレーション失敗時の画面仕様が確定している                      | PO / UX / 開発チーム  | ✅ 合格 (HomeScreen 復元候補 + CompatibilityWarningsDialog + xlsm マクロ破棄ダイアログで実装) |

### 0.3 主要な技術決定

| ID    | 決定                                                                         | 根拠                                                                                    |
| ----- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AD-01 | Cocoの既定の作業ファイル形式は xlsx とする                                   | 弊社の業務フロー（xlsm→CSV）と整合するため。新拡張子の導入は移行摩擦になる              |
| AD-02 | `.coco`（SQLite）はユーザー選択可能な保存形式としては提供しない              | 2026-05-15 確定。当初は Save As の選択肢として残す方針だったが、xlsx 一本化のほうがユーザー認知負荷が低い。SQLite は自動保存・クラッシュ復旧スナップショット・既存 `.coco` の読み込み／上書きにのみ使用 |
| AD-02b| `.xlsm` を開いた場合は xlsx として扱う                                       | マクロ実行・保持はしない（5.3.2 と整合）。保存は xlsx 拡張子で行い、開封時にマクロ破棄をユーザーに通知 |
| AD-03 | Tauri v2 + RustをファイルI/O、SQLite、バックアップ、OS連携の責務にする       | 任意パスファイル、原子的保存、署名、OS権限を堅く扱うため                                |
| AD-04 | React + TypeScript + Univerを表示・編集・計算UIの責務にする                  | 表計算UIの自前実装を避け、MVPを短縮するため                                             |
| AD-05 | xlsx I/O は Rust 実装で完結させる（インポート: `calamine` / エクスポート: `rust_xlsxwriter`） | Phase 0 で確定。SheetJS CE / Univer Pro local server はオフライン同梱や互換範囲で要件を満たさないと判断。Rust 実装に統一することで Tauri 側と責務境界が明確化 |
| AD-06 | SheetJS CE は採用しない（破棄）                                              | Phase 0 PoC で calamine + rust_xlsxwriter のほうがスタイル・条件付き書式・グラフ blob・データ検証など Phase 2 機能の往復保持で優位と確認。AD-05 で代替 |
| AD-07 | Undo/Redo履歴はMVPでは永続化しない                                           | セッション内の操作履歴に限定し、ファイル破損・マイグレーション負荷を避ける              |
| AD-08 | 初期対応言語は ja-JP / en-US の両方                                          | 2026-05-15 確定。初期言語は OS ロケールから自動判定し、SettingsDialog で切替可能。Univer 配下の二次 UI には日本語固定が一部残るが、Phase 2 で順次多言語化 (OI-07 解決) |

### 0.4 一次情報メモ

- Univer import/exportはサーバーサービスを前提にした説明がある: <https://docs.univer.ai/guides/pro/import-export>
- Univer snapshot exportはローカルワークフロー向けの記述があるが、`@univerjs-pro/exchange-client` を含むPro系の確認が必要: <https://docs.univer.ai/guides/sheets/features/import-export>
- SheetJS CEはApache-2.0: <https://docs.sheetjs.com/docs/miscellany/license/>
- SheetJS CEのxlsx出力はデータ保存中心で、スタイル等はPro領域の記述がある: <https://docs.sheetjs.com/docs/api/write-options/>

---

## 1. 概要

### 1.1 目的

社内業務で使用するExcel / Google Sheetsライクなデスクトップアプリ「Coco」を開発し、外部サービスへの依存を排除しながら、オフライン環境でも安定した表計算業務を実現する。

### 1.2 背景

- 社内ではExcelまたはGoogle Sheetsによる業務が広く行われている。
- クラウド依存、ライセンスコスト、機密データの外部送信リスクが課題である。
- 機密データを含む業務において、ローカルファーストで動作する表計算ツールが必要である。
- 将来的には社内ネットワーク上でのリアルタイム共同編集も視野に入れる。

### 1.3 ライセンス方針

- Coco本体の予定ライセンス: Apache-2.0
- 同梱するOSS/商用ライブラリは、配布前に法務確認を完了する。
- Pro/商用ライブラリを採用する場合は、ライセンス費、配布条件、オフライン利用可否をDG-01/DG-03で明示する。

---

## 2. 対象ユーザー / ステークホルダー

| ロール           | 概要                                                             | 主な関心                                               |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| 業務担当者       | 非エンジニアを含む社内スタッフ。Excelに慣れている                | 既存xlsxを開ける、迷わず保存できる、オフラインで使える |
| 管理者           | アプリの配布、アップデート、端末展開を担当する情報システム担当者 | インストール容易性、署名、更新制御、監査               |
| PO               | 機能優先度、リリース可否、制約受容を判断する                     | MVP範囲、受入基準、未解決リスク                        |
| セキュリティ担当 | 機密データ、外部通信、インポート脅威、ログを確認する             | データ送信禁止、暗号化、監査ログ、脆弱性対策           |
| 開発チーム       | Cocoの設計、実装、保守を行う                                     | 技術境界、データ設計、テスト可能性、実装順序           |

---

## 3. スコープ

### 3.1 対象範囲

- Windows 10以降、Windows 11、macOS 12以降で動作するデスクトップアプリ
- Tauri v2、Rust、React、TypeScript、Univerを中心にした実装
- xlsx を唯一のユーザー保存形式として読み書きする
- SQLite を内部用途（新規ブックの自動保存・クラッシュ復旧スナップショット、および既存 `.coco` ファイルの読み込み／上書き）にのみ利用
- CSV エクスポート／インポートに対応
- xlsx / xlsm 読み込み（xlsm はマクロ破棄）と xlsx / CSV 書き出し
- 基本的な表計算操作、複数シート、セル書式、基本数式、検索/置換、Undo/Redo
- ja-JP / en-US 二言語の UI
- オフライン完全動作
- 署名済みWindows `.exe` インストーラー / macOS `.dmg` による社内配布（v0.1.0 では署名待ち、SHA-256 と manifest は付与済み）

### 3.2 MVP対象外

- リアルタイム共同編集
- クラウドストレージとの自動同期
- モバイル対応
- Webブラウザ版
- 既存Excel VBA / Google Apps Scriptの実行
- ピボットテーブルの**作成・編集**（既存 xlsx のピボット定義は blob として保持・往復）
- 配列数式・スピルの完全対応
- Coco独自スクリプト、マクロ記録・再生

### 3.3 P1/P2 機能の MVP での扱い

| 機能                 | v0.1.0 での実装                                                | 補足                    |
| -------------------- | -------------------------------------------------------------- | ----------------------- |
| 条件付き書式         | 往復保持＋オーサリング UI（プレビュー、Ctrl+F8）。cellIs / containsText / top10 / duplicate / unique は typed API＋in-grid 描画。colorScale / dataBar / iconSet は raw XML で blob 保持 | M1 で `<dxf>` 出力対応済み |
| グラフ               | 既存 xlsx のグラフ部品を byte-for-byte 保持。新規挿入ダイアログとサイドバーの `ChartPreviewPanel`（SVG プレビュー、bar/line/pie）あり | 編集 UI は Phase 2 で拡充 |
| 名前付き範囲         | 往復保持＋ CRUD ダイアログ（Ctrl+F3、workbook + sheet スコープ）   | -                       |
| データバリデーション | 往復保持＋オーサリング UI（list / range / date / whole / decimal）。`onBeforeCommandExecute` で live 入力ガード | -                       |
| ハイパーリンク       | 往復保持＋挿入ダイアログ（Ctrl+K）。外部 URL は `open_url` で scheme allowlist 経由、内部 `#Sheet!A1` は facade で遷移 | -                       |
| コメント             | 往復保持＋挿入／編集ダイアログ（Shift+F2）。in-grid 赤三角インジケータと hover ツールチップ | -                       |
| 画像                 | `xl/media/` 配下を保持＋挿入ダイアログ。`ImagePreviewPanel` でサムネイル一覧 | -                       |
| リッチテキスト       | per-run formatting で往復保持                                  | 編集 UI は Phase 2 で検討 |
| 外部リンク           | 自動アクセス禁止。値（キャッシュ値）保持と警告のみ              | Phase 2以降で方針再検討 |

---

## 4. MVP分割と機能要件

### 4.1 MVP-1: ワークブック作成・編集・保存（xlsx 専用）

| ID     | 要件                              | 優先度 | 受入基準                                                   |
| ------ | --------------------------------- | ------ | ---------------------------------------------------------- |
| FR-001 | 新規ワークブックを作成できる      | P0     | ホームから新規作成し、Sheet1の空グリッドが表示される       |
| FR-002 | セルに値を入力・編集・削除できる  | P0     | 文字列、数値、日付、空白を入力し、表示と保存復元が一致する |
| FR-003 | 基本数式を入力できる              | P0     | P0対象関数が計算され、式と計算結果が保存復元される         |
| FR-004 | 複数シートを操作できる            | P0     | 作成、削除、並べ替え、名称変更が保存復元される             |
| FR-005 | セル書式を設定できる              | P0     | P0対象書式が画面表示と保存復元で一致する                   |
| FR-006 | セル結合と行/列固定を操作できる   | P0     | 結合、解除、固定、解除が保存復元される                     |
| FR-007 | コピー/貼り付けができる           | P0     | 値貼り付け、書式貼り付け、値+書式貼り付けが動作する        |
| FR-008 | オートフィルができる              | P0     | 数値連番、日付連番、同値コピーが動作する                   |
| FR-009 | 並べ替え/フィルターができる       | P0     | 単一列、複数条件の基本操作が動作し、保存復元される         |
| FR-010 | 検索/置換ができる                 | P0     | セル値と数式文字列を対象に検索/置換できる                  |
| FR-011 | Undo/Redoができる                 | P0     | セッション中に直近100操作まで戻す/やり直すことができる (`CappedUndoRedoService` で実装) |
| FR-012 | xlsx として保存／読み込みできる   | P0     | Save / Save As ともダイアログのフィルタは xlsx のみ。手動保存、自動保存、再オープンで内容が一致する。既存 `.coco` の読み込み／上書きは互換のため動作するが、新規の Save As では選べない |
| FR-013 | 最近使ったファイルを表示できる    | P0     | 直近10件を表示し、存在しないファイルは「見つかりません」バッジ付きで一覧に残す。ピン留め (P キー) とドラッグ並べ替え対応 |
| FR-014 | `.xlsm` を開いた際にマクロ破棄を警告表示する | P0     | xlsm 拡張子のファイルを開いた直後、`XlsmMacroLossDialog` モーダルで「マクロは保持されません。保存すると .xlsx 形式になります」が表示される |

### 4.2 MVP-2: xlsxインポート

| ID     | 要件                                        | 優先度 | 受入基準                                                              |
| ------ | ------------------------------------------- | ------ | --------------------------------------------------------------------- |
| FR-101 | `.xlsx` を開ける                            | P0     | Excel 2016以降またはGoogle Sheets出力の代表ファイルを開ける           |
| FR-102 | `.xlsx` を作業ブックとして読み込む          | P0     | 元xlsxパスを保持して開き、Ctrl+S で同じ xlsx に上書き保存する（書込前に .bak をローテーション） |
| FR-103 | インポート警告を表示する                    | P0     | 非対応要素、外部リンク、マクロ、破棄予定要素が一覧表示される          |
| FR-104 | 悪意ある/巨大xlsxを拒否する                 | P0     | 5.3の上限を超えるファイルを読み込まず、理由を表示する                 |
| FR-105 | 代表10ファイルのP0要素を取り込める          | P0     | 値、式、計算結果、主要書式、結合、シート順が比較テストで一致する      |

### 4.3 MVP-3: xlsxエクスポート

| ID     | 要件                                                | 優先度 | 受入基準                                                  |
| ------ | --------------------------------------------------- | ------ | --------------------------------------------------------- |
| FR-201 | 現在のブックを新規 `.xlsx` としてエクスポートできる | P0     | エクスポート先を選択し、作業中ファイルパスは維持される（`.coco` 由来の場合も同様） |
| FR-202 | Excel/Google Sheetsで開けるxlsxを出力できる         | P0     | 代表10ファイル相当のP0要素がExcel/Sheetsで開ける          |
| FR-203 | 非対応要素の警告を表示する                          | P0     | 破棄/近似/保持できない要素がエクスポート前に表示される    |
| FR-204 | エクスポート中の失敗から復帰できる                  | P0     | 失敗しても作業ファイルが壊れず、再試行または別名保存を選べる |

### 4.4 P0対象数式

P0対象:

- 集計: `SUM`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN`, `MAX`
- 条件: `IF`, `AND`, `OR`, `NOT`
- 参照: `VLOOKUP`, `INDEX`, `MATCH`
- 文字列: `CONCAT`, `LEFT`, `RIGHT`, `MID`, `LEN`
- 日付: `TODAY`, `DATE`, `YEAR`, `MONTH`, `DAY`
- 数値: `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `ABS`

P0対象外:

- 配列数式、動的配列、スピル
- 循環参照の収束計算
- 外部ブック参照
- ユーザー定義関数
- ロケール依存の関数名入力

### 4.5 P0対象セル書式

P0対象:

- 太字、斜体、下線、取り消し線
- フォントサイズ、フォントファミリー
- 文字色、背景色
- 横位置、縦位置、折り返し
- 数値、通貨、パーセント、日付、時刻の表示形式
- 罫線
- 列幅、行高

P0対象外:

- 条件付き書式
- テーマ連動の完全再現
- 複雑なスタイル継承
- リッチテキストの部分装飾

### 4.6 キーボードショートカット

P0 基本操作:

| 操作                     | Windows/Linux         | macOS              |
| ------------------------ | --------------------- | ------------------ |
| 新規                     | Ctrl+N                | Cmd+N              |
| 開く                     | Ctrl+O                | Cmd+O              |
| 保存                     | Ctrl+S                | Cmd+S              |
| 名前を付けて保存         | Ctrl+Shift+S          | Cmd+Shift+S        |
| Undo                     | Ctrl+Z                | Cmd+Z              |
| Redo                     | Ctrl+Y / Ctrl+Shift+Z | Cmd+Shift+Z        |
| コピー/切り取り/貼り付け | Ctrl+C/X/V            | Cmd+C/X/V          |
| 検索                     | Ctrl+F                | Cmd+F              |
| 置換                     | Ctrl+H                | Cmd+Shift+H        |
| セル削除                 | Delete / Backspace    | Delete / Backspace |
| 確定/移動                | Enter / Tab / 矢印    | Enter / Tab / 矢印 |

Phase 2 オーサリング / 追加 UI（v0.1.0 で実装済み）:

| 操作                     | Windows/Linux         | macOS              | 備考 |
| ------------------------ | --------------------- | ------------------ | ---- |
| コマンドパレット         | Ctrl+Shift+P          | Cmd+Shift+P        | 全コマンド検索・実行 |
| 名前付き範囲ダイアログ   | Ctrl+F3               | Cmd+F3             | Excel 慣例 |
| 表示形式ダイアログ       | Ctrl+1                | Cmd+1              | Excel 慣例 |
| ハイパーリンク挿入       | Ctrl+K                | Cmd+K              | Excel 慣例 |
| コメント挿入/編集        | Shift+F2              | Shift+F2           | Excel 慣例 |
| 条件付き書式ダイアログ   | Ctrl+F8               | Cmd+F8             | Coco カスタム |
| AutoSum                  | Alt+=                 | Option+=           | Excel 慣例 |
| 設定                     | Ctrl+,                | Cmd+,              | macOS 慣例 |
| ヘルプ                   | Ctrl+/ / F1           | Cmd+/ / F1         | - |
| ホーム画面: 最近一覧フィルター | Ctrl+F          | Cmd+F              | HomeScreen 限定 |
| ホーム画面: ピン留めトグル | P                   | P                  | 選択行に対して |

### 4.7 CSV エクスポート

| ID | 要件 | 優先度 | 受入基準 |
|---|---|---|---|
| FR-301 | アクティブシートを CSV としてエクスポートできる | P0 | UTF-8 BOM 付き、Excel と Google Sheets で文字化けせず開ける |
| FR-302 | 複数シートのワークブックでは「シートを選択」ダイアログを表示する | P0 | 単一シートの場合はダイアログ省略 |
| FR-303 | CSV の値表現は表示値ベース | P0 | 数式は計算結果を出力、書式設定後の表示値を採用 |
| FR-304 | CSV インジェクション対策 | P0 | `=`, `+`, `-`, `@` で始まる文字列セルを `'` プレフィックスでエスケープ |

---

## 5. 非機能要件

### 5.1 性能

測定環境の前提:

- RAM 8GB、SSD搭載の標準的な社内PC
- Windows 10 / Windows 11 / macOS 12
- 代表テストファイル: 社内実績ファイル10種、最大5MB、5万行、数式比率10%程度

| 操作                 | 条件                   | p50目標 |   p95目標 |
| -------------------- | ---------------------- | ------: | --------: |
| スクロール           | 1万行×50列、数式なし   |   60fps |     60fps |
| スクロール           | 10万行×100列、数式なし |   60fps | 30fps以上 |
| セル入力レスポンス   | 通常セル               |    16ms |      50ms |
| 数式再計算           | 単純数式1,000セル      |   100ms |     300ms |
| 数式再計算           | VLOOKUP等100セル       |   300ms |     800ms |
| `.xlsx` インポート   | 1MB、数式比率10%       |     2秒 |       5秒 (実測 p95: 3.57 秒 — `xlsx_perf_smoke` テスト, Windows release, 2026-05-14) |
| `.xlsx` インポート   | 5MB                    |     8秒 |      15秒 |
| `.xlsx` エクスポート | 1MB相当                |     3秒 |       8秒 |
| SQLite保存           | 5万セル                |     1秒 |       3秒 |
| アプリ起動           | コールドスタート       |     3秒 |       5秒 |
| メモリ使用量         | 5万行×50列、通常操作   |   300MB |     500MB |

### 5.2 オフライン保証

- アップデート確認を除き、業務データを外部サーバーへ送信しない。
- xlsxインポート、xlsxエクスポート、フォント、ヘルプ、ライセンス検証、クラッシュレポートはネットワーク非依存を原則とする。
- MVPではクラッシュレポートの自動送信は実装しない。
- 外部通信が必要な機能はMVP対象外、または管理者が明示的に許可した場合のみ有効化する。
- CI/E2Eでネットワーク遮断状態の動作確認を必須とする。

### 5.3 セキュリティ

#### 5.3.1 データ送信

- 業務データ、セル値、数式、ファイル本文、ファイル名フルパスを外部送信しない。
- ログにはセル値、数式、ファイル本文を含めない。
- エラー報告を実装する場合は、送信前にユーザー確認と管理者設定を必須とする。

#### 5.3.2 xlsxインポート防御

| 項目                       | MVP上限/扱い                                                 |
| -------------------------- | ------------------------------------------------------------ |
| 入力ファイルサイズ         | 50MBを超える場合は拒否                                       |
| ZIP展開後サイズ            | 300MBを超える場合は拒否                                      |
| ZIP内ファイル数            | 2,000を超える場合は拒否                                      |
| XML単体サイズ              | 50MBを超える場合は拒否                                       |
| シート数                   | 100を超える場合は警告、200を超える場合は拒否                 |
| 行数                       | 1シート100万行を超える場合は拒否                             |
| 列数                       | 16,384列を超える場合は拒否                                   |
| 数式数                     | 100万を超える場合は警告、性能劣化時は読み込み中断可          |
| 外部リンク/外部参照        | 自動アクセス禁止、警告表示、値のみ保持                       |
| Webクエリ/DDE/OLE/外部画像 | 実行・取得しない。警告表示し、値またはプレースホルダのみ保持 |
| VBAマクロ                  | 実行しない。MVPでは保持しない                                |
| 破損xlsx                   | 読み込みを中断し、理由と復旧不可を表示                       |

#### 5.3.3 エクスポート時の式注入対策

- xlsxエクスポートではセル種別を維持し、ユーザーが数式として入力したセルのみ数式として出力する。
- CSVエクスポートを将来追加する場合、`=`, `+`, `-`, `@` で始まる文字列のエスケープ方針を別途定義する。

#### 5.3.4 暗号化

- 機密区分A/Bの業務データを扱うことが確定した場合、`.coco` 暗号化はMVP必須とする。
- 暗号化方式はDG-04で決定する。
- 候補:
  - SQLite Encryption Extension
  - SQLCipher
  - アプリレイヤー暗号化
- 鍵管理候補:
  - Windows Credential Manager / macOS Keychain
  - ユーザー指定パスフレーズ
- パスフレーズ紛失時は復旧不能であることをUIで明示する。
- 暗号化 `.coco` のバックアップは同一方式で暗号化する。

#### 5.3.5 監査ログ

DG-04で必要と判断した場合、以下のイベントをローカルログに記録する。

- アプリ起動/終了
- ファイルopen/save/save-as/import/export/restore
- 保存失敗、復元失敗、マイグレーション失敗
- 外部リンク検出、悪意あるxlsx拒否
- アップデート確認/更新失敗

監査ログにはセル値、数式、ファイル本文を含めない。

### 5.4 可用性・保存・復旧

#### 5.4.1 保存状態

| 状態                  | 表示位置                      | 操作可否                     |
| --------------------- | ----------------------------- | ---------------------------- |
| 読み込み中            | タイトルバー/中央ローディング | 編集不可                     |
| インポート警告あり    | 通知バー                      | 警告確認後に編集可           |
| 未保存の変更あり      | タイトルバー                  | 編集可                       |
| 保存中                | タイトルバー                  | 編集可、終了は確認           |
| 保存済み              | タイトルバー                  | 編集可                       |
| 自動保存済み          | タイトルバー                  | 編集可                       |
| 保存失敗              | 通知バー/ダイアログ           | 編集可、別名保存を促す       |
| エクスポート中        | 通知バー                      | 編集可、同時エクスポート不可 |
| エクスポート成功/失敗 | 通知バー                      | 編集可                       |
| 復元候補あり          | ホーム/起動時ダイアログ       | 復元、破棄、後で確認を選択   |

#### 5.4.2 保存ルール

| 操作                       | 動作                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| 新規作成                   | 無題ブックとして開始し、アプリ管理下の SQLite 一時ファイル（内部用途）へ自動保存する |
| 新規作成後のCtrl+S         | xlsx 保存先ダイアログを表示する（フィルタは xlsx のみ）。Save / Save As とも `.coco` はユーザー選択肢に出さない |
| `.coco` を開く             | 後方互換のため受け付ける。最近使ったファイルからも開ける。同じ `.coco` を作業ファイルとして開く |
| `.coco` 開封後のCtrl+S     | 同じ `.coco` に上書き保存する（原子的書込 + `.bak.1`〜`.bak.5` ローテーション） |
| `.xlsx` を開く             | 同じ xlsx を作業ファイルとして開く。元ファイルパスを保持                  |
| `.xlsx` 開封後のCtrl+S     | 同じ xlsx に上書き保存する。書込前に `.bak.1`〜`.bak.5` をローテーション  |
| `.xlsm` を開く             | xlsx と同様に開くが、`XlsmMacroLossDialog` でマクロ破棄を警告。作業ファイル拡張子は内部的に xlsx 扱い |
| `.xlsm` 開封後のCtrl+S     | xlsx 保存先ダイアログを表示（同名 .xlsx 提案）。元 xlsm は変更しない      |
| 名前を付けて保存           | xlsx の保存先を変更。以後の作業ファイルを切り替える                       |
| CSV エクスポート           | アクティブシート（または選択シート）を別途 CSV 出力。作業ファイルパスは変更しない |
| xlsx エクスポート          | 共有用 xlsx を別途出力。`.coco` 作業中の場合も作業ファイルパスは維持する  |
| 終了時に未保存             | 保存、破棄、キャンセルを選択できる                                        |

#### 5.4.3 自動保存とバックアップ

- 編集後30秒以内に自動保存する（`DEFAULT_AUTOSAVE_MS = 30_000`）。
- 自動保存間隔はユーザー設定可能（SettingsDialog）。
- 未保存の新規ブックはアプリ管理下の一時 SQLite ファイルに自動保存する（クラッシュ復旧用）。
- 明示保存済み xlsx / `.coco` は同一ディレクトリ配下の `.bak.1`〜`.bak.5` にローテーションでバックアップする（`MAX_BACKUPS = 5`）。
- バックアップ最大容量は既定で1GBとし、超過時は古い世代から削除する。
- 復元時は元ファイルを直接上書きせず、復元コピーとして保存する。
- マイグレーション前には必ずバックアップを作成する。

#### 5.4.4 原子的保存

`.coco` および xlsx の保存は次の順序で行う（`.coco` 系のみ integrity check 付き）。

1. 現在ファイルの `.bak` ローテーションを行う。
2. 一時ファイル（同一ディレクトリ）へ書き込む（`.coco` は SQLite トランザクション、xlsx はワンショット書込）。
3. `.coco` の場合は `PRAGMA integrity_check` を実行する。
4. 成功時のみ既存ファイルと rename で置換する。
5. 失敗時は既存ファイルを保持し、別名保存を促す。

### 5.5 互換性

- Windows 10以降、Windows 11、macOS 12以降で動作する。
- Excel互換性はP0対応要素に限定して判定する。
- 「完全一致」はP0対象の値、式、計算結果、表示形式、結合、シート順に適用する。
- 数値比較の許容誤差は小数第10位以内とする。
- 日時はタイムゾーン変換なしで一致すること。
- P1/P2要素は保持、警告、破棄のいずれかを要素ごとに仕様化し、破棄時はエクスポート前に警告する。

### 5.6 配布

- Windows: 署名済み `.exe`
- macOS: 署名・notarization済み `.dmg`
- 配布物にはSHA-256チェックサムを付与する。
- バージョン番号はSemantic Versioningに準拠する。
- インストール/アンインストール時にユーザーデータを削除しない。
- 自動更新を採用する場合は署名検証、失敗時ロールバック、管理者による無効化を必須とする。
- 自動更新を採用しない場合は手動更新手順と旧バージョン互換ポリシーを配布資料に含める。

---

## 6. ユーザーフロー

### 6.1 新規作成から保存

1. ホームで「新規ワークブック」を選択する。
2. 空のSheet1が表示される。
3. セル入力、書式設定、シート追加を行う。
4. 自動保存により内部 SQLite 一時ファイルに保存される（クラッシュ復旧用）。
5. Ctrl+Sを押す。
6. xlsx 保存先ダイアログが表示される（フィルタは xlsx のみ）。
7. 保存後、タイトルバーが「保存済み」になる。

### 6.2 既存 `.coco` を開いて編集（後方互換動線）

1. ホームの最近使ったファイル一覧、または「ファイルを開く」のダイアログから既存の `.coco` を選択する（後方互換のため受け付ける）。
2. ブックが読み込まれる。
3. 編集する。
4. Ctrl+Sで同じ `.coco` に原子的に上書き保存される。
5. 保存失敗時は理由を表示し、別名保存（xlsx）を促す。

### 6.3 `.xlsx` を開いて編集・保存

1. ホームまたはメニューから `.xlsx` を選択する。
2. インポートが実行される。
3. 非対応要素または警告がある場合、`CompatibilityWarningsDialog` で表示される。
4. グリッドに内容が表示される。
5. 編集する。
6. Ctrl+Sを押す。
7. 同じ xlsx に上書き保存される（書込前に `.bak.1`〜`.bak.5` をローテーション）。
8. 別ファイルとして保存したい場合は「名前を付けて保存」を選択する（保存先は xlsx）。

### 6.4 xlsxエクスポート

1. 任意の作業ブック（新規 / `.coco` 由来 / xlsx 由来）を開く。
2. メニューから「xlsxエクスポート」を選択する。
3. 非対応要素がある場合、警告を確認する。
4. 出力先を選択する。
5. `.xlsx` が生成される。
6. 作業中ファイルパスは変更されない。

### 6.5 クラッシュ復元

1. 前回終了が異常だった場合、起動時に復元候補を表示する。
2. ユーザーは「復元コピーを開く」「破棄」「後で確認」を選択する。
3. 復元コピーを開いた場合、元ファイルは上書きされない。
4. 復元後の初回保存では保存先を確認する。

---

## 7. 画面・UI要件

### 7.1 ホーム画面

表示要素:

- 最近使ったファイル一覧（最大10件、ピン留め行と通常行）
- 新規ワークブック作成
- ファイルを開く
- 復元候補
- ファーストラン時のウェルカム表示、再訪時の Tips ローテーション
- インラインフィルター（Ctrl+F でフォーカス）

操作:

- ピン留めトグル: 選択行で `P` キー
- ピン留めの順序変更: ドラッグ＆ドロップ
- 個別削除 / 一括クリア（`workbook_remove_recent` / `workbook_clear_recent`）

状態:

- 最近使ったファイルがない
- ファイルが移動/削除済み（「見つかりません」バッジで一覧に残す）
- 読み取り権限がない
- 破損ファイル検出
- 前回クラッシュ復元候補あり

### 7.2 エディタ画面

```
┌─────────────────────────────────────────────┐
│ メニューバー（ファイル / 編集 / 表示 / 挿入 / 書式 / データ / ヘルプ） │
├─────────────────────────────────────────────┤
│ Coco ツールバー（保存 / AutoSum / 書式コピー / 通貨 / % / 数値書式 等） │
├─────────────────────────────────────────────┤
│ Univer ツールバー（書式・数式・並べ替え・フィルター。左詰めレイアウト） │
├─────────────────────────────────────────────┤
│ 数式バー [セル参照] [数式入力欄]              │
├─────────────────────────────────────────────┤
│                                             │
│ スプレッドシートグリッド（Univer）            │
│  └ 条件付き書式の in-grid ライブ描画          │
│  └ ハイパーリンクの blue+underline 表示       │
│  └ コメントの赤三角インジケータ＋ DOM オーバーレイ │
├─────────────────────────────────────────────┤
│ シートタブ（Sheet1 / Sheet2 / +）             │
├─────────────────────────────────────────────┤
│ ステータスバー（保存状態 / 選択範囲 / 集計）   │
└─────────────────────────────────────────────┘
```

サイドバー / オーバーレイ UI:

- `ChartPreviewPanel`: 既存チャートを SVG プレビュー、クリックで参照範囲にジャンプ
- `ImagePreviewPanel`: 画像サムネイル一覧、クリックでアンカーセルにジャンプ
- コマンドパレット（Ctrl+Shift+P）: 全コマンド検索・実行
- 各種ダイアログ: §4.6 のショートカット表参照

### 7.3 ダイアログ/通知

| UI                          | 表示条件                                | 必須操作                   |
| --------------------------- | --------------------------------------- | -------------------------- |
| インポート警告 (`CompatibilityWarningsDialog`) | xlsx に非対応要素がある    | 詳細表示、続行、キャンセル |
| xlsm マクロ破棄 (`XlsmMacroLossDialog`) | `.xlsm` 開封時             | 続行、キャンセル           |
| 保存失敗                    | 保存に失敗                              | 再試行、別名保存、閉じる   |
| エクスポート警告            | 非対応要素が破棄/近似される             | 続行、キャンセル           |
| 復元候補                    | 自動保存/バックアップがある             | 復元、破棄、後で確認       |
| 悪意あるファイル拒否 (`SecurityBlockDialog`) | セキュリティ上限超過       | 理由表示、閉じる           |
| Phase 2 オーサリングダイアログ | Ctrl+F8 / Ctrl+F3 / Ctrl+1 / Ctrl+K / Shift+F2 等 | 編集して適用、キャンセル |
| スナップショット履歴        | コマンドパレットから起動                | 過去スナップショットを開く、閉じる |
| 設定 (`SettingsDialog`)     | Ctrl+,                                  | 言語切替、自動保存間隔調整、閉じる |

---

## 8. データ要件 / `.coco` SQLite設計

### 8.1 基本方針

- 1ワークブック = 1 SQLiteファイル、拡張子は `.coco`
- MVPでは「Univer snapshot丸ごと保存 + 主要検索/復旧用テーブル」の二層構成とする。
- Phase 2以降で必要に応じてセル単位の正規化を強化する。
- SQLiteはWALモードを有効にする。
- マイグレーション失敗時は元ファイルへロールバックする。

### 8.2 DDLドラフト

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL
);

CREATE TABLE workbook_meta (
  workbook_id TEXT PRIMARY KEY,
  app_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_path TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('new', 'coco', 'xlsx')),
  calc_mode TEXT NOT NULL CHECK (calc_mode IN ('auto', 'manual')),
  locale TEXT NOT NULL DEFAULT 'ja-JP',
  encrypted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workbook_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  workbook_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('manual_save', 'auto_save', 'backup', 'migration')),
  FOREIGN KEY (workbook_id) REFERENCES workbook_meta(workbook_id)
);

CREATE TABLE sheets (
  sheet_id TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sheet_order INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  default_col_width REAL,
  default_row_height REAL,
  freeze_json TEXT,
  FOREIGN KEY (workbook_id) REFERENCES workbook_meta(workbook_id)
);

CREATE TABLE cells (
  sheet_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  col_index INTEGER NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('blank', 'string', 'number', 'boolean', 'date', 'error', 'formula')),
  raw_value TEXT,
  display_value TEXT,
  formula TEXT,
  cached_result TEXT,
  error_code TEXT,
  style_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sheet_id, row_index, col_index),
  FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id),
  FOREIGN KEY (style_id) REFERENCES styles(style_id)
);

CREATE TABLE styles (
  style_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  style_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE col_widths (
  sheet_id TEXT NOT NULL,
  col_index INTEGER NOT NULL,
  width REAL NOT NULL,
  PRIMARY KEY (sheet_id, col_index),
  FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
);

CREATE TABLE row_heights (
  sheet_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  height REAL NOT NULL,
  PRIMARY KEY (sheet_id, row_index),
  FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
);

CREATE TABLE merged_cells (
  sheet_id TEXT NOT NULL,
  start_row INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_row INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  PRIMARY KEY (sheet_id, start_row, start_col),
  FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
);

CREATE TABLE named_ranges (
  workbook_id TEXT NOT NULL,
  name TEXT NOT NULL,
  range_json TEXT NOT NULL,
  PRIMARY KEY (workbook_id, name),
  FOREIGN KEY (workbook_id) REFERENCES workbook_meta(workbook_id)
);

CREATE TABLE filters (
  sheet_id TEXT NOT NULL,
  filter_id TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  PRIMARY KEY (sheet_id, filter_id),
  FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
);

CREATE TABLE formula_dependencies (
  sheet_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  col_index INTEGER NOT NULL,
  dep_sheet_id TEXT NOT NULL,
  dep_row_index INTEGER NOT NULL,
  dep_col_index INTEGER NOT NULL,
  PRIMARY KEY (sheet_id, row_index, col_index, dep_sheet_id, dep_row_index, dep_col_index)
);

CREATE TABLE file_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  path_hash TEXT,
  detail_json TEXT
);
```

### 8.3 保存対象

| 種別                | 保存対象                                          |
| ------------------- | ------------------------------------------------- |
| 値                  | raw value、display value、型                      |
| 数式                | `=` を含むユーザー表示式、cached result、エラー値 |
| 書式                | P0対象書式、style hash                            |
| シート              | 名前、順序、非表示、固定表示                      |
| レイアウト          | 列幅、行高、結合                                  |
| フィルター/並べ替え | Univer snapshotおよび必要テーブル                 |
| Undo/Redo           | MVPでは保存しない                                 |

### 8.4 マイグレーション

- すべての `.coco` に `schema_version` を保持する。
- アプリ起動時に対象ファイルのスキーマバージョンを確認する。
- マイグレーション前にバックアップを作成する。
- 失敗時は元ファイルを開き直し、ユーザーにエラーを表示する。
- 後方互換は直近2マイナーバージョンを対象とする。

---

## 9. アーキテクチャ / API境界

### 9.1 責務分離

| レイヤー            | 技術               | 責務                                                          |
| ------------------- | ------------------ | ------------------------------------------------------------- |
| UI                  | React / TypeScript | 画面、状態表示、メニュー、通知                                |
| Spreadsheet         | Univer             | グリッド表示、編集、数式計算、シート操作                      |
| Application Service | TypeScript         | UI状態、Univer snapshot変換、Tauri command呼び出し            |
| Native Backend      | Rust / Tauri v2    | ファイルI/O、SQLite、バックアップ、暗号化、OSダイアログ、ログ |
| xlsx Adapter        | Phase 0で決定      | xlsx import/export、互換性警告、危険要素検出                  |

### 9.2 Tauri command 一覧（v0.1.0 実装ベース）

ワークブック系:

| Command                       | 概要                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `workbook_new`                | 新規ブック作成                                             |
| `workbook_open_coco`          | 既存 `.coco` 読み込み（後方互換）                          |
| `workbook_import_xlsx`        | `.xlsx` 取り込み                                           |
| `workbook_import_csv`         | CSV / TSV 取り込み                                         |
| `workbook_save`               | 同パスに上書き保存（`.coco` は原子的書込）                  |
| `workbook_save_as`            | 別パスに保存                                               |
| `workbook_export_xlsx`        | xlsx 出力                                                  |
| `workbook_export_csv`         | アクティブシートまたは選択シートを CSV 出力                 |
| `workbook_autosave_coco`      | 既存 `.coco` の自動保存                                    |
| `workbook_autosave_temp`      | 未保存ブックの一時 SQLite ファイルへの自動保存             |
| `workbook_check_integrity`    | `.coco` の `PRAGMA integrity_check`                        |
| `workbook_vacuum`             | `.coco` の VACUUM                                          |
| `workbook_diagnostic_info`    | デバッグ用のファイル統計情報                               |
| `workbook_list_snapshots`     | スナップショット履歴一覧                                   |
| `workbook_open_snapshot`      | 過去スナップショットの読み込み                             |
| `list_sheet_names`            | CSV エクスポートのシート選択ダイアログ用                   |
| `existing_csv_export_paths`   | CSV エクスポートの既存パス検出（上書き確認用）              |

最近ファイル / リカバリ系:

| Command                       | 概要                              |
| ----------------------------- | --------------------------------- |
| `workbook_list_recent`        | 最近使ったファイル一覧            |
| `workbook_remove_recent`      | 最近一覧から個別削除              |
| `workbook_clear_recent`       | 最近一覧の全クリア                |
| `workbook_list_recovery`      | クラッシュ復元候補一覧            |
| `workbook_restore_backup`     | 復元コピー作成                    |
| `workbook_clear_recovery`     | 復元候補のクリア                  |

セキュリティ / シェル系:

| Command                       | 概要                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `security_scan_xlsx`          | xlsx 事前検査（§5.3.2 上限の enforcement）                   |
| `read_file_bytes_base64`      | 画像プレビュー等のための base64 読み出し                     |
| `reveal_in_file_manager`      | OS のファイラで該当ファイルを表示                            |
| `open_url`                    | ハイパーリンクの外部 URL 起動（scheme allowlist + 3 ユニットテスト） |

設定系:

| Command         | 概要                       |
| --------------- | -------------------------- |
| `get_setting`   | 設定値の取得               |
| `set_setting`   | 設定値の保存               |
| `list_settings` | 設定値の一覧               |
| `delete_setting`| 設定値の削除               |

### 9.3 xlsx Adapterインターフェース

```ts
export interface XlsxAdapter {
  scan(path: string): Promise<XlsxScanResult>;
  import(path: string): Promise<WorkbookImportResult>;
  export(snapshot: WorkbookSnapshot, path: string): Promise<XlsxExportResult>;
}

export interface CompatibilityWarning {
  severity: 'info' | 'warning' | 'blocking';
  code: string;
  message: string;
  affectedSheets?: string[];
}
```

### 9.4 xlsx I/O 候補（Phase 0 判定 — 履歴）

> **2026-05-15: AD-05 / AD-06 で Rust 実装に確定。本表は判定経緯の記録として保持。**

| 候補                    | 長所                             | リスク                                             | Phase 0判定結果                   |
| ----------------------- | -------------------------------- | -------------------------------------------------- | --------------------------------- |
| SheetJS CE              | Apache-2.0、ローカル実行しやすい | 高精度スタイル/グラフ互換に制約                    | 不採用（スタイル・条件付き書式・グラフ blob 等で要件未達） |
| SheetJS Pro             | スタイル等の対応範囲が広い可能性 | 商用費用、契約確認                                 | 不採用（コストと配布条件）         |
| Univer Pro local server | Univerとの親和性                 | Pro契約、サーバー同梱、Temporal/Object storage要件 | 不採用（完全オフライン同梱不可）   |
| **Rust 実装** (`calamine` + `rust_xlsxwriter`) | Rust側で完結、Tauriと親和、ライセンスクリア (Apache-2.0 / MIT) | 実装工数 | **採用** — Phase 1 で本実装、代表10ファイル互換性合格 |

---

## 10. xlsx互換性マトリクス

> **2026-05-15: v0.1.0 実装ベースで更新。** インポートとエクスポートで往復保持される項目は「往復保持」と表記。

| 要素                 | インポート (Excel / Sheets→Coco) | エクスポート (Coco→Excel / Sheets)  | 実装層 | 備考 |
| -------------------- | -------------------------------- | ----------------------------------- | ------ | ---- |
| セル値               | 一致                             | 一致                                | typed  | -    |
| 基本数式 / エラー値  | 式保持 + 計算結果一致            | 式保持 + 計算結果一致               | typed  | §4.4 P0 数式範囲 |
| セル書式 P0 subset   | 視覚的に同等                     | 視覚的に同等                        | typed  | font / fill / alignment / border |
| 数値 / 日付書式      | 表示形式一致                     | 表示形式一致                        | typed  | builtin + custom format codes |
| セル結合             | 一致                             | 一致                                | typed  | -    |
| 複数シート / 順序    | 一致                             | 一致                                | typed  | 名前衝突時は `_2` で deduplicate |
| 列幅 / 行高          | 一致または許容差内               | 一致または許容差内                  | typed  | -    |
| シートタブ色         | 往復保持                         | 往復保持                            | typed  | -    |
| フリーズ / スプリットペイン | 往復保持                   | 往復保持                            | typed + post-save zip rewrite | xSplit / ySplit / topLeftCell |
| シート保護           | 往復保持 + 編集ライブ強制        | 往復保持                            | typed  | password 含む |
| オートフィルター     | 往復保持                         | 往復保持                            | typed  | filter range |
| 印刷 / ページ設定    | 往復保持                         | 往復保持                            | typed  | 余白 / 向き / スケール |
| 名前付き範囲         | 往復保持                         | 往復保持                            | typed  | workbook + sheet スコープ、CRUD UI あり |
| 条件付き書式 (典型)  | 往復保持 + 編集 UI               | 往復保持 + `<dxf>` 出力             | typed  | cellIs / containsText / top10 / duplicate / unique |
| 条件付き書式 (高度)  | 往復保持                         | 往復保持                            | raw XML| colorScale / dataBar / iconSet（cfvo / color stops / icon set name） |
| データバリデーション | 往復保持 + ライブ入力ガード      | 往復保持                            | typed  | list / range / date / whole / decimal |
| ハイパーリンク       | 往復保持 + 挿入 UI               | 往復保持                            | typed  | 外部 (open_url) / 内部 (#Sheet!A1) |
| コメント (作者付き)  | 往復保持 + 挿入 UI               | 往復保持                            | typed + zip rewrite | 赤三角インジケータ + hover panel |
| リッチテキスト       | per-run formatting 保持          | per-run formatting 保持             | typed  | -    |
| グラフ               | byte-for-byte 保持               | byte-for-byte 保持                  | blob   | `ChartPreviewPanel` で SVG プレビュー (bar/line/pie) |
| ピボットテーブル     | byte-for-byte 保持               | byte-for-byte 保持                  | blob   | 編集 UI なし（MVP 対象外） |
| 画像 (`xl/media/`)   | 往復保持 + サムネイル UI         | 往復保持                            | blob   | `ImagePreviewPanel` |
| 外部リンク部品       | キャッシュ値保持、自動アクセス禁止 | 部品保持                          | blob   | -    |
| 配列数式 / スピル    | 警告、値保持                     | 値のみ出力                          | -      | MVP 対象外 |
| VBA マクロ           | 実行しない、保持しない（.xlsm は破棄警告） | 対象外                       | -      | -    |

---

## 11. ユーザーストーリーと受入基準

| ID    | ユーザーストーリー                                                 | 受入基準                                                                                                       |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| US-01 | 業務担当者として、xlsxファイルを開いて既存データを確認・編集したい | Given xlsxを選択 When インポートが完了 Then P0要素がグリッドに表示され、非対応要素は警告される                 |
| US-02 | 業務担当者として、数式を入力して結果を確認したい                   | Given 空セル When `=SUM(A1:A10)` を入力 Then 計算結果が表示され、保存復元後も式と結果が保持される              |
| US-03 | 業務担当者として、作業中データを保存したい                          | Given 未保存ブック When Ctrl+S Then xlsx 保存先ダイアログ（フィルタは xlsx のみ）が表示され、保存後タイトルバーが保存済みになる |
| US-04 | 業務担当者として、完成したシートをxlsxで共有したい                 | Given 任意の作業ブック When xlsxエクスポート Then 出力xlsxをExcel/Sheetsで開ける                                 |
| US-05 | 業務担当者として、オフライン環境でも利用したい                     | Given ネットワーク遮断状態 When 新規作成、保存、xlsx import/export Then すべて完了する                         |
| US-06 | 管理者として、社内PCに配布したい                                   | Given 署名済み配布物 When インストール Then アプリが起動し、アンインストールしてもユーザーデータは削除されない |
| US-07 | 業務担当者として、保存失敗時にデータを失いたくない                 | Given 保存先が書き込み不能 When 保存 Then 既存ファイルは保持され、別名保存を選択できる                         |
| US-08 | 業務担当者として、クラッシュ後に作業を復元したい                   | Given 前回異常終了 When 次回起動 Then 復元候補から復元コピーを開ける                                           |

---

## 12. テスト計画

### 12.1 テスト種別

| 種別         | 対象                                           | 必須観点                                         |
| ------------ | ---------------------------------------------- | ------------------------------------------------ |
| Unit         | 数式、変換、保存サービス、セキュリティスキャン | 境界値、エラー値、型                             |
| Integration  | React/Univer/Tauri command/SQLite              | 保存復元、snapshot変換                           |
| E2E          | 主要ユーザーフロー                             | 新規、開く、保存、インポート、エクスポート、復元 |
| 互換性       | 代表xlsx 10種                                  | P0要素の比較                                     |
| セキュリティ | 悪意あるxlsx                                   | Zip bomb、巨大XML、外部リンク、破損ファイル      |
| 性能         | 5万行/10万行ケース                             | p50/p95                                          |
| 復旧         | クラッシュ、保存失敗、マイグレーション失敗     | データ保全                                       |
| 配布         | Windows `.exe` / macOS `.dmg`                  | 署名、インストール、アンインストール             |
| オフライン   | ネットワーク遮断                               | 通信なしで全P0フロー完了                         |

### 12.2 互換性テストデータ

- 社内代表xlsx 10種
- Google Sheetsからエクスポートしたxlsx 3種
- 破損xlsx
- 巨大xlsx
- Zip bomb相当の検査用ファイル
- 外部リンク付きxlsx
- マクロ付きxlsx
- 条件付き書式/グラフ付きxlsx
- 数式エラー値を含むxlsx

### 12.3 最小OSテストマトリクス

| OS           | CPU           | 必須 |
| ------------ | ------------- | ---- |
| Windows 10   | x64           | 必須 |
| Windows 11   | x64           | 必須 |
| macOS 12     | Intel         | 必須 |
| macOS 12以降 | Apple Silicon | 必須 |

### 12.4 Done定義

#### P0 Done

- P0機能要件がすべて実装されている。
- ネットワーク遮断E2Eが合格している。
- 代表xlsx 10種のP0要素往復テストが合格している。
- 悪意あるxlsx拒否テストが合格している。
- 未解決Critical/High不具合が0件である。

#### Security Done

- 脅威モデルが完了している。
- 依存ライブラリのライセンス確認が完了している。
- 脆弱性スキャンでCritical/Highが0件である。
- ログに業務データが含まれないことをテストで確認している。

#### Release Done

- 署名済み配布物がある。
- SHA-256チェックサムがある。
- リリースノートがある。
- 復旧手順、既知制約、ロールバック手順がある。
- インストール/アンインストール検証が完了している。

---

## 13. 成功指標

| 指標                        | 目標値                                                  |
| --------------------------- | ------------------------------------------------------- |
| 既存Excelユーザーの操作習熟 | オンボーディングなしで主要機能を80%以上のテスターが完了 |
| xlsxインポート互換性        | 代表10ファイルのP0要素が比較テストで合格                |
| xlsxエクスポート互換性      | 出力xlsxをExcel/Google Sheetsで開き、P0要素が合格       |
| 起動時間                    | コールドスタート p95 5秒以内                            |
| クラッシュ率                | 月次利用セッションあたり0.5%以下                        |
| オフライン動作              | ネットワーク遮断状態でP0フロー100%合格                  |

---

## 14. リスク / 撤退基準

| リスク                                 | 影響                     | 対策                                        |
| -------------------------------------- | ------------------------ | ------------------------------------------- |
| xlsx I/Oが高精度互換を満たせない       | 既存ファイル移行が困難   | DG-01で方式を早期確定し、P0要素に絞って受入 |
| Univer OSSがP0機能を満たせない         | 表計算UIの作り直しが発生 | Phase 0で基本機能PoCを実施                  |
| Pro/商用ライブラリの配布条件が合わない | リリース不可             | DG-03で法務確認                             |
| SQLiteファイル破損                     | データロスト             | WAL、原子的保存、バックアップ、復旧UI       |
| 大規模ファイルで性能不足               | 業務利用不可             | 性能テスト、仮想スクロール、P0上限定義      |
| 暗号化要件が後出しになる               | 保存設計の手戻り         | DG-04をPhase 1開始前必須にする              |

### 撤退/再選定基準

- UniverでP0必須機能の表示・編集・計算が実装不可能と判明した場合、代替ライブラリ選定へ移行する。
- 完全オフラインのxlsx I/OがP0互換性を満たせない場合、xlsx互換範囲を縮小するか、商用ライブラリ採用を再判断する。
- 代表10ファイルのうち3件以上でP0要素の往復互換が実現できない場合、MVPスコープを再定義する。

---

## 15. スケジュール / 実装順序

### 15.1 Phase 0: 技術検証・基盤（完了）

| 順序 | タスク                                | 完了条件                                       | 状態 |
| ---: | ------------------------------------- | ---------------------------------------------- | ---- |
|    1 | Tauri v2 + React + Univerの最小アプリ | 空ブックを表示し、セル編集できる               | ✅ |
|    2 | Univer snapshot保存/復元PoC           | snapshotを保存し、再起動後に復元できる         | ✅ |
|    3 | `.coco` SQLite保存PoC                 | 本書DDLベースで保存/読み込みできる             | ✅ |
|    4 | xlsx import PoC                       | 代表3ファイルをオフラインで取り込める          | ✅ (代表10ファイル本実装で検証済み) |
|    5 | xlsx export PoC                       | 代表3ファイル相当をExcel/Sheetsで開ける        | ✅ (代表10ファイル本実装で検証済み) |
|    6 | セキュリティスキャンPoC               | 巨大/破損/外部リンクxlsxを検出できる           | ✅ (`security_scan_xlsx` で §5.3.2 上限を enforcement) |
|    7 | 保存/復旧PoC                          | 自動保存、バックアップ、復元コピーを確認できる | ✅ (recovery_flow E2E テストあり) |
|    8 | ライセンス/暗号化/更新方針決定        | DG-01からDG-05が完了                           | ⚠️ DG-01 ✅ / DG-05 ✅ / DG-02 ⚠️ / DG-03 ⚠️ / DG-04 ❌（§0.2 参照） |

### 15.2 Phase 1: MVP 開発（v0.1.0 リリース済み）

- ✅ MVP-1: xlsx 作成・編集・保存（FR-001..FR-014）
- ✅ MVP-2: xlsx インポート（FR-101..FR-105、代表10ファイル互換性スイート合格）
- ✅ MVP-3: xlsx エクスポート（FR-201..FR-204）
- ✅ CSV エクスポート / インポート（FR-301..FR-304）
- ⚠️ 署名済み配布物作成（SHA-256 + manifest は完備、Apple Dev / Windows 証明書調達待ち）
- ⚠️ 社内アルファ配布（DG-04 判定後）

### 15.3 Phase 2 オーサリング UI（プレビュー実装済み・継続開発中）

v0.1.0 でプレビュー出荷した機能（CHANGELOG「xlsx authoring UI (Phase 2)」節）:

- ✅ 条件付き書式（cellIs / containsText / top10 / duplicate / unique 編集 + colorScale / dataBar / iconSet blob 保持）
- ✅ グラフ（既存保持 + 新規挿入ダイアログ + SVG プレビュー）
- ✅ データバリデーション（5 種類のオーサリング + ライブ入力ガード）
- ✅ 名前付き範囲 CRUD ダイアログ（Ctrl+F3）
- ✅ ハイパーリンク挿入（Ctrl+K）
- ✅ コメント挿入/編集（Shift+F2）
- ✅ 画像挿入＋プレビュー
- ✅ 数値書式ダイアログ（Ctrl+1）
- ✅ シート保護トグル
- ✅ Format Painter（書式コピー）

Phase 2 残課題:

- グラフの編集 UI 拡充（軸 / 系列 / ラベル）
- P1 数式拡充
- 二次 UI / Univer 配下のラベルの完全多言語化
- 社内ベータ
- 共同編集検証（OI-10 として将来検討）

---

## 16. 初回スプリントBacklog（全項目完了）

| ID     | タスク                                     | 成果物                                                | 状態 |
| ------ | ------------------------------------------ | ----------------------------------------------------- | ---- |
| BL-001 | Tauri v2 + React + TypeScriptの雛形作成    | 起動可能なデスクトップアプリ                          | ✅ |
| BL-002 | Univerを組み込み、空スプレッドシートを表示 | 編集可能なグリッド                                    | ✅ |
| BL-003 | Application state設計                      | 保存状態、ファイル種別、警告状態の型定義              | ✅ (`useWorkbookStore` zustand) |
| BL-004 | Rust command雛形作成                       | `workbook_new`, `workbook_save`, `workbook_open_coco` | ✅ (§9.2 参照、31 コマンドに拡張) |
| BL-005 | SQLite `.coco` 作成/読み込みPoC            | サンプル `.coco`                                      | ✅ |
| BL-006 | 自動保存の一時復元領域PoC                  | クラッシュ復元候補表示                                | ✅ (`workbook_autosave_temp` + HomeScreen) |
| BL-007 | xlsx Adapter PoC比較                       | SheetJS CE / Univer Pro local / Rust案の比較表        | ✅ (Rust 採用で確定、§9.4 参照) |
| BL-008 | 代表xlsx 3種のテストフィクスチャ準備       | 互換性テスト入力                                      | ✅ (FR-105 代表10ファイルに拡張) |
| BL-009 | ネットワーク遮断E2E雛形                    | オフライン確認手順                                    | ✅ |
| BL-010 | ライセンス一覧ドラフト                     | OSS/Pro候補のライセンス表                             | ✅ |

---

## 17. オープンイシュー

| ID    | 重要度   | 課題                         | 期限    | 担当                  | 状態 (2026-05-15) |
| ----- | -------- | ---------------------------- | ------- | --------------------- | ----------------- |
| OI-01 | Critical | `.coco` スキーマ詳細確定     | DG-02   | 開発チーム            | ⚠️ 実装完了。マイグレーション・破損復旧方針の正式文書化が未完 |
| OI-02 | Critical | Univerライセンス/Pro機能確認 | DG-03   | 開発チーム / 法務     | ⚠️ Univer 0.5.x OSS のみ採用（Pro 機能不使用）。法務正式承認が未完 |
| OI-03 | Critical | xlsx I/O方式決定             | DG-01   | 開発チーム            | ✅ クローズ — calamine + rust_xlsxwriter で確定、代表10ファイル合格 |
| OI-04 | High     | 暗号化要否決定               | DG-04   | PO / セキュリティ担当 | ❌ 未判定。MVP は非暗号化で出荷。機密区分 A/B 確定時に再判定 |
| OI-05 | High     | 監査ログ要否決定             | DG-04   | PO / セキュリティ担当 | ❌ 未判定。MVP は監査ログなし |
| OI-06 | High     | 自動更新要否決定             | DG-04   | PO / 管理者           | ❌ 未判定。MVP は自動更新なし |
| OI-07 | Medium   | 初期対応言語の確定           | Phase 0 | PO                    | ✅ クローズ — AD-08 で ja-JP / en-US 両対応、OS ロケール自動判定 |
| OI-08 | Medium   | VBA非対応の移行支援策        | Phase 1 | PO / 業務担当者       | ⚠️ 部分解決。`XlsmMacroLossDialog` で警告表示。移行支援ドキュメントは未作成 |
| OI-09 | Medium   | 代表xlsx 10種の選定          | Phase 0 | PO / 業務担当者       | ✅ クローズ — `src-tauri/tests/fixtures/` 配下に保有、FR-105 スイートで検証 |
| OI-10 | Medium   | 配布物署名証明書の調達       | Phase 1 | 管理者 / 法務         | ❌ 未着手。Apple Developer 認証情報および Windows 署名証明書の購入と CI 連携が必要（v0.1.0 は署名なしステージング） |
| OI-11 | Low      | リリースノート / 復旧手順 / ロールバック手順の整備 | Phase 1 | PO / 開発チーム | ⚠️ CHANGELOG.md は完備。エンドユーザー向け操作手順とロールバック手順が未作成 |

---

## 18. 用語

| 用語           | 定義                                         |
| -------------- | -------------------------------------------- |
| `.coco`        | 既存ファイルの読み込み／上書き互換のために残された SQLite 形式のワークブックファイル。**ユーザーが Save As から新規選択することはできない**（AD-02、2026-05-15 確定）。同形式は自動保存・クラッシュ復旧スナップショットの内部用途にも使用 |
| snapshot       | Univerのワークブック状態を表すJSON           |
| P0             | MVP必須                                      |
| P1             | Phase 2で対応                                |
| P2             | Phase 3以降またはベストエフォート            |
| 代表xlsx       | 社内業務で実際に使われる互換性評価用ファイル |
| 完全オフライン | インターネット接続なしでP0機能が完了する状態 |
