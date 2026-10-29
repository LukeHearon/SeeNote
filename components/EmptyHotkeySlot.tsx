import { AnnotationTool } from '../types';
import NewToolEntry from './NewToolEntry';

// An unassigned hotkey slot: a dashed box holding a NewToolEntry aimed at that
// one key. Typing an existing tool's name assigns it here; a new name opens the
// create dialog for this key. Shared by Annotation Tool Settings and the Labels
// palette; `className` sets the size and border width for each.
export default function EmptyHotkeySlot({ annotationTools, highlighted, onAssignExisting, onCreateNew, dropUp, className }: {
  annotationTools: AnnotationTool[];
  /** A drag is over this slot: outline it in blue. */
  highlighted: boolean;
  onAssignExisting: (toolIndex: number) => void;
  onCreateNew: (text: string) => void;
  dropUp?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex-1 rounded border-dashed px-2 flex items-center min-w-0 transition-colors ${highlighted ? '' : 'border-slate-700 hover:border-slate-500'} ${className ?? ''}`}
      style={highlighted ? { borderColor: '#3b82f6' } : undefined}
    >
      <NewToolEntry
        annotationTools={annotationTools}
        onAssignExisting={onAssignExisting}
        onCreateNew={onCreateNew}
        dropUp={dropUp}
        className="w-full"
      />
    </div>
  );
}
