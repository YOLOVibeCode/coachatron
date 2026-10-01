import { relayFetch } from './http.js';

export interface SendSmsRequest {
  to: string;
  body: string;
}

export type SendSmsResult =
  | { ok: true; id: string }
  | { ok: false; code: number; message: string };

export async function sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
  const res = await relayFetch('/sms/send', {
    method: 'POST',
    body: JSON.stringify({ to: req.to, body: req.body }),
  });
  if (res.ok) {
    const json = (await res.json()) as { id?: string };
    return { ok: true, id: json.id ?? 'unknown' };
  }
  let code = res.status;
  let message = `relay sms send failed: ${res.status}`;
  try {
    const json = (await res.json()) as { code?: number; message?: string; error?: boolean };
    if (typeof json.code === 'number') code = json.code;
    if (typeof json.message === 'string') message = json.message;
  } catch {
    // keep defaults
  }
  return { ok: false, code, message };
}
