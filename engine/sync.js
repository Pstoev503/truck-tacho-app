// Какво телефонът на шофьора праща на сървъра.
//
// Дневникът може да се променя назад (отворената дейност се затваря, ръчен
// запис разделя стара), затова се праща „прозорец“: всички записи, които още
// текат или са свършили през последните 3 дни. Сървърът заменя своите записи от
// началото на прозореца нататък, а по-старите пази за историята.

export const SYNC_WINDOW_MS = 3 * 24 * 3600 * 1000;

/** Записите за изпращане и откъде сървърът да ги замени. full: целият дневник. */
export function syncPayload(log, now = Date.now(), full = false) {
  const activities = (full ? log : log.filter(e => e.end == null || e.end >= now - SYNC_WINDOW_MS))
    .map(e => {
      const x = { type: e.type, start: e.start, end: e.end ?? null };
      if (e.ferry) x.ferry = true;
      if (e.manual) x.manual = true;
      return x;
    });
  const window_start = activities.length ? Math.min(...activities.map(a => a.start)) : null;
  return { window_start, activities };
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

/** Нормализира адреса на сървъра: без / накрая, само http(s). */
export function serverUrl(s) {
  const v = String(s || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/.test(v) ? v : '';
}
