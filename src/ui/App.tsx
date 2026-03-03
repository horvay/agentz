import { useEffect, useMemo, useRef, useState } from "react";
import type { LaunchConfig, TerminalFrame } from "../shared/protocol";
import { RpcClient } from "./rpcClient";
import { TerminalPane } from "./TerminalPane";

const rpc = new RpcClient("ws://127.0.0.1:4599");
const FIRST_ID = "term-a";
const SECOND_ID = "term-b";

function App() {
  const [frames, setFrames] = useState<Record<string, TerminalFrame>>({});
  const [status, setStatus] = useState("Connecting...");
  const [paneStatus, setPaneStatus] = useState<Record<string, "booting" | "running" | "exited" | "error">>({
    [FIRST_ID]: "booting",
    [SECOND_ID]: "booting",
  });
  const [activePane, setActivePane] = useState(FIRST_ID);
  const activePaneRef = useRef(FIRST_ID);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitRef = useRef<HTMLDivElement>(null);
  const launchConfigRef = useRef<LaunchConfig>({});
  const createdRef = useRef(false);

  useEffect(() => {
    activePaneRef.current = activePane;
  }, [activePane]);

  useEffect(() => {
    const createTerminals = () => {
      if (createdRef.current) return;
      createdRef.current = true;
      rpc.send({
        type: "create",
        id: FIRST_ID,
        cols: 120,
        rows: 36,
        command: launchConfigRef.current.paneA?.command,
        args: launchConfigRef.current.paneA?.args,
        cwd: launchConfigRef.current.paneA?.cwd,
      });
      rpc.send({
        type: "create",
        id: SECOND_ID,
        cols: 120,
        rows: 36,
        command: launchConfigRef.current.paneB?.command,
        args: launchConfigRef.current.paneB?.args,
        cwd: launchConfigRef.current.paneB?.cwd,
      });
    };

    const disposeReady = rpc.onReady(() => {
      setStatus("Connected");
      rpc.send({ type: "launch-config" });
      // Fallback if server does not reply for any reason.
      window.setTimeout(createTerminals, 200);
    });
    const disposeLaunchConfig = rpc.onLaunchConfig((config) => {
      launchConfigRef.current = config;
      createTerminals();
    });
    const disposeCreated = rpc.onCreated((id) => {
      setPaneStatus((prev) => ({ ...prev, [id]: "running" }));
      setStatus("Connected");
    });
    const disposeFrame = rpc.onFrame((frame) => {
      setFrames((prev) => ({ ...prev, [frame.id]: frame }));
      setPaneStatus((prev) => ({ ...prev, [frame.id]: "running" }));
      setStatus("Connected");
    });
    const disposeError = rpc.onError((message) => {
      setStatus(`RPC error: ${message}`);
      setPaneStatus((prev) => ({ ...prev, [activePaneRef.current]: "error" }));
    });
    const disposeExit = rpc.onExit((id, code) => {
      setStatus(`${id} exited (${code})`);
      setPaneStatus((prev) => ({ ...prev, [id]: "exited" }));
    });

    rpc.send({ type: "launch-config" });
    window.setTimeout(createTerminals, 250);

    return () => {
      disposeReady();
      disposeLaunchConfig();
      disposeCreated();
      disposeFrame();
      disposeError();
      disposeExit();
    };
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const raw = (event.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, raw)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMouseDown = () => {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    const handle = document.getElementById("splitter-handle");
    handle?.addEventListener("mousedown", onMouseDown);
    return () => {
      handle?.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const frameCount = useMemo(() => Object.keys(frames).length, [frames]);
  const connectedLabel = frameCount > 0 ? "Connected" : status;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Ghostty Dashboard MVP</p>
          <h1>Dual PTY Surface Lab</h1>
        </div>
        <div className="status-wrap">
          <span className="status-chip">{connectedLabel}</span>
          <span className="status-metric">{frameCount} active frames</span>
        </div>
      </header>

      <section
        className="pane-grid"
        ref={splitRef}
        style={{
          gridTemplateColumns: `${Math.round(splitRatio * 1000) / 10}% 8px ${Math.round((1 - splitRatio) * 1000) / 10}%`,
        }}
      >
        <TerminalPane
          id={FIRST_ID}
          title="Pane A"
          rpc={rpc}
          frame={frames[FIRST_ID]}
          active={activePane === FIRST_ID}
          status={paneStatus[FIRST_ID]}
          onActivate={setActivePane}
        />
        <div id="splitter-handle" className="splitter" role="separator" aria-orientation="vertical" />
        <TerminalPane
          id={SECOND_ID}
          title="Pane B"
          rpc={rpc}
          frame={frames[SECOND_ID]}
          active={activePane === SECOND_ID}
          status={paneStatus[SECOND_ID]}
          onActivate={setActivePane}
        />
      </section>
    </main>
  );
}

export default App;
