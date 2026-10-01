import { Router, type Request, type Response } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { sendText } from '../domain/outbound.js';
import { findCoachByPhone, normalizePhone } from '../domain/auth.js';
import {
  acceptOffer,
  declineOffer,
  startCascade,
  findPendingAskSessionForCoach,
  resolveAskWithoutCascade,
} from '../domain/cascade.js';
import { handleCoachMessage, keywordToken } from '../domain/assistant.js';
import { getLivePending, logAssistant, takeDailyReplySlot } from '../domain/assistantPending.js';
import {
  APP_BASE_URL,
  NODE_ENV,
  SMS_BRAND,
  SUPPORT_EMAIL,
} from '../config.js';
import { clipSms } from '../lib/time.js';
import { formField, parseRelayFormBody, verifyRelaySignature } from '../lib/relay-inbound.js';
import { matchInboundKeyword } from '../domain/sms-keywords.js';
import { clearRevocation, confirmConsentFromReply, hasPendingConsent, revokeConsent } from '../domain/sms-consent.js';

export const smsInboundRouter = Router();
export const smsStatusRouter = Router();

function inboundSecret(): string {
  return process.env.RELAY_INBOUND_SECRET ?? '';
}

function smsWebhookPublicUrl(): string {
  return (
    process.env.SMS_WEBHOOK_PUBLIC_URL ??
    `${(process.env.APP_BASE_URL ?? 'https://coachatron.com').replace(/\/$/, '')}/webhooks/sms`
  );
}

function smsStatusWebhookPublicUrl(): string {
  return (
    process.env.SMS_STATUS_WEBHOOK_PUBLIC_URL ??
    `${(process.env.APP_BASE_URL ?? 'https://coachatron.com').replace(/\/$/, '')}/webhooks/sms-status`
  );
}

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
}

function verifyOrRespond(req: Request, res: Response, publicUrl: string): Record<string, string> | null {
  const secret = inboundSecret();
  const body = rawBody(req);
  if (!secret) {
    if (NODE_ENV === 'production') {
      res.status(503).send('Inbound webhook secret not configured');
      return null;
    }
  } else {
    const header = req.header('x-relay-signature');
    if (!verifyRelaySignature(secret, publicUrl, body, header)) {
      res.status(401).send('Unauthorized');
      return null;
    }
  }
  return parseRelayFormBody(body);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlEmpty(res: Response): void {
  res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

function twimlMessage(res: Response, text: string): void {
  res
    .status(200)
    .type('text/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`);
}

function helpReplyText(): string {
  return `${SMS_BRAND}: booking confirmations and reminders for coaching sessions. Help: ${SUPPORT_EMAIL}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`;
}

async function findSentOfferForPhone(
  db: DbClient,
  phone: string,
): Promise<{ id: number; token: string | null } | null> {
  const result = await db.query<{ id: number; token: string | null }>(
    `select o.id, o.token
     from offer o
     join roster_member rm on rm.id = o.roster_member_id
     where rm.phone = $1 and o.state = 'sent' and o.expires_at > now()
     order by o.sent_at desc
     limit 1`,
    [phone],
  );
  return result.rows[0] ?? null;
}

async function replyOnce(db: DbClient, phone: string, body: string, now: Date): Promise<boolean> {
  const ok = await takeDailyReplySlot(db, phone, now);
  if (!ok) return false;
  await sendText(db, { to: phone, body: clipSms(body), coachId: null, template: 'auto-reply' }, now);
  return true;
}

smsInboundRouter.post('/', async (req, res) => {
  const form = verifyOrRespond(req, res, smsWebhookPublicUrl());
  if (!form) return;

  const db = getDb();
  const now = new Date();
  const fromRaw = formField(form, 'From', 'from');
  const body = formField(form, 'Body', 'body');
  const from = normalizePhone(fromRaw);
  const optOutType = formField(form, 'OptOutType');

  if (!from || !body) {
    res.status(400).send('Missing From or Body');
    return;
  }

  const keyword = matchInboundKeyword(body, optOutType);
  if (keyword === 'STOP') {
    await revokeConsent(db, from);
    await logAssistant(db, {
      phone: from,
      channel: 'sms',
      rawMessage: body,
      layer: 'keyword',
      intent: 'STOP',
      outcome: 'opted-out',
    });
    twimlEmpty(res);
    return;
  }
  if (keyword === 'START') {
    await clearRevocation(db, from);
    twimlEmpty(res);
    return;
  }
  if (keyword === 'HELP') {
    twimlMessage(res, helpReplyText());
    await logAssistant(db, {
      phone: from,
      channel: 'sms',
      rawMessage: body,
      layer: 'keyword',
      intent: 'HELP',
      outcome: 'help',
    });
    return;
  }

  const kw = keywordToken(body);
  if (kw === 'Y' && (await hasPendingConsent(db, from))) {
    await confirmConsentFromReply(db, from);
    twimlEmpty(res);
    return;
  }

  const offer = await findSentOfferForPhone(db, from);
  if (offer) {
    if (kw === 'Y') {
      await acceptOffer(db, offer.id);
      twimlEmpty(res);
      return;
    }
    if (kw === 'N') {
      await declineOffer(db, offer.id);
      twimlEmpty(res);
      return;
    }
    const link = offer.token ? `${APP_BASE_URL}/offer/${offer.token}` : APP_BASE_URL;
    await replyOnce(db, from, `Coachatron: reply Y or ${link}`, now);
    twimlEmpty(res);
    return;
  }

  const coach = await findCoachByPhone(db, from);
  if (coach) {
    if (kw === 'Y' || kw === 'N') {
      const assistantPending = await getLivePending(db, coach.id, now);
      if (!assistantPending) {
        const pendingAsk = await findPendingAskSessionForCoach(db, coach.id);
        if (pendingAsk) {
          if (kw === 'Y') {
            await startCascade(db, pendingAsk);
            twimlEmpty(res);
            return;
          }
          await resolveAskWithoutCascade(db, pendingAsk);
          twimlEmpty(res);
          return;
        }
      }
    }

    const reply = await handleCoachMessage(db, coach, body, 'sms', now);
    await sendText(db, { to: from, body: reply.text, coachId: coach.id, template: 'assistant' }, now);
    twimlEmpty(res);
    return;
  }

  await replyOnce(db, from, `Coachatron: use your booking link at ${APP_BASE_URL}`, now);
  twimlEmpty(res);
});

smsStatusRouter.post('/', async (req, res) => {
  const form = verifyOrRespond(req, res, smsStatusWebhookPublicUrl());
  if (!form) return;

  const db = getDb();
  const messageSid = formField(form, 'MessageSid');
  const messageStatus = formField(form, 'MessageStatus');
  const errorCode = formField(form, 'ErrorCode');
  const toRaw = formField(form, 'To', 'to');
  const to = normalizePhone(toRaw);

  if (messageSid && messageStatus) {
    await db.query('update message_log set status = $1 where provider_id = $2', [messageStatus, messageSid]);
  }
  if (errorCode === '21610' && to) {
    await revokeConsent(db, to);
  }
  twimlEmpty(res);
});

/** Legacy export: other routes may attach here later. */
export const webhooksRouter = Router();
