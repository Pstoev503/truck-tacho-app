import { createMapPlan } from '../engine/map-plan.js';
import { buildPlan } from '../engine/plan.js';
import { indexRoute, pointAtOffset } from '../engine/route-position.js';
import { evaluateParkingCandidates } from '../engine/parking-candidates.js';
import { loadPlannerInitialState } from './planner-initial-state.mjs';
import { createDraft, draftFileName, parseDraftText, readDraftFile } from './planner-draft.mjs';
import {
  describeParkingResults, parkingItemNode, parkingSummaryText, parkingTooltipNode, parseParkingText,
  readParkingFile, validateParkingWindow, windowInMeters
} from './planner-parking.mjs';

const ROAD_TYPES = new Set(['motorway', 'ordinary']);
const BREAK_STYLES = new Set(['45', '15+30']);
const EARTH_RADIUS_M = 6_371_000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));

export function createMapPlannerController({
  now = Date.now,
  adapter = request => createMapPlan(request, { buildPlan, indexRoute, pointAtOffset }),
  evaluateParking = evaluateParkingCandidates,
  onChange = () => {}
} = {}) {
  const points = [];
  const roadTypes = [];
  const choices = {};
  let routeRevision = 0;
  let inputRevision = 0;
  let requestCounter = 0;
  let activeRequestId = null;
  let result = null;
  let error = null;
  let departure = { mode: 'now', hours: 0, minutes: 0 };
  let breakStyle = '45';
  // Draft file loads: a newer load, clear or route edit makes an older read stale.
  const draft = { mode: 'idle', fileName: null, error: null, token: 0 };
  let history = { mode: 'unselected', snapshot: null, summary: null, error: null };
  // The imported list survives route edits; any evaluation result does not.
  const parking = {
    mode: 'empty', fileName: null, candidates: null, error: null,
    window: validateParkingWindow(), windowError: null,
    revision: 0, loadToken: 0, evaluationToken: 0, requestCounter: 0,
    evaluating: false, result: null, items: null
  };

  const snapshot = () => ({
    points: clone(points),
    roadTypes: [...roadTypes],
    choices: clone(choices),
    routeRevision,
    inputRevision,
    departure: { ...departure },
    breakStyle,
    draft: { mode: draft.mode, fileName: draft.fileName, error: draft.error },
    history: clone(history),
    result,
    error,
    parking: {
      mode: parking.mode,
      fileName: parking.fileName,
      count: parking.candidates ? parking.candidates.length : 0,
      error: parking.error,
      window: { ...parking.window },
      windowError: parking.windowError,
      evaluating: parking.evaluating,
      result: parking.result,
      items: parking.items
    }
  });
  const notify = () => onChange(snapshot());
  const dropParkingResult = () => {
    parking.revision++;
    parking.evaluationToken++;
    parking.evaluating = false;
    parking.result = null;
    parking.items = null;
  };
  const invalidate = routeChanged => {
    if (routeChanged) {
      routeRevision++;
      if (draft.mode === 'loading') {
        draft.token++;
        draft.mode = 'idle';
      }
    }
    inputRevision++;
    activeRequestId = null;
    result = null;
    error = null;
    dropParkingResult();
    if (parking.mode === 'evaluated') parking.mode = 'loaded';
    if (parking.mode === 'loaded') parking.error = null;
    notify();
  };
  const setParkingList = (candidates, fileName) => {
    parking.mode = 'loaded';
    parking.fileName = fileName;
    parking.candidates = candidates;
    parking.error = null;
  };
  const failParking = message => {
    parking.mode = 'error';
    parking.fileName = null;
    parking.candidates = null;
    parking.error = message;
  };
  const parkingMessage = caught => (caught instanceof Error && caught.message) ||
    'Файлът с паркинги не може да бъде зареден.';
  const validPoint = point => point && Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) && Math.abs(point.lat) < 85 &&
    Math.abs(point.lon) <= 180;

  function sectionsFor(routeIndex) {
    return routeIndex.segments
      .filter(segment => segment.lengthM > 0)
      .map(segment => ({
        id: `section-${segment.index + 1}`,
        edgeIndex: segment.index,
        fromM: segment.startOffsetM,
        toM: segment.endOffsetM,
        roadType: roadTypes[segment.index]
      }));
  }

  function requestForPlan() {
    const currentNow = now();
    if (!Number.isFinite(currentNow)) throw new Error('Не може да се определи текущият час.');
    const departureUtcMs = currentNow +
      (departure.mode === 'relative'
        ? departure.hours * HOUR_MS + departure.minutes * MINUTE_MS : 0);
    const geometry = clone(points);
    const routeIndex = indexRoute(geometry, { routeRevision: `route-${routeRevision}` });
    const sections = sectionsFor(routeIndex);
    if (sections.some(section => !ROAD_TYPES.has(section.roadType))) {
      throw new Error('Избери изричен тип път за всеки положителен участък.');
    }
    return {
      request: {
        schemaVersion: 1,
        requestId: `request-${++requestCounter}`,
        routeRevision: `route-${routeRevision}`,
        inputRevision: `input-${inputRevision}`,
        nowUtcMs: currentNow,
        departureUtcMs,
        displayTimeZone: 'Europe/Sofia',
        route: {
          geometry,
          geometryKind: 'manual-sketch',
          source: 'manual-map-sketch',
          vehicleProfileRef: null,
          roadSections: sections.map(({ id, fromM, toM, roadType }) => ({
            id, fromM, toM, roadType, source: 'manual'
          }))
        },
        initialState: history.mode === 'loaded'
          ? clone(history.snapshot)
          : { activities: [], lastWeeklyRestEnd: null, source: 'none' },
        choices: {
          breakStyle,
          multiManning: false,
          bySection: sections.map(section => ({
            sectionId: section.id,
            useExtension: choices[section.id]?.useExtension === true,
            dailyRest: choices[section.id]?.dailyRest ?? 'regular'
          }))
        }
      },
      sections
    };
  }

  async function evaluateParkingList() {
    if (!parking.candidates) {
      parking.error = 'Първо зареди файл с паркинги.';
      notify();
      return { accepted: false, error: parking.error };
    }
    // Any earlier result goes first, so the request carries the new revision.
    dropParkingResult();
    parking.mode = 'loaded';
    let request;
    try {
      if (parking.windowError) throw new Error(parking.windowError);
      if (points.length < 2) throw new Error('Начертай маршрут с поне две точки преди оценка на паркингите.');
      const currentNow = now();
      if (!Number.isSafeInteger(currentNow) || currentNow < 0) throw new Error('Не може да се определи текущият час.');
      const geometry = clone(points);
      let routeLengthM;
      try {
        routeLengthM = indexRoute(geometry).totalLengthM;
      } catch {
        throw new Error('Точките не образуват валидна линия; паркингите не са оценени.');
      }
      request = {
        requestId: `parking-${++parking.requestCounter}`,
        routeRevision: `route-${routeRevision}`,
        inputRevision: `input-${inputRevision}.parking-${parking.revision}`,
        geometry,
        evaluatedAt: currentNow,
        window: windowInMeters(parking.window, routeLengthM),
        parkingCandidates: parking.candidates
      };
    } catch (caught) {
      parking.error = caught.message;
      notify();
      return { accepted: false, error: parking.error };
    }

    const token = parking.evaluationToken;
    parking.error = null;
    parking.evaluating = true;
    notify();
    let evaluated;
    try {
      evaluated = await evaluateParking(request);
    } catch {
      if (token !== parking.evaluationToken) return { accepted: false, stale: true };
      parking.evaluating = false;
      parking.error = 'Паркингите не можаха да бъдат оценени. Опитай отново.';
      notify();
      return { accepted: false, error: parking.error };
    }
    if (token !== parking.evaluationToken) return { accepted: false, stale: true };
    parking.evaluating = false;
    if (evaluated?.requestId !== request.requestId ||
        evaluated?.routeRevision !== request.routeRevision ||
        evaluated?.inputRevision !== request.inputRevision) {
      parking.error = 'Оценката не е за текущия маршрут и списък. Опитай отново.';
      notify();
      return { accepted: false, error: parking.error };
    }
    if (evaluated.status !== 'evaluated') {
      parking.error = 'Паркингите не могат да бъдат оценени за тази линия и избрания участък.';
      notify();
      return { accepted: false, error: parking.error };
    }
    parking.mode = 'evaluated';
    parking.result = evaluated;
    parking.items = describeParkingResults(evaluated, parking.candidates);
    notify();
    return { accepted: true, result: evaluated };
  }

  // The whole draft is already validated; every field is replaced at once.
  function applyDraft(loaded, fileName) {
    points.length = 0;
    points.push(...loaded.points.map(point => ({ lat: point.lat, lon: point.lon })));
    roadTypes.length = 0;
    roadTypes.push(...loaded.roadTypes);
    for (const key of Object.keys(choices)) delete choices[key];
    Object.assign(choices, clone(loaded.choices));
    departure = { ...loaded.departure };
    breakStyle = loaded.breakStyle;
    // The log is never taken from a file: choose it again for this draft.
    history = { mode: 'unselected', snapshot: null, summary: null, error: null };
    draft.mode = 'loaded';
    draft.fileName = fileName;
    draft.error = null;
    invalidate(true);
  }
  const failDraft = caught => {
    draft.mode = 'error';
    draft.fileName = null;
    draft.error = (caught instanceof Error && caught.message) || 'Подготовката не може да бъде заредена.';
    notify();
    return { loaded: false, error: draft.error };
  };

  return {
    getState: snapshot,
    exportDraft() {
      const exportedAtUtcMs = now();
      if (!Number.isSafeInteger(exportedAtUtcMs) || exportedAtUtcMs < 0) {
        throw new Error('Не може да се определи текущият час.');
      }
      return {
        text: createDraft({ points, roadTypes, choices, departure, breakStyle }, exportedAtUtcMs),
        fileName: draftFileName(exportedAtUtcMs)
      };
    },
    importDraftText(text, fileName = null) {
      draft.token++;
      let loaded;
      try {
        loaded = parseDraftText(text);
      } catch (caught) {
        return failDraft(caught);
      }
      applyDraft(loaded, fileName);
      return { loaded: true };
    },
    async importDraftFile(file) {
      const token = ++draft.token;
      draft.mode = 'loading';
      draft.error = null;
      notify();
      let loaded;
      try {
        loaded = await readDraftFile(file);
      } catch (caught) {
        if (token !== draft.token) return { loaded: false, stale: true };
        return failDraft(caught);
      }
      if (token !== draft.token) return { loaded: false, stale: true };
      applyDraft(loaded, typeof file.name === 'string' ? file.name : null);
      return { loaded: true };
    },
    loadParkingText(text, fileName = null) {
      parking.loadToken++;
      dropParkingResult();
      try {
        setParkingList(parseParkingText(text), fileName);
      } catch (caught) {
        failParking(parkingMessage(caught));
      }
      notify();
      return { loaded: parking.mode === 'loaded', error: parking.error };
    },
    async loadParkingFile(file) {
      const token = ++parking.loadToken;
      dropParkingResult();
      parking.mode = 'loading';
      parking.fileName = null;
      parking.candidates = null;
      parking.error = null;
      notify();
      let candidates;
      try {
        candidates = await readParkingFile(file);
      } catch (caught) {
        if (token !== parking.loadToken) return { loaded: false, stale: true };
        failParking(parkingMessage(caught));
        notify();
        return { loaded: false, error: parking.error };
      }
      if (token !== parking.loadToken) return { loaded: false, stale: true };
      setParkingList(candidates, typeof file.name === 'string' ? file.name : null);
      notify();
      return { loaded: true };
    },
    clearParking() {
      parking.loadToken++;
      dropParkingResult();
      parking.mode = 'empty';
      parking.fileName = null;
      parking.candidates = null;
      parking.error = null;
      notify();
    },
    setParkingWindow(nextWindow) {
      dropParkingResult();
      if (parking.mode === 'evaluated') parking.mode = 'loaded';
      try {
        parking.window = validateParkingWindow(nextWindow);
        parking.windowError = null;
      } catch (caught) {
        parking.windowError = caught.message;
      }
      notify();
      return parking.windowError === null;
    },
    evaluateParking: evaluateParkingList,
    loadInitialHistory(readStorage) {
      history = { mode: 'loading', snapshot: null, summary: null, error: null };
      invalidate(false);
      try {
        const loaded = loadPlannerInitialState({ readStorage, now });
        history = {
          mode: 'loaded',
          snapshot: loaded.initialState,
          summary: loaded.summary,
          error: null
        };
        notify();
        return { loaded: true, history: snapshot().history };
      } catch (caught) {
        history = {
          mode: 'error',
          snapshot: null,
          summary: null,
          error: caught instanceof Error ? caught.message : 'Локалният дневник не може да бъде прочетен.'
        };
        notify();
        return { loaded: false, error: history.error };
      }
    },
    chooseNoHistory() {
      history = { mode: 'none', snapshot: null, summary: null, error: null };
      invalidate(false);
    },
    storageChanged(key) {
      if ((key !== null && !['th_activities', 'th_weekly_rest_end'].includes(key)) ||
          history.mode !== 'loaded') return false;
      history = {
        mode: 'stale',
        snapshot: null,
        summary: null,
        error: 'Дневникът на устройството се промени. Опресни го или продължи без начална история.'
      };
      invalidate(false);
      return true;
    },
    addPoint(point) {
      if (!validPoint(point)) throw new TypeError('Точката е извън поддържаните координати.');
      if (points.length) roadTypes.push(null);
      points.push({ lat: point.lat, lon: point.lon });
      invalidate(true);
    },
    dragPoint(index, point) {
      if (!Number.isInteger(index) || index < 0 || index >= points.length) {
        throw new RangeError('Невалидна точка от маршрута.');
      }
      if (!validPoint(point)) throw new TypeError('Точката е извън поддържаните координати.');
      points[index] = { lat: point.lat, lon: point.lon };
      invalidate(true);
    },
    removeLastPoint() {
      if (!points.length) return false;
      if (points.length > 1) delete choices[`section-${points.length - 1}`];
      points.pop();
      roadTypes.pop();
      invalidate(true);
      return true;
    },
    clear() {
      if (draft.mode === 'loading') {
        draft.token++;
        draft.mode = 'idle';
        notify();
      }
      if (!points.length && !Object.keys(choices).length && !result) return;
      points.length = 0;
      roadTypes.length = 0;
      for (const key of Object.keys(choices)) delete choices[key];
      invalidate(true);
    },
    setRoadType(edgeIndex, roadType) {
      if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= roadTypes.length) {
        throw new RangeError('Невалиден участък.');
      }
      if (roadType !== null && !ROAD_TYPES.has(roadType)) throw new TypeError('Невалиден тип път.');
      if (roadTypes[edgeIndex] === roadType) return;
      roadTypes[edgeIndex] = roadType;
      invalidate(true);
    },
    setChoice(sectionId, nextChoice) {
      if (typeof sectionId !== 'string' || !/^section-\d+$/.test(sectionId) ||
          !nextChoice || typeof nextChoice.useExtension !== 'boolean' ||
          !['regular', 'reduced'].includes(nextChoice.dailyRest)) {
        throw new TypeError('Невалиден избор за участък.');
      }
      choices[sectionId] = {
        useExtension: nextChoice.useExtension,
        dailyRest: nextChoice.dailyRest
      };
      invalidate(false);
    },
    // Only the break during driving; daily rest and the 10 h request are per section.
    setBreakStyle(nextBreakStyle) {
      if (typeof nextBreakStyle !== 'string' || !BREAK_STYLES.has(nextBreakStyle)) {
        throw new TypeError('Избери пауза 45 мин или 15 + 30 мин.');
      }
      if (nextBreakStyle === breakStyle) return;
      breakStyle = nextBreakStyle;
      invalidate(false);
    },
    setDeparture(nextDeparture) {
      if (!nextDeparture || !['now', 'relative'].includes(nextDeparture.mode)) {
        throw new TypeError('Избери „Сега“ или относително потегляне.');
      }
      const hours = nextDeparture.hours ?? 0;
      const minutes = nextDeparture.minutes ?? 0;
      if (!Number.isInteger(hours) || hours < 0 || hours > 720 ||
          !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
        throw new RangeError('Въведи валидно относително време.');
      }
      departure = { mode: nextDeparture.mode, hours, minutes };
      invalidate(false);
    },
    async plan() {
      let request;
      try {
        if (!['loaded', 'none'].includes(history.mode)) {
          throw new Error('Използвай дневника от устройството или избери изрично „Продължи без начална история“.');
        }
        if (points.length < 2) throw new Error('Добави поне две точки върху картата.');
        request = requestForPlan().request;
      } catch (caught) {
          error = caught.message === 'Добави поне две точки върху картата.' ||
            caught.message === 'Избери изричен тип път за всеки положителен участък.' ||
            caught.message.startsWith('Използвай дневника')
            ? caught.message : 'Точките не образуват валидна линия; провери координатите и разстоянията.';
          result = null;
        notify();
        return { accepted: true, result: null, error };
      }
      const { requestId, routeRevision: requestedRouteRevision, inputRevision: requestedInputRevision } = request;
      activeRequestId = requestId;
      result = null;
      error = null;
      notify();
      try {
        const planned = await adapter(clone(request));
        if (activeRequestId !== requestId ||
            routeRevision !== Number(requestedRouteRevision.slice(6)) ||
            inputRevision !== Number(requestedInputRevision.slice(6))) {
          return { accepted: false, stale: true, result: planned };
        }
        if (planned?.requestId !== requestId ||
            planned?.routeRevision !== requestedRouteRevision ||
            planned?.inputRevision !== requestedInputRevision) {
          activeRequestId = null;
          error = 'Не получих актуален план за този маршрут. Опитай отново.';
          result = null;
          notify();
          return { accepted: false, result: null, error };
        }
        result = planned;
        error = planned?.error ? userError(planned) : null;
        notify();
        return { accepted: true, result: planned, error };
      } catch (caught) {
        if (activeRequestId !== requestId) return { accepted: false, stale: true, result: null };
        error = 'Планът не можа да бъде изчислен. Опитай отново.';
        result = null;
        notify();
        return { accepted: true, result: null, error };
      }
    }
  };
}

function userError(result) {
  const messages = {
    'invalid-input': 'Провери точките, типовете път и часовете.',
    'needs-data': 'Необходими са още данни, за да се изчисли планът.',
    unsupported: 'Тази заявка не се поддържа от планирането.',
    error: 'Възникна грешка при изчисляването; няма показан час на пристигане.'
  };
  return messages[result.state] ?? 'Планът не е наличен.';
}

export function formatSofiaTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('bg-BG', {
    timeZone: 'Europe/Sofia',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp));
}

export function sampleRoute(routeIndex, maxSegmentM = 25_000) {
  const points = [];
  for (const segment of routeIndex.segments) {
    if (segment.lengthM === 0) continue;
    const count = Math.max(1, Math.ceil(segment.lengthM / maxSegmentM));
    for (let step = 0; step <= count; step++) {
      if (points.length && step === 0) continue;
      const offset = segment.startOffsetM + segment.lengthM * step / count;
      const point = pointAtOffset(routeIndex, offset);
      points.push([point.lat, point.lon]);
    }
  }
  return points;
}

const warningText = {
  ESTIMATE_ONLY: 'Само ориентировъчна оценка: трафикът, ограниченията за камиони и наличността на места не са проверени.',
  HISTORY_INCOMPLETE: 'Началната история е непълна или непотвърдена.',
  MANUAL_SKETCH: 'Линията е ръчна скица, не проверен пътен маршрут.',
  MANUAL_ROAD_TYPE: 'Типовете път са въведени ръчно и не са проверени.',
  HISTORY_UNVERIFIED: 'Няма предоставена начална история на дейностите.',
  MULTI_MANNING_UNVERIFIED: 'Данните за екипаж не са независимо потвърдени.',
  ENGINE_VIOLATIONS: 'Двигателят е отчел потенциални нарушения; графикът не е правно одобрение.'
};
const violationLabels = {
  CONTINUOUS_DRIVE: 'Време за непрекъснато управление',
  DAILY_DRIVE: 'Дневно време за управление',
  DAILY_DRIVE_EXT: 'Дневни удължения на управлението',
  DAILY_REST: 'Срок за дневна почивка',
  REDUCED_DAILY_RESTS: 'Брой намалени дневни почивки',
  WEEKLY_DRIVE: 'Седмично време за управление',
  FORTNIGHT_DRIVE: 'Време за управление за две седмици',
  WEEKLY_REST_LATE: 'Срок за седмична почивка',
  CONSECUTIVE_REDUCED_WEEKLY: 'Последователни намалени седмични почивки',
  COMPENSATION: 'Срок за компенсация на седмична почивка'
};

export function formatViolation(violation) {
  const label = violationLabels[violation?.code] ?? 'Отчетено е нарушение';
  const detail = typeof violation?.detail === 'string' ? violation.detail.trim() : '';
  return detail ? `${label}: ${detail}` : label;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderPlanner(state, map, layers, controller) {
  const $ = id => document.getElementById(id);
  const pointsList = $('points');
  pointsList.replaceChildren(...state.points.map((point, index) =>
    element('li', `Точка ${index + 1}: ${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`)));
  const sectionsNode = $('sections');
  sectionsNode.replaceChildren();
  if (state.points.length >= 2) {
    try {
      const routeIndex = indexRoute(state.points);
      for (const segment of routeIndex.segments) {
        if (!segment.lengthM) continue;
        const sectionId = `section-${segment.index + 1}`;
        const section = element('div', undefined, 'section');
        const heading = element('div', undefined, 'section-heading');
        heading.append(element('strong', `Участък ${segment.index + 1}`));
        heading.append(element('span', `${(segment.lengthM / 1000).toFixed(2)} км`));
        section.append(heading);
        section.append(element('p', 'Типът път е ръчно въведен; няма проверка на пътя.', 'muted'));
        const fields = element('div', undefined, 'section-fields');
        const typeLabel = element('label', 'Тип път');
        const typeSelect = element('select');
        typeSelect.setAttribute('aria-label', `Тип път за участък ${segment.index + 1}`);
        for (const [value, label] of [
          ['', 'Избери тип път'], ['motorway', 'Магистрала'], ['ordinary', 'Обикновен път']
        ]) {
          const option = element('option', label);
          option.value = value;
          typeSelect.append(option);
        }
        typeSelect.value = state.roadTypes[segment.index] ?? '';
        typeSelect.addEventListener('change', () =>
          controller.setRoadType(segment.index, typeSelect.value || null));
        typeLabel.append(typeSelect);
        const extensionLabel = element('label', 'Заявка за 10 ч управление');
        const extension = document.createElement('input');
        extension.type = 'checkbox';
        extension.checked = state.choices[sectionId]?.useExtension === true;
        extension.setAttribute('aria-label', `Заявка за удължение до 10 часа, участък ${segment.index + 1}`);
        extensionLabel.append(extension);
        const restLabel = element('label', 'Дневна почивка');
        const rest = document.createElement('select');
        for (const [value, label] of [['regular', '11 ч (обичайна)'], ['reduced', '9 ч (намалена)']]) {
          const option = element('option', label);
          option.value = value;
          rest.append(option);
        }
        rest.value = state.choices[sectionId]?.dailyRest ?? 'regular';
        rest.setAttribute('aria-label', `Заявена дневна почивка, участък ${segment.index + 1}`);
        restLabel.append(rest);
        const updateChoice = () => controller.setChoice(sectionId, {
          useExtension: extension.checked,
          dailyRest: rest.value
        });
        extension.addEventListener('change', updateChoice);
        rest.addEventListener('change', updateChoice);
        fields.append(typeLabel, extensionLabel, restLabel);
        section.append(fields);
        sectionsNode.append(section);
      }
    } catch {
      sectionsNode.append(element('p', 'Точките не образуват поддържана линия.'));
    }
  }

  layers.clearLayers();
  if (state.points.length) {
    try {
      const routeIndex = indexRoute(state.points);
      const line = sampleRoute(routeIndex);
      if (line.length > 1) layers.addLayer(L.polyline(line, { color: '#58a6ff', weight: 5 }));
    } catch {
      if (state.points.length > 1) {
        layers.addLayer(L.polyline(state.points.map(point => [point.lat, point.lon]), { color: '#58a6ff', weight: 5 }));
      }
    }
    state.points.forEach((point, index) => {
      const marker = L.marker([point.lat, point.lon], { draggable: true, title: `Точка ${index + 1}` });
      marker.bindTooltip(String(index + 1), { permanent: true, direction: 'top' });
      marker.on('dragend', event => {
        const moved = event.target.getLatLng();
        controller.dragPoint(index, { lat: moved.lat, lon: moved.lng });
      });
      layers.addLayer(marker);
    });
    if (state.result?.state === 'estimated') {
      for (const event of state.result.events) {
        if (event.type !== 'rest' || !event.fromPoint) continue;
        const marker = L.circleMarker([event.fromPoint.lat, event.fromPoint.lon], {
          radius: 7, color: '#fff', weight: 2, fillColor: '#1769aa', fillOpacity: 1
        });
        marker.bindTooltip('Ориентировъчно място за почивка — паркинг не е избран');
        layers.addLayer(marker);
      }
      map.fitBounds(L.latLngBounds(state.points.map(point => [point.lat, point.lon])).pad(0.12));
    }
    for (const item of state.parking.items ?? []) {
      if (!item.marker) continue;
      const candidate = item.disposition === 'geometric-candidate';
      const marker = L.circleMarker([item.marker.lat, item.marker.lon], {
        radius: 8, weight: 3, color: candidate ? '#b8e986' : '#ffcc80',
        dashArray: candidate ? null : '4 3', fillColor: '#111', fillOpacity: 0.9
      });
      marker.bindTooltip(parkingTooltipNode(document, item));
      layers.addLayer(marker);
    }
  }
  renderParking(state.parking);

  $('departure-mode').value = state.departure.mode;
  $('departure-hours').value = String(state.departure.hours);
  $('departure-minutes').value = String(state.departure.minutes);
  $('relative-inputs').hidden = state.departure.mode !== 'relative';
  $('break-style').value = state.breakStyle;
  renderDraft(state.draft);
  const historyStatus = $('history-status');
  if (state.history.mode === 'loaded') {
    const summary = state.history.summary;
    const boundary = summary.latestBoundary === null
      ? 'няма записана времева граница' : formatSofiaTime(summary.latestBoundary);
    historyStatus.textContent = `Зареден локален дневник: ${summary.activityCount} записа; последна времева граница: ${boundary}. Самоличността и достоверността не са независимо потвърдени.`;
  } else if (state.history.mode === 'none') {
    historyStatus.textContent = 'Избрано: без начална история.';
  } else if (state.history.mode === 'stale') {
    historyStatus.textContent = state.history.error;
  } else if (state.history.mode === 'error') {
    historyStatus.textContent = state.history.error;
  } else if (state.history.mode === 'loading') {
    historyStatus.textContent = 'Зареждане на локалния дневник…';
  } else {
    historyStatus.textContent = 'Без начална история. Избери дневника от устройството или продължи без него.';
  }
  $('history-refresh').hidden = !['loaded', 'stale', 'error'].includes(state.history.mode);
  $('history-use').disabled = state.history.mode === 'loading';
  $('history-refresh').disabled = state.history.mode === 'loading';
  $('history-none').disabled = state.history.mode === 'none';
  $('schedule-card').hidden = !state.result || state.result.state !== 'estimated';
  $('message').textContent = state.error ?? (state.points.length < 2
    ? 'Добави поне две точки върху картата.' : '');
  $('plan').disabled = state.points.length < 2 || !['loaded', 'none'].includes(state.history.mode);
  renderSchedule(state.result);
}

function renderDraft(draft) {
  const status = document.getElementById('draft-status');
  if (draft.mode === 'loading') {
    status.textContent = 'Зареждане на подготовката…';
  } else if (draft.mode === 'error') {
    status.textContent = `${draft.error} Текущата подготовка не е променена.`;
  } else if (draft.mode === 'loaded') {
    const name = draft.fileName ? ` от „${draft.fileName}“` : '';
    status.textContent = `Заредена подготовка${name}. Избери отново дневника от устройството или „Продължи без начална история“, после натисни „Планирай“.`;
  }
}

const parkingFileText = {
  empty: 'Няма зареден списък с паркинги.',
  loading: 'Зареждане на локалния файл…'
};

function renderParking(parking) {
  const $ = id => document.getElementById(id);
  const status = $('parking-status');
  if (parking.mode === 'loaded' || parking.mode === 'evaluated') {
    const name = parking.fileName ? ` от „${parking.fileName}“` : '';
    status.textContent = `Зареден локален списък${name}: ${parking.count} записа. Данните са от файла и не са проверени.`;
  } else if (parking.mode === 'error') {
    status.textContent = parking.error;
  } else {
    status.textContent = parkingFileText[parking.mode] ?? parkingFileText.empty;
  }
  $('parking-message').textContent = parking.windowError ?? (parking.mode === 'error' ? '' : parking.error ?? '');
  $('parking-evaluate').disabled = parking.evaluating || !['loaded', 'evaluated'].includes(parking.mode);
  $('parking-clear').disabled = parking.mode === 'empty';
  const list = $('parking-results');
  list.replaceChildren(...(parking.items ?? []).map(item => parkingItemNode(document, item)));
  $('parking-summary').textContent = parking.result
    ? `${parkingSummaryText(parking.result.summary)} Нито един не е избран или резервиран; ETA и почивките не са променени.`
    : (parking.evaluating ? 'Оценяване…' : '');
}

function renderSchedule(result) {
  const $ = id => document.getElementById(id);
  const schedule = $('schedule');
  const warnings = $('warnings');
  const assumptions = $('assumptions');
  schedule.replaceChildren();
  warnings.replaceChildren();
  assumptions.replaceChildren();
  if (!result || result.state !== 'estimated') {
    $('times').textContent = '';
    return;
  }
  $('times').textContent = `Потегляне: ${formatSofiaTime(result.engineResult.departure)} · Пристигане (оценка): ${formatSofiaTime(result.arrivalUtcMs)} · българско време`;
  for (const warning of result.warnings) warnings.append(element('li', warningText[warning.code] ?? 'Има предупреждение към този ориентировъчен план.'));
  for (const [index, event] of result.events.entries()) {
    const source = result.engineResult.events[index];
    const driving = event.type === 'drive';
    const title = driving ? 'Каране' : (source?.label || 'Пауза / дневна почивка');
    const item = element('li', `${title}: ${formatSofiaTime(event.startUtcMs)} – ${formatSofiaTime(event.endUtcMs)}${driving ? ` · ${(event.toM - event.fromM) / 1000 < 0.01 ? '' : ((event.toM - event.fromM) / 1000).toFixed(1) + ' км'}` : ' · Ориентировъчно място за почивка — паркинг не е избран'}`, driving ? 'drive' : 'rest');
    schedule.append(item);
  }
  const violations = result.engineResult.violations ?? [];
  for (const violation of violations) {
    warnings.append(element('li', formatViolation(violation)));
  }
  for (const item of [...(result.engineResult.ignoredExtensions ?? []), ...(result.engineResult.ignoredDailyRests ?? [])]) {
    warnings.append(element('li', `Изборът за участък ${(item.stageIndex ?? 0) + 1} не е приложен: ${item.reason}`));
  }
  for (const assumption of result.assumptions ?? []) assumptions.append(element('li', assumption));
  if (!assumptions.childElementCount) assumptions.append(element('li', 'Началната история и пълнотата ѝ не са независимо потвърдени.'));
  assumptions.append(element('li', 'Самоличността и достоверността на началния дневник не са независимо потвърдени.'));
}

if (typeof document !== 'undefined') {
  const map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);
  map.setView([42.7, 25.3], 6);
  const layers = L.layerGroup().addTo(map);
  const controller = createMapPlannerController({
    onChange: state => renderPlanner(state, map, layers, controller)
  });
  map.on('click', event => controller.addPoint({ lat: event.latlng.lat, lon: event.latlng.lng }));
  document.getElementById('remove-last').addEventListener('click', () => controller.removeLastPoint());
  document.getElementById('clear-route').addEventListener('click', () => controller.clear());
  document.getElementById('departure-mode').addEventListener('change', event => {
    document.getElementById('relative-inputs').hidden = event.target.value !== 'relative';
    controller.setDeparture({
      mode: event.target.value,
      hours: Number(document.getElementById('departure-hours').value),
      minutes: Number(document.getElementById('departure-minutes').value)
    });
  });
  for (const id of ['departure-hours', 'departure-minutes']) {
    document.getElementById(id).addEventListener('change', () =>
      controller.setDeparture({
        mode: document.getElementById('departure-mode').value,
        hours: Number(document.getElementById('departure-hours').value),
        minutes: Number(document.getElementById('departure-minutes').value)
      }));
  }
  document.getElementById('draft-save').addEventListener('click', () => {
    try {
      const { text, fileName } = controller.exportDraft();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      document.getElementById('draft-status').textContent = `Подготовката е записана във файл „${fileName}“ на това устройство.`;
    } catch (caught) {
      document.getElementById('draft-status').textContent = caught instanceof Error ? caught.message : 'Подготовката не може да бъде записана.';
    }
  });
  document.getElementById('draft-file').addEventListener('change', event => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) controller.importDraftFile(file);
  });
  document.getElementById('break-style').addEventListener('change', event =>
    controller.setBreakStyle(event.target.value));
  document.getElementById('plan').addEventListener('click', () => controller.plan());
  const loadHistory = () => controller.loadInitialHistory(key => localStorage.getItem(key));
  document.getElementById('history-use').addEventListener('click', loadHistory);
  document.getElementById('history-refresh').addEventListener('click', loadHistory);
  document.getElementById('history-none').addEventListener('click', () => controller.chooseNoHistory());
  const parkingWindowInput = () => {
    const kmOrNull = id => {
      const input = document.getElementById(id);
      return input.value.trim() === '' ? null : input.valueAsNumber;
    };
    controller.setParkingWindow({
      fromKm: kmOrNull('parking-from-km'),
      toKm: kmOrNull('parking-to-km'),
      maxLateralM: document.getElementById('parking-max-m').valueAsNumber
    });
  };
  for (const id of ['parking-from-km', 'parking-to-km', 'parking-max-m']) {
    document.getElementById(id).addEventListener('change', parkingWindowInput);
  }
  document.getElementById('parking-file').addEventListener('change', event => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) controller.loadParkingFile(file);
  });
  document.getElementById('parking-evaluate').addEventListener('click', () => controller.evaluateParking());
  document.getElementById('parking-clear').addEventListener('click', () => controller.clearParking());
  window.addEventListener('storage', event => {
    if (event.storageArea === localStorage) controller.storageChanged(event.key);
  });
  renderPlanner(controller.getState(), map, layers, controller);
}
