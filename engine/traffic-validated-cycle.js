import {createTrafficCycle} from './traffic-cycle.js';
import {validateTrafficExchangeWithSourceHealth} from './traffic-source-gate.js';

// Freeze only our structured clone; caller-owned request/response objects remain
// untouched. The seen set also handles cyclic invalid input without recursion.
function readOnlyCopy(value) {
  const copy = structuredClone(value);
  const seen = new WeakSet();
  const freeze = item => {
    if (item === null || typeof item !== 'object' || seen.has(item)) return item;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(copy);
}

/**
 * Caller owns time, TTL, source declarations and IDs. The accepted cycle and
 * contract/source/temporal gate are composed, never replaced.
 */
export function createValidatedTrafficCycle(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config) ||
      !['evaluate', 'plan', 'createRequest', 'getEvaluationContext'].every(key => typeof config[key] === 'function')) {
    throw new TypeError('four callbacks required');
  }
  const {evaluate, plan, createRequest, getEvaluationContext} = config;
  const invalid = code => ({valid: false, errors: [{code, path: 'options.getEvaluationContext'}]});
  let cycle;
  const isCurrent = request => {
    const state = cycle.snapshot();
    return state !== null && state.status === 'running' &&
      state.cycle === request.evaluationCycle &&
      state.routeRevision === request.routeRevision && state.attempt === request.attempt;
  };
  const validate = (request, response, {activeRequest}) => {
    try {
      if (!isCurrent(request)) return invalid('EVALUATION_CONTEXT_STALE');
      const input = Object.freeze({request: readOnlyCopy(request), response: readOnlyCopy(response)});
      const context = getEvaluationContext(input);
      if (context !== null && (typeof context === 'object' || typeof context === 'function')) {
        // Handle native Promises through the intrinsic rather than a caller's
        // potentially throwing/overridden .then property.
        let nativePromise = false;
        try {
          Promise.prototype.then.call(context, undefined, () => {});
          nativePromise = true;
        } catch {}
        if (nativePromise) return invalid('EVALUATION_CONTEXT_ASYNC');

        // All property access is guarded. Capture then once so an accessor
        // cannot throw on a second read during assimilation.
        const then = context.then;
        if (typeof then === 'function') {
          new Promise((resolve, reject) => Reflect.apply(then, context, [resolve, reject])).catch(() => {});
          return invalid('EVALUATION_CONTEXT_ASYNC');
        }
      }
      if (!isCurrent(request)) return invalid('EVALUATION_CONTEXT_STALE');
      if (context === null || typeof context !== 'object' || Array.isArray(context)) {
        return invalid('EVALUATION_CONTEXT_INVALID');
      }
      const result = validateTrafficExchangeWithSourceHealth(request, response, {
        evaluatedAt: context.evaluatedAt,
        maxExchangeAgeMs: context.maxExchangeAgeMs,
        sources: context.sources,
        activeRequest
      });
      // Context getters/callbacks may synchronously cancel or start another
      // cycle. The old result must not reach its planner in that case.
      if (!isCurrent(request)) return invalid('EVALUATION_CONTEXT_STALE');
      if (result.errors.some(error => error.code === 'SOURCE_HEALTH_INVALID_INPUT' ||
          error.code === 'EXCHANGE_INVALID_MAX_AGE' || error.code === 'EXCHANGE_INVALID_EVALUATED_AT')) {
        return {...result, valid: false, errors: [...result.errors, ...invalid('EVALUATION_CONTEXT_INVALID').errors]};
      }
      return result;
    } catch {
      return invalid('EVALUATION_CONTEXT_ERROR');
    }
  };
  const guardedPlan = args => {
    if (!isCurrent(args.request)) throw new Error('TRAFFIC_CYCLE_STALE');
    return plan(args);
  };
  cycle = createTrafficCycle({evaluate, plan: guardedPlan, createRequest, validate});
  return {run: cycle.run, cancel: cycle.cancel, snapshot: cycle.snapshot};
}
