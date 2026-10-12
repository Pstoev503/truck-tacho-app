// Предупреждение за скорост над ограничителя.
//
// Тахографът записва събитие „превишаване на скоростта“, когато камионът кара
// над скоростта на ограничителя повече от 60 секунди (Регламент (ЕС) 2016/799,
// Приложение IC, определение (hh)). За камиони N3 ограничителят е 90 км/ч
// (Директива 92/6/ЕИО).
//
// GPS закъснява и може да показва малко по-различно от тахографа, затова
// броенето свършва 5 секунди по-рано: на екрана тръгва от 30, гласът казва
// 30, 20, 10, а на нулата („превишението е записано“) реално има още 5 секунди.
// Кратки спадания под лимита (до 2 секунди, шум на GPS) не нулират броенето.

export const OVERSPEED_DEFAULTS = Object.freeze({
  limitKmh: 90,             // броенето започва над тази скорост
  recordAfterSec: 60,       // тахографът записва след повече от толкова секунди
  marginSec: 5,             // броенето свършва толкова по-рано
  showAt: 30,               // от колко секунди се показва броячът
  announceAt: [30, 20, 10], // кога говори
  resetAfterSec: 2          // толкова секунди под лимита нулират броенето
});

export function createOverspeedWatch(options = {}) {
  const o = { ...OVERSPEED_DEFAULTS, ...options };
  const total = (o.recordAfterSec - o.marginSec) * 1000;
  let ep = null;

  return {
    get active() { return ep != null; },

    // Подава текущата скорост; връща списък събития за екрана и гласа.
    update(speedKmh, t = Date.now()) {
      const ev = [];
      const over = speedKmh > o.limitKmh;

      if (over) {
        if (!ep) {
          ep = { start: t, below: null, maxSpeed: speedKmh, said: new Set(), shown: false, zero: false, recorded: false };
          ev.push({ type: 'start', speed: speedKmh });
        }
        ep.below = null;
        ep.maxSpeed = Math.max(ep.maxSpeed, speedKmh);
      } else if (ep) {
        if (ep.below == null) ep.below = t;
        if (t - ep.below >= o.resetAfterSec * 1000) {
          const duration = ep.below - ep.start;
          ev.push({ type: 'end', start: ep.start, duration, maxSpeed: ep.maxSpeed, recorded: duration > o.recordAfterSec * 1000 });
          ep = null;
          return ev;
        }
      }
      if (!ep) return ev;

      const elapsed = t - ep.start;
      const remaining = Math.max(0, Math.ceil((total - elapsed) / 1000));
      if (!ep.shown && remaining <= o.showAt) { ep.shown = true; ev.push({ type: 'show' }); }
      ev.push({ type: 'tick', remaining, speed: speedKmh, over, shown: ep.shown });

      if (over) {
        // при пропуснат момент (GPS обновява рядко) казва само последната граница
        const due = o.announceAt.filter(a => remaining <= a && remaining > 0 && !ep.said.has(a));
        if (due.length) {
          due.forEach(a => ep.said.add(a));
          const a = Math.min(...due);
          const first = ep.said.size === due.length;
          ev.push({ type: 'say', text: first ? `Над ${o.limitKmh}. ${a} секунди.` : `${a} секунди.` });
        }
        if (remaining === 0 && !ep.zero) {
          ep.zero = true;
          ev.push({ type: 'zero' });
          ev.push({ type: 'say', text: 'Превишението е записано в тахографа.' });
        }
      }
      if (!ep.recorded && elapsed > o.recordAfterSec * 1000 && over) {
        ep.recorded = true; // реално записано в тахографа (за бележника)
        ev.push({ type: 'recorded', start: ep.start, maxSpeed: ep.maxSpeed });
      }
      return ev;
    },

    reset() { ep = null; }
  };
}
