import { Router, type Request, type Response } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { segmentCount, sendText } from '../domain/outbound.js';
import { findCoachByPhone, normalizePhone } from '../domain/auth.js';
import { acceptOffer, answerAsk, declineOffer, hasOpenAsk, tellMemberClaimed } from '../domain/cascade.js';
import { handleCoachMessage, keywordToken } from '../domain/assistant.js';
import { getLivePending, logAssistant, takeDailyReplySlot } from '../domain/assistantPending.js';
import { createStartLink, phoneHasBooking } from '../domain/startLink.js';
import {
  APP_BASE_URL,
  NODE_ENV,
  SMS_BRAND,
  SUPPORT_EMAIL,
} from '../config.js';
import { clipSms } from '../lib/time.js';
import { formField, parseRelayFormBody, verifyRelaySignature } from '../lib/relay-inbound.js';
import { inboundSmsUrl } from '../lib/inboundSms.js';
import { matchInboundKeyword, overflowReply } from '../domain/sms-keywords.js';
import { clearRevocation, confirmConsentFromReply, hasPendingConsent, revokeConsent } from '../domain/sms-consent.js';

export const smsInboundRouter = Router();
export const smsStatusRouter = Router();

function inboundSecret(): string {
  return (process.env.RELAY_INBOUND_SECRET ?? '').trim();
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

const OVERFLOW_CHOICES_REPLY = 'Coachatron: reply 1 to open a second group, 2 to add a backup coach, or N for no.';

/** The HELP reply: who is texting, where to get help, and how to stop, in
 * one segment (SPEC.md §10). TwiML replies skip the send path, so it is
 * sized here; a long support address drops the description first. The same
 * text belongs in the Messaging Service's own HELP reply. */
export function helpReplyText(): string {
  const tail = 'Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.';
  const wordings = [
    `${SMS_BRAND}: booking and session texts. Help: ${SUPPORT_EMAIL}. ${tail}`,
    `${SMS_BRAND} help: ${SUPPORT_EMAIL}. ${tail}`,
    `${SMS_BRAND} help: ${SUPPORT_EMAIL}. Reply STOP to opt out.`,
  ];
  return wordings.find((text) => segmentCount(text) === 1) ?? wordings[wordings.length - 1];
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

/** The roster member's latest offer from the last day that is no longer
 * open: it expired, was withdrawn, or someone (perhaps they) took the job.
 * A late Y or N answers it. */
async function findClosedOfferForPhone(
  db: DbClient,
  phone: string,
): Promise<{ state: string; token: string | null } | null> {
  const result = await db.query<{ state: string; token: string | null }>(
    `select o.state, o.token
     from offer o
     join roster_member rm on rm.id = o.roster_member_id
     where rm.phone = $1 and o.state <> 'unsent' and o.sent_at > now() - interval '1 day'
     order by o.sent_at desc, o.id desc
     limit 1`,
    [phone],
  );
  return result.rows[0] ?? null;
}

const OFFER_CLOSED_REPLY = 'Coachatron: that offer has closed, so nothing changed. Thanks for answering.';

function offerLink(token: string | null): string {
  return token ? `${APP_BASE_URL}/offer/${token}` : APP_BASE_URL;
}

async function replyOnce(db: DbClient, phone: string, body: string, now: Date): Promise<boolean> {
  const ok = await takeDailyReplySlot(db, phone, now);
  if (!ok) return false;
  await sendText(db, { to: phone, body: clipSms(body), coachId: null, template: 'auto-reply' }, now);
  return true;
}

/** The relay checks Twilio's own signature on every inbound text and
 * status callback and says so here: "1" when it checked out, "0" when not.
 * The relay may forward one whose Twilio signature failed (its log-only
 * mode), still signed with our secret, so a valid relay signature alone
 * does not prove Twilio sent it. Nothing is done without "1"; local
 * testing without a secret has to send the header too. */
const TWILIO_VERIFIED_HEADER = 'x-relay-twilio-verified';

/** True when the relay confirms Twilio sent this request. Otherwise logs
 * one line, answers with empty TwiML, and returns false. */
function sentByTwilio(req: Request, res: Response, route: string): boolean {
  if (req.header(TWILIO_VERIFIED_HEADER) === '1') return true;
  const value = req.header(TWILIO_VERIFIED_HEADER);
  console.warn(`${route}: ignored, ${TWILIO_VERIFIED_HEADER} is ${value === undefined ? 'missing' : value === '0' ? '0' : 'not 1'}`);
  twimlEmpty(res);
  return false;
}

smsInboundRouter.post('/', async (req, res) => {
  const form = verifyOrRespond(req, res, inboundSmsUrl());
  if (!form) return;
  if (!sentByTwilio(req, res, 'sms inbound')) return;

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
      // Someone else may have taken it a moment before. Whoever took it
      // hears it is theirs, with the details.
      if (await acceptOffer(db, offer.id)) await tellMemberClaimed(db, offer.id);
      else await replyOnce(db, from, OFFER_CLOSED_REPLY, now);
      twimlEmpty(res);
      return;
    }
    if (kw === 'N') {
      await declineOffer(db, offer.id);
      twimlEmpty(res);
      return;
    }
    await replyOnce(db, from, `Coachatron: reply Y or ${offerLink(offer.token)}`, now);
    twimlEmpty(res);
    return;
  }

  const coach = await findCoachByPhone(db, from);
  if (coach) {
    // The coach's answer to their open overflow question (SPEC.md §7.3):
    // 1 or 2 always answer it; N answers it unless the assistant is waiting
    // on a Y or N of its own. A bare Y gets the choices again.
    const reply = overflowReply(body);
    if (reply && (await hasOpenAsk(db, coach.id))) {
      if (reply === '1' || reply === '2') {
        await answerAsk(db, coach.id, reply === '1' ? 'second_group' : 'backup');
        twimlEmpty(res);
        return;
      }
      if (!(await getLivePending(db, coach.id, now))) {
        if (reply === 'N') {
          await answerAsk(db, coach.id, 'no');
        } else {
          await sendText(
            db,
            { to: from, body: OVERFLOW_CHOICES_REPLY, coachId: coach.id, template: 'assistant' },
            now,
          );
        }
        twimlEmpty(res);
        return;
      }
    }

    const answer = await handleCoachMessage(db, coach, body, 'sms', now);
    await sendText(db, { to: from, body: answer.text, coachId: coach.id, template: 'assistant' }, now);
    twimlEmpty(res);
    return;
  }

  // A roster member answering an offer that has closed hears so once,
  // instead of the reply for a number we do not know.
  if (kw === 'Y' || kw === 'N') {
    const closed = await findClosedOfferForPhone(db, from);
    if (closed) {
      await replyOnce(
        db,
        from,
        closed.state === 'accepted' ? `Coachatron: you took this one. Details: ${offerLink(closed.token)}` : OFFER_CLOSED_REPLY,
        now,
      );
      twimlEmpty(res);
      return;
    }
  }

  if (await phoneHasBooking(db, from)) {
    await replyOnce(db, from, `Coachatron: use your booking link at ${APP_BASE_URL}`, now);
    twimlEmpty(res);
    return;
  }

  const ok = await takeDailyReplySlot(db, from, now);
  if (ok) {
    const token = await createStartLink(db, from, body, now);
    await sendText(
      db,
      {
        to: from,
        body: `Got it. Tap to see your week and go live: ${APP_BASE_URL}/start/${token}`,
        coachId: null,
        template: 'auto-reply',
        // A start link answers a number we do not know yet.
        visitor: 'always',
      },
      now,
    );
  }
  twimlEmpty(res);
});

smsStatusRouter.post('/', async (req, res) => {
  const form = verifyOrRespond(req, res, smsStatusWebhookPublicUrl());
  if (!form) return;
  if (!sentByTwilio(req, res, 'sms status')) return;

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
