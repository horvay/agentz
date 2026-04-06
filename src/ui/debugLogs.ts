function readBooleanSearchParam(name: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(name);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

export const DEBUG_LOGS_ENABLED = readBooleanSearchParam("debugLogs");
