import { Router, type Response } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { coachNav, html, page, raw, type SafeHtml } from '../lib/html.js';
import { dollarsToCents, rowId } from '../lib/input.js';
import { formatCoachDollars, formatConfirmWhen } from '../lib/time.js';
import {
  isAssistantOf,
  listAssistantPay,
  markAllPaid,
  markPaid,
  owedToAssistantsCents,
  PAID_NOTE_MAX,
  PAY_AMOUNT_CENTS,
  payRowAssistant,
  setPayAmount,
  summarizeAssistantPay,
  undoPaid,
  type AssistantJob,
  type AssistantPayRow,
  type AssistantPaySummary,
  type PayChange,
  type PayState,
} from '../domain/assistantPay.js';

/** Assistant coach pay on My roster (screen 6) and its one line on Money
 * (SPEC.md §8.2). No screen of its own: the roster lists each assistant
 * with what they coached, are owed and were paid, and `?pay=<assistant>`
 * opens that assistant's sessions on the same screen. The coach's record
 * only: nothing here moves money or sends a message. */

/** Mounted by coach.ts at /app/roster, behind the coach's sign-in, so every
 * handler finds the coach in `res.locals.coachId`. */
export const assistantPayRouter = Router();

// Ids in these URLs are row ids, as on the other coach screens.
for (const name of ['payId', 'memberId']) {
  assistantPayRouter.param(name, (_req, res, next, value) => {
    if (rowId(value) === null) {
      notFound(res);
      return;
    }
    next();
  });
}

const JOB: Record<AssistantJob, string> = { second_group: 'Second group', backup: 'Backup coach' };
const STATE: Record<PayState, string> = { upcoming: 'Upcoming', owed: 'Owed', paid: 'Paid', cancelled: 'Cancelled' };
const AMOUNT_RANGE = `Enter an amount from $${PAY_AMOUNT_CENTS.min / 100} to $${(PAY_AMOUNT_CENTS.max / 100).toLocaleString('en-US')}.`;
const NOTE_TOO_LONG = `Keep the note to ${PAID_NOTE_MAX} characters or fewer.`;

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function sessions(n: number): string {
  return `${n} ${n === 1 ? 'session' : 'sessions'}`;
}

/** Where a change sends the coach back to: the roster with that assistant open. */
function assistantHref(memberId: number): string {
  return `/app/roster?pay=${memberId}#pay-${memberId}`;
}

function notFound(res: Response): void {
  res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
}

/** A refusal with why, in the screen's own look, and the way back to the
 * assistant's sessions. */
function refuse(res: Response, status: number, message: string, backHref: string): void {
  res.status(status).send(
    page(
      'Roster',
      html`${coachNav('roster')}
        <h1>Assistant pay</h1>
        <p class="error">${message}</p>
        <a class="action" href="${backHref}">Back</a>`,
    ),
  );
}

/** "Nov 12": the day a payment was marked, in the session's zone. */
function formatDay(isoUtc: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(new Date(isoUtc));
}

function amountText(cents: number | null): string {
  return cents === null ? 'No amount set' : formatCoachDollars(cents);
}

/** The amount form: how "no amount set" gets a number, and how an amount
 * is corrected before the session is marked paid. */
function renderAmountForm(row: AssistantPayRow) {
  const unset = row.amountCents === null;
  const dollars = row.amountCents === null ? '' : String(row.amountCents / 100);
  return html`<details${unset ? raw(' open') : raw('')}>
    <summary>${unset ? 'Set the amount' : 'Change the amount'}</summary>
    <form method="post" action="/app/roster/pay/${row.id}/amount">
      <label for="pay_amount_${row.id}">Amount (dollars)</label>
      <input id="pay_amount_${row.id}" name="amount_dollars" type="number" inputmode="decimal" min="${PAY_AMOUNT_CENTS.min / 100}" max="${PAY_AMOUNT_CENTS.max / 100}" step="0.01" required value="${dollars}" />
      <button type="submit" class="ghost">Save amount</button>
    </form>
  </details>`;
}

function renderNoteField(id: string) {
  return html`<label for="${id}">Note (optional)</label>
    <input id="${id}" name="note" maxlength="${PAID_NOTE_MAX}" placeholder="e.g. Venmo" />`;
}

function renderSession(row: AssistantPayRow) {
  const when = formatConfirmWhen(row.startsAtUtc, row.tz);
  const head = html`<div class="row"><span>${when}</span><strong>${STATE[row.state]}</strong></div>
    <div class="meta"><span>${row.sessionName} · ${JOB[row.kind]}</span><span>${row.state === 'cancelled' ? 'Nothing owed' : amountText(row.amountCents)}</span></div>`;
  if (row.state === 'paid') {
    return html`<div class="card">
      ${head}
      <p class="muted">Marked paid ${row.paidAt ? formatDay(row.paidAt, row.tz) : ''}${row.paidNote ? html` · ${row.paidNote}` : raw('')}</p>
      <form method="post" action="/app/roster/pay/${row.id}/unpaid">
        <button type="submit" class="ghost">Undo paid</button>
      </form>
    </div>`;
  }
  if (row.state === 'owed') {
    return html`<div class="card">
      ${head}
      <form method="post" action="/app/roster/pay/${row.id}/paid">
        ${renderNoteField(`pay_note_${row.id}`)}
        <button type="submit" class="ghost">Mark paid</button>
      </form>
      ${renderAmountForm(row)}
    </div>`;
  }
  if (row.state === 'upcoming') {
    return html`<div class="card">${head}${renderAmountForm(row)}</div>`;
  }
  return html`<div class="card">${head}</div>`;
}

function renderOpenAssistant(a: AssistantPaySummary, rows: AssistantPayRow[]) {
  const total = a.coached + a.upcoming + a.cancelled;
  return html`${a.owedCount > 0
      ? html`<form method="post" action="/app/roster/${a.memberId}/pay-all">
          ${renderNoteField(`pay_note_all_${a.memberId}`)}
          <button type="submit">Mark ${a.owedCount === 1 ? 'the owed session' : `all ${a.owedCount} owed sessions`} paid${a.owedCents > 0 ? ` (${formatCoachDollars(a.owedCents)})` : ''}</button>
        </form>`
      : raw('')}
    ${rows.map(renderSession)}
    ${total > rows.length ? html`<p class="muted">Showing ${rows.length} of ${total} sessions. The totals count them all.</p>` : raw('')}
    <p><a href="/app/roster#pay">Hide ${a.name}'s sessions</a></p>`;
}

function renderAssistant(a: AssistantPaySummary, open: AssistantPayRow[] | null) {
  const counts = [`${sessions(a.coached)} coached`];
  if (a.upcoming > 0) counts.push(`${a.upcoming} upcoming`);
  if (a.cancelled > 0) counts.push(`${a.cancelled} cancelled`);
  return html`<li id="pay-${a.memberId}">
    <div class="card">
      <div class="row"><strong>${a.name}</strong>${a.active ? raw('') : html`<span class="muted">No longer on your roster</span>`}</div>
      <p class="muted">${counts.join(' · ')}</p>
      <div class="meta"><span>Owed ${formatCoachDollars(a.owedCents)}</span><span>Paid ${formatCoachDollars(a.paidCents)}</span></div>
      ${a.owedUnset > 0
        ? html`<p class="muted">${a.owedUnset === 1 ? '1 owed session has' : `${a.owedUnset} owed sessions have`} no amount set, so ${a.owedUnset === 1 ? 'it is' : 'they are'} not in the total.</p>`
        : raw('')}
      ${open ? raw('') : html`<p><a href="${assistantHref(a.memberId)}">See ${a.name}'s sessions</a></p>`}
    </div>
    ${open ? renderOpenAssistant(a, open) : raw('')}
  </li>`;
}

/** The pay section of My roster: every assistant who has accepted a job,
 * and the sessions of the one `open` names (the `pay` query value). Nothing
 * at all until someone has accepted a job, and nothing of another coach's
 * whatever `open` says. */
export async function renderAssistantPay(db: DbClient, coachId: number, open: unknown): Promise<SafeHtml> {
  const now = new Date();
  const assistants = await summarizeAssistantPay(db, coachId, now);
  if (assistants.length === 0) return raw('');
  const openId = rowId(open);
  const opened = assistants.find((a) => a.memberId === openId) ?? null;
  const rows = opened ? await listAssistantPay(db, coachId, opened.memberId, now) : null;
  return html`<h2 id="pay">Assistant pay</h2>
    <p class="muted">Coachatron doesn't pay assistants; this is your record. Each job an assistant accepts is listed with what its offer said it pays, and counts as owed once the session has started.</p>
    <ul class="roster-list">
      ${assistants.map((a) => renderAssistant(a, a === opened ? rows : null))}
    </ul>`;
}

/** Money's one line: what the coach owes assistants, linking to the roster.
 * Nothing when nothing is owed. Not part of collected, booked or fees. */
export async function renderOwedToAssistants(db: DbClient, coachId: number): Promise<SafeHtml> {
  const cents = await owedToAssistantsCents(db, coachId, new Date());
  if (cents <= 0) return raw('');
  return html`<p class="muted"><a href="/app/roster#pay">You owe assistants $${(cents / 100).toFixed(2)}</a></p>`;
}

/** The note typed with a payment: one line, or null when empty or too long. */
function readNote(body: unknown): { ok: true; note: string | null } | { ok: false } {
  const note = field(body, 'note').replace(/\s+/g, ' ');
  if ([...note].length > PAID_NOTE_MAX) return { ok: false };
  return { ok: true, note: note || null };
}

const REFUSED: Record<'amount' | 'paid', Record<PayState, string>> = {
  amount: {
    paid: 'This session is marked paid. Undo that first to change its amount.',
    cancelled: 'This session was cancelled, so nothing is owed for it.',
    owed: '',
    upcoming: '',
  },
  paid: {
    upcoming: 'This session has not happened yet, so nothing is owed for it.',
    cancelled: 'This session was cancelled, so nothing is owed for it.',
    owed: '',
    paid: '',
  },
};

/** Answers a change: back to the assistant's sessions when it is done, a
 * 404 for a row that is not this coach's, or what stood in the way. */
function answer(res: Response, change: PayChange, action: 'amount' | 'paid'): void {
  if (change.kind === 'not_found') {
    notFound(res);
    return;
  }
  if (change.kind === 'refused') {
    refuse(res, 409, REFUSED[action][change.state] || 'That did not apply to this session.', assistantHref(change.memberId));
    return;
  }
  res.redirect(303, assistantHref(change.memberId));
}

assistantPayRouter.post('/pay/:payId/amount', async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const payId = Number(req.params.payId);
  const memberId = await payRowAssistant(db, coachId, payId);
  if (memberId === null) {
    notFound(res);
    return;
  }
  const cents = dollarsToCents(field(req.body, 'amount_dollars'), PAY_AMOUNT_CENTS);
  if (cents === null) {
    refuse(res, 422, AMOUNT_RANGE, assistantHref(memberId));
    return;
  }
  answer(res, await setPayAmount(db, coachId, payId, cents), 'amount');
});

assistantPayRouter.post('/pay/:payId/paid', async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const payId = Number(req.params.payId);
  const memberId = await payRowAssistant(db, coachId, payId);
  if (memberId === null) {
    notFound(res);
    return;
  }
  const note = readNote(req.body);
  if (!note.ok) {
    refuse(res, 422, NOTE_TOO_LONG, assistantHref(memberId));
    return;
  }
  answer(res, await markPaid(db, coachId, payId, note.note), 'paid');
});

assistantPayRouter.post('/pay/:payId/unpaid', async (req, res) => {
  const coachId = res.locals.coachId as number;
  answer(res, await undoPaid(getDb(), coachId, Number(req.params.payId)), 'paid');
});

assistantPayRouter.post('/:memberId/pay-all', async (req, res) => {
  const coachId = res.locals.coachId as number;
  const memberId = Number(req.params.memberId);
  const db = getDb();
  if (!(await isAssistantOf(db, coachId, memberId))) {
    notFound(res);
    return;
  }
  const note = readNote(req.body);
  if (!note.ok) {
    refuse(res, 422, NOTE_TOO_LONG, assistantHref(memberId));
    return;
  }
  if ((await markAllPaid(db, coachId, memberId, note.note)) === null) {
    notFound(res);
    return;
  }
  res.redirect(303, assistantHref(memberId));
});
