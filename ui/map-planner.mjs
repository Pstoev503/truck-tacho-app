import { createMapPlan } from '../engine/map-plan.js';
import { buildPlan } from '../engine/plan.js';
import { indexRoute, pointAtOffset } from '../engine/route-position.js';
import { loadPlannerInitialState } from './planner-initial-state.mjs';

const ROAD_TYPES = new Set(['motorway', 'ordinary']);
const EARTH_RADIUS_M = 6_371_000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));

export function createMapPlannerController({
  now = Date.now,
  adapter = request => createMapPlan(request, { buildPlan, indexRoute, pointAtOffset }),
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
  let history = { mode: 'unselected', snapshot: null, summary: null, error: null };

  const snapshot = () => ({
    points: clone(points),
    roadTypes: [...roadTypes],
    choices: clone(choices),
    routeRevision,
    inputRevision,
    departure: { ...departure },
    history: clone(history),
    result,
    error
  });
  const notify = () => onChange(snapshot());
  const invalidate = routeChanged => {
    if (routeChanged) routeRevision++;
    inputRevision++;
    activeRequestId = null;
    result = null;
    error = null;
    notify();
  };
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
          breakStyle: '45',
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

  return {
    getState: snapshot,
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
  }

  $('relative-inputs').hidden = $('departure-mode').value !== 'relative';
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
  document.getElementById('plan').addEventListener('click', () => controller.plan());
  const loadHistory = () => controller.loadInitialHistory(key => localStorage.getItem(key));
  document.getElementById('history-use').addEventListener('click', loadHistory);
  document.getElementById('history-refresh').addEventListener('click', loadHistory);
  document.getElementById('history-none').addEventListener('click', () => controller.chooseNoHistory());
  window.addEventListener('storage', event => {
    if (event.storageArea === localStorage) controller.storageChanged(event.key);
  });
  renderPlanner(controller.getState(), map, layers, controller);
}
