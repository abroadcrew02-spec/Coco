# リリース / 自動アップデート手順

Coco の新バージョンを配信する際の手順と注意点。開発者向け。

## 仕組み（概要）

- ユーザーは**初回のみ**インストーラ（`distbin/` の `*-setup.exe` / `*.msi`）を手動インストール
- 以降は起動時に GitHub Releases の `latest.json` を確認し、新しいバージョンがあれば**自動更新**
- リリースは **バージョンタグ（`v*`）の push** で GitHub Actions（`.github/workflows/release.yml`）が自動実行：
  ビルド → 署名 → `latest.json` 生成 → GitHub Releases へ公開

## 新バージョンを出す手順

例として v0.3.0 を出す場合：

1. バージョンを **3ファイルすべて**で上げる（必ず一致させる）
   - `package.json` の `version`
   - `src-tauri/tauri.conf.json` の `version`
   - `src-tauri/Cargo.toml` の `version`（`src-tauri/Cargo.lock` の `coco` エントリも）
2. `CHANGELOG/v0.3.0.md` を作成（リリースノートになる）
3. コミット
4. タグを push：
   ```
   git tag v0.3.0
   git push origin v0.3.0
   ```
5. GitHub Actions が自動でビルド・署名・公開（数十分）
6. 各 PC の Coco が起動時に検知して自動更新

**2回目以降はローカルビルド不要。** タグ push のみで配信される。

## 注意点

| # | 注意点 | 理由 |
|---|---|---|
| 1 | **署名鍵を失わない・変えない**（最重要） | `coco-updater.key` とパスワードを失うと既存ユーザーへ更新を配信できなくなる。リポジトリ外にもバックアップ必須 |
| 2 | バージョンは必ず上げる・3ファイル一致 | 据え置き / ダウングレードは更新と認識されない |
| 3 | タグ名 = `v` + バージョン | version `0.3.0` → tag `v0.3.0` |
| 4 | `CHANGELOG/vX.Y.Z.md` を毎回用意 | 無いと GitHub 自動生成ノートになる |
| 5 | GitHub Secrets を消さない | `TAURI_UPDATER_PRIVATE_KEY` / `TAURI_UPDATER_KEY_PASSWORD` が無いと CI ビルドが署名で失敗 |
| 6 | タグ push 前に動作確認 | 一度配信すると全ユーザーに降る。撤回は困難 |
| 7 | `tauri.conf.json` の `pubkey` を変えない | 署名鍵を変えない限り固定。変えると旧バージョンが自動更新不能になる |

## 署名鍵について

- 秘密鍵: `coco-updater.key`（パスワードで暗号化）。ローカルバックアップは `.secrets/`（`.gitignore` 済み）
- 公開鍵: `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に埋め込み済み
- GitHub Actions: `TAURI_UPDATER_PRIVATE_KEY` / `TAURI_UPDATER_KEY_PASSWORD` の Secrets を使用
- ローカルでリリースビルドする場合（初回など）は環境変数で鍵を渡す：
  ```powershell
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = "<coco-updater.key のパス>"
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<パスワード>"
  npm run pack
  ```

## 初回インストール

自動アップデートは「インストール済み → 次のバージョン」でのみ機能する。
新しい PC への初回導入、および初版は**手動インストール**が必要（`distbin/` のインストーラを使う）。

## 関連ドキュメント

- `.github/workflows/release.yml` — リリースの CI 定義
- `docs/AUTO_UPDATE.md` — 自動アップデートの詳細
- `docs/CODE_SIGNING.md` — Windows コード署名（SmartScreen 対策、任意）
