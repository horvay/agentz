import { useCallback, useEffect, useState } from "react";
import type { AppUpdateStatus } from "../shared/protocol";
import type { RemoteAccessState } from "../shared/webAuth";
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
  remoteAccessState: RemoteAccessState | null;
  remoteAccessControlsEnabled?: boolean;
  updateStatus: AppUpdateStatus;
  onClose: () => void;
  onSave: (nextConfig: DashboardConfig) => void;
  onCheckForUpdates: () => void;
  onApproveRemotePairing: (requestId: string) => void;
  onRejectRemotePairing: (requestId: string) => void;
  onForgetRemoteDevice: (deviceId: string) => void;
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

function formatTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

export function SettingsModal({
  open,
  config,
  remoteAccessState,
  remoteAccessControlsEnabled = true,
  updateStatus,
  onClose,
  onSave,
  onCheckForUpdates,
  onApproveRemotePairing,
  onRejectRemotePairing,
  onForgetRemoteDevice,
}: SettingsModalProps) {
  if (!open) return null;

  return (
    <SettingsModalContent
      config={config}
      remoteAccessState={remoteAccessState}
      remoteAccessControlsEnabled={remoteAccessControlsEnabled}
      updateStatus={updateStatus}
      onClose={onClose}
      onSave={onSave}
      onCheckForUpdates={onCheckForUpdates}
      onApproveRemotePairing={onApproveRemotePairing}
      onRejectRemotePairing={onRejectRemotePairing}
      onForgetRemoteDevice={onForgetRemoteDevice}
    />
  );
}

interface SettingsModalContentProps {
  config: DashboardConfig;
  remoteAccessState: RemoteAccessState | null;
  remoteAccessControlsEnabled: boolean;
  updateStatus: AppUpdateStatus;
  onClose: () => void;
  onSave: (nextConfig: DashboardConfig) => void;
  onCheckForUpdates: () => void;
  onApproveRemotePairing: (requestId: string) => void;
  onRejectRemotePairing: (requestId: string) => void;
  onForgetRemoteDevice: (deviceId: string) => void;
}

function SettingsModalContent({
  config,
  remoteAccessState,
  remoteAccessControlsEnabled,
  updateStatus,
  onClose,
  onSave,
  onCheckForUpdates,
  onApproveRemotePairing,
  onRejectRemotePairing,
  onForgetRemoteDevice,
}: SettingsModalContentProps) {
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
              Pane behavior, remote access, update prompts, and shortcuts update as soon as you change them.
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
              <h3>Remote Access</h3>
              <button
                type="button"
                className={`settings-toggle-card ${config.remoteAccess.enabled ? "settings-toggle-card-enabled" : ""}`}
                role="switch"
                aria-checked={config.remoteAccess.enabled}
                disabled={!remoteAccessControlsEnabled}
                onClick={() => {
                  updateConfig((current) => ({
                    ...current,
                    remoteAccess: {
                      enabled: !current.remoteAccess.enabled,
                    },
                  }));
                }}
              >
                <span className="settings-toggle-copy">
                  <span className="settings-toggle-title">Expose this desktop on the network</span>
                  <span className="settings-toggle-description">
                    {remoteAccessControlsEnabled
                      ? "Browser clients must enter the generated passcode for every new session, then wait for approval here the first time."
                      : "Remote access settings stay desktop-only, even when you open agentz from another device."}
                  </span>
                </span>
                <span className="settings-toggle-track" aria-hidden="true">
                  <span className="settings-toggle-thumb" />
                </span>
              </button>
              <div className="settings-remote-grid">
                <div className="settings-remote-card">
                  <span className="settings-remote-label">Pairing passcode</span>
                  <strong className="settings-remote-passcode">
                    {config.remoteAccess.enabled
                      ? remoteAccessControlsEnabled
                        ? remoteAccessState?.passcode ?? "Desktop only"
                        : "Desktop only"
                      : "Disabled"}
                  </strong>
                  <p className="settings-note">
                    Three failed passcode attempts lock all new pairings until the desktop app restarts. Network exposure always starts disabled again on the next launch.
                  </p>
                </div>
                <div className="settings-remote-card">
                  <span className="settings-remote-label">Reachable URLs</span>
                  {config.remoteAccess.enabled && remoteAccessState?.urls.length
                    ? (
                      <div className="settings-remote-url-list">
                        {remoteAccessState.urls.map((url) => <code key={url}>{url}</code>)}
                      </div>
                    )
                    : <p className="settings-note">Enable remote access in the desktop app to publish URLs for other devices.</p>}
                </div>
              </div>
              {!remoteAccessControlsEnabled
                ? <p className="settings-note">Open Settings on the desktop app to change exposure, passcodes, or approvals.</p>
                : null}
              {remoteAccessState?.pairingsLocked && remoteAccessControlsEnabled
                ? <p className="settings-error">Pairing is locked until the app restarts.</p>
                : null}
              <section className="settings-remote-subsection">
                <div className="settings-remote-subsection-header">
                  <h4>Pending approvals</h4>
                  <span>{remoteAccessState?.pendingRequests.length ?? 0}</span>
                </div>
                {remoteAccessControlsEnabled && remoteAccessState?.pendingRequests.length
                  ? (
                    <div className="settings-approval-list">
                      {remoteAccessState.pendingRequests.map((request) => (
                        <div key={request.id} className="settings-approval-card">
                          <div className="settings-approval-copy">
                            <strong>{request.deviceName}</strong>
                            <span>{request.remoteAddress}</span>
                            <span>Requested {formatTimeLabel(request.requestedAt)}</span>
                          </div>
                          <div className="settings-approval-actions">
                            <button
                              type="button"
                              className="settings-secondary-button"
                              onClick={() => onApproveRemotePairing(request.id)}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="settings-secondary-button settings-secondary-button-danger"
                              onClick={() => onRejectRemotePairing(request.id)}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                  : <p className="settings-note">{remoteAccessControlsEnabled ? "No devices are waiting for approval right now." : "Pending approvals are only manageable from the desktop app."}</p>}
              </section>

              <section className="settings-remote-subsection">
                <div className="settings-remote-subsection-header">
                  <h4>Approved devices</h4>
                  <span>{remoteAccessState?.approvedDevices.length ?? 0}</span>
                </div>
                {remoteAccessControlsEnabled && remoteAccessState?.approvedDevices.length
                  ? (
                    <div className="settings-approval-list">
                      {remoteAccessState.approvedDevices.map((device) => (
                        <div key={device.id} className="settings-approval-card">
                          <div className="settings-approval-copy">
                            <strong>{device.label}</strong>
                            <span>Approved {formatTimeLabel(device.approvedAt)}</span>
                            <span>Last seen {formatTimeLabel(device.lastSeenAt)}</span>
                          </div>
                          <div className="settings-approval-actions">
                            <button
                              type="button"
                              className="settings-secondary-button settings-secondary-button-danger"
                              onClick={() => onForgetRemoteDevice(device.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                  : <p className="settings-note">{remoteAccessControlsEnabled ? "Approved browsers show up here and can be removed at any time." : "Approved devices are listed and managed from the desktop app."}</p>}
              </section>
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
