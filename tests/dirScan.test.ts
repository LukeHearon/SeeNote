import { describe, it, expect } from 'vitest';
import { partialUpdateDelayMs } from '../utils/dirScan';
import { tracksWithResults, trackIdent } from '../utils/resultPresence';

describe('partialUpdateDelayMs', () => {
  it('starts at one second and grows with the list', () => {
    expect(partialUpdateDelayMs(0)).toBe(1000);
    expect(partialUpdateDelayMs(200_000)).toBe(3000);
  });
});

describe('trackIdent', () => {
  it('is the path under the media root without extension', () => {
    expect(trackIdent('/m/site/a.b.mp3', '/m')).toBe('site/a.b');
    expect(trackIdent('/m/site/a.mp3', '/m/')).toBe('site/a');
  });
  it('is null outside the root, including a sibling that shares a prefix', () => {
    expect(trackIdent('/other/a.mp3', '/m')).toBeNull();
    expect(trackIdent('/media2/a.mp3', '/m')).toBeNull();
  });
});

describe('tracksWithResults', () => {
  const tracks = ['/m/s1/a.mp3', '/m/s1/b.wav', '/m/s2/a.b.flac', '/m/s2/c.mp3'];

  it('maps annotation files back to their tracks', () => {
    const got = tracksWithResults(tracks, '/m', '/ann', ['/ann/s1/a.txt', '/ann/s2/a.b.txt', '/ann/s9/zzz.txt'], ['.txt']);
    expect([...got].sort()).toEqual(['/m/s1/a.mp3', '/m/s2/a.b.flac']);
  });

  it('counts finished and in-progress buzzdetect files', () => {
    const got = tracksWithResults(
      tracks, '/m', '/bd',
      ['/bd/s1/a_buzzdetect.csv', '/bd/s1/b_buzzpart.csv', '/bd/s2/c.csv'],
      ['_buzzdetect.csv', '_buzzpart.csv'],
    );
    expect([...got].sort()).toEqual(['/m/s1/a.mp3', '/m/s1/b.wav']);
  });

  it('handles Windows separators and a trailing slash on the result root', () => {
    const got = tracksWithResults(['C:\\m\\s\\a.mp3'], 'C:\\m', 'C:\\ann\\', ['C:\\ann\\s\\a.txt'], ['.txt']);
    expect([...got]).toEqual(['C:\\m\\s\\a.mp3']);
  });

  it('ignores files outside the result root', () => {
    expect(tracksWithResults(tracks, '/m', '/ann', ['/elsewhere/s1/a.txt'], ['.txt']).size).toBe(0);
  });
});
