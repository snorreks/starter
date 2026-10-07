export interface SupabaseCapturedMail {
  id: string;
  to: string;
  subject: string;
  text: string;
  capturedAt: number;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const stringField = (
  value: Record<string, unknown>,
  primary: string,
  fallback: string,
): string | null => {
  if (typeof value[primary] === 'string') {
    return value[primary] as string;
  }
  if (typeof value[fallback] === 'string') {
    return value[fallback] as string;
  }
  return null;
};

export const readSupabaseCapturedMail = async (
  mailUrl: string,
  recipient: string | null,
  fetcher: typeof fetch = fetch,
): Promise<SupabaseCapturedMail[]> => {
  const base = new URL(mailUrl);
  const listing = await fetcher(new URL('/api/v1/messages?limit=50', base));
  if (!listing.ok) {
    throw new Error(`Local Supabase mail capture returned HTTP ${listing.status}.`);
  }
  const payload = record(await listing.json());
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const output: SupabaseCapturedMail[] = [];
  for (const candidate of messages) {
    const message = record(candidate);
    const id = stringField(message, 'ID', 'id');
    let recipients: string[] = [];
    if (Array.isArray(message.To)) {
      recipients = message.To.map((item) => record(item).Address).filter(
        (item): item is string => typeof item === 'string',
      );
    } else if (typeof message.to === 'string') {
      recipients = [message.to];
    }
    if (
      !id ||
      (recipient !== null &&
        !recipients.some((address) => address.toLowerCase() === recipient.toLowerCase()))
    ) {
      continue;
    }
    const detailResponse = await fetcher(
      new URL(`/api/v1/message/${encodeURIComponent(id)}`, base),
    );
    if (!detailResponse.ok) {
      throw new Error(`Local Supabase mail detail returned HTTP ${detailResponse.status}.`);
    }
    const detail = record(await detailResponse.json());
    const [textResponse, htmlResponse] = await Promise.all([
      fetcher(new URL(`/view/${encodeURIComponent(id)}.txt`, base)),
      fetcher(new URL(`/view/${encodeURIComponent(id)}.html`, base)),
    ]);
    const plainText = textResponse.ok
      ? await textResponse.text()
      : (stringField(detail, 'Text', 'text') ?? '');
    const html = htmlResponse.ok
      ? await htmlResponse.text()
      : (stringField(detail, 'HTML', 'html') ?? '');
    const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((match) =>
      (match[1] ?? '').replaceAll('&amp;', '&'),
    );
    const text = [plainText, ...links].filter(Boolean).join('\n');
    const subject = stringField(message, 'Subject', 'subject') ?? '';
    const created = Date.parse(String(message.Created ?? message.createdAt ?? ''));
    output.push({
      id,
      to: recipients[0] ?? '',
      subject,
      text,
      capturedAt: Number.isNaN(created) ? 0 : created,
    });
  }
  return output;
};
