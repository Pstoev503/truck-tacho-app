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

      if (breakStyle === '15+30' && !splitFirstTaken && continuousDrive >= 4 * H) {
        add('rest', BREAK_SPLIT_FIRST, 'Пауза 15 мин', index);
        splitFirstTaken = true;
        continue;
      }
      if (continuousDrive >= LIMITS.continuousDrive) {
        const duration = breakStyle === '15+30' && splitFirstTaken
          ? BREAK_SPLIT_SECOND : LIMITS.breakFull;
        add('rest', duration, breakStyle === '15+30' && splitFirstTaken
          ? 'Пауза 30 мин (15 + 30)' : 'Пауза 45 мин', index);
        continuousDrive = 0;
        splitFirstTaken = false;
        continue;
      }

      let dailyLimit = DAILY_STANDARD;
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
          extensionUsedOnStage = true;
          dailyExtensionAlreadyUsed = true;
        } else if (!extensionIgnored) {
          ignoredExtensions.push({ stageIndex: index, reason: 'Използвани са двете седмични удължения или липсва история.' });
          extensionIgnored = true;
        }
      }
      if (dailyDrive >= dailyLimit) {
        let restDuration = LIMITS.dailyRestRegular;
        let restLabel = 'Редовна дневна почивка 11 ч';
        if (stage.dailyRest === 'reduced' && !reducedRestUsedOnStage) {
          if (analysisAt(time).status.daily.reducedRestsLeft > 0) {
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
        add('rest', restDuration, restLabel, index);
        dailyDrive = 0;
        continuousDrive = 0;
        dailyExtensionAlreadyUsed = false;
        splitFirstTaken = false;
        continue;
      }

      const continuousLimit = breakStyle === '15+30' && !splitFirstTaken
        ? 4 * H : LIMITS.continuousDrive;
      const available = Math.min(
        remainingDrive,
        dailyLimit - dailyDrive,
        continuousLimit - continuousDrive
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
      if (dailyDrive > DAILY_STANDARD) dailyExtensionAlreadyUsed = true;
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
  const earliest = baseActivities.reduce((value, activity) => Math.min(value, toTime(activity.start)), Infinity);
  const logCoversFortnight = Number.isFinite(earliest) && earliest <= weekStart(start) - WEEK_MS;
  const historyComplete = logCoversFortnight && !analysis.status.daily.startAssumed && !analysis.status.weeklyRest.estimated;
  const departureGapAssumed = start > currentTime;
  const confirmed = analysis.violations.length === 0 && historyComplete && !departureGapAssumed;

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
    confirmed,
    confidence: confirmed ? 'потвърдено от наличните данни' : 'непотвърдено — липсват данни или има допускания',
    assumptions: [
      'Ориентировъчни постоянни скорости: 80 км/ч по магистрала и 55 км/ч по обикновен път.',
      'Не са включени трафик, граници, товарене, ограничения за камиони или наличност на паркинги.',
      ...(departureGapAssumed ? ['Дейността до бъдещия час на потегляне е неизвестна; не се зачита автоматично като почивка.'] : []),
      ...(!historyComplete ? ['Историята не покрива надеждно две седмици, дневните удължения или последната седмична почивка.'] : [])
    ]
  };
}
