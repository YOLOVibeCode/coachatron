import { Router, type Request, type RequestHandler, type Response } from 'express';
import { getDb } from '../db/client.js';
import { findCoachById } from '../domain/auth.js';
import {
  bookingsCsv,
  CUSTOM_RANGE,
  DOWNLOAD_LIMITS,
  downloadLimitKey,
  MAX_CUSTOM_DAYS,
  MAX_EXPORT_ROWS,
  paymentsCsv,
  presetRange,
  RANGE_PRESETS,
  resolveRange,
  type RangePreset,
} from '../domain/moneyExport.js';
import { isOverLimit, takeRequest } from '../domain/requestLimits.js';
import { coachHeader, html, page, raw, type SafeHtml } from '../lib/html.js';
import { DEFAULT_TZ, isValidTimeZone } from '../lib/time.js';

/** The Download block on Payments (screen 7) and the two files behind it: the
 * coach's payments and bookings as CSV, for a range of days in the coach's
 * timezone (src/domain/moneyExport.ts). No screen of its own. */

const PAYMENTS_PATH = '/app/money/download/payments.csv';
const BOOKINGS_PATH = '/app/money/download/bookings.csv';

const PRESET_WORDS: Record<RangePreset, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'this-year': 'This year',
  'last-year': 'Last year',
};

const DOWNLOAD_FORM_SCRIPT = raw(`<script>
(function(){
  var form=document.getElementById('download_form');
  var range=document.getElementById('download_range');
  var custom=document.getElementById('download_custom');
  var feedback=document.getElementById('download_feedback');
  if(!form||!range||!custom)return;
  function syncCustom(){
    var on=range.value==='${CUSTOM_RANGE}';
    custom.hidden=!on;
    if(!on){var f=document.getElementById('download_from');var t=document.getElementById('download_to');if(f)f.value='';if(t)t.value='';}
  }
  range.addEventListener('change',syncCustom);
  syncCustom();
  form.addEventListener('submit',function(ev){
    var sub=ev.submitter;
    if(!sub||sub.type!=='submit')return;
    var action=sub.getAttribute('formaction')||form.getAttribute('action')||'';
    if(action.indexOf('/download/')===-1)return;
    ev.preventDefault();
    if(feedback)feedback.textContent='Working…';
    var data=new FormData(form);
    var params=new URLSearchParams();
    data.forEach(function(v,k){params.append(k,v);});
    if(range.value!=='${CUSTOM_RANGE}'){params.delete('from');params.delete('to');}
    var url=action+(action.indexOf('?')===-1?'?':'&')+params.toString();
    fetch(url,{credentials:'same-origin'}).then(function(res){
      var ct=(res.headers.get('content-type')||'').toLowerCase();
      if(res.ok&&ct.indexOf('text/csv')!==-1){
        return res.text().then(function(text){
          var lines=text.replace(/^\uFEFF/,'').trim().split(/\\r?\\n/).filter(function(l){return l.length;});
          if(lines.length<=1){
            if(feedback)feedback.textContent='Nothing in that range for those dates.';
            return;
          }
          var disp=res.headers.get('content-disposition')||'';
          var m=/filename="([^"]+)"/.exec(disp);
          var name=m?m[1]:'download.csv';
          var blob=new Blob([text],{type:'text/csv;charset=utf-8'});
          var a=document.createElement('a');
          a.href=URL.createObjectURL(blob);
          a.download=name;
          a.click();
          URL.revokeObjectURL(a.href);
          if(feedback)feedback.textContent='Downloaded '+name+'.';
        });
      }
      return res.text().then(function(text){
        var title=(/<h1>([^<]*)<\\/h1>/.exec(text)||[])[1];
        var msg=(/<p class="muted">([^<]*)<\\/p>/.exec(text)||[])[1];
        if(feedback)feedback.textContent=(title&&msg)?title+': '+msg:'That download did not work.';
      });
    }).catch(function(){if(feedback)feedback.textContent='That download did not work. Try again.';});
  });
})();
</script>`);

function coachZone(tz: string): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

/** The block on Payments: one range and two buttons. Script handles custom
 * dates, feedback, and the file save; without JS the GET form still works. */
export function renderDownloadBlock(tz: string, now: Date = new Date()): SafeHtml {
  const zone = coachZone(tz);
  return html`<h2 id="download">Download</h2>
    <div class="card download">
      <p class="muted">Download your payments and bookings as CSV files for your records.</p>
      <form id="download_form" method="get" action="${PAYMENTS_PATH}">
        <label for="download_range">Range</label>
        <select id="download_range" name="range">
          ${RANGE_PRESETS.map((preset) => html`<option value="${preset}">${PRESET_WORDS[preset]} (${presetRange(preset, zone, now).words})</option>`)}
          <option value="${CUSTOM_RANGE}">Custom dates</option>
        </select>
        <div id="download_custom" class="download-custom" hidden>
          <label for="download_from">From</label>
          <input id="download_from" name="from" type="date" />
          <label for="download_to">To (up to ${MAX_CUSTOM_DAYS} days)</label>
          <input id="download_to" name="to" type="date" />
        </div>
        <div class="download-btn-wrap">
          <button type="submit" class="ghost">Download payments</button>
          <p class="muted download-btn-desc">What clients paid, listed by the day they paid.</p>
        </div>
        <div class="download-btn-wrap">
          <button type="submit" class="ghost" formaction="${BOOKINGS_PATH}">Download bookings</button>
          <p class="muted download-btn-desc">Who booked what, listed by the day of the session.</p>
        </div>
        <p id="download_feedback" class="muted" role="status"></p>
        <p class="muted download-refund-note">A part-refund made outside Coachatron appears in the file but not in Payments totals.</p>
      </form>
      ${DOWNLOAD_FORM_SCRIPT}
    </div>`;
}

/** A short page in place of a file that was not made, with the way back. */
function refusal(res: Response, status: number, title: string, message: string): void {
  res.status(status).send(
    page(
      title,
      html`${coachHeader('payments')}
        <h1>${title}</h1>
        <p class="muted">${message}</p>
        <a class="action" href="/app/payments#download">Back to Payments</a>`,
    ),
  );
}

function setFileHeaders(res: Response, kind: string, label: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="coachatron-${kind}-${label}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
}

async function sendFile(kind: 'payments' | 'bookings', req: Request, res: Response): Promise<void> {
  const headOnly = req.method === 'HEAD';
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const tz = coachZone(coach.tz);
  const range = resolveRange(req.query, tz, new Date());
  if (!range) {
    refusal(
      res,
      400,
      'That range did not work',
      `Choose a range. To use your own dates, choose "Custom dates" and give a from and a to date, the first no later than the last and no more than ${MAX_CUSTOM_DAYS} days apart. With any other range, leave the dates empty.`,
    );
    return;
  }
  // Refused before the query when the hour's downloads are used up; counted
  // only once a file was made, so a refusal or a bad range costs nothing.
  if (await isOverLimit(db, DOWNLOAD_LIMITS, downloadLimitKey(coach.id))) {
    refusal(res, 429, 'Too many downloads', 'That is more downloads than an hour allows. Try again in an hour.');
    return;
  }
  if (headOnly) {
    // Headers only: no query, nothing counted.
    setFileHeaders(res, kind, range.label);
    res.status(200).end();
    return;
  }
  const made = kind === 'payments' ? await paymentsCsv(db, coach.id, tz, range) : await bookingsCsv(db, coach.id, tz, range);
  if (!made.ok) {
    refusal(
      res,
      422,
      'That range is too long',
      `It holds more than ${MAX_EXPORT_ROWS.toLocaleString('en-US')} ${kind}, which is more than one file takes. Choose a shorter range and download it in parts.`,
    );
    return;
  }
  await takeRequest(db, DOWNLOAD_LIMITS, downloadLimitKey(coach.id));
  setFileHeaders(res, kind, range.label);
  res.status(200).send(Buffer.from(made.csv, 'utf8'));
}

/** The two downloads, behind the coach's sign-in: signed out goes to
 * sign-in, and a coach gets only their own rows. `requireAuth` is the coach
 * screens' own check, handed in by the router that mounts this one. */
export function moneyDownloadRouter(requireAuth: RequestHandler): Router {
  const router = Router();
  // HEAD is answered by the same handler, which sends headers alone.
  router.head(PAYMENTS_PATH, requireAuth, (req, res) => sendFile('payments', req, res));
  router.head(BOOKINGS_PATH, requireAuth, (req, res) => sendFile('bookings', req, res));
  router.get(PAYMENTS_PATH, requireAuth, (req, res) => sendFile('payments', req, res));
  router.get(BOOKINGS_PATH, requireAuth, (req, res) => sendFile('bookings', req, res));
  return router;
}