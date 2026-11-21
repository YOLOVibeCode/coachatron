import { html, raw, type SafeHtml } from './html.js';

/** Same text as eval `landing-placeholder` and the week textarea placeholder. */
export const LANDING_WEEK_EXAMPLE =
  'Tuesdays and Thursdays at 6pm, an hour, 8 athletes, $35. Privates Saturday at 9am, 45 minutes, $70. 10-pack for $300.';

export interface LandingPreviewSlot {
  id: string;
  title: string;
  metaLeft: string;
  spotsLabel: string;
  bookLabel: string;
}

/** Parent-booking demo built from the landing week example (not live data). */
export const LANDING_PREVIEW_SLOTS: LandingPreviewSlot[] = [
  {
    id: 'tue',
    title: 'Tue 7 Oct · 6:00pm',
    metaLeft: '60 min · Group',
    spotsLabel: '2 of 8 spots left · $35',
    bookLabel: 'Book Tue 6:00pm',
  },
  {
    id: 'thu',
    title: 'Thu 9 Oct · 6:00pm',
    metaLeft: '60 min · Group',
    spotsLabel: '5 of 8 spots left · $35',
    bookLabel: 'Book Thu 6:00pm',
  },
  {
    id: 'sat',
    title: 'Sat 11 Oct · 9:00am',
    metaLeft: '45 min · Private',
    spotsLabel: '1 spot left · $70',
    bookLabel: 'Book Sat 9:00am',
  },
];

export const LANDING_PREVIEW_PACK = { name: '10-pack', priceLabel: '$300' };

export function renderLandingPhonePreview(): SafeHtml {
  const defaultSlot = LANDING_PREVIEW_SLOTS[0]!;
  return html`<div class="stage" aria-hidden="true">
    <p class="preview-label">What parents see, built from your words</p>
    <div class="phone"><div class="screen">
      <div class="status"><span>9:14</span><span>LTE</span></div>
      <div class="body landing-preview-body">
        <p class="eyebrow">coachatron.com/c/your-coach</p>
        <h2>Open sessions</h2>
        <p class="sub">Tap a time. Pay before you arrive.</p>
        <div class="landing-slots">
          ${LANDING_PREVIEW_SLOTS.map((slot, i) =>
            html`<button type="button" class="card landing-slot${i === 0 ? ' on' : ''}" data-landing-slot data-book-label="${slot.bookLabel}" aria-pressed="${i === 0 ? 'true' : 'false'}">
              <strong>${slot.title}</strong>
              <div class="meta"><span>${slot.metaLeft}</span><span class="spots">${slot.spotsLabel}</span></div>
            </button>`,
          )}
        </div>
        <div class="card landing-pack"><strong>${LANDING_PREVIEW_PACK.name}</strong><div class="meta"><span>Package</span><span>${LANDING_PREVIEW_PACK.priceLabel}</span></div></div>
        <div class="btn landing-book" id="landing-book-btn" role="status">${defaultSlot.bookLabel}</div>
      </div>
    </div></div>
  </div>`;
}

export const LANDING_PREVIEW_SCRIPT = raw(`<script>
(function(){
  var btn=document.getElementById('landing-book-btn');
  if(!btn)return;
  document.querySelectorAll('[data-landing-slot]').forEach(function(el){
    el.addEventListener('click',function(){
      document.querySelectorAll('[data-landing-slot]').forEach(function(s){
        s.classList.remove('on');
        s.setAttribute('aria-pressed','false');
      });
      el.classList.add('on');
      el.setAttribute('aria-pressed','true');
      var label=el.getAttribute('data-book-label');
      if(label)btn.textContent=label;
    });
  });
})();
</script>`);

export const COPY_SMS_NUMBER_SCRIPT =
  "var b=this,i=document.getElementById('landing-sms-number');if(!i)return;" +
  "function done(){b.textContent='Copied'}" +
  "function old(){try{if(document.execCommand('copy'))done()}catch(e){}}" +
  "function pick(){i.focus();i.select();}" +
  "pick();try{navigator.clipboard.writeText(i.value).then(done,function(){pick();old()})}catch(e){pick();old()}";