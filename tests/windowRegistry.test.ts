import { describe, expect, it } from 'vitest';
import { addWindowListener, forEachWindow, registerWindow } from '../utils/windowRegistry';

// Node has no `window`, so the registry starts empty and these stand in for
// the main window and a popout.
const fakeWindow = () => new EventTarget() as unknown as Window;
const fire = (w: Window, type: string) => (w as unknown as EventTarget).dispatchEvent(new Event(type));

describe('windowRegistry', () => {
  it('delivers a listener added before a window registered', () => {
    const w = fakeWindow();
    let hits = 0;
    const off = addWindowListener('keydown', () => { hits++; });
    const unregister = registerWindow(w);
    fire(w, 'keydown');
    expect(hits).toBe(1);
    unregister();
    off();
  });

  it('delivers a listener to windows registered earlier and later', () => {
    const a = fakeWindow();
    const b = fakeWindow();
    const unregisterA = registerWindow(a);
    let hits = 0;
    const off = addWindowListener('mouseup', () => { hits++; });
    const unregisterB = registerWindow(b);
    fire(a, 'mouseup');
    fire(b, 'mouseup');
    expect(hits).toBe(2);
    off();
    fire(a, 'mouseup');
    fire(b, 'mouseup');
    expect(hits).toBe(2);
    unregisterA();
    unregisterB();
  });

  it('stops delivering from an unregistered window', () => {
    const w = fakeWindow();
    const unregister = registerWindow(w);
    let hits = 0;
    const off = addWindowListener('mousemove', () => { hits++; });
    unregister();
    fire(w, 'mousemove');
    expect(hits).toBe(0);
    off();
  });

  it('visits every registered window', () => {
    const a = fakeWindow();
    const b = fakeWindow();
    const un = [registerWindow(a), registerWindow(b)];
    const seen: Window[] = [];
    forEachWindow(w => seen.push(w));
    expect(seen).toEqual([a, b]);
    un.forEach(u => u());
  });
});
