// Дневник на дейностите на водача — от него броячите (tacho-rules.js) смятат всичко.
//
// Всяка смяна на състоянието добавя запис { type, start, end } с време в
// милисекунди. Текущата дейност е последният запис с end: null. Така
// презареждане на приложението или рестарт на телефона не губят нищо.
//
// Видове: drive (каране), work (друга работа), avail (на разположение), rest (почивка).
// Отметки: ferry — почивка на ферибот/влак; manual — въведено ръчно.

export const TYPES = Object.freeze(['drive', 'work', 'avail', 'rest']);

// Пази се 35 дни: стигат за две седмици назад, 144-те часа и компенсацията
// за намалена седмична почивка (до края на третата седмица след нея).
export const KEEP_MS = 35 * 24 * 3600 * 1000;

const copy = e => ({ ...e });

/** Текущата (отворена) дейност или null. */
export function current(log) {
  const last = log.at(-1);
  return last && last.end == null ? last : null;
}

/**
 * Сменя дейността в момент t. Връща нов дневник (старият не се променя).
 * Същата дейност (и същата отметка за ферибот) не добавя нов запис.
 */
export function switchTo(log, type, t = Date.now(), extra = {}) {
  if (!TYPES.includes(type)) throw new Error(`Непознат вид дейност: ${type}`);
  const ferry = type === 'rest' && !!extra.ferry;
  const out = log.map(copy);
  const cur = current(out);
  if (cur) {
    if (cur.type === type && !!cur.ferry === ferry) return out;
    // часовникът никога не връща назад записите; запис с нулева дължина се заменя
    t = Math.max(t, cur.start);
    if (t === cur.start) out.pop();
    else cur.end = t;
  } else if (out.length) {
    t = Math.max(t, out.at(-1).end);
  }
  out.push(ferry ? { type, start: t, end: null, ferry: true } : { type, start: t, end: null });
  return out;
}

/**
 * Добавя ръчно въведен запис (например докато телефонът е бил изключен).
 * Ръчният запис покрива автоматичните, които се застъпват с него.
 * Ако влиза в текущата дейност, тя започва след края му.
 */
export function addManual(log, { type, start, end }, now = Date.now()) {
  if (!TYPES.includes(type)) throw new Error(`Непознат вид дейност: ${type}`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Краят трябва да е след началото');
  if (end > now) throw new Error('Не може да се въвежда време в бъдещето');
  const out = log.map(copy);
  const cur = current(out);
  if (cur && end > cur.start) {
    // частта от текущата дейност преди ръчния запис остава като отделен запис
    if (start > cur.start) {
      const before = { type: cur.type, start: cur.start, end: start };
      if (cur.ferry) before.ferry = true;
      out.push(before);
    }
    cur.start = end;
  }
  out.push({ type, start, end, manual: true });
  return sort(out);
}

/** Маха записите, свършили преди повече от keep милисекунди. */
export function prune(log, now = Date.now(), keep = KEEP_MS) {
  return log.filter(e => e.end == null || e.end >= now - keep).map(copy);
}

function sort(log) {
  // отвореният запис винаги остава последен
  const open = log.filter(e => e.end == null);
  const closed = log.filter(e => e.end != null).sort((a, b) => a.start - b.start || a.end - b.end);
  return [...closed, ...open.slice(-1)];
}

/** Чете дневника от текст (localStorage). Повредени записи се пропускат. */
export function parse(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const ok = raw
    .filter(e => e && TYPES.includes(e.type) && Number.isFinite(e.start) &&
      (e.end == null || (Number.isFinite(e.end) && e.end >= e.start)))
    .map(e => {
      const x = { type: e.type, start: e.start, end: e.end ?? null };
      if (e.ferry && e.type === 'rest') x.ferry = true;
      if (e.manual) x.manual = true;
      return x;
    });
  // само последният запис може да е отворен; другите отворени свършват при следващия
  const open = ok.filter(e => e.end == null).sort((a, b) => a.start - b.start);
  const closed = ok.filter(e => e.end != null);
  for (let i = 0; i < open.length - 1; i++) {
    open[i].end = Math.max(open[i].start, open[i + 1].start);
    closed.push(open[i]);
  }
  return sort([...closed, ...open.slice(-1)]);
}

/** Сумира дейностите между from и to (без застъпванията — ръчното е с предимство). */
export function totals(log, from, to) {
  const sum = { drive: 0, work: 0, avail: 0, rest: 0, manual: false };
  const cover = [];
  // ръчните първо, после автоматичните само там, където няма ръчно
  const order = [...log.filter(e => e.manual), ...log.filter(e => !e.manual)];
  for (const e of order) {
    let pieces = [[Math.max(e.start, from), Math.min(e.end ?? to, to)]];
    for (const [cs, ce] of cover) {
      pieces = pieces.flatMap(([s, en]) => {
        if (en <= cs || s >= ce) return [[s, en]];
        const r = [];
        if (s < cs) r.push([s, cs]);
        if (en > ce) r.push([ce, en]);
        return r;
      });
    }
    for (const [s, en] of pieces) {
      if (en <= s) continue;
      sum[e.type] += en - s;
      cover.push([s, en]);
      if (e.manual) sum.manual = true;
    }
  }
  return sum;
}
