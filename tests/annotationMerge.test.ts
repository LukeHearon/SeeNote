import { describe, it, expect } from 'vitest';
import { setMergeContent } from '../utils/annotationMerge';

// Mirrors the Rust set-merge tests in
// src-tauri/src/commands/git_sync/annotate.rs (keep both in sync), plus the
// numeric-identity cases specific to the canonical-key form both sides use.

describe('setMergeContent', () => {
  it('unions independent adds', () => {
    const ancestor = '1.0\t2.0\ta\n';
    const ours = '1.0\t2.0\ta\n3.0\t4.0\tb\n';
    const theirs = '1.0\t2.0\ta\n5.0\t6.0\tc\n';
    expect(setMergeContent(ancestor, ours, theirs)).toBe('1.0\t2.0\ta\n3.0\t4.0\tb\n5.0\t6.0\tc\n');
  });

  it('honors a delete on one side', () => {
    const ancestor = '1.0\t2.0\ta\n3.0\t4.0\tb\n';
    const ours = '1.0\t2.0\ta\n';
    const theirs = '1.0\t2.0\ta\n3.0\t4.0\tb\n';
    expect(setMergeContent(ancestor, ours, theirs)).toBe('1.0\t2.0\ta\n');
  });

  it('keeps an add alongside an unrelated delete', () => {
    const ancestor = '1.0\t2.0\ta\n3.0\t4.0\tb\n';
    const ours = '1.0\t2.0\ta\n3.0\t4.0\tb\n5.0\t6.0\tc\n'; // added c
    const theirs = '3.0\t4.0\tb\n'; // deleted a
    expect(setMergeContent(ancestor, ours, theirs)).toBe('3.0\t4.0\tb\n5.0\t6.0\tc\n');
  });

  it('keeps both when each side edits the same extent', () => {
    const ancestor = '10.0\t12.0\tL\n';
    const ours = '10.0\t13.0\tL\n';
    const theirs = '9.0\t12.0\tL\n';
    expect(setMergeContent(ancestor, ours, theirs)).toBe('9.0\t12.0\tL\n10.0\t13.0\tL\n');
  });

  it('sorts by start time', () => {
    const merged = setMergeContent('', '5.0\t6.0\tc\n1.0\t2.0\ta\n', '3.0\t4.0\tb\n');
    expect(merged).toBe('1.0\t2.0\ta\n3.0\t4.0\tb\n5.0\t6.0\tc\n');
  });

  it('produces no trailing newline for an empty result', () => {
    expect(setMergeContent('1.0\t2.0\ta\n', '', '')).toBe('');
  });

  it('treats numeric-precision variants as the same record, preferring ancestor text', () => {
    // `1.234` and `1.23400` are the same record: ancestor's stored text wins,
    // and it is not double-counted as an add + delete.
    const ancestor = '1.23400\t2.00000\ta\n';
    const ours = '1.234\t2.0\ta\n3.0\t4.0\tb\n'; // reserialized at lower precision, added b
    const theirs = '1.23400\t2.00000\ta\n';
    expect(setMergeContent(ancestor, ours, theirs)).toBe('1.23400\t2.00000\ta\n3.0\t4.0\tb\n');
  });

  it('collapses a precision-only whole-file rewrite back to the ancestor', () => {
    const ancestor = '1.2340000\t2.0000000\ta\n3.5000000\t4.5000000\tb\n';
    const ours = '1.234\t2\ta\n3.5\t4.5\tb\n'; // same records, terser serialization
    const theirs = ancestor;
    expect(setMergeContent(ancestor, ours, theirs)).toBe(ancestor);
  });

  it('falls back to non-numeric line identity when fields are not numbers', () => {
    const ancestor = '';
    const ours = 'header line\n';
    const theirs = 'header line\n';
    // Non-numeric start sorts last but the single record is preserved verbatim.
    expect(setMergeContent(ancestor, ours, theirs)).toBe('header line\n');
  });
});
