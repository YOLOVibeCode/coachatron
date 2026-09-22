export interface SendSmsRequest {
  to: string;
  body: string;
}

export async function sendSms(req: SendSmsRequest): Promise<{ id: string }> {
  const base = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
  const res = await fetch(`${base}/sms/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: req.to, body: req.body }),
  });
  if (!res.ok) throw new Error(`relay sms send failed: ${res.status}`);
  return (await res.json()) as { id: string };
}
