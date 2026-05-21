// Per-host UrlFetch credential management (#180). Embedded in SettingsDialog.
//
// Lets the user attach a Bearer token / API key / OAuth client-credentials
// grant to a host pattern. Secrets are written to the OS secure store by Rust;
// this component never reads a secret back — the list shows masked summaries
// only, so stored values render as `••••`.

import { useEffect, useState } from "react";
import {
  type CredentialKind,
  type UrlFetchCredentialInput,
  type UrlFetchCredentialSummary,
  deleteUrlFetchCredential,
  isValidCredentialInput,
  listUrlFetchCredentials,
  setUrlFetchCredential,
} from "../store/urlFetch";

const KIND_LABELS: Record<CredentialKind, string> = {
  bearer: "Bearer トークン",
  api_key: "API キー (ヘッダ指定)",
  oauth_client_credentials: "OAuth 2.0 (client credentials)",
};

const MASK = "••••••••";

interface DraftState {
  host: string;
  kind: CredentialKind;
  secret: string;
  headerName: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
}

const EMPTY_DRAFT: DraftState = {
  host: "",
  kind: "bearer",
  secret: "",
  headerName: "",
  tokenUrl: "",
  clientId: "",
  scope: "",
};

export default function UrlFetchCredentialsEditor() {
  const [items, setItems] = useState<UrlFetchCredentialSummary[]>([]);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void listUrlFetchCredentials()
      .then((list) => setItems(Array.isArray(list) ? list : []))
      .catch(() => {
        // Best-effort: leave the list empty if the store can't be read.
        setItems([]);
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  const draftToInput = (): UrlFetchCredentialInput => ({
    host: draft.host,
    kind: draft.kind,
    secret: draft.secret,
    headerName:
      draft.kind === "api_key" && draft.headerName.trim()
        ? draft.headerName.trim()
        : undefined,
    tokenUrl:
      draft.kind === "oauth_client_credentials"
        ? draft.tokenUrl.trim()
        : undefined,
    clientId:
      draft.kind === "oauth_client_credentials"
        ? draft.clientId.trim()
        : undefined,
    scope:
      draft.kind === "oauth_client_credentials" && draft.scope.trim()
        ? draft.scope.trim()
        : undefined,
  });

  const onAdd = () => {
    const input = draftToInput();
    if (!isValidCredentialInput(input)) {
      setError(
        "入力を確認してください: ホスト名 (例 api.example.com / *.example.com)、シークレット、OAuth の場合はトークン URL と client_id が必要です。",
      );
      return;
    }
    setError(null);
    setBusy(true);
    void setUrlFetchCredential(input)
      .then(() => {
        setDraft(EMPTY_DRAFT);
        refresh();
      })
      .catch((e) => {
        setError(`保存に失敗しました: ${String(e)}`);
      })
      .finally(() => setBusy(false));
  };

  const onDelete = (host: string) => {
    setBusy(true);
    void deleteUrlFetchCredential(host)
      .then(refresh)
      .catch((e) => setError(`削除に失敗しました: ${String(e)}`))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <p className="settings-hint">
        許可ドメインごとに認証情報を保存します。値は OS のセキュアストレージ
        (Windows 資格情報マネージャー / macOS キーチェーン / Linux Secret
        Service) に保存され、平文ファイルには書き込まれません。一致するホストへの{" "}
        <code>http_fetch</code>{" "}
        には自動で <code>Authorization</code>{" "}
        が付与されます (呼び出し側が明示したヘッダが優先)。
      </p>

      {items.length > 0 && (
        <table className="url-fetch-cred-table">
          <thead>
            <tr>
              <th>ホスト</th>
              <th>種別</th>
              <th>値</th>
              <th>
                <span className="url-fetch-cred-sr">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.host}>
                <td>
                  <code>{c.host}</code>
                </td>
                <td>{KIND_LABELS[c.kind]}</td>
                <td>
                  <span
                    className="url-fetch-cred-mask"
                    aria-label="保存済み (マスク表示)"
                    title="保存済み"
                  >
                    {MASK}
                  </span>
                  {c.kind === "oauth_client_credentials" && c.clientId && (
                    <span className="url-fetch-cred-meta">
                      {" "}
                      client_id: <code>{c.clientId}</code>
                    </span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={busy}
                    onClick={() => onDelete(c.host)}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="url-fetch-cred-draft">
        <div className="url-fetch-cred-row">
          <label className="url-fetch-cred-field">
            <span>ホスト</span>
            <input
              type="text"
              value={draft.host}
              spellCheck={false}
              placeholder="api.example.com"
              onChange={(e) => setDraft({ ...draft, host: e.target.value })}
            />
          </label>
          <label className="url-fetch-cred-field">
            <span>種別</span>
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft({ ...draft, kind: e.target.value as CredentialKind })
              }
            >
              <option value="bearer">{KIND_LABELS.bearer}</option>
              <option value="api_key">{KIND_LABELS.api_key}</option>
              <option value="oauth_client_credentials">
                {KIND_LABELS.oauth_client_credentials}
              </option>
            </select>
          </label>
        </div>

        {draft.kind === "api_key" && (
          <div className="url-fetch-cred-row">
            <label className="url-fetch-cred-field">
              <span>ヘッダ名 (既定: Authorization)</span>
              <input
                type="text"
                value={draft.headerName}
                spellCheck={false}
                placeholder="X-Api-Key"
                onChange={(e) =>
                  setDraft({ ...draft, headerName: e.target.value })
                }
              />
            </label>
          </div>
        )}

        {draft.kind === "oauth_client_credentials" && (
          <>
            <div className="url-fetch-cred-row">
              <label className="url-fetch-cred-field">
                <span>トークン URL</span>
                <input
                  type="text"
                  value={draft.tokenUrl}
                  spellCheck={false}
                  placeholder="https://auth.example.com/oauth/token"
                  onChange={(e) =>
                    setDraft({ ...draft, tokenUrl: e.target.value })
                  }
                />
              </label>
            </div>
            <div className="url-fetch-cred-row">
              <label className="url-fetch-cred-field">
                <span>client_id</span>
                <input
                  type="text"
                  value={draft.clientId}
                  spellCheck={false}
                  onChange={(e) =>
                    setDraft({ ...draft, clientId: e.target.value })
                  }
                />
              </label>
              <label className="url-fetch-cred-field">
                <span>scope (任意)</span>
                <input
                  type="text"
                  value={draft.scope}
                  spellCheck={false}
                  onChange={(e) =>
                    setDraft({ ...draft, scope: e.target.value })
                  }
                />
              </label>
            </div>
          </>
        )}

        <div className="url-fetch-cred-row">
          <label className="url-fetch-cred-field url-fetch-cred-field--grow">
            <span>
              {draft.kind === "oauth_client_credentials"
                ? "client_secret"
                : draft.kind === "api_key"
                  ? "API キー"
                  : "Bearer トークン"}
            </span>
            <input
              type="password"
              value={draft.secret}
              spellCheck={false}
              autoComplete="off"
              placeholder="••••••••"
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="settings-btn settings-btn--primary url-fetch-cred-add"
            disabled={busy}
            onClick={onAdd}
          >
            追加
          </button>
        </div>
      </div>

      {error && <p className="settings-hint url-fetch-cred-error">{error}</p>}
    </div>
  );
}
