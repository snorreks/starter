/** Refresh once per return, even when visibility and focus both announce it. */
export const refreshOnReturn = (
  refresh: () => void,
  doc: Pick<Document, 'visibilityState' | 'hasFocus' | 'addEventListener' | 'removeEventListener'>,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): (() => void) => {
  let returned = doc.visibilityState === 'visible' && doc.hasFocus();
  const onLeave = (): void => {
    returned = false;
  };
  const onReturn = (): void => {
    if (doc.visibilityState !== 'visible') {
      onLeave();
      return;
    }
    if (!returned) {
      returned = true;
      refresh();
    }
  };
  doc.addEventListener('visibilitychange', onReturn);
  win.addEventListener('focus', onReturn);
  win.addEventListener('blur', onLeave);
  return () => {
    doc.removeEventListener('visibilitychange', onReturn);
    win.removeEventListener('focus', onReturn);
    win.removeEventListener('blur', onLeave);
  };
};
