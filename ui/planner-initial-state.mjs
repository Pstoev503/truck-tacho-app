const ACTIVITY_TYPES = new Set(['drive', 'work', 'avail', 'rest']);
const ACTIVITY_KEYS = new Set(['type', 'start', 'end', 'manual', 'ferry']);
const ACTIVITY_STORAGE_KEY = 'th_activities';
const WEEKLY_REST_STORAGE_KEY = 'th_weekly_rest_end';
const NUMERIC_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function invalidActivities() {
  return new Error('Локалният дневник е невалиден или непълен; не е заредена история.');
}

function parseActivities(raw, now) {
  if (raw == null) return [];
  if (typeof raw !== 'string') throw invalidActivities();

  let activities;
  try {
    activities = JSON.parse(raw);
  } catch {
    throw invalidActivities();
  }
  if (!Array.isArray(activities)) throw invalidActivities();

  return activities.map(activity => {
    if (!activity || typeof activity !== 'object' || Array.isArray(activity) ||
        Object.keys(activity).some(key => !ACTIVITY_KEYS.has(key)) ||
        !ACTIVITY_TYPES.has(activity.type) ||
        !Object.hasOwn(activity, 'start') || !Object.hasOwn(activity, 'end') ||
        typeof activity.start !== 'number' || !Number.isFinite(activity.start) ||
        activity.start > now ||
        (activity.end !== null &&
          (typeof activity.end !== 'number' || !Number.isFinite(activity.end) ||
           activity.end <= activity.start || activity.end > now)) ||
        ['manual', 'ferry'].some(flag =>
          Object.hasOwn(activity, flag) && typeof activity[flag] !== 'boolean') ||
        (Object.hasOwn(activity, 'ferry') && activity.type !== 'rest')) {
      throw invalidActivities();
    }
    return {
      type: activity.type,
      start: activity.start,
      end: activity.end,
      ...(Object.hasOwn(activity, 'manual') ? { manual: activity.manual } : {}),
      ...(Object.hasOwn(activity, 'ferry') ? { ferry: activity.ferry } : {})
    };
  });
}

function parseWeeklyRestEnd(raw, now) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'string' || !NUMERIC_TEXT.test(raw.trim())) {
    throw new Error('Краят на седмичната почивка е невалиден; въведи коректна стойност на устройството.');
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value > now) {
    throw new Error('Краят на седмичната почивка е невалиден или е в бъдещето.');
  }
  return value;
}

export function loadPlannerInitialState({ readStorage, now = Date.now } = {}) {
  if (typeof readStorage !== 'function' || typeof now !== 'function') {
    throw new TypeError('Нужни са четец на локални данни и часовник.');
  }
  const currentTime = now();
  if (!Number.isFinite(currentTime)) throw new Error('Не може да се определи текущият час.');

  let rawActivities, rawWeeklyRestEnd;
  try {
    rawActivities = readStorage(ACTIVITY_STORAGE_KEY);
    rawWeeklyRestEnd = readStorage(WEEKLY_REST_STORAGE_KEY);
  } catch {
    throw new Error('Локалният дневник не може да бъде прочетен от това устройство.');
  }
  const activities = parseActivities(rawActivities, currentTime);
  const lastWeeklyRestEnd = parseWeeklyRestEnd(rawWeeklyRestEnd, currentTime);
  const latestBoundary = activities.length
    ? activities.reduce((latest, activity) =>
      Math.max(latest, activity.start, activity.end ?? activity.start), -Infinity)
    : null;

  return {
    initialState: {
      activities,
      lastWeeklyRestEnd,
      source: 'local-device'
    },
    summary: {
      activityCount: activities.length,
      latestBoundary
    }
  };
}
