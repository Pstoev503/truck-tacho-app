// Coordinates of one stretch [minOffsetM, maxOffsetM] of the drawn line, for
// drawing it on the map. It follows the same indexed line (vertices kept, long
// arcs sampled) and never draws a straight shortcut between its two ends.
import { indexRoute, pointAtOffset } from '../engine/route-position.js';

export const MAX_WINDOW_STEP_M = 25_000;
export const MAX_WINDOW_POINTS = 2000;

export class RouteWindowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new RouteWindowError(code, message); };
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// Returns a frozen array of { lat, lon, routeOffsetM }: the exact start, every
// route vertex strictly inside the stretch, intermediate samples at most
// MAX_WINDOW_STEP_M apart, and the exact end.
export function routeWindowPoints(geometry, { minOffsetM, maxOffsetM } = {}) {
  if (!Array.isArray(geometry) ||
      !geometry.every(point => point && typeof point === 'object' && isNumber(point.lat) && isNumber(point.lon))) {
    fail('INVALID_GEOMETRY', 'Линията трябва да е масив от точки с числови lat и lon.');
  }
  let index;
  try {
    index = indexRoute(geometry);
  } catch (caught) {
    fail('INVALID_GEOMETRY', `Линията не е поддържана: ${caught.message}`);
  }
  if (!isNumber(minOffsetM) || !isNumber(maxOffsetM) ||
      minOffsetM < 0 || minOffsetM >= maxOffsetM || maxOffsetM > index.totalLengthM) {
    fail('INVALID_OFFSETS', 'Участъкът трябва да е 0 ≤ начало < край ≤ дължината на линията.');
  }

  const points = [];
  const push = offsetM => {
    if (points.length >= MAX_WINDOW_POINTS) {
      fail('TOO_MANY_POINTS', `Участъкът изисква над ${MAX_WINDOW_POINTS} точки за показване.`);
    }
    const { lat, lon } = pointAtOffset(index, offsetM);
    points.push(Object.freeze({ lat, lon, routeOffsetM: offsetM }));
  };

  push(minOffsetM);
  for (const segment of index.segments) {
    if (segment.lengthM === 0 || segment.endOffsetM <= minOffsetM || segment.startOffsetM >= maxOffsetM) continue;
    const from = Math.max(minOffsetM, segment.startOffsetM);
    const to = Math.min(maxOffsetM, segment.endOffsetM);
    const steps = Math.max(1, Math.ceil((to - from) / MAX_WINDOW_STEP_M));
    for (let step = 1; step <= steps; step++) {
      // The last step lands exactly on the vertex or the window end.
      push(step === steps ? to : from + (to - from) * step / steps);
    }
  }
  return Object.freeze(points);
}
