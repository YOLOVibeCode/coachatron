/** The second closed schema the model fills (PLATFORM.md §4.2): a coach's
 * spoken or typed week, extracted into rows. The model only extracts;
 * src/domain/setup.ts validates, asks, previews, and writes. Strict: every
 * property required, nullable where the coach may not have said it. */

function obj(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

const nullableInt = { type: ['integer', 'null'] };
const nullableStr = { type: ['string', 'null'] };

export const SETUP_JSON_SCHEMA = obj({
  coach_timezone: nullableStr,
  session_types: {
    type: 'array',
    items: obj({
      key: { type: 'string' },
      name: { type: 'string' },
      duration_min: nullableInt,
      capacity: nullableInt,
      price_cents: nullableInt,
      backup_pay_cents: nullableInt,
    }),
  },
  weekly: {
    type: 'array',
    items: obj({
      type_key: { type: 'string' },
      weekday: { type: 'integer' },
      time_local: { type: 'string' },
      location: nullableStr,
    }),
  },
  packages: {
    type: 'array',
    items: obj({
      name: { type: 'string' },
      credits: { type: 'integer' },
      price_cents: { type: 'integer' },
      expires_days: nullableInt,
    }),
  },
  plans: {
    type: 'array',
    items: obj({
      name: { type: 'string' },
      price_cents: { type: 'integer' },
      credits_per_month: { type: 'integer' },
    }),
  },
});
