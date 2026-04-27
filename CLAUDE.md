# CLAUDE.md

SeeNote is a Tauri v2 + React/TypeScript desktop app for annotating audio/video files to build ML training datasets.

For domain terms (Track, Annotation Tool, Selection, Ident, etc.), see [`TERMS.md`](TERMS.md).

## CRITICAL: Sample-level synchrony is the cornerstone invariant

**Every visual element that lives on the time axis must be in exact 1:1 correspondence with the underlying audio samples, and with each other.** Users are determining ML label boundaries by eye and ear against the spectrogram; any drift between what they see and what they hear corrupts the ground truth.

The time-axis elements that MUST stay in lockstep:
- **Spectrogram pixels** — each column represents a precise sample window; chunk boundaries must be seamless (see `decoder.rs` sample-accuracy contract)
- **Playhead** — the position must correspond to the sample currently being emitted by the audio hardware, never ahead, never behind
- **Audio playback** — when a selected region is played, playback must be sample-identical with no codec-frame snap
- **Annotation boundaries** — rendered rectangles map to exact PCM samples and round-trip through export unchanged
- **Selection region** — the shaded band represents the exact half-open sample interval that will play

**Rules that follow from this invariant:**
1. **The playhead is slave to the audio clock.** If audio is buffering or stalled, the playhead waits. Never advance the playhead from a wall clock, a timer, or a stale media-element event when the audio hasn't actually produced that sample yet.
2. **Compressed-format quirks (MP3/AAC/m4a/ogg/opus) must be absorbed by the Rust decoder and never surface to the frontend.** The `PcmStream::open` 500ms seek margin + first-packet timestamp tracking in `src-tauri/src/audio/decoder.rs` is the canonical pattern. Both `PcmStream` and `decode_audio_range` share this logic; any new decode path must reuse `PcmStream`.
3. **If a change touches playback, decode, selection math, spectrogram chunking, or annotation export, think explicitly about whether it can drift relative to any of the other four.** If yes, it's broken, regardless of whether tests pass.

## Non-obvious constraints

- **Key "0" is reserved** for the Custom Annotation Tool — new annotations get an empty `text` field so the user can type a one-off name. Auto-focus on the annotation text input is triggered by `text === ""`. Do not repurpose key "0".
- **Tauri IPC**: never call `invoke()` directly from components. All Rust commands are wrapped in `utils/tauriCommands.ts` or `utils/projectCommands.ts` — add a wrapper there. When adding a new Rust command: implement in `src-tauri/src/commands/*.rs`, register in `src-tauri/src/lib.rs` `invoke_handler!`, then add a TypeScript wrapper.

## Commit workflow

After completing any task that modifies files, create a git commit — but only after the user has verified the changes. **Workflow: edit → ask user to verify → wait for confirmation → commit.** Never commit proactively. The `local/` directory is gitignored; never stage files from it.

## local/TODO.md

`local/TODO.md` tracks outstanding work items. After implementing an item, remove it from the file. If you implement everything, leave only the NOTE header.
