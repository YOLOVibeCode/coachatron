import { relayFetch } from './http.js';

export interface SendSmsRequest {
  to: string;
  body: string;
}

export async function sendSms(req: SendSmsRequest): Promise<{ id: string }> {
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
  if (!res.ok) throw new Error(`relay sms send failed: ${res.status}`);
  return (await res.json()) as { id: string };
}
