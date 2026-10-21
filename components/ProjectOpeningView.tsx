import { Loader2 } from 'lucide-react';
import ProjectHeader from './ProjectHeader';
import { projectOpening as copy } from '../copy/ui';

interface Props {
  name: string;
  nameGradientColors?: [string, string] | null;
  /** Abandon the open and return to the launch screen. */
  onCancel: () => void;
}

/**
 * The project window's stand-in while a project is being opened. Reaching the
 * project's settings is a stat and two reads in its folder, and on a sleeping
 * external drive the first of those waits on spin-up, so the click switches
 * here at once (named from the launch list's mirrored name and colors) and the
 * real window replaces it as soon as the settings are in.
 */
export default function ProjectOpeningView({ name, nameGradientColors, onCancel }: Props) {
  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      <ProjectHeader name={name} nameGradientColors={nameGradientColors} onClose={onCancel} sync={null} />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400" role="status">
        <Loader2 size={32} className="animate-spin text-slate-500" />
        <p className="text-sm">{copy.opening}</p>
      </div>
    </div>
  );
}
