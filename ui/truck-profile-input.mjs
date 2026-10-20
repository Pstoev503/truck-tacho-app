// Manually entered truck profile for the owner's route-options request.
// Strict text → JSON parser for contract truck-profile-v1 and a small request
// controller that drops stale answers. No DOM, storage or network at import.

// Contract order. `inputId` is the control in boss.html.
export const PROFILE_FIELDS = Object.freeze([
  Object.freeze({ key: 'heightM', inputId: 'tpHeight', label: 'Височина', unit: 'm', kind: 'measure' }),
  Object.freeze({ key: 'widthM', inputId: 'tpWidth', label: 'Ширина', unit: 'm', kind: 'measure' }),
  Object.freeze({ key: 'lengthM', inputId: 'tpLength', label: 'Дължина', unit: 'm', kind: 'measure' }),
  Object.freeze({ key: 'grossWeightT', inputId: 'tpGross', label: 'Обща маса', unit: 't', kind: 'measure' }),
  Object.freeze({ key: 'axleLoadT', inputId: 'tpAxleLoad', label: 'Натоварване на ос', unit: 't', kind: 'measure' }),
  Object.freeze({ key: 'axleCount', inputId: 'tpAxleCount', label: 'Брой оси', unit: 'бр.', kind: 'count' }),
  Object.freeze({ key: 'hazmat', inputId: 'tpHazmat', label: 'Опасен товар', unit: '', kind: 'choice' })
]);

// Digits with at most one decimal point or comma; no sign, exponent or spaces inside.
const MEASURE_TEXT = /^\d+(?:[.,]\d+)?$/;
const COUNT_TEXT = /^\d+$/;
// More significant digits than a double keeps exactly would be rounded silently.
const MAX_SIGNIFICANT_DIGITS = 15;

const MESSAGES = {
  REQUIRED: 'Попълни полето.',
  NOT_A_NUMBER: 'Въведи число, например 4 или 4.1 (без единици).',
  TOO_PRECISE: 'Твърде много цифри; въведи до 15 значещи цифри.',
  NOT_POSITIVE: 'Стойността трябва да е по-голяма от 0.',
  NOT_AN_INTEGER: 'Въведи цяло число, например 5.',
  NOT_SAFE_INTEGER: 'Числото е твърде голямо.',
  CHOOSE: 'Избери „Не“ или „Да“.',
  AXLE_OVER_GROSS: 'Натоварването на ос не може да е по-голямо от общата маса.'
};

const significantDigits = text => text.replace(/[.,]/, '').replace(/^0+/, '').replace(/0+$/, '').length;

function parseMeasure(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (typeof raw !== 'string' || text === '') return { code: 'REQUIRED' };
  if (!MEASURE_TEXT.test(text)) return { code: 'NOT_A_NUMBER' };
  if (significantDigits(text) > MAX_SIGNIFICANT_DIGITS) return { code: 'TOO_PRECISE' };
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value) || !(value > 0)) return { code: 'NOT_POSITIVE' };
  return { value };
}

function parseCount(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (typeof raw !== 'string' || text === '') return { code: 'REQUIRED' };
  if (!COUNT_TEXT.test(text)) return { code: 'NOT_AN_INTEGER' };
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return { code: 'NOT_SAFE_INTEGER' };
  if (value <= 0) return { code: 'NOT_POSITIVE' };
  return { value };
}

function parseChoice(raw) {
  if (raw === 'no') return { value: false };
  if (raw === 'yes') return { value: true };
  return { code: 'CHOOSE' };
}

const PARSERS = { measure: parseMeasure, count: parseCount, choice: parseChoice };

// form: { heightM: '4', …, axleCount: '5', hazmat: '' | 'no' | 'yes' } exactly as typed.
// Returns { ok: true, profile } with a new frozen object of the seven contract fields,
// or { ok: false, errors: [{ field, code, message }] } in field order. Never clamps or defaults.
export function parseTruckProfile(form) {
  const source = form && typeof form === 'object' ? form : {};
  const profile = {};
  const errors = [];
  for (const field of PROFILE_FIELDS) {
    const raw = Object.prototype.hasOwnProperty.call(source, field.key) ? source[field.key] : undefined;
    const parsed = PARSERS[field.kind](raw);
    if (parsed.code) errors.push({ field: field.key, code: parsed.code, message: MESSAGES[parsed.code] });
    else profile[field.key] = parsed.value;
  }
  if (!errors.some(e => e.field === 'axleLoadT' || e.field === 'grossWeightT') && profile.axleLoadT > profile.grossWeightT) {
    errors.push({ field: 'axleLoadT', code: 'AXLE_OVER_GROSS', message: MESSAGES.AXLE_OVER_GROSS });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, profile: Object.freeze(profile) };
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
const copyPoint = p => ({ lat: p.lat, lon: p.lon, label: typeof p.label === 'string' ? p.label : '' });

// The POST /api/route-options body: copies of start, end and the profile, nothing else.
export function routeOptionsBody(points, profile) {
  return {
    origin: copyPoint(points[0]),
    destination: copyPoint(points[1]),
    truckProfile: Object.fromEntries(PROFILE_FIELDS.map(f => [f.key, profile[f.key]]))
  };
}

// request(body) → Promise of the server answer (the page's own api() wrapper).
// Every invalidate() or newer request makes an older answer or error stale.
export function createRouteOptionsController({ request }) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  let generation = 0;
  let pending = false;
  let providerSelected = false;

  function invalidate() {
    generation += 1;
    pending = false;
    const hadProviderSelection = providerSelected;
    providerSelected = false;
    return { hadProviderSelection };
  }

  // Outcomes: { status: 'invalid', reason, errors? } before any request;
  // { status: 'applied', data } | { status: 'error', error } for the current request;
  // { status: 'stale' } when the inputs changed or a newer request started meanwhile.
  async function requestOptions({ points, form, loggedIn }) {
    if (!Array.isArray(points) || points.length !== 2 || !points.every(p => p && finite(p.lat) && finite(p.lon))) {
      return { status: 'invalid', reason: 'POINTS' };
    }
    if (loggedIn !== true) return { status: 'invalid', reason: 'LOGIN' };
    const parsed = parseTruckProfile(form);
    if (!parsed.ok) return { status: 'invalid', reason: 'PROFILE', errors: parsed.errors };
    const body = routeOptionsBody(points, parsed.profile);
    generation += 1;
    const mine = generation;
    pending = true;
    // An earlier selected provider line stays marked until a profile or point change removes it.
    try {
      const data = await request(body);
      if (mine !== generation) return { status: 'stale' };
      pending = false;
      return { status: 'applied', data };
    } catch (error) {
      if (mine !== generation) return { status: 'stale' };
      pending = false;
      return { status: 'error', error };
    }
  }

  return {
    requestOptions,
    invalidate,
    markProviderSelected() { providerSelected = true; },
    markManualGeometry() { providerSelected = false; },
    getState: () => ({ generation, pending, providerSelected })
  };
}
