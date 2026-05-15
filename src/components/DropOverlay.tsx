import "./DropOverlay.css";

export default function DropOverlay() {
  return (
    <div className="drop-overlay" role="presentation" aria-hidden="true">
      <div className="drop-overlay__panel">
        <div className="drop-overlay__icon">⬇</div>
        <div className="drop-overlay__title">ここにファイルをドロップして開く</div>
        <div className="drop-overlay__hint">.xlsx / .xlsm / .csv に対応</div>
      </div>
    </div>
  );
}
