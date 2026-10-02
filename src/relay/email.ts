import { relayFetch } from './http.js';
import { coachatronEmailFrom } from '../config.js';

export interface SendEmailRequest {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** POST /email/send on the relay, in its native shape: to, subject, text or
 * html, and optional from / fromName. With no from, the relay sends from its
 * shared, authenticated sender; COACHATRON_EMAIL_FROM switches to
 * no-reply@coachatron.com once that domain is authenticated in SendGrid. */
export async function sendEmail(req: SendEmailRequest): Promise<{ id: string }> {
  const from = coachatronEmailFrom();
  const res = await relayFetch(
    '/email/send',
    {
      method: 'POST',
      body: JSON.stringify({
        to: req.to,
        subject: req.subject,
        text: req.text,
        ...(req.html ? { html: req.html } : {}),
        ...(from ? { from } : {}),
        fromName: 'Coachatron',
      }),
    },
    { appEnv: true },
  );
  if (!res.ok) throw new Error(`relay email send failed: ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { email?: { messageId?: string }; id?: string };
  return { id: String(body.email?.messageId ?? body.id ?? '') };
}
