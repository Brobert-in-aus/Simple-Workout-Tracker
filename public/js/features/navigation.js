import { getMonday, shiftDate, todayStr } from '../core/dates.js';
import { state } from '../core/state.js';

export function initNavigation({ loadTemplate, loadBodyTab, loadWeek, loadWorkout, loadNutrition }) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

      if (btn.dataset.tab === 'template') loadTemplate();
      if (btn.dataset.tab === 'body') loadBodyTab();
      if (btn.dataset.tab === 'nutrition') loadNutrition();
    });
  });

  initWorkoutDoubleTap(loadWorkout);

  document.getElementById('week-prev').addEventListener('click', () => {
    state.currentWeekStart = shiftDate(state.currentWeekStart, -7);
    state.currentDate = state.currentWeekStart;
    loadWeek();
  });

  document.getElementById('week-next').addEventListener('click', () => {
    state.currentWeekStart = shiftDate(state.currentWeekStart, 7);
    state.currentDate = state.currentWeekStart;
    loadWeek();
  });

  document.getElementById('week-today').addEventListener('click', () => {
    state.currentDate = todayStr();
    state.currentWeekStart = getMonday(state.currentDate);
    loadWeek();
  });
}

function initWorkoutDoubleTap(loadWorkout) {
  const workoutBtn = document.querySelector('.nav-btn[data-tab="workout"]');
  let lastTap = 0;
  let lastTouchEnd = 0;

  function doDoubleTapScroll() {
    const cards = document.querySelectorAll('#exercises-list .exercise-card:not(.skipped):not(.preview-card)');
    let target = null;
    for (const card of cards) {
      const checks = card.querySelectorAll('.set-check');
      if (checks.length === 0) continue;
      if (!Array.from(checks).every((check) => check.classList.contains('done'))) {
        target = card;
        break;
      }
    }
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const beginDiv = document.querySelector('#exercises-list .begin-workout');
    if (beginDiv) {
      beginDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

  workoutBtn.addEventListener('touchend', () => {
    const now = Date.now();
    lastTouchEnd = now;
    if (now - lastTap < 500) doDoubleTapScroll();
    lastTap = now;
  }, { passive: true });

  workoutBtn.addEventListener('click', () => {
    if (Date.now() - lastTouchEnd < 600) return;
    const now = Date.now();
    if (now - lastTap < 500) doDoubleTapScroll();
    lastTap = now;
  });
}
