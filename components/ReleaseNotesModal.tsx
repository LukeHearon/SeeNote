import React, { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { releaseNotesModal } from '../copy/ui';
import { Block, Inline, fetchReleaseNotes, parseMarkdown } from '../utils/releaseNotes';
import { openGithubUrl } from '../utils/tauriCommands';

function renderInlines(inlines: Inline[]) {
  return inlines.map((node, i) => {
    switch (node.kind) {
      case 'bold': return <strong key={i} className="text-white font-semibold">{node.text}</strong>;
      case 'code': return <code key={i} className="px-1 py-0.5 bg-gray-800 rounded text-[0.85em]">{node.text}</code>;
      case 'link':
        return node.url.startsWith('https://github.com/')
          ? <button key={i} onClick={() => openGithubUrl(node.url).catch(console.error)} className="text-blue-400 hover:underline">{node.text}</button>
          : <span key={i}>{node.text}</span>;
      default: return <React.Fragment key={i}>{node.text}</React.Fragment>;
    }
  });
}

function renderBlock(block: Block, i: number) {
  switch (block.kind) {
    case 'heading':
      return <h4 key={i} className={`text-white font-semibold ${block.level <= 2 ? 'text-base mt-5' : 'text-sm mt-4'} first:mt-0 mb-2`}>{renderInlines(block.inlines)}</h4>;
    case 'list':
      return (
        <ul key={i} className="list-disc pl-5 space-y-1 mb-3">
          {block.items.map((item, j) => <li key={j}>{renderInlines(item)}</li>)}
        </ul>
      );
    default:
      return <p key={i} className="mb-3">{renderInlines(block.inlines)}</p>;
  }
}

export default function ReleaseNotesModal({ version, fallbackNotes, onClose }: {
  version: string;
  fallbackNotes: string | null;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchReleaseNotes(version)
      .then(body => { if (!cancelled) setNotes(body); })
      .catch(err => {
        console.error('Failed to fetch release notes:', err);
        if (cancelled) return;
        if (fallbackNotes) setNotes(fallbackNotes);
        else setFailed(true);
      });
    return () => { cancelled = true; };
  }, [version, fallbackNotes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blocks = notes ? parseMarkdown(notes) : [];

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-xl border border-gray-700 shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h3 className="text-white font-semibold text-base">{releaseNotesModal.title(version)}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto text-sm text-gray-300 leading-relaxed">
          {failed ? (
            <p className="text-red-400">{releaseNotesModal.loadError}</p>
          ) : notes === null ? (
            <div className="flex items-center gap-2 text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              {releaseNotesModal.loading}
            </div>
          ) : blocks.length === 0 ? (
            <p className="text-gray-400">{releaseNotesModal.empty}</p>
          ) : (
            blocks.map(renderBlock)
          )}
        </div>
      </div>
    </div>
  );
}
