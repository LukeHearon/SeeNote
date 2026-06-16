import React, { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  headerAction?: React.ReactNode;
}

/** Small disclosure section (chevron + title) used for optional form fields. */
export default function CollapsibleSection({ title, defaultOpen = false, children, headerAction }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-gray-700/70 pt-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1 text-gray-400 hover:text-gray-200 text-sm transition-colors"
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {title}
        </button>
        {headerAction}
      </div>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}
