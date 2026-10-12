// Броячи за време на шофиране и почивка по Регламент (ЕО) № 561/2006
// (консолидиран текст от 22.05.2024 г., чл. 4, 6, 7, 8 и 9).
//
// Модулът не пази брояч, който се увеличава с времето. Пази само дневник на
// дейностите (каране, работа, разположение, почивка) и при всяко питане
// изчислява всичко наново от него. Така състоянието не се губи при рестарт
// на телефона, отчетът към собственика излиза от същите данни, а грешка в
// един ден не се пренася в следващия.
//
// Работи в браузъра и в Node.js, без външни библиотеки.
// Какво е опростено и какво не е покрито: виж README.md в същата папка.

export const MIN = 60_000;
export const H = 60 * MIN;
const DAY = 24 * H;
const WEEK = 7 * DAY;

// Числата от регламента.
export const LIMITS = Object.freeze({
  continuousDrive: 4.5 * H,        // чл. 7: след 4 ч 30 мин каране
  breakFull: 45 * MIN,             // чл. 7: пауза 45 мин
  breakSplitFirst: 15 * MIN,       // чл. 7: или 15 мин...
  breakSplitSecond: 30 * MIN,      // ...последвани от 30 мин
  dailyDrive: 9 * H,               // чл. 6(1)
  dailyDriveExtended: 10 * H,      // чл. 6(1): до 10 ч
  extensionsPerWeek: 2,            // чл. 6(1): два пъти седмично
  weeklyDrive: 56 * H,             // чл. 6(2)
  fortnightDrive: 90 * H,          // чл. 6(3)
  dailyRestRegular: 11 * H,        // чл. 4(g)
  dailyRestReduced: 9 * H,         // чл. 4(g)
  splitRestFirst: 3 * H,           // чл. 4(g): разделена 3 + 9 ч
  reducedDailyRestsMax: 3,         // чл. 8(4)
  dailyWindow: 24 * H,             // чл. 8(2)
  multiManningWindow: 30 * H,      // чл. 8(5)
  weeklyRestRegular: 45 * H,       // чл. 4(h)
  weeklyRestReduced: 24 * H,       // чл. 4(h)
  weeklyRestDeadline: 6 * DAY,     // чл. 8(6): до края на шест 24-часови периода
  ferryMaxInterruptions: 2,        // чл. 9(1)
  ferryMaxInterruptionTotal: 1 * H // чл. 9(1)
});

const TYPES = new Set(['drive', 'work', 'avail', 'rest']);

const DEFAULTS = {
  now: undefined,                   // момент на изчислението; по подразбиране Date.now()
  multiManning: false,              // двойка: дневна почивка 9 ч в рамките на 30 ч
  international: false,             // международен превоз: две поредни намалени седмични почивки са позволени (чл. 8(6))
  availabilityCountsAsBreak: false, // „на разположение“ като пауза по чл. 7 (никога като дневна или седмична почивка)
  gapsAsRest: true,                 // празнините в дневника се броят за почивка и се отбелязват
  weekOffsetMinutes: 0,             // седмицата е пон 00:00 – нед 24:00; тахографът брои в UTC
  lastRestEnd: undefined,           // край на последната дневна почивка преди дневника
  lastWeeklyRestEnd: undefined,     // край на последната седмична почивка преди дневника
  lastWeeklyRestReduced: false,     // дали тя е била намалена
  history: undefined,               // { reducedRestsUsed, extensionsUsed, drivenThisWeek, drivenPreviousWeek } от разпечатка
  timeZone: 'Europe/Sofia',         // за часовете в изреченията
  warnBreakMinutes: 15,
  warnDailyDriveMinutes: 30,
  warnDailyRestMinutes: 60,
  warnWeeklyRestHours: [24, 12, 4],
  warnWeeklyDriveMinutes: 120
};

// ─────────────────────────── помощни ───────────────────────────

const toMs = t => (typeof t === 'number' ? t : t instanceof Date ? t.getTime() : Date.parse(t));
const overlap = (s1, e1, s2, e2) => Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));

// Начало на седмицата (понеделник 00:00), отместено с offset минути спрямо UTC.
// 1 януари 1970 г. е четвъртък, затова (ден + 3) % 7 дава 0 за понеделник.
export function weekStart(t, offsetMinutes = 0) {
  const off = offsetMinutes * MIN;
  const day = Math.floor((t + off) / DAY);
  const dow = ((day + 3) % 7 + 7) % 7;
  return (day - dow) * DAY - off;
}

// 1. Записите в дневника: отворен запис (end: null) свършва там, където започва
//    следващият. При застъпване по-късният запис покрива по-ранния (по-ранният
//    се разделя около него), а ръчните записи покриват автоматичните.
function resolve(activities, o) {
  const now = o.now;
  const list = activities.map((a, i) => {
    if (!TYPES.has(a.type)) throw new Error(`Непознат вид дейност: ${a.type}`);
    const s = toMs(a.start);
    const e = a.end == null ? null : toMs(a.end);
    if (Number.isNaN(s) || (e != null && Number.isNaN(e))) throw new Error('Невалидно време в дневника');
    return { type: a.type, s, e, ferry: !!a.ferry, manual: !!a.manual, i };
  }).filter(a => a.s < now).sort((x, y) => x.s - y.s || x.i - y.i);

  for (let k = 0; k < list.length; k++) {
    if (list[k].e == null) {
      const next = list.slice(k + 1).find(n => n.s > list[k].s);
      list[k].e = next ? next.s : now;
    }
    list[k].e = Math.min(list[k].e, now);
  }

  let tl = [];
  for (const x of [...list.filter(a => !a.manual), ...list.filter(a => a.manual)]) {
    if (x.e <= x.s) continue;
    const next = [];
    for (const y of tl) {
      if (y.e <= x.s || y.s >= x.e) { next.push(y); continue; }
      if (y.s < x.s) next.push({ ...y, e: x.s });
      if (y.e > x.e) next.push({ ...y, s: x.e });
    }
    next.push({ ...x });
    tl = next.sort((p, q) => p.s - q.s);
  }
  return tl;
}

// 2. Празнините (и времето след последния запис) стават почивка с отметка gap;
//    съседните еднакви дейности се сливат. Две съседни почивки са една
//    непрекъсната почивка, независимо дали едната е на ферибот.
function fill(tl, o) {
  const out = [];
  const push = a => {
    const last = out.at(-1);
    if (last && last.e === a.s && last.type === a.type) {
      last.e = a.e;
      last.manual = last.manual || !!a.manual;
      last.ferry = last.ferry || !!a.ferry;
      last.gap = last.gap || !!a.gap;
    } else {
      out.push({ type: a.type, s: a.s, e: a.e, ferry: !!a.ferry, manual: !!a.manual, gap: !!a.gap });
    }
  };
  let t = null;
  for (const a of tl) {
    if (t != null && a.s > t && o.gapsAsRest) push({ type: 'rest', s: t, e: a.s, gap: true });
    push(a);
    t = a.e;
  }
  if (t != null && t < o.now && o.gapsAsRest) push({ type: 'rest', s: t, e: o.now, gap: true });
  return out;
}

// 3. Чл. 9: редовна дневна или намалена седмична почивка на ферибот/влак може
//    да се прекъсне до 2 пъти общо до 1 ч. Сливаме само ако почивката без
//    прекъсванията е поне 11 ч. Прекъсванията не се броят за почивка, а
//    карането в тях влиза в дневното и седмичното каране.
function mergeFerry(list) {
  const out = [];
  let i = 0;
  while (i < list.length) {
    const a = list[i];
    const single = { ...a, len: a.e - a.s, parts: [[a.s, a.e]], inner: [] };
    if (a.type !== 'rest' || !a.ferry) { out.push(single); i++; continue; }
    const parts = [[a.s, a.e]], inner = [];
    let j = i, count = 0, total = 0;
    for (;;) {
      let k = j + 1;
      const run = [];
      while (k < list.length && list[k].type !== 'rest') run.push(list[k++]);
      if (!run.length || k >= list.length || !list[k].ferry) break;
      const ms = run.reduce((t, x) => t + (x.e - x.s), 0);
      if (count + 1 > LIMITS.ferryMaxInterruptions || total + ms > LIMITS.ferryMaxInterruptionTotal) break;
      count++;
      total += ms;
      inner.push(...run);
      parts.push([list[k].s, list[k].e]);
      j = k;
    }
    const restMs = parts.reduce((t, [s, e]) => t + (e - s), 0);
    if (j > i && restMs >= LIMITS.dailyRestRegular) {
      out.push({ type: 'rest', s: a.s, e: list[j].e, len: restMs, ferry: true, parts, inner,
        manual: a.manual, gap: parts.some((_, n) => list[i + 2 * n]?.gap) });
      i = j + 1;
    } else {
      out.push(single);
      i++;
    }
  }
  return out;
}

// ─────────────────────────── анализ ───────────────────────────

export function analyze(activities, options = {}) {
  const o = { ...DEFAULTS, ...options };
  o.now = o.now == null ? Date.now() : toMs(o.now);
  const now = o.now;
  const raw = fill(resolve(activities, o), o);
  const segs = mergeFerry(raw);
  const violations = [];
  const V = (code, article, at, detail) => violations.push({ code, article, at, detail });
  const hist = o.history || {};

  // ── чл. 7: непрекъснато каране и паузи (15 + 30 се брои само в този ред)
  const cont = { drive: 0, splitFirst: false, lastBreak: null };
  {
    let violated = false, blk = null;
    const breakLike = a => a.type === 'rest' || (a.type === 'avail' && o.availabilityCountsAsBreak);
    const endBreak = () => {
      if (!blk) return;
      blk.splitBefore = cont.splitFirst;
      if (blk.len >= LIMITS.breakFull || (cont.splitFirst && blk.len >= LIMITS.breakSplitSecond)) {
        cont.drive = 0; cont.splitFirst = false; violated = false;
      } else if (blk.len >= LIMITS.breakSplitFirst) {
        cont.splitFirst = true;
      }
      cont.lastBreak = blk;
      blk = null;
    };
    for (const a of raw) {
      const len = a.e - a.s;
      if (breakLike(a)) {
        if (!blk) blk = { s: a.s, e: a.e, len: 0 };
        blk.len += len;
        blk.e = a.e;
        continue;
      }
      endBreak();
      if (a.type === 'drive') {
        if (!violated && cont.drive + len > LIMITS.continuousDrive) {
          V('CONTINUOUS_DRIVE', 'чл. 7', a.s + (LIMITS.continuousDrive - cont.drive),
            'Над 4 ч 30 мин каране без пауза 45 мин (или 15 + 30 мин)');
          violated = true;
        }
        cont.drive += len;
      }
    }
    endBreak();
  }

  // ── седмично каране (чл. 6(2), 6(3))
  const firstWs = weekStart(raw[0]?.s ?? now, o.weekOffsetMinutes);
  const weekDrive = new Map();
  const addWeek = (ws, ms) => weekDrive.set(ws, (weekDrive.get(ws) || 0) + ms);
  if (hist.drivenThisWeek) addWeek(firstWs, hist.drivenThisWeek);
  if (hist.drivenPreviousWeek) addWeek(firstWs - WEEK, hist.drivenPreviousWeek);
  for (const g of segs) {
    for (const x of [g, ...g.inner]) {
      if (x.type !== 'drive') continue;
      let t = x.s;
      while (t < x.e) {
        const ws = weekStart(t, o.weekOffsetMinutes);
        const end = Math.min(x.e, ws + WEEK);
        addWeek(ws, end - t);
        t = end;
      }
    }
  }

  // ── дежурства (времето между две дневни почивки) и почивки (чл. 8)
  const window = o.multiManning ? LIMITS.multiManningWindow : LIMITS.dailyWindow;
  const duties = [];
  const weeklyRests = [];
  let cur = null;
  let lastRestEnd = o.lastRestEnd != null ? toMs(o.lastRestEnd) : null;

  for (const g of segs) {
    if (g.type !== 'rest') {
      if (!cur) {
        cur = { start: lastRestEnd ?? g.s, startAssumed: lastRestEnd == null, end: null,
          drive: 0, work: 0, avail: 0, split3: null, manual: false, rest: null };
      }
      const len = g.e - g.s;
      if (g.type === 'drive') cur.drive += len;
      else if (g.type === 'work') cur.work += len;
      else cur.avail += len;
      cur.manual = cur.manual || g.manual;
      continue;
    }
    if (cur) {
      for (const x of g.inner) {
        if (x.type === 'drive') cur.drive += x.e - x.s;
        else if (x.type === 'work') cur.work += x.e - x.s;
      }
    }
    const L = g.len;
    const ongoing = g.e === now;
    const isWeekly = L >= LIMITS.weeklyRestReduced;
    if (isWeekly) weeklyRests.push({ s: g.s, e: g.e, len: L, reduced: L < LIMITS.weeklyRestRegular, ongoing, gap: g.gap });

    if (!cur) {
      if (L >= LIMITS.dailyRestReduced) lastRestEnd = g.e;
      continue;
    }
    if (L >= LIMITS.dailyRestReduced) {
      const winEnd = cur.start + window;
      const inWindow = g.parts.reduce((t, [s, e]) => t + overlap(s, e, cur.start, winEnd), 0);
      let kind;
      if (o.multiManning) kind = inWindow >= LIMITS.dailyRestReduced ? 'multi' : 'insufficient';
      else if (inWindow >= LIMITS.dailyRestRegular) kind = 'regular';
      else if (cur.split3 && cur.split3.s < winEnd && inWindow >= LIMITS.dailyRestReduced) kind = 'split';
      else if (inWindow >= LIMITS.dailyRestReduced) kind = 'reduced';
      else kind = 'insufficient';
      // почивка, която още тече и може да стане редовна, още не е намалена
      if (ongoing && kind === 'reduced' && winEnd - g.s >= LIMITS.dailyRestRegular) kind = 'pending';
      cur.end = g.s;
      cur.rest = { kind, s: g.s, e: g.e, len: L, inWindow, weekly: isWeekly, ongoing, gap: g.gap };
      duties.push(cur);
      cur = null;
      lastRestEnd = g.e;
    } else if (L >= LIMITS.splitRestFirst && !cur.split3) {
      cur.split3 = { s: g.s, e: g.e };
    }
  }
  if (cur) duties.push(cur);

  // ── нарушения по дежурства: дневно каране, удължения, почивки
  const ext = new Map();
  if (hist.extensionsUsed) ext.set(firstWs, hist.extensionsUsed);
  let reducedSinceWeekly = hist.reducedRestsUsed || 0;
  for (const d of duties) {
    const ws = weekStart(d.start, o.weekOffsetMinutes);
    if (d.drive > LIMITS.dailyDrive) { // и ден над 10 ч изразходва едно от удълженията
      const n = (ext.get(ws) || 0) + 1;
      ext.set(ws, n);
      d.extended = true;
      if (n > LIMITS.extensionsPerWeek) V('DAILY_DRIVE_EXT', 'чл. 6(1)', d.start, 'Трето дневно каране над 9 ч за седмицата');
    }
    if (d.drive > LIMITS.dailyDriveExtended) V('DAILY_DRIVE', 'чл. 6(1)', d.start, 'Дневно каране над 10 ч');
    if (!d.rest) continue;
    if (d.rest.kind === 'insufficient') {
      V('DAILY_REST', o.multiManning ? 'чл. 8(5)' : 'чл. 8(2)', d.rest.s, `Дневната почивка не е взета в рамките на ${window / H} ч`);
    }
    if (d.rest.kind === 'reduced') {
      reducedSinceWeekly++;
      if (reducedSinceWeekly > LIMITS.reducedDailyRestsMax) {
        V('REDUCED_DAILY_RESTS', 'чл. 8(4)', d.rest.s, 'Повече от 3 намалени дневни почивки между две седмични');
      }
    }
    if (d.rest.weekly) d.reducedBefore = reducedSinceWeekly, reducedSinceWeekly = 0;
  }

  // ── седмични лимити
  for (const ws of [...weekDrive.keys()].sort((a, b) => a - b)) {
    const w = weekDrive.get(ws);
    if (w > LIMITS.weeklyDrive) V('WEEKLY_DRIVE', 'чл. 6(2)', ws, 'Седмично каране над 56 ч');
    if ((weekDrive.get(ws - WEEK) || 0) + w > LIMITS.fortnightDrive) {
      V('FORTNIGHT_DRIVE', 'чл. 6(3)', ws, 'Каране над 90 ч за две последователни седмици');
    }
  }

  // ── седмични почивки (чл. 8(6)). Ако последната е неизвестна, приемаме, че е
  //    свършила в началото на дневника: така срокът е най-късният възможен.
  const weekly = {
    prevEnd: o.lastWeeklyRestEnd != null ? toMs(o.lastWeeklyRestEnd) : (raw.length ? raw[0].s : null),
    estimated: o.lastWeeklyRestEnd == null,
    prevReduced: !!o.lastWeeklyRestReduced
  };
  const debts = [];
  for (const r of weeklyRests) {
    if (weekly.prevEnd != null && r.s > weekly.prevEnd + LIMITS.weeklyRestDeadline) {
      V('WEEKLY_REST_LATE', 'чл. 8(6)', weekly.prevEnd + LIMITS.weeklyRestDeadline,
        'Седмичната почивка не е започнала до 144 ч след предишната');
    }
    if (r.ongoing) { r.prevReduced = weekly.prevReduced; continue; }
    if (r.reduced) {
      debts.push({ hours: (LIMITS.weeklyRestRegular - r.len) / H, ms: LIMITS.weeklyRestRegular - r.len,
        from: r.s, due: weekStart(r.s, o.weekOffsetMinutes) + 4 * WEEK, paid: false });
      if (weekly.prevReduced) {
        if (o.international) r.secondReducedInRow = true;
        else V('CONSECUTIVE_REDUCED_WEEKLY', 'чл. 8(6)', r.s, 'Две поредни намалени седмични почивки (позволено само при международен превоз)');
      }
    }
    weekly.prevEnd = r.e;
    weekly.estimated = false;
    weekly.prevReduced = r.reduced;
  }

  // ── компенсация: прикрепена към друга почивка от поне 9 ч, наведнъж, до края на
  //    третата седмица. Строго: собствената част на дневна почивка се брои 11 ч,
  //    на седмична 45 ч, за да не се брои едно и също време два пъти.
  const used = new Set();
  for (const debt of debts) {
    for (const g of segs) {
      if (g.type !== 'rest' || g.len < LIMITS.dailyRestReduced || g.s <= debt.from || used.has(g)) continue;
      const own = g.len >= LIMITS.weeklyRestReduced ? LIMITS.weeklyRestRegular : LIMITS.dailyRestRegular;
      if (g.len - own >= debt.ms && g.s + own + debt.ms <= debt.due) {
        debt.paid = true; debt.paidAt = g.s; used.add(g); break;
      }
    }
    if (!debt.paid && now > debt.due) V('COMPENSATION', 'чл. 8(6)', debt.due, 'Компенсацията за намалена седмична почивка не е взета навреме');
  }

  const status = buildStatus({ o, now, raw, duties, weekDrive, ext, reducedSinceWeekly, weekly, weeklyRests, debts, cont, window });

  // ── нарушения, които текат в момента: почивката закъснява
  const since = status.currentRest ? status.currentRest.since : null;
  const latest = status.daily.latestRestStart;
  if (latest != null && now > latest && (since == null || since > latest)) {
    V('DAILY_REST', o.multiManning ? 'чл. 8(5)' : 'чл. 8(2)', latest, 'Дневната почивка закъснява');
  }
  const wd = status.weeklyRest.deadline;
  if (wd != null && now > wd && !weeklyRests.some(r => r.ongoing) && (since == null || since > wd)) {
    V('WEEKLY_REST_LATE', 'чл. 8(6)', wd, 'Седмичната почивка закъснява');
  }
  violations.sort((a, b) => a.at - b.at);
  return {
    status, violations, weeklyRests, compensation: debts,
    duties: duties.map(d => ({ start: d.start, startAssumed: d.startAssumed, end: d.end, drive: d.drive, work: d.work,
      avail: d.avail, extended: !!d.extended, manual: d.manual, rest: d.rest }))
  };
}

// ─────────────────────────── текущо състояние ───────────────────────────

// Приоритет при равни стойности: по-тежкото ограничение казва какво следва.
const BINDING_ORDER = ['weeklyRest', 'dailyRest', 'fortnight', 'weekly', 'daily', 'break'];

function buildStatus(x) {
  const { o, now, raw, duties, weekDrive, ext, reducedSinceWeekly, weekly, weeklyRests, debts, cont, window } = x;
  const last = raw.at(-1);
  const activity = last && last.e === now ? last.type : 'unknown';
  const resting = activity === 'rest';
  const restSince = resting ? last.s : null;
  const restLen = resting ? now - last.s : 0;

  const lastDuty = duties.at(-1);
  const openDuty = lastDuty && !lastDuty.rest ? lastDuty : null;
  const restDuty = lastDuty && lastDuty.rest && lastDuty.rest.ongoing ? lastDuty : null; // текущата почивка вече е 9+ ч
  const ctxDuty = openDuty || restDuty;

  // колко намалени почивки са използвани преди текущата
  let reducedBefore = reducedSinceWeekly;
  if (restDuty) {
    if (restDuty.rest.weekly) reducedBefore = restDuty.reducedBefore ?? 0;
    else if (restDuty.rest.kind === 'reduced') reducedBefore -= 1;
  }
  const reducedLeft = Math.max(0, LIMITS.reducedDailyRestsMax - reducedBefore);
  const needDaily = d => (o.multiManning || (d && d.split3) || reducedLeft > 0 ? LIMITS.dailyRestReduced : LIMITS.dailyRestRegular);

  // седмична почивка: ако предишната е била намалена, тази трябва да е 45 ч
  const ongoingWeekly = weeklyRests.find(r => r.ongoing);
  const needWeekly = weekly.prevReduced && !o.international ? LIMITS.weeklyRestRegular : LIMITS.weeklyRestReduced;

  // текущата почивка изпълнена ли е (може ли да започне ново дежурство)
  let restComplete = false, mustKeepResting = null;
  if (restDuty) {
    if (restDuty.rest.weekly) {
      restComplete = restLen >= needWeekly || restLen >= needDaily(restDuty);
      // почивка над 24 ч е седмична; ако трябва да е 45 ч или срокът е минал, се довършва
      if (restLen < needWeekly && (needWeekly === LIMITS.weeklyRestRegular ||
          (weekly.prevEnd != null && now > weekly.prevEnd + LIMITS.weeklyRestDeadline))) {
        restComplete = false; mustKeepResting = 'weeklyRest';
      }
    } else {
      restComplete = restDuty.rest.kind !== 'insufficient' && restLen >= needDaily(restDuty);
    }
    if (!restComplete && !mustKeepResting) mustKeepResting = 'dailyRest';
  }
  const fresh = !openDuty; // следващото каране започва ново дежурство

  const ws = weekStart(openDuty ? openDuty.start : now, o.weekOffsetMinutes);
  const extUsed = ext.get(ws) || 0;
  const dutyDrive = openDuty ? openDuty.drive : 0;
  const alreadyExt = dutyDrive > LIMITS.dailyDrive;
  const extAllowed = alreadyExt ? extUsed <= LIMITS.extensionsPerWeek : extUsed < LIMITS.extensionsPerWeek;
  const dailyLimit = extAllowed ? LIMITS.dailyDriveExtended : LIMITS.dailyDrive;
  const dailyRemaining = Math.max(0, dailyLimit - dutyDrive);

  const wsNow = weekStart(now, o.weekOffsetMinutes);
  const weekMs = weekDrive.get(wsNow) || 0;
  const prevWeekMs = weekDrive.get(wsNow - WEEK) || 0;
  const weeklyRemaining = Math.max(0, LIMITS.weeklyDrive - weekMs);
  const fortnightRemaining = Math.max(0, LIMITS.fortnightDrive - prevWeekMs - weekMs);
  const continuousRemaining = Math.max(0, LIMITS.continuousDrive - cont.drive);

  const latestRestStart = openDuty ? openDuty.start + window - needDaily(openDuty) : null;
  const weeklyDeadline = weekly.prevEnd != null ? weekly.prevEnd + LIMITS.weeklyRestDeadline : null;
  const weeklyDone = ongoingWeekly && restLen >= needWeekly; // седмичната почивка вече е изпълнена
  const weeklyStartedInTime = resting && weeklyDeadline != null && restSince <= weeklyDeadline;

  const cands = {
    weeklyRest: weeklyDeadline == null || weeklyDone ? Infinity : Math.max(0, weeklyDeadline - now),
    dailyRest: latestRestStart == null ? Infinity : Math.max(0, latestRestStart - now),
    fortnight: fortnightRemaining,
    weekly: weeklyRemaining,
    daily: dailyRemaining,
    break: fresh && restComplete ? LIMITS.continuousDrive : continuousRemaining
  };
  let driveRemaining = Math.min(...Object.values(cands));
  if (driveRemaining < MIN) driveRemaining = 0; // под минута — спри сега
  let binding = BINDING_ORDER.find(k => cands[k] <= driveRemaining) ?? 'break';
  if (mustKeepResting) { driveRemaining = 0; binding = mustKeepResting; }

  // кога може да тръгне отново, ако сега почива: първата граница, след която
  // никое ограничение не пречи (пауза, после дневна, после седмична почивка)
  let resumeAt = null;
  if (resting && driveRemaining === 0) {
    const brk = cont.lastBreak && cont.lastBreak.e === now ? cont.lastBreak : null;
    let t = binding === 'break' ? restSince + (brk?.splitBefore ? LIMITS.breakSplitSecond : LIMITS.breakFull) : now;
    if (binding === 'daily' || binding === 'dailyRest') t = restSince + needDaily(ctxDuty);
    if (binding === 'weeklyRest') t = restSince + needWeekly;
    if (latestRestStart != null && t > latestRestStart) t = Math.max(t, restSince + needDaily(ctxDuty));
    if (weeklyDeadline != null && !weeklyDone && t > weeklyDeadline) t = Math.max(t, restSince + needWeekly);
    if (weeklyRemaining === 0 || fortnightRemaining === 0) t = Math.max(t, wsNow + WEEK);
    resumeAt = t;
  }

  // какво вече покрива текущата почивка и коя е следващата граница
  let currentRest = null;
  if (resting) {
    const brk = cont.lastBreak && cont.lastBreak.e === now ? cont.lastBreak : null;
    const steps = brk?.splitBefore
      ? [[LIMITS.breakSplitSecond, 'втората част от паузата (30 мин)']]
      : [[LIMITS.breakSplitFirst, 'първата част от паузата (15 мин)'], [LIMITS.breakFull, 'пауза 45 мин']];
    if (ctxDuty?.split3) steps.push([LIMITS.dailyRestReduced, 'дневна почивка (3 + 9 ч)']);
    else if (o.multiManning) steps.push([LIMITS.dailyRestReduced, 'дневна почивка при двойка (9 ч)']);
    else {
      // „първа част от разделена почивка“ има смисъл само докато почивката е под 9 ч
      steps.push([LIMITS.splitRestFirst, 'първата част от разделена дневна почивка (3 ч)', LIMITS.dailyRestReduced]);
      if (reducedLeft > 0) steps.push([LIMITS.dailyRestReduced, 'намалена дневна почивка 9 ч']);
      steps.push([LIMITS.dailyRestRegular, 'дневна почивка 11 ч']);
    }
    if (needWeekly === LIMITS.weeklyRestReduced) steps.push([LIMITS.weeklyRestReduced, 'намалена седмична почивка 24 ч']);
    steps.push([LIMITS.weeklyRestRegular, 'седмична почивка 45 ч']);
    steps.sort((a, b) => a[0] - b[0]);
    let qualifies = null, next = null;
    for (const [ms, name, until] of steps) {
      if (restLen >= ms) { if (until == null || restLen < until) qualifies = name; }
      else if (!next) next = { name, at: restSince + ms };
    }
    currentRest = { since: restSince, length: restLen, qualifies, next, fromGap: !!last.gap };
  }

  // по време на пауза: колко трябва да е тя, според това дали 15-те мин са взети преди нея
  const inBreak = cont.lastBreak && cont.lastBreak.e === now ? cont.lastBreak : null;
  const splitTaken = inBreak ? inBreak.splitBefore : cont.splitFirst;
  const status = {
    now, activity, currentRest, driveRemaining, binding, resumeAt,
    continuous: {
      driven: cont.drive, remaining: continuousRemaining,
      splitFirstTaken: splitTaken, nextBreak: splitTaken ? LIMITS.breakSplitSecond : LIMITS.breakFull
    },
    daily: {
      dutyStart: openDuty ? openDuty.start : null, startAssumed: openDuty ? openDuty.startAssumed : false,
      driven: dutyDrive, limit: dailyLimit, remaining: dailyRemaining, latestRestStart,
      reducedRestsUsed: reducedBefore, reducedRestsLeft: reducedLeft,
      extensionsUsed: extUsed, extensionsLeft: Math.max(0, LIMITS.extensionsPerWeek - extUsed),
      manual: openDuty ? openDuty.manual : false
    },
    weekly: { driven: weekMs, remaining: weeklyRemaining, previousWeek: prevWeekMs, fortnightRemaining },
    weeklyRest: {
      lastEnd: weekly.prevEnd, deadline: weeklyDeadline, estimated: weekly.estimated,
      remaining: weeklyDeadline != null ? weeklyDeadline - now : null,
      onWeeklyRest: !!ongoingWeekly, startedInTime: weeklyStartedInTime, mustBeRegular: needWeekly === LIMITS.weeklyRestRegular
    },
    compensation: debts.filter(d => !d.paid).map(d => ({ hours: d.hours, due: d.due }))
  };
  status.warnings = warningsFor(status, o);
  return status;
}

const MSG = {
  soon: {
    break: (s, t) => [`BREAK_SOON`, `След ${fmt(t)} трябва пауза ${s.continuous.nextBreak / MIN} мин`],
    daily: (s, t) => [`DAILY_DRIVE_SOON`, `След ${fmt(t)} дневното каране свършва`],
    weekly: (s, t) => [`WEEKLY_DRIVE_SOON`, `След ${fmt(t)} седмичното каране (56 ч) свършва`],
    fortnight: (s, t) => [`WEEKLY_DRIVE_SOON`, `След ${fmt(t)} свършват 90-те часа за две седмици`]
  },
  now: {
    break: s => [`BREAK_NOW`, `Време е за пауза ${s.continuous.nextBreak / MIN} мин`],
    daily: () => [`DAILY_DRIVE_NOW`, 'Дневното каране свърши, трябва дневна почивка'],
    weekly: () => [`WEEKLY_DRIVE_NOW`, 'Седмичното каране (56 ч) свърши'],
    fortnight: () => [`WEEKLY_DRIVE_NOW`, '90-те часа за две седмици са изчерпани']
  }
};

function warningsFor(st, o) {
  const w = [];
  const W = ([code, message]) => w.push({ code, message });
  const soonLimit = { break: o.warnBreakMinutes, daily: o.warnDailyDriveMinutes, weekly: o.warnWeeklyDriveMinutes, fortnight: o.warnWeeklyDriveMinutes };
  if (st.activity === 'drive' && MSG.soon[st.binding]) {
    if (st.driveRemaining === 0) W(MSG.now[st.binding](st));
    else if (st.driveRemaining <= soonLimit[st.binding] * MIN) W(MSG.soon[st.binding](st, st.driveRemaining));
  }
  const resting = st.activity === 'rest';
  const latest = st.daily.latestRestStart;
  if (latest != null && !(resting && st.currentRest.since <= latest)) {
    const left = latest - st.now;
    if (left <= 0) W(['DAILY_REST_LATE', 'Дневната почивка трябваше вече да е започнала']);
    else if (left <= o.warnDailyRestMinutes * MIN) W(['DAILY_REST_SOON', `Дневната почивка трябва да започне до ${clock(latest, o)}`]);
  }
  const wr = st.weeklyRest;
  if (wr.deadline != null && !wr.onWeeklyRest && !wr.startedInTime) {
    const left = wr.remaining;
    if (left <= 0) W(['WEEKLY_REST_LATE', 'Седмичната почивка трябваше вече да е започнала']);
    else {
      const hit = [...o.warnWeeklyRestHours].sort((a, b) => a - b).find(h => left <= h * H);
      if (hit != null) W([`WEEKLY_REST_${hit}H`, `Седмичната почивка трябва да започне до ${clock(wr.deadline, o)}`]);
    }
  }
  if (resting && st.currentRest.length >= LIMITS.weeklyRestReduced && wr.mustBeRegular && st.currentRest.length < LIMITS.weeklyRestRegular) {
    W(['WEEKLY_REST_MUST_BE_REGULAR', 'Тази седмична почивка трябва да е поне 45 ч, защото предишната беше намалена']);
  }
  for (const c of st.compensation) {
    if (c.due - st.now <= 7 * DAY) W(['COMPENSATION_DUE', `Дължиш ${round1(c.hours)} ч компенсация до ${clock(c.due, o)}`]);
  }
  return w;
}

// ─────────────────────────── изречения за гласа ───────────────────────────

// Закръгля надолу: „остават 9 мин“, никога повече от истинското.
export function fmt(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r} мин`;
  if (!r) return `${h} ч`;
  return `${h} ч ${r} мин`;
}

const round1 = n => Math.round(n * 10) / 10;

// „понеделник 21:00“ в часовата зона на шофьора
export function clock(t, options = {}) {
  const o = { ...DEFAULTS, ...options };
  try {
    const parts = new Intl.DateTimeFormat('bg-BG', {
      timeZone: o.timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(t);
    const p = k => parts.find(x => x.type === k)?.value ?? '';
    return `${p('weekday')} ${p('hour')}:${p('minute')}`;
  } catch {
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

// „в понеделник“, но „във вторник“
const on = when => (/^[вф]/i.test(when) ? `във ${when}` : `в ${when}`);

const AFTER = {
  break: st => `, после пауза ${st.continuous.nextBreak / MIN} мин`,
  daily: () => ', после дневна почивка',
  dailyRest: () => ', после трябва да започнеш дневна почивка',
  weekly: () => ', после седмичното каране (56 ч) свършва',
  fortnight: () => ', после свършват 90-те часа за две седмици',
  weeklyRest: () => ', после трябва да започнеш седмична почивка'
};
const STOP = {
  break: st => `Не можеш да караш повече, трябва пауза ${st.continuous.nextBreak / MIN} мин.`,
  daily: () => 'Дневното каране свърши, трябва дневна почивка.',
  dailyRest: () => 'Трябва да започнеш дневна почивка.',
  weekly: () => 'Седмичното каране (56 ч) свърши.',
  fortnight: () => '90-те часа за две седмици са изчерпани.',
  weeklyRest: () => 'Трябва да започнеш седмична почивка.'
};

// Отговорът на „Колко ми остава?“.
export function describe(result, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const st = result.status ?? result;
  const parts = [];
  if (st.activity === 'rest' && st.currentRest) {
    const r = st.currentRest;
    parts.push(`Почиваш от ${fmt(r.length)}${r.qualifies ? `, това вече е ${r.qualifies}` : ''}${r.fromGap ? ' (без запис в приложението)' : ''}.`);
  }
  if (st.driveRemaining <= 0) {
    const go = st.resumeAt != null ? ` Можеш да тръгнеш ${on(clock(st.resumeAt, o))}.` : '';
    if (st.activity === 'rest' && st.binding === 'break' && go) parts.push(go.trim());
    else if (st.activity === 'rest' && (st.binding === 'dailyRest' || st.binding === 'weeklyRest')) parts.push('Продължи почивката.' + go);
    else parts.push(STOP[st.binding](st) + go);
  } else {
    parts.push(`Можеш да караш още ${fmt(st.driveRemaining)}${AFTER[st.binding](st)}.`);
  }
  const d = st.daily;
  if (d.dutyStart != null) {
    const of = d.driven > LIMITS.dailyDrive || d.limit === LIMITS.dailyDrive
      ? fmt(d.limit)
      : `9 ч (до 10 ч още ${d.extensionsLeft} ${d.extensionsLeft === 1 ? 'път' : 'пъти'} тази седмица)`;
    parts.push(`Днес си карал ${fmt(d.driven)} от ${of}.`);
    if (d.latestRestStart != null) {
      parts.push(`Дневната почивка трябва да започне до ${clock(d.latestRestStart, o)}${d.startAssumed ? ' (най-късно, не знам кога е свършила предишната)' : ''}.`);
    }
  }
  const wr = st.weeklyRest;
  if (wr.deadline != null && !wr.onWeeklyRest && !wr.startedInTime) {
    parts.push(wr.estimated
      ? `Седмичната почивка трябва да започне най-късно до ${clock(wr.deadline, o)}; кажи ми кога е свършила последната, за да е точно.`
      : `Седмичната почивка трябва да започне до ${clock(wr.deadline, o)}.`);
  }
  return parts.join(' ');
}
