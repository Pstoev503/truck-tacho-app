import { decodePolyline6, MAX_GEOMETRY_POINTS } from '../engine/route.js';

export class ProviderGeometryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const invalidGeometry = () => new ProviderGeometryError('INVALID_GEOMETRY', 'Маршрутизаторът върна невалидна геометрия.');

export function providerGeometry(trip) {
  if (!trip || typeof trip !== 'object' || Array.isArray(trip) || !Array.isArray(trip.legs) || trip.legs.length === 0) {
    throw invalidGeometry();
  }
  const points = [];
  for (const leg of trip.legs) {
    if (!leg || typeof leg !== 'object' || Array.isArray(leg) ||
        typeof leg.shape !== 'string' || leg.shape.length === 0) {
      throw invalidGeometry();
    }
    let decoded;
    try {
      decoded = decodePolyline6(leg.shape);
    } catch {
      throw invalidGeometry();
    }
    if (decoded.length < 2) throw invalidGeometry();
    const start = points.length ? 1 : 0;
    if (points.length + decoded.length - start > MAX_GEOMETRY_POINTS) {
      throw new ProviderGeometryError('TOO_MANY_POINTS', `Маршрутът надхвърля лимита от ${MAX_GEOMETRY_POINTS} точки.`);
    }
    points.push(...decoded.slice(start));
  }
  if (points.length < 2) throw invalidGeometry();
  return points;
}
