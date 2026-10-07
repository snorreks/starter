import type { VisionConfig } from '../config.ts';
import { reviewJsonSchema, validateReviewResult, type ReviewResult } from '../schemas.ts';

export interface VisionResponse {
  review: ReviewResult;
  usage: { inputTokens: number | null; outputTokens: number | null; latencyMs: number; calls: number };
}

const readBounded = async (response: Response, maxBytes: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Vision provider returned an empty response body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Vision provider response exceeded ${maxBytes} bytes.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
};

export const requestStructuredVision = async (options: {
  config: VisionConfig;
  image: { bytes: Buffer; mimeType: string };
  prompt: string;
  requirementIds: readonly string[];
  callBudget?: number;
  fetcher?: typeof fetch;
}): Promise<VisionResponse> => {
  const fetcher = options.fetcher ?? fetch;
  const startedAt = Date.now();
  const deadline = startedAt + options.config.timeoutMs;
  const dataUrl = `data:${options.image.mimeType};base64,${options.image.bytes.toString('base64')}`;
  let repair: string | undefined;
  let calls = 0;
  for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
    const content = [
      { type: 'text', text: repair === undefined ? options.prompt : `${options.prompt}\nThe prior response was invalid. Return a corrected JSON object only. Error: ${repair}` },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
    const payload = {
      model: options.config.model,
      stream: false,
      max_tokens: options.config.maxOutputTokens,
      messages: [{ role: 'user', content }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'starter_ui_review_v1', strict: true, schema: reviewJsonSchema() },
      },
      provider: { require_parameters: true },
    };
    let response: Response | undefined;
    let body = '';
    for (let transportAttempt = 0; transportAttempt < 3; transportAttempt += 1) {
      if (options.callBudget !== undefined && calls >= options.callBudget) {
        throw new Error(`Vision provider reached its call budget (${options.callBudget}).`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Vision review exceeded its total deadline.');
      calls += 1;
      response = await fetcher(`${options.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.min(remaining, options.config.timeoutMs)),
      });
      if (response.ok) {
        body = await readBounded(response, 1024 * 1024);
        break;
      }
      const detail = await readBounded(response, 4096);
      if (![429, 500, 502, 503, 504].includes(response.status) || transportAttempt === 2) {
        throw new Error(`Vision provider returned HTTP ${response.status}: ${detail.slice(0, 400)}`);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) ? Math.min(2000, Math.max(100, retryAfter * 1000)) : 250 * (transportAttempt + 1);
      if (Date.now() + delay >= deadline) throw new Error('Vision provider retry would exceed its total deadline.');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (response === undefined || !response.ok) throw new Error('Vision provider transport did not return a usable response.');
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      repair = 'The provider response was not valid JSON.';
      continue;
    }
    const envelope = decoded as {
      choices?: Array<{ message?: { content?: unknown; refusal?: unknown; finish_reason?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const message = envelope.choices?.[0]?.message;
    if (message?.refusal !== undefined && message.refusal !== null) {
      throw new Error('Vision provider refused the review request.');
    }
    if (message?.finish_reason === 'length') throw new Error('Vision provider output was truncated; increase E2E_VISION_MAX_OUTPUT_TOKENS.');
    if (typeof message?.content !== 'string') {
      repair = 'The provider omitted a single JSON content string.';
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(message.content);
      const review = validateReviewResult(parsed, options.requirementIds);
      return {
        review,
        usage: {
          inputTokens: typeof envelope.usage?.prompt_tokens === 'number' ? envelope.usage.prompt_tokens : null,
          outputTokens: typeof envelope.usage?.completion_tokens === 'number' ? envelope.usage.completion_tokens : null,
          latencyMs: Date.now() - startedAt,
          calls,
        },
      };
    } catch (error) {
      repair = error instanceof Error ? error.message.slice(0, 1200) : String(error);
    }
  }
  throw new Error(`Vision provider did not return a valid review after one schema repair: ${repair ?? 'unknown error'}`);
};
