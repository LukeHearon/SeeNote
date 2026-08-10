import { useEffect, useState } from 'react';
import { DiagnosticInfo, getDiagnosticInfo } from '../utils/tauriCommands';

/**
 * App version / OS / build info from the Rust side. Shared by the launch
 * screen (which shows just the version) and the debug console (which shows
 * the full line); pass `enabled: false` to defer the call until a panel opens.
 */
export function useDiagnosticInfo(enabled = true): DiagnosticInfo | null {
  const [info, setInfo] = useState<DiagnosticInfo | null>(null);

  useEffect(() => {
    if (!enabled || info) return;
    let cancelled = false;
    getDiagnosticInfo()
      .then((d) => { if (!cancelled) setInfo(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled, info]);

  return info;
}
