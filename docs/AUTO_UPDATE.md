# Coco — auto-update operations runbook

This is the operations runbook for Coco's auto-update feature. Audience: Coco maintainers (5 people or fewer) who will cut releases. Read this end-to-end once before your first release; afterwards section 3 ("リリース手順") is the daily reference.

## 1. 概要

Coco の自動アップデートは [Tauri v2 updater plugin](https://v2.tauri.app/plugin/updater/) と GitHub Releases を組み合わせたフローで動作する。リリース時、GitHub Releases に minisign 署名済みの `.nsis.zip` バンドルと `latest.json` メタファイルを配置する。アプリは起動時 (および任意のタイミングで) `latest.json` を取得し、現在のバージョンより新しければユーザーに更新を提示する。ユーザーが承認するとバックグラウンドで `.nsis.zip` をダウンロードし、ローカルで minisign 署名検証 → 検証成功時のみ Coco.exe をスワップして再起動する。署名検証に失敗したダウンロードは破棄される。

- 対象 OS: **Windows のみ** (macOS / Linux 版は Phase 2)
- 通信先: `https://github.com/abroadcrew02-spec/Coco/releases/latest/download/latest.json`
- ユーザーは設定ダイアログから自動更新を OFF にできる (起動時チェック自体を無効化 → 外部通信ゼロ)

## 2. 初期セットアップ (1 回限り)

このセクションは最初に自動更新を有効化するときの 1 回限りの作業。すでに完了していれば section 3 へ。

### 2-1. minisign 鍵生成

ローカルマシン (リリース担当者の開発機) で 1 回だけ実行する:

```bash
npx tauri signer generate --ci -p "" -w coco_updater.key -f
```

生成物:

- `coco_updater.key` — **秘密鍵**。`.gitignore` 済。**絶対に commit しない**。漏洩したら section 7 へ。
- `coco_updater.key.pub` — 公開鍵。`.gitignore` 済だが、その中身は `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に埋め込み済みなので、コードとしては既に commit されている。

注意: 上の例は `-p ""` でパスフレーズなし。本番運用ではパスフレーズ付きを推奨する。パスフレーズを付ける場合は section 2-2 の `TAURI_UPDATER_KEY_PASSWORD` も忘れずに登録する。

### 2-2. GitHub Actions Secrets 登録

GitHub repo → Settings → Secrets and variables → Actions → **New repository secret** から 2 件登録する。

| Secret 名 | 値 |
|---|---|
| `TAURI_UPDATER_PRIVATE_KEY` | `coco_updater.key` のファイル全体 (改行含む、`untrusted comment:` から始まる行を含む全文) |
| `TAURI_UPDATER_KEY_PASSWORD` | パスフレーズ。パスフレーズなしで生成した場合も空文字で登録しておく |

**IMPORTANT**: `TAURI_UPDATER_PRIVATE_KEY` には `coco_updater.key` (**秘密鍵** のファイル) の内容を貼り付ける。`coco_updater.key.pub` (公開鍵) を間違えて貼ると、署名検証はサイレントに壊れる (CI ビルドは通るが、生成された `.sig` が無効になり、ユーザー側の更新が「署名検証失敗」で常に落ちる) ので絶対に間違えないこと。

これらは Release workflow が `tauri-action` 経由で minisign 署名を作成するときに参照する。

### 2-3. 公開鍵の確認

`src-tauri/tauri.conf.json` の `plugins.updater.pubkey` フィールドが `coco_updater.key.pub` の **中身そのもの** と一致していることを確認する。

- 1 行で書く形式と、改行を含む形式 (`\n` エスケープ) のどちらも Tauri はサポートする。
- 公開鍵を書き換えると、その公開鍵で署名されたリリースしか旧アプリは受け取れなくなる (section 7 参照)。

## 3. リリース手順

通常リリースはタグを切るだけ。GitHub Actions の `Release` workflow が自動でビルド・署名・アップロードを行う。

```bash
# 1. version bump (3 ファイルを必ず同期させる)
#    - package.json                "version"
#    - src-tauri/Cargo.toml        [package] version
#    - src-tauri/tauri.conf.json   "version"

# 2. リリースノートを作成
#    - CHANGELOG/v0.2.0.md を新規作成 (フォーマットは section 4)

# 3. コミット + タグ + プッシュ
git add -A
git commit -m "chore: bump to v0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

その後の流れ:

1. GitHub Actions の `Release` workflow が `v*` タグを検知して起動する (所要 ~10 分)。
2. 完了すると `https://github.com/abroadcrew02-spec/Coco/releases/tag/v0.2.0` に以下が揃う:
   - `Coco_0.2.0_x64-setup.exe` (NSIS インストーラ)
   - `Coco_0.2.0_x64-setup.nsis.zip` (updater 用バンドル)
   - `Coco_0.2.0_x64-setup.nsis.zip.sig` (minisign 署名)
   - `Coco_0.2.0_x64_en-US.msi` (MSI インストーラ)
   - `latest.json` (updater が読むメタファイル)
3. 既存ユーザーは次回起動時に `latest.json` をチェックして更新を検知する。

ローカルでのビルドは不要 — 全て CI で実行される。

## 4. CHANGELOG ファイル形式

`CHANGELOG/v<version>.md` を以下のフォーマットで作成する:

```markdown
# Coco v0.2.0

## 新機能
- ...

## バグ修正
- ...

## 既知の問題
- ...
```

このファイルが存在すれば Release workflow がそのまま GitHub Release の body に貼り付ける。ファイルがない場合は GitHub の auto-generated notes (`--generate-notes`) にフォールバックする。

## 5. ドライラン (推奨: 本番タグ前)

本番タグの前にプレリリースで全フローを確認する。

```bash
git tag v0.1.1-rc1
git push origin v0.1.1-rc1
```

確認手順:

1. GitHub Actions タブで `Release` workflow が成功することを確認する。
2. Release ページに `latest.json` と `.nsis.zip.sig` が揃っていることを確認する。
3. 古い `0.1.0` のアプリ (アンインストール前のもの、または VM のスナップショット) を起動する。
4. 更新通知が表示される → 承認 → 自動ダウンロード → 再起動。
5. 再起動後のバージョン表示が `0.1.1-rc1` になっていることを確認する。
6. 問題があれば後始末:

```bash
gh release delete v0.1.1-rc1 --cleanup-tag --yes
```

## 6. 緊急 hotfix の流れ

1. `main` から hotfix ブランチを切る: `git checkout -b hotfix/v0.2.1`
2. 修正コミットを作成
3. PR を作成し `main` にマージ
4. `main` で version bump (section 3 の step 1)
5. タグを切ってプッシュ (section 3 の step 3)
6. Release workflow が自動実行される
7. (オプション) 旧バージョンで稼働中の社内ユーザーに「アプリを再起動して更新を受け取って下さい」と連絡

## 7. 秘密鍵漏洩時の対応

秘密鍵 (`coco_updater.key` または `TAURI_UPDATER_PRIVATE_KEY` Secret) が漏洩した疑いがある場合、即座に以下を実行する。

1. GitHub Actions Secret から `TAURI_UPDATER_PRIVATE_KEY` を削除 (Settings → Secrets and variables → Actions)。これで漏洩鍵を使った CI 経由の悪意ある署名は不可能になる。
2. 新鍵を生成:

   ```bash
   npx tauri signer generate --ci -p "" -w coco_updater.key -f
   ```

3. `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` を新公開鍵の中身で差し替える。
4. 新しい `TAURI_UPDATER_PRIVATE_KEY` を GitHub Secrets に登録する (section 2-2)。
5. version bump + 新タグでリリースする (section 3)。
6. **重要**: 旧公開鍵で動いている既存ユーザーは、新リリースの署名を検証できないため自動更新を受け取れない。
   - GitHub Issues と README で「手動ダウンロード + 再インストールが必要」と告知する。
   - 影響範囲が広い場合は Release ノートの冒頭に大きく明記する。
7. 次のリリース以降は新鍵で正常に流れる (再インストール済みユーザーは新公開鍵を持っているため)。

## 8. ユーザーへの説明 (FAQ)

社内ユーザーや初回利用者から来やすい質問をまとめておく。サポート対応時にコピペで使える。

- **Q: 自動アップデートを止めるには?**
  A: 設定ダイアログ → 更新セクション → 「起動時に更新を確認する」を OFF。次回起動以降は外部通信を行わない。

- **Q: 完全にオフラインで使いたい。**
  A: 上記の「起動時に更新を確認する」を OFF にすれば、Coco から外部への通信はゼロになる。アップデートが必要になったら手動で Releases ページから DL する。

- **Q: アップデート中にデータが消えませんか?**
  A: 消えない。`.coco` / `.xlsx` / 設定ファイル / 各種バックアップは無傷で、`Coco.exe` のバイナリだけが置換される。最近開いたファイルや UI 状態も保持される。

- **Q: 過去のバージョンに戻したい。**
  A: GitHub Releases ページ (`https://github.com/abroadcrew02-spec/Coco/releases`) から旧バージョンの `.exe` を手動ダウンロードして再インストールする。設定とユーザーデータはそのまま引き継がれる。

- **Q: Windows のセキュリティ警告が出ます。**
  A: SmartScreen の「詳細情報」リンクをクリック → 「実行」で進められる。Phase 2 で EV コードサイニング証明書を取得する予定で、それ以降は警告が出なくなる。Windows コード署名証明書 (オプション): [docs/CODE_SIGNING.md](CODE_SIGNING.md) 参照。

## 9. トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| Actions が `TAURI_SIGNING_PRIVATE_KEY not set` で失敗する | Secret 未登録 | repo Settings で `TAURI_UPDATER_PRIVATE_KEY` を登録 (section 2-2) |
| アプリが更新を検知しない | `pubkey` 不一致 / `latest.json` の URL 間違い | `gh release view v<x>` でアセット URL を確認、`tauri.conf.json` の `plugins.updater.endpoints` と `pubkey` を確認 |
| ダウンロード後に「署名検証失敗」 | 古い `pubkey` でビルドされたアプリが新鍵リリースを受け取った | 旧版を一度手動 DL で再インストールしてから自動更新を試す |
| `gh release create` が `release already exists` で失敗 | 同タグでの再ビルド | `gh release delete v<x> --cleanup-tag --yes` してから再 push |
| ユーザーが「更新が来ない」と報告 | `latest.json` のキャッシュ / バージョン番号の比較不一致 | `latest.json` を直接ブラウザで開き `version` フィールドを確認、3 ファイル (package.json / Cargo.toml / tauri.conf.json) が同期しているか確認 |
| 更新後にアプリが起動しない | 新バージョンのバグ | section 6 で hotfix を出す。緊急なら旧バージョン `.exe` を Releases から再配布 |

## 10. 自動更新導入前ビルドからの移行

`v0.1.0` は自動更新機能を搭載する前のビルドである。このバージョンを使っているユーザーは、updater プラグインが組み込まれていないため、`latest.json` を取りに行く処理自体が存在しない。したがって以下のように扱う。

- **`v0.1.0` ユーザー** → 自動更新は届かない。次の更新 (`v0.1.1` 以降) は **1 回だけ手動ダウンロード + 再インストール** が必要。
  - 案内テンプレ: 「お手数ですが [Releases ページ](https://github.com/abroadcrew02-spec/Coco/releases/latest) から最新版 `Coco_x.y.z_x64-setup.exe` をダウンロードして上書きインストールしてください。次回以降はアプリ内から自動更新されます。」
- **`v0.1.1` 以降のユーザー** → updater プラグイン入りのため、それ以降のバージョンは全自動で配信される。手動操作は不要。
- 設定・ユーザーデータ・最近開いたファイルなどは手動再インストールでも引き継がれる (`%AppData%/com.coco.app/` 配下なのでインストーラの影響を受けない)。

リリースノート (`CHANGELOG/v0.1.1.md`) の冒頭に「v0.1.0 からの初回のみ手動 DL が必要」の旨を 1 行入れておくと社内サポート工数が下がる。
