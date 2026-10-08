import type { VisionConfig } from '../config.ts';
import { type ReviewResult, validateReviewResult } from '../schemas.ts';

export interface VisionResponse {
  review: ReviewResult;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
    calls: number;
  };
}

const readBounded = async (response: Response, maxBytes: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error('Vision provider returned an empty response body.');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error(`Vision provider response exceeded ${maxBytes} bytes.`);
      }
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
      {
        type: 'text',
        text:
          repair === undefined
            ? `${options.prompt}\n${RESPONSE_CONTRACT}`
            : `${options.prompt}\n${RESPONSE_CONTRACT}\nThe prior response was invalid. Return a corrected JSON object only. Error: ${repair}`,
      },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
    const payload = {
      model: options.config.model,
      stream: false,
      max_tokens: options.config.maxOutputTokens,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      provider: { require_parameters: true },
    };
    let response: Response | undefined;
    let body = '';
    for (let transportAttempt = 0; transportAttempt < 3; transportAttempt += 1) {
      if (options.callBudget !== undefined && calls >= options.callBudget) {
        throw new Error(`Vision provider reached its call budget (${options.callBudget}).`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Vision review exceeded its total deadline.');
      }
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
      const detail = await readBounded(response, 4096).catch(
        () => 'Response body unavailable or exceeds 4096 bytes.',
      );
      if (![429, 500, 502, 503, 504].includes(response.status) || transportAttempt === 2) {
        throw new Error(
          `Vision provider returned HTTP ${response.status}: ${detail.slice(0, 400)}`,
        );
      }
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const delay = Number.isFinite(retryAfter)
        ? Math.min(2000, Math.max(100, retryAfter * 1000))
        : 250 * (transportAttempt + 1);
      if (Date.now() + delay >= deadline) {
        throw new Error('Vision provider retry would exceed its total deadline.');
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (response === undefined || !response.ok) {
      throw new Error('Vision provider transport did not return a usable response.');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      repair = 'The provider response was not valid JSON.';
      continue;
    }
    const envelope = decoded as {
      choices?: Array<{
        message?: { content?: unknown; refusal?: unknown };
        finish_reason?: unknown;
      }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const choice = envelope.choices?.[0];
    const message = choice?.message;
    if (message?.refusal !== undefined && message.refusal !== null) {
      throw new Error('Vision provider refused the review request.');
    }
    if (choice?.finish_reason === 'length') {
      throw new Error(
        'Vision provider output was truncated; increase E2E_VISION_MAX_OUTPUT_TOKENS.',
      );
    }
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
          inputTokens:
            typeof envelope.usage?.prompt_tokens === 'number' ? envelope.usage.prompt_tokens : null,
          outputTokens:
            typeof envelope.usage?.completion_tokens === 'number'
              ? envelope.usage.completion_tokens
              : null,
          latencyMs: Date.now() - startedAt,
          calls,
        },
      };
    } catch (error) {
      repair = error instanceof Error ? error.message.slice(0, 1200) : String(error);
    }
  }
  throw new Error(
    `Vision provider did not return a valid review after one schema repair: ${repair ?? 'unknown error'}`,
  );
};

const RESPONSE_CONTRACT = `Return exactly one JSON object with these required top-level fields: schemaVersion (1), summary (string), dimensions, requirements, issues, reference. dimensions must contain layout, typography, hierarchy, consistency, responsiveFit, and stateClarity. Each dimension has evidence and uncertainty (low, medium, or high), plus either score (integer 0-4) or unassessable (true). requirements is an array of {id, status (met, violated, or unclear), evidence}; copy these requirement IDs exactly once each from the prompt's explicit Requirement IDs line. issues is an array of {dimension, requirementId (one exact supplied ID or null), category, severity (minor, major, or blocker), observation, region, box, impact, correction, uncertainty}. dimension must be one of layout, typography, hierarchy, consistency, responsiveFit, stateClarity. category, observation, region, impact, correction, and uncertainty must be strings. severity must be minor, major, or blocker. box must be null or an object with numeric x, y, width, and height properties from 0 to 1; never use an array. reference is null. Do not include extra fields.`;
