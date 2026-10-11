import { expect, test } from 'bun:test';
import { refreshOnReturn } from './refresh_on_return.ts';

for (const order of [
  ['visibilitychange', 'focus'],
  ['focus', 'visibilitychange'],
]) {
  test(`refreshes once when returning via ${order.join(' then ')}`, () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
      hasFocus: () => true,
    });
    const win = new EventTarget();
    let calls = 0;
    const stop = refreshOnReturn(
      () => {
        calls += 1;
      },
      doc,
      win,
    );
    win.dispatchEvent(new Event('blur'));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toBe(0);
    doc.visibilityState = 'visible';
    for (const event of order) {
      (event === 'focus' ? win : doc).dispatchEvent(new Event(event));
    }
    expect(calls).toBe(1);
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('focus'));
    expect(calls).toBe(2);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toBe(3);
    stop();
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('focus'));
    expect(calls).toBe(3);
  });
}

test('refreshes on first focus when mounted in a visible, unfocused window', () => {
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
    hasFocus: () => false,
  });
  const win = new EventTarget();
  let calls = 0;
  const stop = refreshOnReturn(
    () => {
      calls += 1;
    },
    doc,
    win,
  );
  win.dispatchEvent(new Event('focus'));
  expect(calls).toBe(1);
  stop();
});
