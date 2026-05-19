import { useEffect, useState } from "react";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { getLocale, setLocale, t, type Locale } from "../i18n/locale";
import {
  isAutoCheckEnabled,
  setAutoCheckEnabled,
  getLastCheckedAt,
} from "../store/updater";
import "./SettingsDialog.css";

interface Props {
  onClose: () => void;
}

type CsvEncoding = "utf8-bom" | "utf8" | "shift_jis";
type CsvImportEncoding = "auto" | "utf8" | "shift_jis";

const INTERVAL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 15_000, label: "15 秒ごと" },
  { ms: 30_000, label: "30 秒ごと（推奨）" },
  { ms: 60_000, label: "1 分ごと" },
  { ms: 300_000, label: "5 分ごと" },
  { ms: 0, label: "無効" },
];

const CSV_ENCODING_OPTIONS: Array<{ value: CsvEncoding; label: string }> = [
  { value: "utf8-bom", label: "UTF-8 (BOM 付き) — Excel/Sheets 推奨" },
  { value: "utf8", label: "UTF-8 (BOM なし)" },
  { value: "shift_jis", label: "Shift_JIS — レガシーツール向け" },
];

const CSV_IMPORT_ENCODING_OPTIONS: Array<{ value: CsvImportEncoding; label: string }> = [
  { value: "auto", label: "自動判定（推奨）— BOM / UTF-8 / Shift_JIS を順に試行" },
  { value: "utf8", label: "UTF-8 を強制" },
  { value: "shift_jis", label: "Shift_JIS を強制" },
];

export default function SettingsDialog({ onClose }: Props) {
  const intervalMs = useWorkbookStore((s) => s.autoSaveIntervalMs);
  const setAutoSaveInterval = useWorkbookStore((s) => s.setAutoSaveInterval);
  const csvEncoding = useWorkbookStore((s) => s.csvExportEncoding);
  const setCsvExportEncoding = useWorkbookStore((s) => s.setCsvExportEncoding);
  const csvImportEncoding = useWorkbookStore((s) => s.csvImportEncoding);
  const setCsvImportEncoding = useWorkbookStore((s) => s.setCsvImportEncoding);
  const suppressCsvPocWarning = useWorkbookStore((s) => s.suppressCsvPocWarning);
  const setSuppressCsvPocWarning = useWorkbookStore((s) => s.setSuppressCsvPocWarning);

  const [pendingInterval, setPendingInterval] = useState<number>(intervalMs);
  const [pendingEncoding, setPendingEncoding] = useState<CsvEncoding>(csvEncoding);
  const [pendingImportEncoding, setPendingImportEncoding] =
    useState<CsvImportEncoding>(csvImportEncoding);
  const [pendingSuppressPoc, setPendingSuppressPoc] =
    useState<boolean>(suppressCsvPocWarning);
  const initialLocale = getLocale();
  const [pendingLocale, setPendingLocale] = useState<Locale>(initialLocale);
  // Auto-update: read current localStorage state at dialog open; persist on apply.
  const initialAutoUpdate = isAutoCheckEnabled();
  const [pendingAutoUpdate, setPendingAutoUpdate] = useState<boolean>(initialAutoUpdate);
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    void import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setAppVersion)
      .catch(() => undefined);
  }, []);
  const lastChecked = getLastCheckedAt();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = async () => {
    if (pendingInterval !== intervalMs) {
      await setAutoSaveInterval(pendingInterval);
    }
    if (pendingEncoding !== csvEncoding) {
      await setCsvExportEncoding(pendingEncoding);
    }
    if (pendingImportEncoding !== csvImportEncoding) {
      await setCsvImportEncoding(pendingImportEncoding);
    }
    if (pendingSuppressPoc !== suppressCsvPocWarning) {
      await setSuppressCsvPocWarning(pendingSuppressPoc);
    }
    if (pendingLocale !== initialLocale) {
      setLocale(pendingLocale);
    }
    if (pendingAutoUpdate !== initialAutoUpdate) {
      setAutoCheckEnabled(pendingAutoUpdate);
    }
    onClose();
  };

  const isDirty =
    pendingInterval !== intervalMs ||
    pendingEncoding !== csvEncoding ||
    pendingImportEncoding !== csvImportEncoding ||
    pendingSuppressPoc !== suppressCsvPocWarning ||
    pendingLocale !== initialLocale ||
    pendingAutoUpdate !== initialAutoUpdate;

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="settings-title" className="settings-title">{t("dialog.settings")}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="settings-body">
          <details className="settings-section" open>
            <summary className="settings-section-summary">
              <h3>自動保存の頻度</h3>
            </summary>
            <p className="settings-hint">
              編集後この間隔で復元用スナップショットを書き出します。ユーザーの xlsx ファイルは明示保存（Ctrl+S）時のみ更新されます。
            </p>
            <div className="settings-radio-group">
              {INTERVAL_OPTIONS.map((opt) => (
                <label key={opt.ms} className="settings-radio">
                  <input
                    type="radio"
                    name="autosave-interval"
                    checked={pendingInterval === opt.ms}
                    onChange={() => setPendingInterval(opt.ms)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </details>
          <details className="settings-section">
            <summary className="settings-section-summary">
              <h3>CSV エクスポートの文字コード</h3>
            </summary>
            <p className="settings-hint">
              CSV エクスポート時の文字コード既定値。Excel および Google Sheets は UTF-8 BOM 付きを推奨します。レガシーツールに渡す場合は Shift_JIS を選択できます。
            </p>
            <div className="settings-radio-group">
              {CSV_ENCODING_OPTIONS.map((opt) => (
                <label key={opt.value} className="settings-radio">
                  <input
                    type="radio"
                    name="csv-encoding"
                    checked={pendingEncoding === opt.value}
                    onChange={() => setPendingEncoding(opt.value)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </details>
          <details className="settings-section">
            <summary className="settings-section-summary">
              <h3>CSV インポートの文字コード</h3>
            </summary>
            <p className="settings-hint">
              通常は自動判定で問題ありません。判定が外れた場合や、社内ツールが特定の文字コードを使う場合は固定指定に切り替えてください。
            </p>
            <div className="settings-radio-group">
              {CSV_IMPORT_ENCODING_OPTIONS.map((opt) => (
                <label key={opt.value} className="settings-radio">
                  <input
                    type="radio"
                    name="csv-import-encoding"
                    checked={pendingImportEncoding === opt.value}
                    onChange={() => setPendingImportEncoding(opt.value)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </details>
          <details className="settings-section">
            <summary className="settings-section-summary">
              <h3>CSV インポートの通知</h3>
            </summary>
            <p className="settings-hint">
              毎回表示される「CSV PoC インポート」情報バナーを抑制します。エンコーディング判定や上限超過などの警告は引き続き表示されます。
            </p>
            <label className="settings-radio">
              <input
                type="checkbox"
                checked={pendingSuppressPoc}
                onChange={(e) => setPendingSuppressPoc(e.target.checked)}
              />
              <span>「CSV PoC インポート」バナーを表示しない</span>
            </label>
          </details>
          <details className="settings-section">
            <summary className="settings-section-summary">
              <h3>{t("settings.language")}</h3>
            </summary>
            <p className="settings-hint">{t("settings.languageHint")}</p>
            <div className="settings-radio-group">
              <label className="settings-radio">
                <input
                  type="radio"
                  name="coco-locale"
                  checked={pendingLocale === "ja-JP"}
                  onChange={() => setPendingLocale("ja-JP")}
                />
                <span>{t("settings.languageJa")}</span>
              </label>
              <label className="settings-radio">
                <input
                  type="radio"
                  name="coco-locale"
                  checked={pendingLocale === "en-US"}
                  onChange={() => setPendingLocale("en-US")}
                />
                <span>{t("settings.languageEn")}</span>
              </label>
            </div>
          </details>
          <details className="settings-section">
            <summary className="settings-section-summary">
              <h3>{t("settings.section.update")}</h3>
            </summary>
            <p className="settings-hint">
              GitHub Releases から起動時に新バージョンを匿名チェックします。OFF にすると外部通信は行いません。
            </p>
            <label className="settings-radio">
              <input
                type="checkbox"
                checked={pendingAutoUpdate}
                onChange={(e) => setPendingAutoUpdate(e.target.checked)}
              />
              <span>{t("settings.autoUpdate.label")}</span>
            </label>
            <p className="settings-hint" style={{ marginTop: 8 }}>
              {t("settings.autoUpdate.current")}: <strong>v{appVersion || "?"}</strong>
              {lastChecked && (
                <>
                  {" · "}
                  {t("settings.autoUpdate.lastChecked")}:{" "}
                  {new Date(lastChecked).toLocaleString("ja-JP")}
                </>
              )}
            </p>
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("coco:editor-command", { detail: "help-check-update" }),
                );
                onClose();
              }}
            >
              {t("settings.autoUpdate.checkNow")}
            </button>
          </details>
        </div>
        <footer className="settings-footer">
          <button type="button" className="settings-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={apply}
            disabled={!isDirty}
          >
            適用
          </button>
        </footer>
      </div>
    </div>
  );
}
