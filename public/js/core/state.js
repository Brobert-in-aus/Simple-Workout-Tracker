import { getMonday, todayStr } from './dates.js';

export const CHAIN_SVG_LINKED = `<svg class="sync-chain-icon" width="13" height="9" viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1.5" width="7.5" height="9" rx="3.75"/><rect x="11.5" y="1.5" width="7.5" height="9" rx="3.75"/><line x1="8.5" y1="6" x2="11.5" y2="6"/></svg>`;
export const CHAIN_SVG_BROKEN = `<svg class="sync-chain-icon" width="13" height="9" viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1.5" width="7" height="9" rx="3.5"/><rect x="12" y="1.5" width="7" height="9" rx="3.5"/></svg>`;

export const state = {
  currentDate: todayStr(),
  currentWeekStart: getMonday(todayStr()),
  currentWorkoutBlocks: [],
  saveTimers: {},
  scheduleCache: null,
  templatesCache: null,
  backupStatusCache: null,
  bodyWeightsCache: null,
  exerciseTrendCache: {},
  performedExercisesCache: null,
  workoutDatesCache: null,
  progressSection: 'body',
  progressTimeRange: '3m',
  progressExerciseId: null,
  progressExerciseName: '',
  bodyHistoryExpanded: false,
};

export function invalidateScheduleCache() {
  state.scheduleCache = null;
}

export function invalidateTemplatesCache() {
  state.templatesCache = null;
}

export function invalidateBackupStatusCache() {
  state.backupStatusCache = null;
}

export function invalidateBodyCache() {
  state.bodyWeightsCache = null;
}

export function invalidateProgressCaches() {
  state.performedExercisesCache = null;
  state.exerciseTrendCache = {};
  state.workoutDatesCache = null;
}
