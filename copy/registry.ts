import { tooltips } from './tooltips';
import * as uiExports from './ui';
import { helpPanel } from './help';
import { withoutRecording, withoutOverrides } from './overrideStore';

export function buildRegistry(): Record<string, string> {
  const out: Record<string, string> = {};

  function flatten(obj: unknown, prefix: string) {
    if (typeof obj === 'string') {
      out[prefix] = obj;
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'function') {
          flatten(v, prefix ? `${prefix}.${k}` : k);
        }
      }
    }
  }

  withoutRecording(() => withoutOverrides(() => {
    flatten(tooltips, 'tooltips');
    flatten(uiExports, 'ui');
    flatten({ helpPanel }, '');
  }));

  return out;
}
