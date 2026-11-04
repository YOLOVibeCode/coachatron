import { relayFetch } from './http.js';

export interface SendSmsRequest {
  to: string;
  body: string;
}

export type SendSmsResult =
  | { ok: true; id: string }
  /** code is Twilio's (or the relay's own, e.g. 20429 for its caps);
   * status is the relay's HTTP status, 429 when its limits refused. */
  | { ok: false; code: number; message: string; status: number };

/** The relay answers { success, message: { twilio_sid, ... } }; the sid is
 * what Twilio's status callbacks name (MessageSid), so it is the id the log
 * keeps. A captured dev text has no sid. An older { id } answer still works. */
function providerId(json: unknown): string {
  const body = (json ?? {}) as { id?: unknown; message?: { twilio_sid?: unknown } | null };
  const sid = body.message?.twilio_sid;
  if (typeof sid === 'string' && sid) return sid;
  if (typeof body.id === 'string' && body.id) return body.id;
  return 'unknown';
}

export async function sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
  // X-App-Env (from RELAY_APP_ENV): dev is captured in smtp4dev as an email
  // to sms-<digits>@sms.capture.noctusoft.com and never texted; uat is sent
  // with a "[UAT] " prefix; unset is sent as-is (relay sms-env.js).
  const res = await relayFetch(
    '/sms/send',
    {
      method: 'POST',
      body: JSON.stringify({ to: req.to, body: req.body }),
    },
    { appEnv: true },
  );
  if (res.ok) {
    return { ok: true, id: providerId(await res.json().catch(() => ({}))) };
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
  return { ok: false, code, message, status: res.status };
}
