import React, { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { AnnotationTool } from '../types';
import { annotationToolsSettingsModal as copy } from '../copy/ui';

// A text field that replaces a "+ New tool" button: typing a prefix pops a
// dropdown of matching tools (click, or type the full name + Enter, to pick
// one); typing a name that matches nothing calls onCreateNew. Shared by the
// Annotation Tool Settings modal (empty hotkey slots) and the Labels palette.
export default function NewToolEntry({ annotationTools, onAssignExisting, onCreateNew, className, dropUp }: {
  annotationTools: AnnotationTool[];
  onAssignExisting: (toolIndex: number) => void;
  onCreateNew: (text: string) => void;
  className?: string;
  // Open the match list above the field (for a field pinned to a container's bottom edge).
  dropUp?: boolean;
}) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Rows past this many scroll inside the dropdown.
  const MAX_VISIBLE_MATCHES = 6;
  const ROW_H = 32;

  const trimmed = value.trim();
  const matches = trimmed === ''
    ? []
    : annotationTools
      .map((tool, toolIndex) => ({ tool, toolIndex }))
      .filter(({ tool, toolIndex }) => toolIndex !== 0 && tool.text.toLowerCase().startsWith(trimmed.toLowerCase()));

  const commit = () => {
    if (trimmed === '') return;
    const exactIndex = annotationTools.findIndex((t, i) => i !== 0 && t.text.toLowerCase() === trimmed.toLowerCase());
    if (exactIndex !== -1) onAssignExisting(exactIndex);
    else onCreateNew(trimmed);
    setValue('');
    inputRef.current?.blur();
  };

  const selectMatch = (toolIndex: number) => {
    onAssignExisting(toolIndex);
    setValue('');
    inputRef.current?.blur();
  };

  return (
    <div className={`relative flex items-center gap-1.5 min-w-0 ${className ?? ''}`}>
      <Plus size={10} className="text-slate-500 flex-none" />
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setValue(''); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        placeholder={copy.toolNamePlaceholder}
        className="flex-1 min-w-0 bg-transparent text-xs text-slate-300 placeholder:text-slate-500 outline-none"
      />
      {focused && matches.length > 0 && (
        <div
          className={`absolute left-0 w-full overflow-y-auto bg-slate-900 border border-slate-600 rounded shadow-lg z-10 p-1 space-y-1 ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          style={{ maxHeight: MAX_VISIBLE_MATCHES * ROW_H + 8 }}
        >
          {matches.map(({ tool, toolIndex }) => (
            <button
              key={toolIndex}
              onMouseDown={e => { e.preventDefault(); selectMatch(toolIndex); }}
              className="w-full flex items-center gap-2 h-8 px-2 rounded bg-slate-800 hover:bg-slate-700 transition-colors"
              style={{ borderLeft: `3px solid ${tool.color}` }}
            >
              <span className="text-xs text-white truncate">{tool.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
