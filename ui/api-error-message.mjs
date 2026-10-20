const GENERIC = 'Провери въведените полета.';

const contexts = [
  {
    path: '/api/route-options',
    method: 'POST',
    fields: new Set(['origin', 'destination', 'lat', 'lon', 'truckProfile',
      'heightM', 'widthM', 'lengthM', 'grossWeightT', 'axleLoadT', 'axleCount', 'hazmat']),
    message: 'Провери профила на камиона и началната/крайната координата.'
  },
  {
    path: '/api/owner/register',
    method: 'POST',
    fields: new Set(['company', 'name', 'email', 'password', 'registration_code']),
    message: 'Провери името на фирмата, името, имейла, паролата и кода за регистрация.'
  },
  {
    path: '/api/owner/login',
    method: 'POST',
    fields: new Set(['email', 'password']),
    message: 'Провери имейла и паролата.'
  },
  {
    path: '/api/drivers',
    method: 'POST',
    fields: new Set(['name']),
    message: 'Провери името на шофьора.'
  },
  {
    path: /^\/api\/drivers\/\d+$/,
    method: 'PATCH',
    fields: new Set(['name', 'active']),
    message: 'Провери името или статуса на шофьора.'
  },
  {
    path: '/api/routes',
    method: 'POST',
    fields: new Set(['name', 'driver_id', 'waypoints', 'geometry', 'notes', 'lat', 'lon']),
    message: 'Провери името на маршрута, точките, координатите и избрания шофьор.'
  }
];

function isKnownContextError(error, fields) {
  if (!error || typeof error !== 'object' || Array.isArray(error) || !Array.isArray(error.loc)
      || error.loc.length < 2 || error.loc[0] !== 'body'
      || !error.loc.every(part => typeof part === 'string' || (Number.isInteger(part) && part >= 0))) return false;
  const fieldPath = error.loc.slice(1);
  return fieldPath.some(part => typeof part === 'string')
    && fieldPath.every(part => typeof part === 'number' || fields.has(part));
}

export function apiErrorMessage(path, method, payload) {
  const context = contexts.find(item =>
    item.method === method && (typeof item.path === 'string' ? item.path === path : item.path.test(path))
  );
  if (typeof path !== 'string' || typeof method !== 'string' || !payload || typeof payload !== 'object'
      || Array.isArray(payload) || !Array.isArray(payload.detail) || payload.detail.length === 0
      || !context || !payload.detail.every(error => isKnownContextError(error, context.fields))) return GENERIC;
  return context.message;
}
