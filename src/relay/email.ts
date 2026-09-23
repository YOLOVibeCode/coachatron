import { relayFetch } from './http.js';

export interface SendEmailRequest {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(req: SendEmailRequest): Promise<{ id: string }> {
  const res = await relayFetch(
    '/email/send',
    {
      method: 'POST',
      body: JSON.stringify({
        personalizations: [{ to: [{ email: req.to }] }],
        from: { email: 'noreply@coachatron.com', name: 'Coachatron' },
        subject: req.subject,
        content: [{ type: 'text/plain', value: req.text }],
      }),
    },
    { appEnv: true },
  );
  if (!res.ok) throw new Error(`relay email send failed: ${res.status}`);
  return (await res.json()) as { id: string };
}
