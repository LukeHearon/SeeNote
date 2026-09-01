import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { AnnotationTool } from '../types';
import { annotationToolsSettingsModal as copy } from '../copy/ui';

// A text field that replaces a "+ New tool" button: typing a prefix pops a
// dropdown of matching tools (click, arrow keys + Enter, or type the full name
// + Enter, to pick one); typing a name that matches nothing calls onCreateNew.
// While the dropdown is open the field lifts into it as its top row. Shared by
// the Annotation Tool Settings modal (empty hotkey slots) and the Labels palette.
export default function NewToolEntry({ annotationTools, onAssignExisting, onCreateNew, className, dropUp }: {
  annotationTools: AnnotationTool[];
  onAssignExisting: (toolIndex: number) => void;
  onCreateNew: (text: string) => void;
  className?: string;
  // Grow the open dropdown upward (for a field pinned to a container's bottom edge).
  dropUp?: boolean;
}) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Rows past this many scroll inside the dropdown.
  const MAX_VISIBLE_MATCHES = 6;
  const ROW_H = 32;

  const trimmed = value.trim();
  const matches = trimmed === ''
    ? []
    : annotationTools
      .map((tool, toolIndex) => ({ tool, toolIndex }))
      .filter(({ tool, toolIndex }) => toolIndex !== 0 && tool.text.toLowerCase().startsWith(trimmed.toLowerCase()));
  const open = focused && matches.length > 0;

  // Keep the highlighted row valid as the query narrows, and scroll it into view.
  useEffect(() => { setActiveIndex(0); }, [trimmed]);
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const reset = () => { setValue(''); inputRef.current?.blur(); };

  const commit = () => {
    if (trimmed === '') return;
    const exactIndex = annotationTools.findIndex((t, i) => i !== 0 && t.text.toLowerCase() === trimmed.toLowerCase());
    if (exactIndex !== -1) onAssignExisting(exactIndex);
    else onCreateNew(trimmed);
    reset();
  };

  const selectMatch = (toolIndex: number) => {
    onAssignExisting(toolIndex);
    reset();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && matches[activeIndex]) selectMatch(matches[activeIndex].toolIndex);
      else commit();
    } else if (e.key === 'Escape') {
      reset();
    }
  };

  const field = (
    <div className="flex items-center gap-1.5 min-w-0">
      <Plus size={10} className="text-slate-500 flex-none" />
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setValue(''); }}
        onKeyDown={onKeyDown}
        placeholder={copy.toolNamePlaceholder}
        className="flex-1 min-w-0 bg-transparent text-xs text-slate-300 placeholder:text-slate-500 outline-none"
      />
    </div>
  );

  // The field lives at one stable tree position; only the wrapper's styling
  // switches between in-flow and the open popover, so the input never remounts
  // (which would drop focus and slam the dropdown shut).
  return (
    <div className={`relative min-h-[1.25rem] min-w-0 ${className ?? ''}`}>
      <div
        className={open
          ? `absolute left-0 right-0 z-20 flex flex-col gap-1 bg-slate-900 border border-slate-600 rounded shadow-lg p-1 ${dropUp ? 'bottom-0' : 'top-0'}`
          : 'flex items-center min-h-[1.25rem]'}
      >
        {field}
        {open && (
          <div
            className="overflow-y-auto flex flex-col gap-1"
            style={{ maxHeight: MAX_VISIBLE_MATCHES * ROW_H }}
          >
            {matches.map(({ tool, toolIndex }, i) => (
              <button
                key={toolIndex}
                ref={el => { itemRefs.current[i] = el; }}
                onMouseDown={e => { e.preventDefault(); selectMatch(toolIndex); }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full flex items-center gap-2 h-8 px-2 rounded transition-colors ${i === activeIndex ? 'bg-slate-700' : 'bg-slate-800 hover:bg-slate-700'}`}
                style={{ borderLeft: `3px solid ${tool.color}` }}
              >
                <span className="text-xs text-white truncate">{tool.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
