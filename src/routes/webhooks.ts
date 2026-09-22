import { Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { sendSms } from '../relay/sms.js';
import { findCoachByPhone } from '../domain/auth.js';
import {
  acceptOffer,
  declineOffer,
  startCascade,
  upsertOptOut,
  findPendingAskSessionForCoach,
  resolveAskWithoutCascade,
} from '../domain/cascade.js';

export const webhooksRouter = Router();

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function findSentOfferForPhone(db: DbClient, phone: string): Promise<{ id: number } | null> {
  const result = await db.query<{ id: number }>(
    `select o.id
     from offer o
     join roster_member rm on rm.id = o.roster_member_id
     where rm.phone = $1 and o.state = 'sent' and o.expires_at > now()
     order by o.sent_at desc
     limit 1`,
    [phone],
  );
  return result.rows[0] ?? null;
}

// ---- Inbound SMS: keyword layer only (Y/YES, N/NO, STOP, HELP) ----
// SPEC.md §10: "Inbound SMS is parsed for a small fixed vocabulary only in
// Slice 1 ... Anything else gets a single reply pointing at the web link."
webhooksRouter.post('/webhooks/sms', async (req, res) => {
  const db = getDb();
  const from = field(req.body, 'from');
  const body = field(req.body, 'body').toUpperCase();

  if (!from || !body) {
    res.status(400).send('Missing from or body');
    return;
  }

  if (body === 'STOP') {
    await upsertOptOut(db, from);
    // The STOP confirmation itself is the one message a just-opted-out
    // number is always allowed to receive (SPEC.md §10).
    await sendSms({ to: from, body: 'Coachatron: you are opted out. Text HELP for help, or use your booking link.' });
    res.status(200).send('opted out');
    return;
  }

  if (body === 'HELP') {
    await sendSms({ to: from, body: 'Coachatron: for help, visit your booking or coach link. Text STOP to opt out.' });
    res.status(200).send('help sent');
    return;
  }

  // Coach replying to the overflow ask on one of their sessions.
  const coach = await findCoachByPhone(db, from);
  if (coach) {
    const pendingSessionId = await findPendingAskSessionForCoach(db, coach.id);
    if (pendingSessionId) {
      if (body === 'Y' || body === 'YES') {
        await startCascade(db, pendingSessionId);
        res.status(200).send('cascade started');
        return;
      }
      if (body === 'N' || body === 'NO') {
        await resolveAskWithoutCascade(db, pendingSessionId);
        res.status(200).send('overflow declined');
        return;
      }
    }
  }

  // Roster member replying to their offer.
  const offer = await findSentOfferForPhone(db, from);
  if (offer) {
    if (body === 'Y' || body === 'YES') {
      const accepted = await acceptOffer(db, offer.id);
      res.status(200).send(accepted ? 'offer accepted' : 'offer no longer available');
      return;
    }
    if (body === 'N' || body === 'NO') {
      await declineOffer(db, offer.id);
      res.status(200).send('offer declined');
      return;
    }
  }

  await sendSms({ to: from, body: 'Text HELP for help or use your link.' });
  res.status(200).send('unrecognized');
});
