// Маршрут от шефа: точки на картата → връзка за шофьора → навигация.
//
// Маршрутът е { name, notes, waypoints: [{ lat, lon, label }] }. Може да се прати
// през сървъра или като връзка (всичко е в адреса след #route=, без сървър).
// Шофьорът го отваря в Google Maps (до 9 междинни точки на етап) или го
// изтегля като GPX за навигация за камиони.

const R_KM = 6371;
export const MAX_POINTS = 25;
export const GOOGLE_MAX_WAYPOINTS = 9; // междинни точки в една връзка към Google Maps

const round6 = x => Math.round(x * 1e6) / 1e6;
const okPoint = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** Проверява и почиства маршрут. Връща null, ако не става. */
export function cleanRoute(r) {
  if (!r || !Array.isArray(r.waypoints)) return null;
  const waypoints = r.waypoints.filter(okPoint).slice(0, MAX_POINTS)
    .map(p => ({ lat: round6(p.lat), lon: round6(p.lon), label: String(p.label ?? '').slice(0, 120) }));
  if (waypoints.length < 2) return null;
  return {
    name: String(r.name ?? '').slice(0, 120) || 'Маршрут',
    notes: String(r.notes ?? '').slice(0, 2000),
    waypoints
  };
}

// base64url за UTF-8 текст (кирилицата минава)
function toB64url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

/** Маршрут → кратък текст за връзка. */
export function encodeRoute(route) {
  const r = cleanRoute(route);
  if (!r) throw new Error('Маршрутът трябва да има поне 2 точки');
  return toB64url(JSON.stringify({ n: r.name, t: r.notes, w: r.waypoints.map(p => [p.lat, p.lon, p.label]) }));
}

/** Текст от връзка → маршрут или null. */
export function decodeRoute(s) {
  try {
    const o = JSON.parse(fromB64url(String(s)));
    return cleanRoute({ name: o.n, notes: o.t, waypoints: (o.w || []).map(([lat, lon, label]) => ({ lat, lon, label })) });
  } catch {
    return null;
  }
}

/** Чете #route=…, #join=…&server=… от адреса. */
export function parseHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const out = {};
  if (p.get('route')) out.route = decodeRoute(p.get('route'));
  if (p.get('join')) out.join = p.get('join');
  if (p.get('server')) out.server = p.get('server');
  return out;
}

const ll = p => `${p.lat},${p.lon}`;

/**
 * Връзки към Google Maps. Първият етап тръгва от мястото на телефона (fromHere)
 * или от първата точка. Ако точките са много, се разделят на етапи.
 */
export function googleMapsLinks(waypoints, { fromHere = true } = {}) {
  const pts = waypoints.filter(okPoint);
  if (!pts.length) return [];
  const links = [];
  let origin = fromHere ? null : pts[0];
  let i = fromHere ? 0 : 1;
  while (i < pts.length) {
    const leg = pts.slice(i, i + GOOGLE_MAX_WAYPOINTS + 1); // междинни + крайна
    const dest = leg[leg.length - 1];
    const mid = leg.slice(0, -1);
    const q = new URLSearchParams({ api: '1', destination: ll(dest), travelmode: 'driving' });
    if (origin) q.set('origin', ll(origin));
    if (mid.length) q.set('waypoints', mid.map(ll).join('|'));
    links.push('https://www.google.com/maps/dir/?' + q.toString());
    origin = dest;
    i += leg.length;
  }
  return links;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GPX 1.1 с маршрут и точки — за Sygic, TomTom и други навигации. */
export function gpx(route) {
  const r = cleanRoute(route);
  if (!r) throw new Error('Маршрутът трябва да има поне 2 точки');
  const pt = (tag, p, i) => `  <${tag} lat="${p.lat}" lon="${p.lon}"><name>${esc(p.label || `Точка ${i + 1}`)}</name></${tag}>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Top10EU" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(r.name)}</name>${r.notes ? `<desc>${esc(r.notes)}</desc>` : ''}</metadata>`,
    ...r.waypoints.map((p, i) => pt('wpt', p, i)),
    `  <rte><name>${esc(r.name)}</name>`,
    ...r.waypoints.map((p, i) => '  ' + pt('rtept', p, i)),
    '  </rte>',
    '</gpx>'
  ].join('\n');
}

/** Разстояние по права линия, км. */
export function haversineKm(a, b) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

export function straightKm(waypoints) {
  let km = 0;
  for (let i = 1; i < waypoints.length; i++) km += haversineKm(waypoints[i - 1], waypoints[i]);
  return km;
}
