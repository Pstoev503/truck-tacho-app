export const MAX_PROVIDER_GEOMETRY_POINTS = 20_000;

export class ProviderGeometryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function providerGeometry(trip, decodePolyline6) {
  if (typeof decodePolyline6 !== 'function') throw new TypeError('decodePolyline6 must be a function');
  const points = [];
  for (const leg of (Array.isArray(trip?.legs) ? trip.legs : [])) {
    if (!leg?.shape) continue;
    const decoded = decodePolyline6(leg.shape);
    if (!Array.isArray(decoded)) {
      throw new ProviderGeometryError('INVALID_GEOMETRY', 'Маршрутизаторът върна невалидна геометрия.');
    }
    const start = points.length ? 1 : 0;
    if (points.length + Math.max(0, decoded.length - start) > MAX_PROVIDER_GEOMETRY_POINTS) {
      throw new ProviderGeometryError('TOO_MANY_POINTS', `Маршрутизаторът върна над ${MAX_PROVIDER_GEOMETRY_POINTS} точки за един маршрут.`);
    }
    for (let i = start; i < decoded.length; i++) points.push(decoded[i]);
  }
  return points;
}
