import { DbClient } from '../db/client.js';
import { sendSms } from '../relay/sms.js';
import { randomUUID } from 'node:crypto';

export const OVERFLOW_OFFER_TTL_MINUTES = 20;

// Check if a session has overflow that needs to be asked about
export async function checkOverflow(db: DbClient, sessionId: number): Promise<void> {
  // Count bookings for this session
  const bookingResult = await db.query<{ count: string }>(
    `select count(*) as count from booking where session_id = $1 and status = 'booked'`,
    [sessionId]
  );
  const bookedCount = parseInt(bookingResult.rows[0].count, 10);

  // Get capacity and overflow_threshold
  const sessionResult = await db.query<{ capacity: number | null; capacity_override: number | null; overflow_threshold: number }>(
    `select s.capacity_override, st.overflow_threshold
     from session s
     join session_type st on s.session_type_id = st.id
     where s.id = $1`,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    return;
  }

  const sessionRow = sessionResult.rows[0];
  const capacity = sessionRow.capacity_override ?? await getCapacityForSession(db, sessionId);
  
  // overflow_threshold of -1 means use capacity as threshold
  const threshold = sessionRow.overflow_threshold >= 0 ? sessionRow.overflow_threshold : capacity;

  // Check if there's a pending overflow ask for this session
  const askResult = await db.query<{ id: number }>(
    `select id from overflow_ask where session_id = $1 and coach_notified_at is null`,
    [sessionId]
  );

  if (askResult.rows.length > 0) {
    // Already has a pending ask, don't send another
    return;
  }

  // Check if there are roster members who could be offered
  const rosterResult = await db.query<{ count: string }>(
    `select count(*) as count from roster_member where coach_id = (select session_type.coach_id from session join session_type on session.session_type_id = session_type.id where session.id = $1) and active = true`,
    [sessionId]
  );

  const rosterCount = parseInt(rosterResult.rows[0].count, 10);

  // Only send ask if booked >= threshold AND there are roster members available
  if (bookedCount >= threshold && rosterCount > 0) {
    // Get the coach's phone number
    const coachResult = await db.query<{ phone: string }>(
      `select coach.phone from coach 
       join session_type on coach.id = session_type.coach_id 
       join session on session_type.id = session.session_type_id 
       where session.id = $1`,
      [sessionId]
    );
    
    if (coachResult.rows.length > 0) {
      const phone = coachResult.rows[0].phone;
      
      // Create overflow ask record
      await db.query(
        `insert into overflow_ask (session_id) values ($1)`,
        [sessionId]
      );
      
      // Send SMS to coach asking YES or NO
      await sendSms({
        to: phone,
        body: 'Overflow full! Reply YES to open a second group?'
      });
    }
  }
}

async function getCapacityForSession(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ capacity: number }>(
    `select st.capacity from session s 
     join session_type st on s.session_type_id = st.id 
     where s.id = $1`,
    [sessionId]
  );
  
  if (result.rows.length === 0) {
    return 0;
  }
  
  return result.rows[0].capacity;
}

// Coach replied YES - start the overflow cascade
export async function startCascade(db: DbClient, sessionId: number): Promise<void> {
  // Find roster members with no expired offers for this session
  const rosterResult = await db.query<{ id: number; name: string; phone: string }>(
    `select rm.id, rm.name, rm.phone 
     from roster_member rm
     where rm.coach_id = (select st.coach_id from session s join session_type st on s.session_type_id = st.id where s.id = $1)
       and rm.active = true
       and not exists (
         select 1 from offer o 
         where o.roster_member_id = rm.id 
           and o.session_id = $1 
           and o.state in ('sent', 'accepted')
           and o.expires_at > now()
       )
     order by rm.priority asc 
     limit 1`,
    [sessionId]
  );
  
  if (rosterResult.rows.length === 0) {
    // No more roster members to offer
    const coachResult = await db.query<{ phone: string }>(
      `select coach.phone from coach 
       join session_type on coach.id = session_type.coach_id 
       join session on session_type.id = session.session_type_id 
       where session.id = $1`,
      [sessionId]
    );
    
    if (coachResult.rows.length > 0) {
      await sendSms({
        to: coachResult.rows[0].phone,
        body: 'No more roster members available for overflow.'
      });
    }
    return;
  }
  
  const member = rosterResult.rows[0];

  // Create the offer
  const expiresAt = new Date(Date.now() + OVERFLOW_OFFER_TTL_MINUTES * 60 * 1000);
  const token = randomUUID();

  await db.query(
    `insert into offer (session_id, roster_member_id, sent_at, expires_at, state, token)
     values ($1, $2, now(), $3, 'sent', $4)`,
    [sessionId, member.id, expiresAt, token]
  );
  
  // Mark the overflow ask as notified
  await db.query(
    `update overflow_ask set coach_notified_at = now() where session_id = $1 and coach_notified_at is null`,
    [sessionId]
  );
  
  // Send SMS to roster member
  await sendSms({
    to: member.phone,
    body: `You have an overflow spot! Reply YES to accept or NO to decline.`
  });
}

// Advance the cascade for expired offers
export async function advanceCascade(db: DbClient, now: Date): Promise<void> {
  // Find expired offers that are still 'sent'
  const expiredOffers = await db.query<{ id: number; session_id: number }>(
    `select id, session_id from offer 
     where state = 'sent' and expires_at < $1`,
    [now]
  );
  
  for (const offer of expiredOffers.rows) {
    // Mark the offer as expired
    await db.query(
      `update offer set state = 'expired' where id = $1`,
      [offer.id]
    );
    
    // Try to start cascade again from this session to offer the next roster member
    await startCascade(db, offer.session_id);
  }
}

// Accept an offer - only succeeds if still in 'sent' state
export async function acceptOffer(db: DbClient, offerId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>(
    `update offer set state = 'accepted', accepted_at = now() 
     where id = $1 and state = 'sent' 
     returning id`,
    [offerId]
  );
  
  if (result.rows.length === 0) {
    // Offer not found or already accepted/expired
    return false;
  }
  
  return true;
}

// Decline an offer and advance cascade immediately
export async function declineOffer(db: DbClient, offerId: number): Promise<void> {
  await db.query(
    `update offer set state = 'declined' where id = $1`,
    [offerId]
  );
  
  // Get the session_id from this offer
  const offerResult = await db.query<{ session_id: number }>(
    `select session_id from offer where id = $1`,
    [offerId]
  );
  
  if (offerResult.rows.length > 0) {
    await startCascade(db, offerResult.rows[0].session_id);
  }
}

// Get an offer by token
export async function getOfferByToken(db: DbClient, token: string): Promise<{ id: number; session_id: number; roster_member_id: number } | null> {
  const result = await db.query<{ id: number; session_id: number; roster_member_id: number }>(
    `select id, session_id, roster_member_id from offer where token = $1`,
    [token]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0];
}
