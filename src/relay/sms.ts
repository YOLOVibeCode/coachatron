import { relayFetch } from './http.js';

export interface SendSmsRequest {
  to: string;
  body: string;
}

export async function sendSms(req: SendSmsRequest): Promise<{ id: string }> {
  const res = await relayFetch('/sms/send', {
    method: 'POST',
    body: JSON.stringify({ to: req.to, body: req.body }),
  });
  if (!res.ok) throw new Error(`relay sms send failed: ${res.status}`);
  return (await res.json()) as { id: string };
}
