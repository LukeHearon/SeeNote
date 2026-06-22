import React from 'react';
import { X, GitBranch, ShieldCheck } from 'lucide-react';
import { gitSyncSetupModal } from '../copy/ui';

interface Props {
  onClose: () => void;
  /** When true, renders as a full window instead of an in-app modal overlay. */
  standalone?: boolean;
}

/**
 * Informational step-by-step for setting up a git-tracked (synced) project.
 * Pure guidance — it performs no actions; the actual config is entered in
 * Project Settings → Sync (see ProjectSettingsModal). Instructions target a
 * normal personal GitHub account, not an org/bot setup.
 *
 * GitHub URLs are shown as plain text rather than links: the app runs in a
 * Tauri webview with no external-link opener, so a real <a href> would navigate
 * the app away. Users copy the paths into a browser.
 */
export default function GitSyncSetupModal({ onClose, standalone }: Props) {
  const card = (
    <div
      className={standalone
        ? 'bg-gray-900 flex flex-col h-screen overflow-hidden'
        : 'bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl h-[680px] max-h-[88vh] flex flex-col shadow-2xl overflow-hidden'}
      onMouseDown={e => e.stopPropagation()}
    >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-none">
          <div className="flex items-center gap-2">
            <GitBranch size={18} className="text-blue-400" />
            <h2 className="text-white text-lg font-semibold">{gitSyncSetupModal.title}</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0 text-sm text-gray-300 space-y-5">
          <p>
            SeeNote can sync your annotations to a private GitHub repository so collaborators
            stay in step. Only your annotation files are shared — your media, your annotation
            tools, and your local settings (including your access token) stay on your machine.
            Each labeler keeps their own tools. This is a one-time setup per project.
          </p>

          <Step n={1} title="Create a GitHub account">
            <p>
              Skip this if you already have one. Otherwise go to{' '}
              <Mono>github.com</Mono> and sign up — a free account is enough.
            </p>
          </Step>

          <Step n={2} title="Create a private repository">
            <p>
              On GitHub, click <B>New</B> (or <B>New repository</B>). Give it a name such as{' '}
              <Mono>lab-annotations</Mono>, set it to <B>Private</B>, and leave it empty (don't
              add a README or license). Click <B>Create repository</B>.
            </p>
          </Step>

          <Step n={3} title="Generate an access token">
            <p>On GitHub, go to:</p>
            <p className="mt-1">
              <Mono>Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token</Mono>
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Give the token a name and an expiration you're comfortable with.</li>
              <li>
                Under <B>Repository access</B>, choose <B>Only select repositories</B> and pick
                the repo you made in step 2.
              </li>
              <li>
                In the Permissions section, click the <B>Add Permissions</B> button, check the <B>Contents</B> box,
                and make sure the Access is set to <B>Read and write</B>.
              </li>
              <li>
                Click <B>Generate token</B> and copy it now — GitHub only shows it once.
              </li>
            </ul>
          </Step>

          <Step n={4} title="Enter the details in SeeNote">
            <p>
              Create or open your project, then open <B>Project Settings</B> (the gear icon) and
              expand the <B>Sync (GitHub)</B> section. Paste in:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>the <B>repository URL</B> from step 2,</li>
              <li>the <B>access token</B> from step 3,</li>
              <li>
                <B>your name</B> — recorded as the author of your edits so collaborators can see
                who changed what.
              </li>
            </ul>
            <p className="mt-2">Click <B>Save</B>.</p>
          </Step>

          <Step n={5} title="Sync">
            <p>
              A <B>refresh icon</B> now appears in the project toolbar. Click it to push your
              annotations and pull in everyone else's. Sync whenever you want to share your work
              or catch up on theirs.
            </p>
            <p className="mt-2">
              Annotations merge automatically: if two people label the same recording, both sets
              are kept — only a deliberate deletion removes a label. A short summary shows what
              changed after each sync.
            </p>
          </Step>

          <Step n={6} title="Add collaborators">
            <p>
              In your repository on GitHub, go to{' '}
              <Mono>Settings → Collaborators → Add people</Mono> and invite each collaborator by
              their GitHub username. Once they accept, each person repeats steps 3–5 on their own
              machine — their own token, their own name, the same repository URL. Everyone's edits
              merge together.
            </p>
          </Step>

          <div className="flex items-start gap-2 bg-blue-950/40 border border-blue-900 rounded-lg px-4 py-3">
            <ShieldCheck size={16} className="text-blue-400 flex-none mt-0.5" />
            <p className="text-blue-200 text-xs leading-relaxed">
              Your token is stored only on this computer and is never uploaded to the repository — by
              default in your OS keychain. If an unsigned build keeps prompting for a password, switch
              <B> Token storage</B> to <B>plaintext</B> in Project Settings (saved unencrypted on disk,
              still never pushed). Keep the token private — anyone who has it can write to your
              annotations. If it ever leaks, delete it on GitHub and generate a new one.
            </p>
          </div>
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-gray-700 flex-none">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors"
          >
            {gitSyncSetupModal.gotItButton}
          </button>
        </div>
      </div>
  );

  if (standalone) return card;

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      {card}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-none w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div className="min-w-0">
        <h3 className="text-white font-medium mb-1">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function B({ children }: { children: React.ReactNode }) {
  return <span className="text-white font-medium">{children}</span>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-xs text-blue-300 bg-gray-800 rounded px-1 py-0.5 break-all">
      {children}
    </span>
  );
}
