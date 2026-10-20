// Какво телефонът на шофьора праща на сървъра.
//
// Дневникът може да се променя назад (отворената дейност се затваря, ръчен
// запис разделя стара), затова се праща „прозорец“: всички записи, които още
// текат или са свършили през последните 3 дни. Сървърът заменя своите записи от
// началото на прозореца нататък, а по-старите пази за историята.

export const SYNC_WINDOW_MS = 3 * 24 * 3600 * 1000;
export const MAX_ENTRIES = 15000; // сървърът приема до 20 000 записа наведнъж

/**
 * Записите за изпращане и откъде сървърът да ги замени.
 * from: най-ранният момент, от който сървърът трябва да се обнови (ръчен запис
 * назад във времето, дълго без връзка, ново свързване: -Infinity = всичко).
 * Изпраща се всичко, което започва след началото на прозореца — и старите
 * ръчни записи вътре в дълга почивка, за да не ги изтрие сървърът.
 */
export function syncPayload(log, now = Date.now(), from = null, maxEntries = MAX_ENTRIES) {
  const cutoff = Math.min(now - SYNC_WINDOW_MS, from ?? Infinity);
  const recent = log.filter(e => e.end == null || e.end >= cutoff);
  if (!recent.length) return { window_start: null, activities: [] };
  const window = Math.min(...recent.map(e => e.start));
  let send = log.filter(e => e.start >= window);
  if (send.length > maxEntries) send = send.slice(-maxEntries); // твърде много: само най-новите
  const activities = send.map(e => {
    const x = { type: e.type, start: e.start, end: e.end ?? null };
    if (e.ferry) x.ferry = true;
    if (e.manual) x.manual = true;
    return x;
  });
  return { window_start: activities[0].start, activities };
}

/**
 * Кратък образ на броячите за собственика (той ги смята и сам от дневника).
 * extra: настройките на телефона, които влияят на сметката (двойка, последна седмична почивка).
 */
export function statusSnapshot(result, now = Date.now(), extra = {}) {
  if (!result) return null;
  const st = result.status;
  return {
    ...extra,
    at: now,
    activity: st.activity,
    driveRemaining: st.driveRemaining,
    binding: st.binding,
    resumeAt: st.resumeAt,
    dailyDriven: st.daily.driven,
    dailyLimit: st.daily.limit,
    latestRestStart: st.daily.latestRestStart,
    weeklyDriven: st.weekly.driven,
    weeklyRestDeadline: st.weeklyRest.deadline,
    warnings: st.warnings.map(w => w.code)
  };
}

/** „2026-10-13“ по местното време на телефона. */
export function dayKey(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Смените от отчета на телефона (ключ toDateString) за последните дни. */
export function recentShifts(history, now = Date.now(), days = 7) {
  const out = [];
  for (const [k, data] of Object.entries(history || {})) {
    const t = Date.parse(k);
    if (!Number.isFinite(t) || now - t > days * 24 * 3600 * 1000 || !data) continue;
    out.push({ day: dayKey(t), data });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** Нормализира адреса на сървъра: без / накрая; https, а http само за този компютър. */
export function serverUrl(s) {
  const v = String(s || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[^\s/]+/.test(v)) return v;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(v)) return v;
  return '';
}

// кирилски букви, които изглеждат като латински (код, набран на българска клавиатура)
const LOOKALIKE = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y' };

/** Кодът за покана: главни латински букви и цифри, без тирета и интервали. */
export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[А-ЯЁ]/g, ch => LOOKALIKE[ch] || ch).replace(/[^A-Z0-9]/g, '');
}
