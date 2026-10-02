import { useCallback, useState } from 'react';
import type { ProjectFormValues } from '../utils/projectForm';

/** The project form's values plus a patch-style setter (see ProjectBaseFields). */
export function useProjectForm(initial: () => ProjectFormValues) {
  const [values, setValues] = useState(initial);
  const set = useCallback((patch: Partial<ProjectFormValues>) => setValues(v => ({ ...v, ...patch })), []);
  return { values, set };
}
