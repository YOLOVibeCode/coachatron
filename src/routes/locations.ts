import type { RequestHandler, Response, Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { namesList } from '../domain/bookingMessages.js';
import {
  LOCATION_LIMITS,
  addLocation,
  findLocationByName,
  listLocations,
  ownPlaceTimes,
  placeLine,
  readLocationFields,
  removeLocation,
  renameLocation,
  tidyPlace,
  type OwnPlaceTime,
  type SavedLocation,
  type WeeklyTimeRef,
} from '../domain/locations.js';
import {
  changeSessionLocation,
  isUpcoming,
  loadSessionPlace,
  placeChangeText,
  placeTextAllowed,
  previewPlaceChange,
  type PlaceChangeReach,
} from '../domain/sessionLocation.js';
import { formatClock } from '../domain/setup.js';
import { html, page, raw, type SafeHtml } from '../lib/html.js';
import { rowId } from '../lib/input.js';
import { formatLocal } from '../lib/time.js';
import { notFoundPage } from './errors.js';

/** Saved locations on the coach's screens (SPEC.md §8.2). No screen of its
 * own: the list lives on the Session types edit form (screen 4), the weekly
 * times form picks from it, and Session detail (screen 3) moves one session.
 * coach.ts mounts the routes and calls the pieces below from those screens. */

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function queryText(query: unknown, key: string): string {
  const value = (query as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

function weeklyTimeLabel(time: WeeklyTimeRef): string {
  return `${WEEKDAY_LABELS[time.weekday]} ${formatClock(time.time_local)}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- Screen 4: the list on the Session types edit form ----

function editHref(sessionTypeId: number, state = ''): string {
  return `/app/session-types/${sessionTypeId}/edit${state ? `?loc=${state}` : ''}#locations`;
}

/** What the edit form says after a change, read from ?loc=. */
function locationNotice(state: string): string | null {
  if (state === 'added') return 'Location added.';
  if (state === 'have') return 'That location is already saved.';
  if (state === 'removed') return 'Location removed. Sessions already on your calendar keep what they said.';
  const saved = /^saved\.(\d{1,6})\.(\d{1,6})$/.exec(state);
  if (!saved) return null;
  const weeklyTimes = Number(saved[1]);
  const sessions = Number(saved[2]);
  if (weeklyTimes === 0 && sessions === 0) return 'Location saved.';
  const where = [
    ...(weeklyTimes > 0 ? [count(weeklyTimes, 'weekly time', 'weekly times')] : []),
    ...(sessions > 0 ? [count(sessions, 'upcoming session', 'upcoming sessions')] : []),
  ];
  return `Location saved. ${namesList(where)} now ${weeklyTimes + sessions === 1 ? 'says' : 'say'} it.`;
}

/** The saved locations of one session type, each with its rename and
 * remove, and the form that adds one while the type is under its limit. */
export async function typeLocationsSection(db: DbClient, sessionTypeId: number, query: unknown): Promise<SafeHtml> {
  const locations = await listLocations(db, sessionTypeId);
  const base = `/app/session-types/${sessionTypeId}/locations`;
  const notice = locationNotice(queryText(query, 'loc'));
  return html`<h2 id="locations">Locations</h2>
    <p class="muted">Save up to ${LOCATION_LIMITS.perType} places this session runs. Each weekly time picks one, so you type a place once.</p>
    ${notice ? html`<div class="card"><p>${notice}</p></div>` : raw('')}
    ${locations.map(
      (l) => html`<div class="card">
        <form method="post" action="${base}/${l.id}">
          <label for="location-name-${l.id}">Location name</label>
          <input id="location-name-${l.id}" name="name" required maxlength="${LOCATION_LIMITS.nameChars}" value="${l.name}" />
          <label for="location-address-${l.id}">Address (optional)</label>
          <input id="location-address-${l.id}" name="address" maxlength="${LOCATION_LIMITS.addressChars}" value="${l.address ?? ''}" />
          <button type="submit" class="ghost">Save location</button>
        </form>
        <form method="post" action="${base}/${l.id}/remove">
          <button type="submit" class="ghost">Remove ${l.name}</button>
        </form>
      </div>`,
    )}
    ${locations.length >= LOCATION_LIMITS.perType
      ? html`<p class="muted">That is as many as a session type keeps. Remove one to add another.</p>`
      : html`<form method="post" action="${base}">
          <label for="location-name-new">New location</label>
          <input id="location-name-new" name="name" required maxlength="${LOCATION_LIMITS.nameChars}" placeholder="Field 3" />
          <label for="location-address-new">Address (optional)</label>
          <input id="location-address-new" name="address" maxlength="${LOCATION_LIMITS.addressChars}" placeholder="120 River Rd" />
          <button type="submit" class="ghost">Add location</button>
        </form>`}`;
}

/** The branded page for a location change that was refused, with the way
 * back to the form, as the session type form answers its own. */
function refuse(res: Response, status: number, title: string, message: string, backHref: string): void {
  res.status(status).send(
    page(
      title,
      html`<h1>${title}</h1>
        <p class="error">${message}</p>
        <a class="action" href="${backHref}">Back</a>`,
    ),
  );
}

// ---- The weekly times form: pick a saved location, or type a new place ----

/** Weekly times whose place stayed their own words, and why. */
function ownPlaceNote(times: OwnPlaceTime[], withType: boolean): SafeHtml {
  if (times.length === 0) return raw('');
  const items = times.map((t) => `${t.location_text} (${withType ? `${t.type_name}, ` : ''}${weeklyTimeLabel(t)})`);
  return html`<p class="muted own-places">${namesList(items)} ${times.length === 1 ? 'is on that weekly time only' : 'are on those weekly times only'}: ${withType ? 'a session type' : 'this session type'} keeps up to ${LOCATION_LIMITS.perType} saved locations and already had them. To save a new place, remove a saved location on the session type's Edit screen first.</p>`;
}

/** The "where" fields of the weekly times form: the type's saved locations
 * to pick from, and a box for a new place while the type has room for one. */
export async function weeklyPlaceFields(db: DbClient, sessionTypeId: number): Promise<SafeHtml> {
  const locations = await listLocations(db, sessionTypeId);
  const own = await ownPlaceTimes(db, { sessionTypeId });
  const full = locations.length >= LOCATION_LIMITS.perType;
  return html`${ownPlaceNote(own, false)}
    ${locations.length > 0
      ? html`<label for="location_id">Where (optional)</label>
          <select id="location_id" name="location_id">
            <option value="">No location</option>
            ${locations.map((l) => html`<option value="${l.id}">${placeLine(l.name, l.address)}</option>`)}
          </select>`
      : raw('')}
    ${full
      ? html`<p class="muted">This session type has all the saved locations it keeps. <a href="${editHref(sessionTypeId)}">Change them</a> to use a new place.</p>`
      : html`<label for="location">${locations.length > 0 ? 'Or a new place' : 'Where (optional)'}</label>
          <input id="location" name="location" maxlength="${LOCATION_LIMITS.nameChars}" placeholder="Field 3" />
          ${locations.length > 0
            ? html`<p class="muted">A new place is saved to this session type's locations. <a href="${editHref(sessionTypeId)}">Rename or remove them</a>.</p>`
            : raw('')}`}`;
}

export type FormPlace =
  | { ok: true; locationId: number | null; text: string | null }
  | { ok: false; error: string };

/** The place a weekly-times form sent: a saved location picked from the
 * list, or a typed one, or none. Typed words that match a saved location
 * read as that location, so its name is what the form compares and saves. */
export async function placeFromForm(db: DbClient, sessionTypeId: number, body: unknown): Promise<FormPlace> {
  const picked = field(body, 'location_id');
  const typed = tidyPlace(field(body, 'location'));
  if (picked && typed) return { ok: false, error: 'Pick a saved location or type a new place, not both.' };
  if (!picked && !typed) return { ok: true, locationId: null, text: null };
  const locations = await listLocations(db, sessionTypeId);
  if (picked) {
    const id = rowId(picked);
    const location = id === null ? undefined : locations.find((l) => l.id === id);
    if (!location) return { ok: false, error: "Pick one of this session type's saved locations." };
    return { ok: true, locationId: location.id, text: location.name };
  }
  const same = await findLocationByName(db, sessionTypeId, typed);
  if (!same && typed.length > LOCATION_LIMITS.nameChars) {
    return { ok: false, error: `A place name is up to ${LOCATION_LIMITS.nameChars} characters.` };
  }
  return same ? { ok: true, locationId: same.id, text: same.name } : { ok: true, locationId: null, text: typed };
}

/** True when a weekly time just saved kept its place as its own words, so
 * the coach is shown why on the weekly times screen. */
export function keptOwnPlace(slots: Array<{ location_text: string | null; location_id?: number | null }>): boolean {
  return slots.some((s) => Boolean(s.location_text) && s.location_id == null);
}

/** After a setup is published (by text or voice): the weekly times whose
 * typed place was not saved as a location, and why. Nothing when there are
 * none. */
export async function ownPlacesNote(db: DbClient, coachId: number): Promise<SafeHtml> {
  const own = await ownPlaceTimes(db, { coachId });
  return own.length === 0 ? raw('') : html`<div class="card">${ownPlaceNote(own, true)}</div>`;
}

// ---- Screen 3: where one session is, and moving it ----

const LATE_NOTE = 'It is late; clients will see the new place on their booking page and in their reminder.';

function reachSentence(reach: PlaceChangeReach, text: string, late: boolean): SafeHtml {
  const { parents, textable } = reach;
  if (parents === 0) return html`<p class="muted">Nobody is booked, so nobody is texted.</p>`;
  if (late) return html`<p class="muted">${LATE_NOTE}</p>`;
  if (textable === 0) {
    return html`<p class="muted">${parents === 1 ? '1 client is booked and does not get texts' : `${parents} clients are booked and do not get texts`}, so nothing is sent. They see the new place on their booking page.</p>`;
  }
  const lead =
    textable === parents
      ? parents === 1
        ? '1 client is booked and gets this text:'
        : `${parents} clients are booked and get this text:`
      : `${parents} clients are booked. ${textable} of them ${textable === 1 ? 'gets' : 'get'} this text:`;
  const rest = parents - textable;
  return html`<p class="muted">${lead} "${text}"${rest > 0 ? ` The ${rest === 1 ? 'other sees' : 'others see'} the new place on their booking page.` : ''}</p>`;
}

/** What Session detail says after a change, read from ?placed=texted.parents. */
function placedNotice(state: string): string | null {
  const match = /^(\d{1,4})\.(\d{1,4})(\.late)?$/.exec(state);
  if (!match) return null;
  const texted = Number(match[1]);
  const parents = Number(match[2]);
  if (parents === 0) return 'Location changed.';
  if (match[3]) return `Location changed. ${LATE_NOTE}`;
  return `Location changed. Texted ${texted} of ${count(parents, 'client', 'clients')}.${texted < parents ? ' The rest see the new place on their booking page.' : ''}`;
}

/** Session detail's "Where": the session's place, and for a session still
 * to come, the type's other saved locations to move it to. With ?place=
 * it is the question the coach answers first: who is booked, and the text
 * they get. */
export async function sessionPlaceSection(db: DbClient, coachId: number, sessionId: number, query: unknown): Promise<SafeHtml> {
  const session = await loadSessionPlace(db, coachId, sessionId);
  if (!session) return raw('');
  const here = placeLine(session.location_text, session.location_address);
  const locations = isUpcoming(session) ? await listLocations(db, session.session_type_id) : [];
  const isCurrent = (l: SavedLocation) => l.id === session.location_id && l.name === session.location_text;
  const others = locations.filter((l) => !isCurrent(l));
  if (!here && others.length === 0) return raw('');

  const action = `/app/sessions/${sessionId}/location`;
  const askedId = rowId(queryText(query, 'place'));
  const asked = askedId === null ? undefined : others.find((l) => l.id === askedId);
  const notice = placedNotice(queryText(query, 'placed'));
  return html`<h2 id="where">Where</h2>
    <p>${here || 'No location set.'}</p>
    ${notice ? html`<div class="card"><p>${notice}</p></div>` : raw('')}
    ${asked
      ? html`<div class="card">
          <p><strong>Move ${formatLocal(session.starts_at_utc, session.tz)} to ${asked.name}?</strong></p>
          ${reachSentence(await previewPlaceChange(db, sessionId), placeChangeText(session, asked.name), !placeTextAllowed(session, new Date()))}
          <form method="post" action="${action}">
            <input type="hidden" name="location_id" value="${asked.id}" />
            <input type="hidden" name="confirm" value="1" />
            <button type="submit">Change location</button>
          </form>
          <a class="action ghost" href="/app/sessions/${sessionId}">${session.location_text ? `Keep ${session.location_text}` : 'Keep it as it is'}</a>
        </div>`
      : others.length > 0
        ? html`<form method="post" action="${action}">
            <label for="location_id">Move this session to</label>
            <select id="location_id" name="location_id">
              ${others.map((l) => html`<option value="${l.id}">${placeLine(l.name, l.address)}</option>`)}
            </select>
            <button type="submit" class="ghost">Change location</button>
          </form>`
        : raw('')}`;
}

// ---- Routes ----

/** Adds the location routes to the coach's router, behind its sign-in
 * check. Every id in these addresses is a row id (the router's own check
 * covers :id; :locationId is checked the same way here). */
export function mountLocationRoutes(router: Router, requireAuth: RequestHandler): void {
  router.param('locationId', (_req, res, next, value) => {
    if (rowId(value) === null) {
      res.status(404).send(notFoundPage());
      return;
    }
    next();
  });

  router.post('/app/session-types/:id/locations', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const typeId = Number(req.params.id);
    const fields = readLocationFields(field(req.body, 'name'), field(req.body, 'address'));
    if (!fields.ok) {
      refuse(res, 422, 'Edit session type', fields.error, editHref(typeId));
      return;
    }
    const result = await addLocation(getDb(), coachId, typeId, fields.name, fields.address);
    if (result.kind === 'not-found') {
      res.status(404).send(notFoundPage());
      return;
    }
    if (result.kind === 'full') {
      refuse(
        res,
        422,
        'Edit session type',
        `A session type keeps up to ${LOCATION_LIMITS.perType} saved locations. Remove one to add ${fields.name}.`,
        editHref(typeId),
      );
      return;
    }
    res.redirect(303, editHref(typeId, result.kind === 'exists' ? 'have' : 'added'));
  });

  router.post('/app/session-types/:id/locations/:locationId', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const typeId = Number(req.params.id);
    const current = (await listLocations(getDb(), typeId)).find((l) => l.id === Number(req.params.locationId));
    const fields = readLocationFields(field(req.body, 'name'), field(req.body, 'address'), current?.name);
    if (!fields.ok) {
      refuse(res, 422, 'Edit session type', fields.error, editHref(typeId));
      return;
    }
    const result = await renameLocation(getDb(), coachId, typeId, Number(req.params.locationId), fields.name, fields.address);
    if (result.kind === 'not-found') {
      res.status(404).send(notFoundPage());
      return;
    }
    if (result.kind === 'taken') {
      refuse(res, 422, 'Edit session type', `This session type already has a location called ${fields.name}.`, editHref(typeId));
      return;
    }
    res.redirect(303, editHref(typeId, `saved.${result.weeklyTimes}.${result.sessions}`));
  });

  router.post('/app/session-types/:id/locations/:locationId/remove', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const typeId = Number(req.params.id);
    const result = await removeLocation(getDb(), coachId, typeId, Number(req.params.locationId));
    if (result.kind === 'not-found') {
      res.status(404).send(notFoundPage());
      return;
    }
    if (result.kind === 'in-use') {
      const times = result.weeklyTimes.map(weeklyTimeLabel);
      refuse(
        res,
        422,
        'Edit session type',
        `${result.location.name} is still used by ${namesList(times)}. Remove ${times.length === 1 ? 'that weekly time' : 'those weekly times'} first, or rename the location instead.`,
        editHref(typeId),
      );
      return;
    }
    res.redirect(303, editHref(typeId, 'removed'));
  });

  router.post('/app/sessions/:id/location', requireAuth, async (req, res) => {
    const db = getDb();
    const coachId = res.locals.coachId as number;
    const sessionId = Number(req.params.id);
    const back = `/app/sessions/${sessionId}`;
    const session = await loadSessionPlace(db, coachId, sessionId);
    if (!session) {
      res.status(404).send(notFoundPage());
      return;
    }
    const notUpcoming = 'Only a session still to come can change its location.';
    if (!isUpcoming(session)) {
      refuse(res, 422, session.type_name, notUpcoming, back);
      return;
    }
    const notSaved = "Pick one of this session type's saved locations.";
    const locationId = rowId(field(req.body, 'location_id'));
    const location =
      locationId === null ? undefined : (await listLocations(db, session.session_type_id)).find((l) => l.id === locationId);
    if (!location) {
      refuse(res, 422, session.type_name, notSaved, back);
      return;
    }
    if (session.location_id === location.id && session.location_text === location.name) {
      res.redirect(303, `${back}#where`);
      return;
    }
    // With parents booked, the coach first sees who is told and in what
    // words (Session detail with ?place=), and confirms there.
    if (field(req.body, 'confirm') !== '1' && (await previewPlaceChange(db, sessionId)).parents > 0) {
      res.redirect(303, `${back}?place=${location.id}#where`);
      return;
    }
    const result = await changeSessionLocation(db, coachId, sessionId, location.id);
    switch (result.kind) {
      case 'changed':
        res.redirect(303, `${back}?placed=${result.texted}.${result.parents}${result.late && result.parents > 0 ? '.late' : ''}#where`);
        return;
      case 'same':
        res.redirect(303, `${back}#where`);
        return;
      case 'not-found':
        res.status(404).send(notFoundPage());
        return;
      case 'not-upcoming':
        refuse(res, 422, session.type_name, notUpcoming, back);
        return;
      case 'no-location':
        refuse(res, 422, session.type_name, notSaved, back);
        return;
    }
  });
}
