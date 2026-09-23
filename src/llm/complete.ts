import { LITELLM_TIMEOUT_MS } from '../config.js';
import type { CompleteFn, CompleteRequest } from './schema.js';

export type { ChatMessage, CompleteFn, CompleteRequest } from './schema.js';

async function postOnce(req: CompleteRequest): Promise<unknown> {
  const apiKey = process.env.LITELLM_API_KEY ?? '';
  const base = process.env.LITELLM_BASE ?? 'https://api.noctusoft.com/v1';
  const model = process.env.LITELLM_MODEL ?? 'coachatron';
  if (!apiKey) {
    throw new Error('LITELLM_API_KEY missing');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LITELLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: req.messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'intent', schema: req.schema, strict: true },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`litellm ${res.status}`);
    }
    const data: unknown = await res.json();
    return parseCompletion(data);
  } finally {
    clearTimeout(timer);
  }
}

function parseCompletion(data: unknown): unknown {
  const envelope = data as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = envelope.choices?.[0]?.message?.content;
  if (content && typeof content === 'object') {
    return content;
  }
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('litellm empty content');
  }
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed) as unknown;
}

export async function productionComplete(req: CompleteRequest): Promise<unknown> {
  try {
    return await postOnce(req);
  } catch {
    return await postOnce(req);
  }
}

let impl: CompleteFn = productionComplete;

export function setComplete(fn: CompleteFn): void {
  impl = fn;
}

export function resetComplete(): void {
  impl = productionComplete;
}

/** One closed prompt in, structured intent JSON out. Tests inject a fake. */
export function complete(req: CompleteRequest): Promise<unknown> {
  return impl(req);
}
