import { Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { sendSms } from '../relay/sms.js';
import { findCoachByPhone, normalizePhone } from '../domain/auth.js';
import {
  acceptOffer,
  declineOffer,
  startCascade,
  upsertOptOut,
  findPendingAskSessionForCoach,
  resolveAskWithoutCascade,
} from '../domain/cascade.js';
import { handleCoachMessage, keywordToken } from '../domain/assistant.js';
import { getLivePending, logAssistant, takeDailyReplySlot } from '../domain/assistantPending.js';
import { APP_BASE_URL } from '../config.js';
import { clipSms } from '../lib/time.js';

export const webhooksRouter = Router();

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
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
  await sendSms({ to: phone, body: clipSms(body) });
  return true;
}

// Inbound SMS: STOP/HELP, roster Y, pending confirm, overflow Y, then the
// model for the coach only. Do not uppercase the whole body — keyword
// checks are case-insensitive on a single token (PLATFORM.md §4.1).
webhooksRouter.post('/webhooks/sms', async (req, res) => {
  const db = getDb();
  const now = new Date();
  const fromRaw = field(req.body, 'from');
  const body = field(req.body, 'body');
  const from = normalizePhone(fromRaw) ?? fromRaw;

  if (!from || !body) {
    res.status(400).send('Missing from or body');
    return;
  }

  const kw = keywordToken(body);

  if (kw === 'STOP') {
    await upsertOptOut(db, from);
    await sendSms({
      to: from,
      body: 'Coachatron: you are opted out. Text HELP for help, or use your booking link.',
    });
    await logAssistant(db, {
      phone: from,
      channel: 'sms',
      rawMessage: body,
      layer: 'keyword',
      intent: 'STOP',
      outcome: 'opted-out',
    });
    res.status(200).send('opted out');
    return;
  }

  if (kw === 'HELP') {
    await sendSms({ to: from, body: 'Coachatron: for help, visit your booking or coach link. Text STOP to opt out.' });
    await logAssistant(db, {
      phone: from,
      channel: 'sms',
      rawMessage: body,
      layer: 'keyword',
      intent: 'HELP',
      outcome: 'help',
    });
    res.status(200).send('help sent');
    return;
  }

  const offer = await findSentOfferForPhone(db, from);
  if (offer) {
    if (kw === 'Y') {
      const accepted = await acceptOffer(db, offer.id);
      res.status(200).send(accepted ? 'offer accepted' : 'offer no longer available');
      return;
    }
    if (kw === 'N') {
      await declineOffer(db, offer.id);
      res.status(200).send('offer declined');
      return;
    }
    const link = offer.token ? `${APP_BASE_URL}/offer/${offer.token}` : APP_BASE_URL;
    await replyOnce(db, from, `Coachatron: reply Y or ${link}`, now);
    res.status(200).send('offer link');
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
            res.status(200).send('cascade started');
            return;
          }
          await resolveAskWithoutCascade(db, pendingAsk);
          res.status(200).send('overflow declined');
          return;
        }
      }
    }

    const reply = await handleCoachMessage(db, coach, body, 'sms', now);
    await sendSms({ to: from, body: reply.text });
    res.status(200).send(reply.kind);
    return;
  }

  await replyOnce(db, from, `Coachatron: use your booking link at ${APP_BASE_URL}`, now);
  res.status(200).send('unrecognized');
});
