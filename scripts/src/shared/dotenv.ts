/** Parse the deliberately small dotenv grammar accepted by Starter's local files. */
export const parseDotenv = (source: string, label: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const [index, original] of source.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${label}: unsupported dotenv syntax on line ${index + 1}.`);
    }
    const key = match[1] as string;
    if (Object.hasOwn(values, key)) {
      throw new Error(`${label}: duplicate ${key} on line ${index + 1}.`);
    }
    const raw = match[2] as string;
    let value: string;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0] as string;
      const end = raw.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) {
        throw new Error(`${label}: malformed quoted value for ${key} on line ${index + 1}.`);
      }
      const inner = raw.slice(1, end);
      value =
        quote === '"'
          ? inner.replace(
              /\\([\\"nrt])/g,
              (_all, escaped: string) =>
                ({
                  '\\': '\\',
                  '"': '"',
                  n: '\n',
                  r: '\r',
                  t: '\t',
                })[escaped] as string,
            )
          : inner;
    } else {
      if (/["']/.test(raw)) {
        throw new Error(`${label}: quote must enclose the whole ${key} value.`);
      }
      value = raw.replace(/\s+#.*$/, '').trimEnd();
    }
    values[key] = value;
  }
  return values;
};
