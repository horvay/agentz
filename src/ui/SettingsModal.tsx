import { useCallback, useEffect, useState } from "react";
import type { AppUpdateStatus } from "../shared/protocol";
import {
  DEFAULT_VISIBLE_LIVE_PANES,
  MAX_VISIBLE_LIVE_PANES,
  MAX_PANE_WIDTH,
  MIN_VISIBLE_LIVE_PANES,
  MIN_PANE_WIDTH,
  normalizeDashboardConfig,
  normalizeVisibleLivePanes,
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
  updateStatus: AppUpdateStatus;
  onClose: () => void;
  onSave: (nextConfig: DashboardConfig) => void;
  onCheckForUpdates: () => void;
}

function clampPaneWidth(value: number): number {
  return Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, Math.round(value)));
}

function formatVisiblePaneLabel(value: number): string {
  return `${value} live pane${value === 1 ? "" : "s"}`;
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

export function SettingsModal({ open, config, updateStatus, onClose, onSave, onCheckForUpdates }: SettingsModalProps) {
  if (!open) return null;

  return (
    <SettingsModalContent
      config={config}
      updateStatus={updateStatus}
      onClose={onClose}
      onSave={onSave}
      onCheckForUpdates={onCheckForUpdates}
    />
  );
}

interface SettingsModalContentProps {
  config: DashboardConfig;
  updateStatus: AppUpdateStatus;
  onClose: () => void;
  onSave: (nextConfig: DashboardConfig) => void;
  onCheckForUpdates: () => void;
}

function SettingsModalContent({ config, updateStatus, onClose, onSave, onCheckForUpdates }: SettingsModalContentProps) {
  const [recordingField, setRecordingField] = useState<keyof DashboardShortcuts | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  const updateConfig = useCallback(
    (updater: (current: DashboardConfig) => DashboardConfig) => {
      setShortcutError(null);
      onSave(normalizeDashboardConfig(updater(config)));
    },
    [config, onSave],
  );

  useEffect(() => {
    if (recordingField) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, recordingField]);

  useEffect(() => {
    if (!recordingField) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingField(null);
        return;
      }

      const combo = keyboardEventToShortcut(event);
      if (!combo) return;
      const nextShortcuts = {
        ...config.shortcuts,
        [recordingField]: combo,
      };
      const nextError = findDuplicateShortcutError(nextShortcuts);
      if (nextError) {
        setShortcutError(nextError);
        setRecordingField(null);
        return;
      }
      setShortcutError(null);
      onSave(
        normalizeDashboardConfig({
          ...config,
          shortcuts: nextShortcuts,
        }),
      );
      setRecordingField(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [config, onSave, recordingField]);

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
            <p className="settings-eyebrow">agentz settings</p>
            <h2 id="settings-title">Terminal Preferences</h2>
            <p className="settings-subtitle">
              Pane behavior, update prompts, and shortcuts update as soon as you change them.
            </p>
          </div>
          <button type="button" className="settings-close-button" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </header>

        <div className="settings-form">
          <div className="settings-scroll">
            <section className="settings-section">
              <h3>Default Terminal Width</h3>
              <div className="settings-width-controls">
                <input
                  type="range"
                  min={MIN_PANE_WIDTH}
                  max={MAX_PANE_WIDTH}
                  step={10}
                  value={config.defaultPaneWidth}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value);
                    updateConfig((current) => ({ ...current, defaultPaneWidth: clampPaneWidth(next) }));
                  }}
                />
                <label className="settings-width-input-wrap">
                  <span>Pixels</span>
                  <input
                    type="number"
                    min={MIN_PANE_WIDTH}
                    max={MAX_PANE_WIDTH}
                    step={10}
                    value={config.defaultPaneWidth}
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      if (!Number.isFinite(next)) return;
                      updateConfig((current) => ({ ...current, defaultPaneWidth: clampPaneWidth(next) }));
                    }}
                  />
                </label>
              </div>
              <p className="settings-note">
                Range: {MIN_PANE_WIDTH}px - {MAX_PANE_WIDTH}px. Applies to newly created panes.
              </p>
            </section>

            <section className="settings-section">
              <h3>Live Panes In View</h3>
              <div className="settings-width-controls">
                <input
                  type="range"
                  min={MIN_VISIBLE_LIVE_PANES}
                  max={MAX_VISIBLE_LIVE_PANES}
                  step={2}
                  value={config.visibleLivePanes}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value);
                    if (!Number.isFinite(next)) return;
                    updateConfig((current) => ({
                      ...current,
                      visibleLivePanes: normalizeVisibleLivePanes(next),
                    }));
                  }}
                />
                <div className="settings-value-chip" aria-live="polite">
                  {formatVisiblePaneLabel(config.visibleLivePanes)}
                </div>
              </div>
              <p className="settings-note">
                Odd-number cap for fully rendered panes that are currently visible. Default: {DEFAULT_VISIBLE_LIVE_PANES}.
              </p>
            </section>

            <section className="settings-section">
              <h3>App Updates</h3>
              <button
                type="button"
                className={`settings-toggle-card ${config.enableAutoUpdates ? "settings-toggle-card-enabled" : ""}`}
                role="switch"
                aria-checked={config.enableAutoUpdates}
                onClick={() => {
                  updateConfig((current) => ({
                    ...current,
                    enableAutoUpdates: !current.enableAutoUpdates,
                  }));
                }}
              >
                <span className="settings-toggle-copy">
                  <span className="settings-toggle-title">Prompt for release updates</span>
                  <span className="settings-toggle-description">
                    Check GitHub Releases and ask before downloading or restarting to install.
                  </span>
                </span>
                <span className="settings-toggle-track" aria-hidden="true">
                  <span className="settings-toggle-thumb" />
                </span>
              </button>
              <p className="settings-note">
                Turn this off if you want to manage AppImage, macOS, or Windows installs manually.
              </p>
              <div className="settings-update-actions">
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={onCheckForUpdates}
                  disabled={
                    !config.enableAutoUpdates ||
                    updateStatus.state === "checking" ||
                    updateStatus.state === "disabled" ||
                    updateStatus.state === "unsupported"
                  }
                >
                  {updateStatus.state === "checking" ? "Checking..." : "Check now"}
                </button>
                <div className="settings-update-status" aria-live="polite">
                  {updateStatus.message}
                </div>
              </div>
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
                        onClick={() => {
                          setShortcutError(null);
                          setRecordingField(field);
                        }}
                      >
                        {isRecording ? "Press keys..." : config.shortcuts[field]}
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="settings-note">Use at least one modifier key. Press Escape to cancel recording.</p>
              {shortcutError ? <p className="settings-error">{shortcutError}</p> : null}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
