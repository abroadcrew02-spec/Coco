# Coco — Windows コード署名 (オプション) 運用ガイド

このドキュメントは Windows 向け Coco インストーラ (`*-setup.exe` / `*.msi`) のコード署名運用手順をまとめたものである。署名証明書を取得していない状態でも release pipeline は通る (Phase 1 と同じ未署名状態) ため、本ガイドの対応はオプション扱い。

## 1. 概要

Windows でユーザーが Coco インストーラを実行すると、初回は **Microsoft Defender SmartScreen** が「発行元不明のアプリ」警告を出す。これを回避するにはインストーラに信頼された発行元の **Authenticode 署名** を付与する必要がある。署名証明書には大きく分けて 2 種類ある。

| 種別 | 価格目安 (年) | SmartScreen 即時パス | 備考 |
|---|---|---|---|
| **OV (Organization Validation)** | $80 - $200 | △ ダウンロード数に応じて段階的に評価が上がる | コスパは良いが「最初の数百 DL は警告」 |
| **EV (Extended Validation)** | $200 - $400 | ○ 取得直後から警告なし | ハードウェアトークン必須 (HSM / USB) |

Coco のように初回 DL 数が読めない場合、 **EV cert + クラウド署名サービス** の組み合わせが運用負荷と効果のバランスが良い。

## 2. 証明書購入の選択肢

価格は 1 年契約あたりの目安。複数年契約で割引が効く CA もある。

| CA | OV cert | EV cert | クラウド署名 | 特徴 |
|---|---|---|---|---|
| **DigiCert** | $474+ | $599+ | KeyLocker (有料) | 日本語サポート、企業向け |
| **SSL.com** | $129+ | $249+ | eSigner (年額数千円) | コスパ良し、eSigner が GH Actions と相性良 |
| **GlobalSign** | $410+ | $599+ | DSS (有料) | 国内法人検証手厚い |
| **Sectigo (Comodo)** | $179+ | $329+ | (要問い合わせ) | 安価。リセラー経由で更に下がる |
| **Certum** (個人向け OV) | $30 - $80 | n/a | n/a | 個人開発者向け、SmartScreen の評価蓄積に時間がかかる |

**推奨**: 法人なら **SSL.com EV + eSigner** が最も GitHub Actions 統合が楽。個人なら **Certum 個人 OV** で始めて、DL 数が増えたら EV へ移行。

## 3. GitHub Secrets 登録手順

証明書 (.pfx) を取得したら以下の手順で Secrets に登録する。

### 3-1. .pfx を base64 に変換

ローカル PowerShell で実行:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\coco-signing.pfx")) | Set-Clipboard
```

クリップボードに base64 文字列がコピーされる。

### 3-2. GitHub Secrets 登録

GitHub repo → Settings → Secrets and variables → Actions → **New repository secret** から 2 件登録する。

| Secret 名 | 値 |
|---|---|
| `WINDOWS_CERT_BASE64` | 3-1 でクリップボードに入った base64 文字列を貼り付け |
| `WINDOWS_CERT_PASSWORD` | .pfx エクスポート時に設定したパスワード |

これらは Release workflow の "Install Windows code-signing certificate" ステップで参照され、CI ランナー上の `CurrentUser\My` 証明書ストアにインポートされる。インポート直後に thumbprint を取得し、後続の "Sign Windows artifacts" ステップで `signtool.exe sign /sha1 <thumb>` が `*.exe` / `*.msi` 全てに署名を付ける。

両 Secret が未登録の場合、両ステップは `if:` 条件で完全にスキップされ、Phase 1 と同じ未署名アセットが配布される。

## 4. 動作確認

リリース完了後、署名されたインストーラを Windows マシンにダウンロードし、以下のいずれかで検証する。

### 4-1. signtool verify (CLI)

```powershell
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" verify /pa /v Coco_x.y.z_x64-setup.exe
```

`Successfully verified` と表示されればOK。

### 4-2. エクスプローラ (GUI)

1. `Coco_x.y.z_x64-setup.exe` を右クリック → **プロパティ**
2. **デジタル署名** タブが存在することを確認
3. 署名者欄をダブルクリック → 「この証明書を表示」で発行元と有効期限を確認

### 4-3. SmartScreen の挙動

VM またはまっさらな Windows マシンでダブルクリックし、SmartScreen ダイアログが出ないこと (EV cert) または「詳細情報」リンクなしですぐ実行できること (OV cert で reputation 蓄積済み) を確認する。

## 5. タイムスタンプサーバ

`signtool sign` に `/tr <url> /td sha256` を渡してタイムスタンプを埋め込んでいる。これにより**証明書の有効期限が切れた後も署名は有効**として扱われる (タイムスタンプ時点で証明書が有効だったことが暗号学的に証明されるため)。

Coco では DigiCert RFC 3161 サーバ (`http://timestamp.digicert.com`) を使用。代替:

- `http://timestamp.sectigo.com`
- `http://timestamp.globalsign.com/tsa/r6advanced1`
- `http://time.certum.pl`

タイムスタンプサーバ自体は CA 契約と独立。どこの cert でも使える公開サーバ。

## 6. EV cert のハードウェアトークン制約

EV 証明書は CA から **USB ハードウェアトークン (HSM)** に焼かれた状態で送られてくることが多い。物理デバイスをホストに挿す必要があるため **GitHub Actions の hosted runner では直接使えない**。回避策:

### 6-1. SSL.com eSigner (推奨)

SSL.com のクラウド署名サービス。証明書をクラウド HSM に置き、API 経由で署名する。GitHub Actions から `CodeSignTool` または `eSignerCKA` 経由で利用可能。月額数千円。

### 6-2. Azure Key Vault + AzureSignTool

証明書を Azure Key Vault の HSM に置き、`AzureSignTool` (.NET CLI) で署名する。Microsoft アカウントを既に持っていれば最安の選択肢。

### 6-3. DigiCert KeyLocker

DigiCert のクラウド署名。`smctl` CLI を経由して signtool 互換のインタフェースで利用できる。本ドキュメントの release.yml は plain signtool 前提なので、KeyLocker 使用時は `signtool` を `smctl sign` に置き換える。

### 6-4. セルフホスト runner (非推奨)

EV トークンを挿した自前 Windows マシンを GH Actions runner として登録する。物理的な可用性と紛失リスクが高いため非推奨。

## 7. トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| `Import-PfxCertificate` が `The specified password is incorrect` | `WINDOWS_CERT_PASSWORD` の値ミス | .pfx エクスポート時のパスワードを再確認、Secret を更新 |
| `signtool.exe not found in Windows Kits` | runner image に Win10 SDK 未バンドル | `windows-latest` には Win10 SDK が入っている。pinned image の場合は `windows-2022` 以降に上げる |
| `SignTool Error: No certificates were found that met all the given criteria` | thumbprint が `CurrentUser\My` に存在しない | "Install Windows code-signing certificate" ステップのログを確認、`Cert:\CurrentUser\My` に出力された thumbprint と一致するか確認 |
| 署名後の .exe が Windows SmartScreen で警告される | OV cert で reputation 未蓄積 | 数百〜数千 DL で警告が減る。すぐ消したいなら EV へ移行 |
| `The timestamp signature and/or certificate could not be verified` | タイムスタンプサーバが一時的にダウン | 代替サーバ (section 5) に切り替えてリトライ |
| 証明書の有効期限が切れた | 更新忘れ | CA から更新版 .pfx を取得 → section 3 の手順で Secrets 上書き |

## 8. 関連ドキュメント

- [docs/AUTO_UPDATE.md](AUTO_UPDATE.md) — 自動アップデート全体の運用 (本ドキュメントの親)
- Tauri v2 codesigning 公式: <https://v2.tauri.app/distribute/sign/windows/>
- Microsoft Authenticode 仕様: <https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool>
