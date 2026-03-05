import { useEffect, useMemo, useState } from "react";
import {
  cloneDashboardConfig,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  normalizeDashboardConfig,
  type DashboardConfig,
  type DashboardShortcuts,
} from "../shared/config";
import {
  keyboardEventToShortcut,
  SHORTCUT_FIELD_LABELS,
  SHORTCUT_FIELD_ORDER,
} from "./shortcuts";

interface SettingsModalProps {
  open: boolean;
  config: DashboardConfig;
  onClose: () => void;
  onSave: (nextConfig: DashboardConfig) => void;
}

function clampPaneWidth(value: number): number {
  return Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, Math.round(value)));
}

function findDuplicateShortcutError(shortcuts: DashboardShortcuts): string | null {
  const seen = new Map<string, keyof DashboardShortcuts>();

  for (const field of SHORTCUT_FIELD_ORDER) {
    const combo = shortcuts[field];
    const existing = seen.get(combo);
    if (existing) {
      return `Shortcut conflict: "${SHORTCUT_FIELD_LABELS[field]}" duplicates "${SHORTCUT_FIELD_LABELS[existing]}".`;
    }
    seen.set(combo, field);
  }

  return null;
}

export function SettingsModal({ open, config, onClose, onSave }: SettingsModalProps) {
  const [draft, setDraft] = useState<DashboardConfig>(() => cloneDashboardConfig(config));
  const [recordingField, setRecordingField] = useState<keyof DashboardShortcuts | null>(null);
  const duplicateShortcutError = useMemo(() => findDuplicateShortcutError(draft.shortcuts), [draft.shortcuts]);

  useEffect(() => {
    if (!open) return;
    setDraft(cloneDashboardConfig(config));
    setRecordingField(null);
  }, [config, open]);

  useEffect(() => {
    if (!open || recordingField) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open, recordingField]);

  useEffect(() => {
    if (!open || !recordingField) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingField(null);
        return;
      }

      const combo = keyboardEventToShortcut(event);
      if (!combo) return;
      setDraft((prev) => ({
        ...prev,
        shortcuts: {
          ...prev.shortcuts,
          [recordingField]: combo,
        },
      }));
      setRecordingField(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, recordingField]);

  if (!open) return null;

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <p className="settings-eyebrow">Dashboard Config</p>
            <h2 id="settings-title">Terminal Preferences</h2>
            <p className="settings-subtitle">Defaults apply to newly created panes only.</p>
          </div>
          <button type="button" className="settings-close-button" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </header>

        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (recordingField) return;
            if (duplicateShortcutError) return;
            const normalized = normalizeDashboardConfig(draft);
            onSave(normalized);
            onClose();
          }}
        >
          <section className="settings-section">
            <h3>Default Terminal Width</h3>
            <div className="settings-width-controls">
              <input
                type="range"
                min={MIN_PANE_WIDTH}
                max={MAX_PANE_WIDTH}
                step={10}
                value={draft.defaultPaneWidth}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  setDraft((prev) => ({ ...prev, defaultPaneWidth: clampPaneWidth(next) }));
                }}
              />
              <label className="settings-width-input-wrap">
                <span>Pixels</span>
                <input
                  type="number"
                  min={MIN_PANE_WIDTH}
                  max={MAX_PANE_WIDTH}
                  step={10}
                  value={draft.defaultPaneWidth}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value);
                    if (!Number.isFinite(next)) return;
                    setDraft((prev) => ({ ...prev, defaultPaneWidth: clampPaneWidth(next) }));
                  }}
                />
              </label>
            </div>
            <p className="settings-note">
              Range: {MIN_PANE_WIDTH}px - {MAX_PANE_WIDTH}px
            </p>
          </section>

          <section className="settings-section">
            <h3>Shortcuts</h3>
            <div className="settings-shortcut-grid">
              {SHORTCUT_FIELD_ORDER.map((field) => {
                const isRecording = recordingField === field;
                return (
                  <div key={field} className="settings-shortcut-row">
                    <span>{SHORTCUT_FIELD_LABELS[field]}</span>
                    <button
                      type="button"
                      className={`settings-shortcut-capture ${isRecording ? "settings-shortcut-capture-recording" : ""}`}
                      onClick={() => setRecordingField(field)}
                    >
                      {isRecording ? "Press keys..." : draft.shortcuts[field]}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="settings-note">Use at least one modifier key. Press Escape to cancel recording.</p>
          </section>

          <footer className="settings-footer">
            {duplicateShortcutError ? (
              <span className="settings-error">{duplicateShortcutError}</span>
            ) : (
              <span className="settings-note">Settings are saved to your config file and synced instantly.</span>
            )}
            <div className="settings-actions">
              <button type="button" className="settings-button settings-button-muted" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="settings-button settings-button-primary"
                disabled={Boolean(recordingField) || Boolean(duplicateShortcutError)}
              >
                Save Changes
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
