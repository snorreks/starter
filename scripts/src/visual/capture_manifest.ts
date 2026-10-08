/** Rejects a producer digest that does not describe the screenshot bytes. */
export const assertCaptureSha256 = (declared: unknown, actual: string, path: string): void => {
  if (typeof declared !== 'string' || !/^[a-f0-9]{64}$/.test(declared)) {
    throw new Error(`Capture manifest omitted a valid SHA-256 for ${path}.`);
  }
  if (declared !== actual) {
    throw new Error(`Capture hash mismatch for ${path}.`);
  }
};
