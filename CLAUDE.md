# CLAUDE.md

SeeNote is a Tauri v2 + React/TypeScript desktop app for annotating audio/video files to build ML training datasets.

For domain terms (Track, Annotation Tool, Selection, Ident, etc.), see [`TERMS.md`](TERMS.md). For a quick codebase map, see [`FILEMAP.md`](FILEMAP.md).

## CRITICAL: Time-axis synchrony is the cornerstone invariant

**Every visual element that lives on the time axis must be in exact correspondence with the underlying media — audio samples and video frames — and with each other.** Users are determining ML label boundaries by eye and ear against the spectrogram; any drift between what they see, what they hear, and what they read off annotation boundaries corrupts the ground truth.

The time-axis elements that MUST stay in lockstep:
- **Spectrogram pixels** — each column represents a precise sample window; chunk boundaries must be seamless (see `decoder.rs` sample-accuracy contract)
- **Playhead** — the position must correspond to the media currently being presented, never ahead, never behind
- **Audio playback** — when a selected region is played, playback must be sample-identical with no codec-frame snap
- **Video playback** — frames must align to the same media clock as the audio; never let the `<video>` element drift on its own timeline
- **Annotation boundaries** — rendered rectangles map to exact PCM samples and round-trip through export unchanged
- **Selection region** — the shaded band represents the exact half-open sample interval that will play

**Rules that follow from this invariant:**
1. **The playhead is slave to the media clock; audio and video are both masters.** If either is buffering or stalled, the playhead waits. Never advance it from a wall clock, a timer, or a stale media-element event when the underlying media hasn't actually produced that sample/frame yet.
2. **Compressed-format quirks (MP3/AAC/m4a/ogg/opus, and the audio track of video containers) must be absorbed by the Rust decoder and never surface to the frontend.** The `PcmStream::open` 500ms seek margin + first-packet timestamp tracking in `src-tauri/src/audio/decoder.rs` is the canonical pattern. Both `PcmStream` and `decode_audio_range` share this logic; any new decode path must reuse `PcmStream`.
3. **If a change touches playback, decode, selection math, spectrogram chunking, video frame sync, or annotation export, think explicitly about whether it can drift relative to any of the others.** If yes, it's broken, regardless of whether tests pass.

## No duplicated logic — extract and share

**Do not implement the same logic in two places.** If a piece of functionality exists in one component and a second component needs it, extract it into a shared module — a standalone component, a custom hook, a utility function, or a shared Rust module — and have both call the shared version. Writing a second copy of logic that already exists elsewhere is not acceptable, even if it's faster in the moment.

## Non-obvious constraints

- **Key "0" is reserved** for the Custom Annotation Tool — new annotations get an empty `text` field so the user can type a one-off name. Auto-focus on the annotation text input is triggered by `text === ""`. Do not repurpose key "0".
- **Keep `components/HelpPanel.tsx` current**: when a user-facing behavior or hotkey changes, update the relevant Section and Shortcuts entry in the same change.
- **Tauri IPC**: never call `invoke()` directly from components. All Rust commands are wrapped in `utils/tauriCommands.ts` or `utils/projectCommands.ts` — add a wrapper there. When adding a new Rust command: implement in `src-tauri/src/commands/*.rs`, register in `src-tauri/src/lib.rs` `invoke_handler!`, then add a TypeScript wrapper.

## Releasing a new version

`npm version <x.y.z>` then `git push --follow-tags`. This commits, tags, and syncs the version across `package.json`, `tauri.conf.json`, and `Cargo.toml`. The GitHub Actions workflow picks up the tag and builds a draft release.

## Commit workflow

After completing any task that modifies files, create a git commit — but only after the user has verified the changes. **Workflow: edit → ask user to verify → wait for confirmation → commit.** Never commit proactively. The `local/` directory is gitignored; never stage files from it.
