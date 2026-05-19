import { useEffect, useState } from "react";
import { TEMPLATE_CATALOG, type TemplateInfo } from "../store/templates";
import "./TemplatesGalleryDialog.css";

interface Props {
  /** Invoked with the template id when the user activates a tile. The parent
   *  is responsible for closing the dialog (it can call onClose itself). */
  onUseTemplate: (id: string) => void;
  onClose: () => void;
}

export default function TemplatesGalleryDialog({ onUseTemplate, onClose }: Props) {
  // Default selection on the first template so Enter immediately picks "Blank"
  // — matches Excel's Start screen behaviour where the blank tile is the
  // primary call to action.
  const [selectedId, setSelectedId] = useState<string>(
    TEMPLATE_CATALOG[0]?.id ?? "blank",
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onUseTemplate(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onUseTemplate, selectedId]);

  const renderTile = (t: TemplateInfo) => {
    const isSelected = t.id === selectedId;
    return (
      <li key={t.id}>
        <button
          type="button"
          role="option"
          aria-selected={isSelected}
          className={"tgd-tile" + (isSelected ? " tgd-tile--active" : "")}
          onClick={() => setSelectedId(t.id)}
          onDoubleClick={() => {
            setSelectedId(t.id);
            onUseTemplate(t.id);
          }}
          data-testid={`tgd-tile-${t.id}`}
        >
          <span className="tgd-tile-thumb" aria-hidden="true">
            {t.thumbnailEmoji}
          </span>
          <span className="tgd-tile-name">{t.nameJa}</span>
          <span className="tgd-tile-desc">{t.descriptionJa}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="tgd-backdrop" onClick={onClose}>
      <div
        className="tgd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tgd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tgd-header">
          <h2 id="tgd-title" className="tgd-title">テンプレートから新規作成</h2>
          <button
            type="button"
            className="tgd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="tgd-body">
          <ul className="tgd-grid" role="listbox" aria-label="テンプレート">
            {TEMPLATE_CATALOG.map(renderTile)}
          </ul>
        </div>
        <footer className="tgd-footer">
          <button type="button" className="tgd-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="tgd-btn tgd-btn--primary"
            onClick={() => onUseTemplate(selectedId)}
            data-testid="tgd-use"
          >
            このテンプレートで作成
          </button>
        </footer>
      </div>
    </div>
  );
}
