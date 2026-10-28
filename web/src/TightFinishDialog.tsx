// Rule change: the tight-finish salary alert (BuildScreen.tsx's own
// useEffect -- once per level, the moment a locked pick first reaches it)
// shows as an in-app dialog instead of window.alert. Deliberately reuses
// PickPanel's own modal styles (PickPanel.css's pick-modal-overlay/
// pick-modal/pick-modal-header/pick-modal-footer/pick-modal-actions/
// lock-player) rather than inventing a parallel set -- same dimmed
// backdrop, same centered-card-on-desktop/bottom-sheet-on-mobile layout,
// same theme-aware CSS variables, for free. The only new rules
// (tight-finish-dialog-heading's level colors) live in PickPanel.css too,
// right alongside the pick-tight-finish rules they mirror.
//
// Rule change "Tight-finish alerts: new levels + Go back": a third level
// ("critical" -- barely completable) joins caution/warning, and the
// dialog now offers "Go back" (primary) alongside "OK" -- BuildScreen's
// own onGoBack undoes the pick that just triggered this dialog and
// reopens that same pick's own list, so White can choose a cheaper
// player; onDismiss ("OK") just keeps the pick and closes the dialog,
// unchanged from before.
import "./PickPanel.css";
import type { TightFinishLevel, TightFinishStatus } from "./buildStats";

const HEADING: Record<TightFinishLevel, string> = {
  caution: "Caution",
  warning: "Warning",
  critical: "Critical",
};

interface Props {
  status: TightFinishStatus;
  onDismiss: () => void;
  onGoBack: () => void;
}

export default function TightFinishDialog({ status, onDismiss, onGoBack }: Props) {
  return (
    <div className="pick-modal-overlay">
      <div className="pick-modal tight-finish-dialog" role="dialog" aria-modal="true" aria-label="Salary alert">
        <div className="pick-modal-header">
          <div>
            <h2 className={`tight-finish-dialog-heading ${status.level}`}>{HEADING[status.level]}</h2>
          </div>
        </div>
        <p className="tight-finish-dialog-message">{status.message}</p>
        <p className="tight-finish-dialog-hint">Consider going back and picking a cheaper player.</p>
        <div className="pick-modal-footer">
          <div className="pick-modal-actions">
            <button type="button" onClick={onDismiss}>
              OK
            </button>
            <button type="button" className="lock-player" onClick={onGoBack} autoFocus>
              Go back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
