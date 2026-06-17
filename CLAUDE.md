# CLAUDE.md

SeeNote is a Tauri v2 + React/TypeScript desktop app for annotating audio/video files to build ML training datasets.

For domain terms (Track, Annotation Tool, Selection, Ident, etc.), see [`TERMS.md`](TERMS.md). For a quick codebase map, see [`FILEMAP.md`](FILEMAP.md).


## No duplicated logic — extract and share

**Do not implement the same logic in two places.** If a piece of functionality exists in one component and a second component needs it, extract it into a shared module — a standalone component, a custom hook, a utility function, or a shared Rust module — and have both call the shared version. Writing a second copy of logic that already exists elsewhere is not acceptable, even if it's faster in the moment.

## Non-obvious constraints

- **Key "0" is reserved** for the Custom Annotation Tool — new annotations get an empty `text` field so the user can type a one-off name. Auto-focus on the annotation text input is triggered by `text === ""`. Do not repurpose key "0".
- **Keep `components/HelpPanel.tsx` current**: when a user-facing behavior or hotkey changes, update the relevant Section and Shortcuts entry in the same change.
- **Tauri IPC**: never call `invoke()` directly from components. All Rust commands are wrapped in `utils/tauriCommands.ts` or `utils/projectCommands.ts` — add a wrapper there. When adding a new Rust command: implement in `src-tauri/src/commands/*.rs`, register in `src-tauri/src/lib.rs` `invoke_handler!`, then add a TypeScript wrapper.

## Tests

- Frontend (vitest, node env): `npm test`. Specs live in `tests/**/*.test.ts` and target pure functions in `utils/` and `MultiTierSpectrogramCache.ts`. `tests/setup.ts` mocks `@tauri-apps/api/core` so modules that call `invoke()` at construction time don't blow up.
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml`. Unit tests live alongside the modules they cover (`audio/decoder.rs`, `audio/fft.rs`, `commands/filesystem.rs`). One test in `decoder.rs` (`chunked_matches_oneshot`) is `#[ignore]`d — it needs a real fixture at `local/test.mp3`.
- When adding new pure functions to `utils/`, add a corresponding test. When touching sample/time/pixel math, FFT layout, path resolution, or annotation export, run the suite — those tests pin the cornerstone time-axis-synchrony invariant and the portable-project path contract.

## Releasing a new version

`npm version <x.y.z>` then `git push --follow-tags`. This commits, tags, and syncs the version across `package.json`, `tauri.conf.json`, and `Cargo.toml`. The GitHub Actions workflow picks up the tag and builds a draft release.

## Commit workflow

After completing any task that modifies files, create a git commit — but only after the user has verified the changes. **Workflow: edit → ask user to verify → wait for confirmation → commit.** Never commit proactively. The `local/` directory is gitignored; never stage files from it.
