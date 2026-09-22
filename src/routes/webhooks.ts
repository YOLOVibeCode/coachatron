import { Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { sendSms } from '../relay/sms.js';
import { findCoachByPhone } from '../domain/auth.js';
import { acceptOffer, advanceCascade, declineOffer } from '../domain/cascade.js';

export const webhooksRouter = Router();

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

webhooksRouter.post('/sms', async (req, res) => {
  const db = getDb();
  const from = field(req.body, 'from');
  const body = field(req.body, 'body');

  if (!from || !body) {
    res.status(400).send('Missing from or body');
    return;
  }

  // STOP logic: opt out the sender
  if (body === 'STOP') {
    await upsertOptOut(db, from);
    res.status(200).send('You have been opted out. Text HELP for help.');
    return;
  }

  // HELP logic: send a support link
  if (body === 'HELP') {
    const supportLink = process.env.SUPPORT_LINK ?? 'https://coachatron.app/help';
    await sendSms({ to: from, body: `CoachatronSupport: ${supportLink}` });
    res.status(200).send('Info sent.');
    return;
  }

  // Check if this is a coach's overflow reply (Y/YES)
  const coach = await findCoachByPhone(db, from);
  if (coach) {
    // Coach replied Y to an overflow ask
    if (body === 'Y' || body === 'YES') {
      await startOverflowForCoach(db, coach.id);
      res.status(200).send('Overflow cascade started.');
      return;
    }
    // Coach replied N - do nothing (cascade won't happen)
    if (body === 'N' || body === 'NO') {
      res.status(200).send('Overflow not approved.');
      return;
    }
  }

  // Check if this is a roster member's offer reply
  const offer = await findOfferForPhone(db, from);
  if (offer) {
    if (body === 'Y' || body === 'YES') {
      const accepted = await acceptOffer(db, offer.id);
      if (accepted) {
        res.status(200).send('Offer accepted!');
      } else {
        res.status(200).send('Offer no longer available.');
      }
    } else if (body === 'N' || body === 'NO') {
      await declineOffer(db, offer.id);
      res.status(200).send('Offer declined. Next member will be offered.');
    } else {
      // Invalid response for an active offer
      res.status(200).send('reply YES to accept or NO to decline.');
    }
    return;
  }

  // Unknown context - general reply
  res.status(200).send('Text HELP for help or use your link.');
});

// Helper: find an active sent offer for this phone
async function findOfferForPhone(db: DbClient, phone: string): Promise<{ id: number } | null> {
  const result = await db.query<{ id: number; roster_member_id: number }>(
    `select o.id, rm.phone
     from offer o
     join roster_member rm on rm.id = o.roster_member_id
     where rm.phone = $1 and o.state = 'sent' and o.expires_at > now()`,
    [phone]
  );
  return result.rows.length > 0 ? { id: result.rows[0].id } : null;
}

// Helper: start overflow cascade for a coach (when they reply YES)
async function startOverflowForCoach(db: DbClient, coachId: number): Promise<void> {
  // Find the most recent session with a pending overflow ask
  const askResult = await db.query<{ session_id: number }>(
    `select sa.session_id
     from overflow_ask sa
     join session s on s.id = sa.session_id
     join session_type st on st.id = s.session_type_id
     where sa.coach_notified_at is null and st.coach_id = $1
     order by sa.asked_at desc limit 1`,
    [coachId]
  );

  if (askResult.rows.length > 0) {
    await advanceCascade(db, new Date());
  }
}

// Helper: upsert opt-out status for a phone number
async function upsertOptOut(db: DbClient, phone: string): Promise<void> {
  // For now, just insert into message_log as an opt_out record
  // A proper migration could add a dedicated opt_out table
  await db.query(
    `insert into message_log (to_phone, template, body, status)
     values ($1, 'opt_out', 'User opted out', 'sent')`,
    [phone]
  );
}
