import { isTauri } from '@tauri-apps/api/core';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';

/** Deliver OS callback URLs to native auth without exposing other Tauri APIs. */
export const listenForAuthLinks = async (
  handle: (url: string) => Promise<void>,
): Promise<() => void> => {
  if (!isTauri()) {
    return () => {};
  }
  const current = await getCurrent();
  if (current !== null) {
    for (const url of current) {
      await handle(url);
    }
  }
  const unlisten = await onOpenUrl((urls) => {
    for (const url of urls) {
      void handle(url).catch(() => undefined);
    }
  });
  return unlisten;
};
