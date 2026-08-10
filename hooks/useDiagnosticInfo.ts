import { useEffect, useState } from 'react';
import { DiagnosticInfo, getDiagnosticInfo } from '../utils/tauriCommands';

export interface DiagnosticState {
  info: DiagnosticInfo | null;
  /** Why the fetch failed, surfaced rather than swallowed — see DebugConsole. */
  error: string | null;
}

/**
 * OS / arch / build info from the Rust side. Pass `enabled: false` to defer the
 * call until a panel opens.
 *
 * The app version deliberately does NOT come from here — use APP_VERSION from
 * utils/appVersion, which is inlined at build time and so survives this call
 * failing. A Windows user on v0.16.1 reported the debug console showing no
 * diagnostics at all, and because the failure was swallowed there was no way
 * to tell whether the invoke had rejected or the build was simply older.
 */
export function useDiagnosticInfo(enabled = true): DiagnosticState {
  const [state, setState] = useState<DiagnosticState>({ info: null, error: null });

  useEffect(() => {
    if (!enabled || state.info) return;
    let cancelled = false;
    getDiagnosticInfo()
      .then((info) => { if (!cancelled) setState({ info, error: null }); })
      .catch((err) => {
        if (cancelled) return;
        setState({ info: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [enabled, state.info]);

  return state;
}
