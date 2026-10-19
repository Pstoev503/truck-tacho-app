// Review window for parkings before one planned pause: the stretch of the drawn
// line that ends at the pause. It is a viewing aid, not a legal reserve and not
// proof that a parking can be reached in time.
export const DEFAULT_LOOKBACK_KM = 20;
export const MAX_LOOKBACK_KM = 200;

export class RestWindowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new RestWindowError(code, message); };

export function validateLookbackKm(lookbackKm) {
  if (typeof lookbackKm !== 'number' || !Number.isFinite(lookbackKm) ||
      lookbackKm <= 0 || lookbackKm > MAX_LOOKBACK_KM) {
    fail('INVALID_LOOKBACK', `„Преглед назад“ трябва да е число над 0 и до ${MAX_LOOKBACK_KM} км.`);
  }
  return lookbackKm;
}

// event: a map-plan rest event ({ type: 'rest', fromM, toM, ... }).
// Returns { restOffsetM, minOffsetM, maxOffsetM, lookbackKm, clamped } in metres
// along the route; maxOffsetM is exactly event.fromM, nothing after the pause.
export function restParkingWindow({ event, totalLengthM, lookbackKm = DEFAULT_LOOKBACK_KM } = {}) {
  validateLookbackKm(lookbackKm);
  if (typeof totalLengthM !== 'number' || !Number.isFinite(totalLengthM) || totalLengthM <= 0) {
    fail('INVALID_ROUTE_LENGTH', 'Дължината на маршрута не е известна.');
  }
  if (!event || typeof event !== 'object' || event.type !== 'rest') {
    fail('NOT_A_REST', 'Избери пауза или почивка от графика.');
  }
  const { fromM, toM } = event;
  if (typeof fromM !== 'number' || !Number.isFinite(fromM) || fromM !== toM ||
      fromM < 0 || fromM > totalLengthM) {
    fail('INVALID_REST_POSITION', 'Позицията на паузата по линията е невалидна.');
  }
  if (fromM === 0) {
    fail('REST_AT_START', 'Паузата е в началото на маршрута; преди нея няма участък за преглед.');
  }
  const minOffsetM = Math.max(0, fromM - lookbackKm * 1000);
  return {
    restOffsetM: fromM,
    minOffsetM,
    maxOffsetM: fromM,
    lookbackKm,
    clamped: minOffsetM === 0 && fromM < lookbackKm * 1000
  };
}
