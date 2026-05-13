import "./BusyOverlay.css";

interface Props {
  label: string;
  /** If true (default), the overlay blocks pointer events on the grid below it
   *  — used during "loading" (initial import) where the snapshot is being
   *  replaced wholesale. Set to false during "saving"/"exporting" per req 5.4.1
   *  which says those states keep editing enabled. */
  blocking?: boolean;
}

// Centered translucent overlay covering the grid. The toolbar stays clickable
// regardless because it lives outside .univer-wrap.
export default function BusyOverlay({ label, blocking = true }: Props) {
  return (
    <div
      className={`busy-overlay ${blocking ? "busy-overlay--blocking" : "busy-overlay--passthrough"}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="busy-overlay__panel">
        <div className="busy-overlay__spinner" aria-hidden="true" />
        <div className="busy-overlay__label">{label}</div>
      </div>
    </div>
  );
}
