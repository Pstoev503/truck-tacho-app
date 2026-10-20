export const ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE = 'Отговорът с вариантите е невалиден. Опитай отново.';
export const MAX_ROUTE_OPTION_CANDIDATES = 3;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTrip = value => isRecord(value) && Array.isArray(value.legs) && value.legs.length > 0;
const invalidResponse = () => new TypeError(ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE);

export function normalizeRouteOptionsResponse(response) {
  if (!isRecord(response) || !isTrip(response.trip)) throw invalidResponse();

  const trips = [response.trip];
  if (response.alternates == null) return trips;
  if (!Array.isArray(response.alternates)) throw invalidResponse();
  if (response.alternates.length > MAX_ROUTE_OPTION_CANDIDATES - 1) throw invalidResponse();

  for (const alternate of response.alternates) {
    if (!isRecord(alternate)) throw invalidResponse();
    const trip = Object.prototype.hasOwnProperty.call(alternate, 'trip') ? alternate.trip : alternate;
    if (!isTrip(trip)) throw invalidResponse();
    trips.push(trip);
  }

  return trips;
}
