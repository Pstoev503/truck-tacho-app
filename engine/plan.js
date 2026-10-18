import { analyze, H, LIMITS, MIN, weekStart } from './tacho-rules.js';
import { haversineKm } from './route.js';

export const PLANNER_SPEEDS = Object.freeze({ motorway: 80, ordinary: 55 });
const DAILY_EXTENDED = LIMITS.dailyDriveExtended;
const DAILY_STANDARD = LIMITS.dailyDrive;
const WEEK_MS = 7 * 24 * H;
const BREAK_SPLIT_FIRST = LIMITS.breakSplitFirst;
const BREAK_SPLIT_SECOND = LIMITS.breakSplitSecond;
const MAX_ITERATIONS = 10000;

function pointDistanceKm(a, b) {
  return haversineKm(a, b);
}

/** Returns routed geometry distances for each waypoint pair, or null when unavailable. */
export function routeStageDistances(route) {
  const waypoints = route?.waypoints;
  const geometry = route?.geometry;
  if (!Array.isArray(waypoints) || waypoints.length < 2 ||
      !Array.isArray(geometry) || geometry.length < 2) return null;

  const cumulative = [0];
  for (let i = 1; i < geometry.length; i++) {
    cumulative.push(cumulative[i - 1] + pointDistanceKm(geometry[i - 1], geometry[i]));
  }
  const nearest = [];
  let from = 0;
  for (const waypoint of waypoints) {
    let best = from, bestDistance = Infinity;
    for (let i = from; i < geometry.length; i++) {
      const d = pointDistanceKm(waypoint, geometry[i]);
      if (d < bestDistance) { best = i; bestDistance = d; }
    }
    nearest.push(best);
    from = best;
  }
  return nearest.slice(1).map((index, i) => Math.max(0, cumulative[index] - cumulative[nearest[i]]));
}

function toTime(value) {
  return typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
}

// Coverage is evidence of recorded intervals, not proof that the activities are
// correct. Never let a future-dated record fill an unobserved interval.
function checkHistoryCoverage(activities, from, to, observedUntil) {
  const intervals = activities.map(activity => ({
    start: Math.max(from, toTime(activity.start)),
    end: Math.min(to, observedUntil, toTime(activity.end))
  })).filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end) &&
    interval.end > interval.start).sort((a, b) => a.start - b.start);
  const gaps = [];
  let cursor = from;
  for (const interval of intervals) {
    if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < to) gaps.push({ start: cursor, end: to });
  return { from, to, observedUntil, complete: gaps.length === 0, gaps };
}

function validateStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) throw new Error('Добави поне един пътен етап.');
  return stages.map((stage, index) => {
    if (!stage || !Number.isFinite(stage.distanceKm) || stage.distanceKm <= 0) {
      throw new Error(`Етап ${index + 1}: разстоянието трябва да е положително число.`);
    }
    if (!Object.prototype.hasOwnProperty.call(PLANNER_SPEEDS, stage.roadType)) {
      throw new Error(`Етап ${index + 1}: избери тип път.`);
    }
    const dailyRest = stage.dailyRest ?? 'regular';
    if (dailyRest !== 'regular' && dailyRest !== 'reduced') {
      throw new Error(`Етап ${index + 1}: избери дневна почивка 11 ч или намалена 9 ч.`);
    }
    return {
      label: String(stage.label || `Етап ${index + 1}`).slice(0, 120),
      distanceKm: stage.distanceKm,
      roadType: stage.roadType,
      useExtension: stage.useExtension === true,
      dailyRest
    };
  });
}

/**
 * Builds a planning-only driving/rest schedule and validates it through the
 * same regulatory engine used by the live tachograph.
 */
export function buildPlan({
  stages, departure, activities = [], now = Date.now(), breakStyle = '45',
  multiManning = false, lastWeeklyRestEnd = null
} = {}) {
  const checkedStages = validateStages(stages);
  const start = toTime(departure), currentTime = toTime(now);
  if (!Number.isFinite(start) || !Number.isFinite(currentTime)) throw new Error('Въведи валиден час на потегляне.');
  if (start < currentTime) throw new Error('Часът на потегляне не може да е в миналото.');
  if (breakStyle !== '45' && breakStyle !== '15+30') throw new Error('Избери пауза 45 мин или разделена 15 + 30 мин.');
  if (!Array.isArray(activities)) throw new Error('Дневникът на дейностите е невалиден.');

  const baseActivities = activities.map(activity => ({
    ...activity,
    end: activity.end == null ? currentTime : activity.end
  }));
  // Unknown intervals cannot earn driving/rest allowances. In particular, the
  // interval before departure is not a confirmed rest supplied by the driver.
  const options = { now: start, multiManning, timeZone: 'Europe/Sofia', gapsAsRest: false };
  if (lastWeeklyRestEnd != null) options.lastWeeklyRestEnd = lastWeeklyRestEnd;
  const planned = [];
  const events = [];
  const stageResults = [];
  const ignoredExtensions = [];
  const ignoredDailyRests = [];
  let time = start;
  let iterations = 0;

  const add = (type, duration, label, stageIndex = null) => {
    if (duration <= 0) return;
    const end = time + duration;
    planned.push({ type, start: time, end });
    events.push({ type, label, start: time, end, stageIndex });
    time = end;
  };
  const analysisAt = at => analyze([...baseActivities, ...planned], { ...options, now: at });

  const initialStatus = analysisAt(time).status;
  let continuousDrive = initialStatus.continuous.driven;
  let dailyDrive = initialStatus.daily.driven;
  let dailyExtensionAlreadyUsed = dailyDrive > DAILY_STANDARD;
  let splitFirstTaken = initialStatus.continuous.splitFirstTaken;

  for (let index = 0; index < checkedStages.length; index++) {
    const stage = checkedStages[index];
    const stageStart = time;
    const totalDrive = stage.distanceKm / PLANNER_SPEEDS[stage.roadType] * H;
    let remainingDrive = totalDrive;
    let extensionUsedOnStage = false;
    let extensionIgnored = false;
    let reducedRestUsedOnStage = false;
    let reducedRestIgnored = false;

    while (remainingDrive > 0.5) {
      if (++iterations > MAX_ITERATIONS) throw new Error('Планът е твърде дълъг за симулация.');

      let dailyLimit = DAILY_STANDARD;
      let extensionAvailable = false;
      if (dailyExtensionAlreadyUsed) {
        dailyLimit = DAILY_EXTENDED;
        if (stage.useExtension && !extensionUsedOnStage && !extensionIgnored) {
          ignoredExtensions.push({ stageIndex: index, reason: 'Удължението вече е използвано в това дневно дежурство.' });
          extensionIgnored = true;
        }
      } else if (stage.useExtension && !extensionUsedOnStage && dailyDrive >= DAILY_STANDARD) {
        const state = analysisAt(time).status.daily;
        if (state.extensionsLeft > 0) {
          dailyLimit = DAILY_EXTENDED;
          extensionAvailable = true;
        } else if (!extensionIgnored) {
          ignoredExtensions.push({ stageIndex: index, reason: 'Използвани са двете седмични удължения или липсва история.' });
          extensionIgnored = true;
        }
      }
      const dailyState = analysisAt(time).status.daily;
      const canReduceRest = stage.dailyRest === 'reduced' && !reducedRestUsedOnStage &&
        dailyState.reducedRestsLeft > 0;
      const chosenRestDuration = canReduceRest ? LIMITS.dailyRestReduced : LIMITS.dailyRestRegular;
      // latestRestStart can assume a minimum 9h rest. The stage's explicit
      // regular selection instead requires all 11h inside the duty window.
      const restWindow = multiManning ? LIMITS.multiManningWindow : LIMITS.dailyWindow;
      const restDeadline = (dailyState.dutyStart ?? time) + restWindow - chosenRestDuration;
      const splitBreakDue = breakStyle === '15+30' && !splitFirstTaken && continuousDrive >= 4 * H;
      const fullBreakDue = continuousDrive >= LIMITS.continuousDrive;
      const breakDuration = splitBreakDue ? BREAK_SPLIT_FIRST : fullBreakDue
        ? (breakStyle === '15+30' && splitFirstTaken ? BREAK_SPLIT_SECOND : LIMITS.breakFull) : 0;

      if (dailyDrive >= dailyLimit || time >= restDeadline ||
          (breakDuration > 0 && time + breakDuration >= restDeadline)) {
        let restDuration = LIMITS.dailyRestRegular;
        let restLabel = 'Редовна дневна почивка 11 ч';
        if (stage.dailyRest === 'reduced' && !reducedRestUsedOnStage) {
          if (canReduceRest) {
            restDuration = LIMITS.dailyRestReduced;
            restLabel = 'Намалена дневна почивка 9 ч';
            reducedRestUsedOnStage = true;
          } else if (!reducedRestIgnored) {
            ignoredDailyRests.push({ stageIndex: index, reason: 'Използвани са трите намалени дневни почивки.' });
            reducedRestIgnored = true;
          }
        } else if (stage.dailyRest === 'reduced' && !reducedRestIgnored) {
          ignoredDailyRests.push({ stageIndex: index, reason: 'Етапът вече използва една намалена дневна почивка.' });
          reducedRestIgnored = true;
        }
        if (time > restDeadline) {
          ignoredDailyRests.push({ code: 'DAILY_REST_DEADLINE_MISSED', stageIndex: index,
            reason: 'Срокът за избраната дневна почивка е пропуснат преди следващото управление; почивката започва веднага, без да заличава изминалия интервал.' });
          restLabel = `Дневна почивка ${restDuration / H} ч — избраният вид е извън срока`;
        }
        add('rest', restDuration, restLabel, index);
        dailyDrive = 0;
        continuousDrive = 0;
        dailyExtensionAlreadyUsed = false;
        splitFirstTaken = false;
        continue;
      }

      if (splitBreakDue) {
        add('rest', BREAK_SPLIT_FIRST, 'Пауза 15 мин', index);
        splitFirstTaken = true;
        continue;
      }
      if (fullBreakDue) {
        add('rest', breakDuration, breakStyle === '15+30' && splitFirstTaken
          ? 'Пауза 30 мин (15 + 30)' : 'Пауза 45 мин', index);
        continuousDrive = 0;
        splitFirstTaken = false;
        continue;
      }

      const continuousLimit = breakStyle === '15+30' && !splitFirstTaken
        ? 4 * H : LIMITS.continuousDrive;
      const available = Math.min(
        remainingDrive,
        dailyLimit - dailyDrive,
        continuousLimit - continuousDrive,
        restDeadline - time
      );
      if (available <= 0) continue;
      const before = time;
      add('drive', available, `Каране: ${stage.label}`, index);
      const distance = available / totalDrive * stage.distanceKm;
      remainingDrive -= available;
      dailyDrive += available;
      continuousDrive += available;
      const last = stageResults[index];
      if (!last) stageResults[index] = {
        label: stage.label, distanceKm: 0, drivingMs: 0, start: before, end: time,
        roadType: stage.roadType
      };
      stageResults[index].distanceKm += distance;
      stageResults[index].drivingMs += available;
      stageResults[index].end = time;
      if (dailyDrive > DAILY_STANDARD) {
        dailyExtensionAlreadyUsed = true;
        if (extensionAvailable) extensionUsedOnStage = true;
      }
    }
    if (!stageResults[index]) {
      stageResults[index] = {
        label: stage.label, distanceKm: 0, drivingMs: 0, start: stageStart, end: time,
        roadType: stage.roadType
      };
    }
    stageResults[index].distanceKm = stage.distanceKm;
    stageResults[index].extensionUsed = extensionUsedOnStage;
    stageResults[index].reducedRestUsed = reducedRestUsedOnStage;
  }

  const analysis = analysisAt(time);
  const historyCoverage = checkHistoryCoverage(baseActivities, weekStart(start) - WEEK_MS, start, currentTime);
  const historyComplete = historyCoverage.complete && !analysis.status.daily.startAssumed && !analysis.status.weeklyRest.estimated;
  const departureGapAssumed = start > currentTime;
  const restChoiceMissed = ignoredDailyRests.some(item => item.code === 'DAILY_REST_DEADLINE_MISSED');
  const confirmed = analysis.violations.length === 0 && historyComplete && !departureGapAssumed && !restChoiceMissed;

  return {
    departure: start,
    arrival: time,
    distanceKm: checkedStages.reduce((sum, stage) => sum + stage.distanceKm, 0),
    drivingMs: stageResults.reduce((sum, stage) => sum + stage.drivingMs, 0),
    stages: stageResults,
    events,
    activities: planned,
    violations: analysis.violations,
    status: analysis.status,
    extendedDuties: analysis.duties.filter(duty => duty.extended).map(duty => duty.start),
    ignoredExtensions,
    ignoredDailyRests,
    historyCoverage,
    confirmed,
    confidence: confirmed ? 'потвърдено от наличните данни' : 'непотвърдено — липсват данни или има допускания',
    assumptions: [
      'Ориентировъчни постоянни скорости: 80 км/ч по магистрала и 55 км/ч по обикновен път.',
      'Не са включени трафик, граници, товарене, ограничения за камиони или наличност на паркинги.',
      ...(restChoiceMissed ? ['Избраният вид дневна почивка вече е извън срока; незабавната почивка не променя миналата история.'] : []),
      ...(departureGapAssumed ? ['Дейността до бъдещия час на потегляне е неизвестна; не се зачита автоматично като почивка.'] : []),
      ...(historyCoverage.gaps.length ? [`Има ${historyCoverage.gaps.length} непокрити интервала в необходимата начална история.`] : []),
      ...(!historyComplete ? ['Историята не покрива надеждно две седмици, дневните удължения или последната седмична почивка.'] : [])
    ]
  };
}
