// Rule change: the tight-finish salary alert (BuildScreen.tsx's own
// useEffect -- once per level, the moment a locked pick first reaches it)
// now shows as an in-app dialog instead of window.alert. Deliberately
// reuses PickPanel's own modal styles (PickPanel.css's pick-modal-overlay/
// pick-modal/pick-modal-header/pick-modal-footer/pick-modal-actions/
// lock-player) rather than inventing a parallel set -- same dimmed
// backdrop, same centered-card-on-desktop/bottom-sheet-on-mobile layout,
// same theme-aware CSS variables, for free. The only new rules
// (tight-finish-dialog-heading's level colors) live in PickPanel.css too,
// right alongside the pick-tight-finish rules they mirror.
import "./PickPanel.css";
import type { TightFinishLevel, TightFinishStatus } from "./buildStats";

const HEADING: Record<TightFinishLevel, string> = {
  caution: "Caution",
  warning: "Warning",
};

interface Props {
  status: TightFinishStatus;
  onDismiss: () => void;
}

export default function TightFinishDialog({ status, onDismiss }: Props) {
  return (
    <div className="pick-modal-overlay">
      <div className="pick-modal tight-finish-dialog" role="dialog" aria-modal="true" aria-label="Salary alert">
        <div className="pick-modal-header">
          <div>
            <h2 className={`tight-finish-dialog-heading ${status.level}`}>{HEADING[status.level]}</h2>
          </div>
        </div>
        <p className="tight-finish-dialog-message">{status.message}</p>
        <div className="pick-modal-footer">
          <div className="pick-modal-actions">
            <button type="button" className="lock-player" onClick={onDismiss} autoFocus>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
