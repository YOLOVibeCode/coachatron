import type { DbClient } from '../db/client.js';
import type { CoachRow } from './auth.js';
import { canText, sendEmailMessage, sendText, type SendOutcome } from './outbound.js';

export type ClientContactChannel = 'coachatron' | 'email' | 'phone';

const CHANNELS = new Set<ClientContactChannel>(['coachatron', 'email', 'phone']);

export function parseClientContactChannel(raw: string): ClientContactChannel | null {
  return CHANNELS.has(raw as ClientContactChannel) ? (raw as ClientContactChannel) : null;
}

export async function getClientContactChannel(db: DbClient, coachId: number): Promise<ClientContactChannel> {
  const result = await db.query<{ client_contact_channel: string }>(
    'select client_contact_channel from coach where id = $1',
    [coachId],
  );
  const row = result.rows[0]?.client_contact_channel;
  return parseClientContactChannel(row ?? '') ?? 'coachatron';
}

export async function setClientContactChannel(db: DbClient, coachId: number, channel: ClientContactChannel): Promise<void> {
  await db.query('update coach set client_contact_channel = $2 where id = $1', [coachId, channel]);
}

interface CoachContactRow {
  email: string;
  phone: string | null;
}

async function coachContact(db: DbClient, coachId: number): Promise<CoachContactRow | null> {
  const result = await db.query<CoachContactRow>('select email, phone from coach where id = $1', [coachId]);
  return result.rows[0] ?? null;
}

/** Delivers a parent's question to the coach. The relay is SMS or email; the
 * coach's number and address never appear on the public page. */
export async function sendClientQuestion(
  db: DbClient,
  coach: Pick<CoachRow, 'id' | 'name'>,
  channel: ClientContactChannel,
  clientReply: string,
  message: string,
): Promise<SendOutcome> {
  const info = await coachContact(db, coach.id);
  if (!info) return 'refused';

  const trimmed = message.trim().slice(0, 2000);
  const reply = clientReply.trim().slice(0, 200);
  const subject = `Question about ${coach.name}'s sessions`;
  const body = `${trimmed}\n\nReply to: ${reply}`;

  const preferText = channel === 'phone' || channel === 'coachatron';
  if (preferText && info.phone && canText(info.phone)) {
    return await sendText(db, {
      to: info.phone,
      body: `${coach.name}: a parent asked:\n${body}`,
      coachId: coach.id,
      template: 'client-question',
      visitor: 'always',
    });
  }

  if (!info.email) return 'refused';
  return await sendEmailMessage(db, {
    to: info.email,
    subject,
    text: body,
    coachId: coach.id,
    template: 'client-question',
  });
}