import { api } from '../../core/api.js';
import { formatDate, formatDateShort, groupByWeek, shiftDate, toISO, todayStr } from '../../core/dates.js';
import { state, invalidateBodyCache, invalidateProgressCaches } from '../../core/state.js';
import { getStrengthFavoriteIds, toggleStrengthFavorite } from '../../core/storage.js';
import { attachFirstTapCursorEnd, showToast } from '../../core/ui.js';
import { renderHistorySection } from '../history.js';
import { buildBarChart, buildLineChart, countWeeksInRange, filterByRange, getRangeBounds, wireExpandableCharts } from './charts.js';

export { invalidateBodyCache, invalidateProgressCaches };

async function getBackupStatus() {
  if (!state.backupStatusCache) state.backupStatusCache = await api('/api/backup/status');
  return state.backupStatusCache;
}

async function saveBodyWeight(date, weightKg) {
  await api(`/api/body-weight/${date}`, { method: 'PUT', body: { weight_kg: weightKg } });
  invalidateBodyCache();
}

export async function loadBodyTab() {
  const tab = document.getElementById('tab-body');
  if (!tab.querySelector('.progress-shell')) {
    renderProgressShell(tab);
  } else {
    tab.querySelectorAll('.seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.section === state.progressSection));
    tab.querySelectorAll('.range-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.range === state.progressTimeRange));
    tab.querySelector('.progress-range-row').classList.toggle('hidden', state.progressSection === 'history');
  }
  await loadProgressSection();
}

function renderProgressShell(container) {
  container.innerHTML = `
    <div class="progress-shell">
      <div class="progress-segments">
        <button class="seg-btn active" data-section="body">Body</button>
        <button class="seg-btn" data-section="strength">Strength</button>
        <button class="seg-btn" data-section="workouts">Workouts</button>
        <button class="seg-btn" data-section="history">History</button>
      </div>
      <div class="progress-range-row">
        <button class="range-btn" data-range="1m">1M</button>
        <button class="range-btn active" data-range="3m">3M</button>
        <button class="range-btn" data-range="6m">6M</button>
        <button class="range-btn" data-range="1y">1Y</button>
        <button class="range-btn" data-range="all">All</button>
        <button class="progress-export-btn" type="button">Export JSON</button>
      </div>
      <div class="progress-content"></div>
    </div>
  `;

  container.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.progressSection = btn.dataset.section;
      container.querySelector('.progress-range-row').classList.toggle('hidden', state.progressSection === 'history');
      loadProgressSection();
    });
  });

  container.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.progressTimeRange = btn.dataset.range;
      loadProgressSection();
    });
  });

  container.querySelector('.progress-export-btn').addEventListener('click', () => {
    window.location.href = '/api/export/json';
  });
}

async function loadProgressSection() {
  const content = document.querySelector('#tab-body .progress-content');
  if (!content) return;
  content.innerHTML = '<div class="progress-loading">Loading...</div>';
  if (state.progressSection === 'body') await renderBodySection(content);
  else if (state.progressSection === 'strength') await renderStrengthSection(content);
  else if (state.progressSection === 'workouts') await renderWorkoutsSection(content);
  else await renderHistorySection(content);
}

async function renderBodySection(container) {
  if (!state.bodyWeightsCache) state.bodyWeightsCache = await api('/api/body-weight');
  const readings = state.bodyWeightsCache;
  const today = todayStr();
  const todayReading = readings.find((r) => r.date === today) || null;
  const latestReading = readings[0] || null;
  const entryCount = readings.length;
  const hasNoReadings = entryCount === 0;
  const hasOneReading = entryCount === 1;

  const chartSeries = filterByRange(
    [...readings].sort((a, b) => a.date.localeCompare(b.date)),
    state.progressTimeRange
  );
  const activeDateCount = chartSeries.length;
  const chartHtml = buildLineChart(
    chartSeries.map((r) => ({ date: r.date, value: r.weight_kg, measured: true })),
    {
      formatY: (v) => v.toFixed(1),
      emptyMsg: 'Add your first weigh-in above to start tracking',
      dotFilter: (point) => point.measured,
      dotClass: 'chart-dot chart-dot-measured',
    }
  );

  const historyHtml = buildBodyHistoryHtml(readings);
  const hint = latestReading
    ? `Latest logged: ${latestReading.weight_kg} kg on ${formatDate(latestReading.date)} - carries forward to today`
    : 'Add your weight above to start tracking and support bodyweight-aware progress later';
  const chartHelper = hasNoReadings
    ? 'Your first logged weight will be used for bodyweight-aware calculations until a newer weigh-in replaces it.'
    : hasOneReading
      ? 'This chart shows your first weigh-in. Add another entry later to start seeing direction over time.'
      : 'The chart connects actual weigh-ins. Calculations still carry your first logged weight backward and later weights forward until replaced.';

  container.innerHTML = `
    <div class="body-today-card">
      <div class="body-today-label">${formatDate(today)}</div>
      <div class="body-today-input-row">
        <input type="number" class="body-today-input" value="${todayReading ? todayReading.weight_kg : ''}"
               placeholder="-" step="0.1" inputmode="decimal" min="20" max="400">
        <span class="body-today-unit">kg</span>
      </div>
      <div class="body-today-hint">${hint}</div>
    </div>
    <div class="progress-stats-row body-stats-row">
      <div class="progress-stat-card">
        <div class="progress-stat-value">${latestReading ? latestReading.weight_kg.toFixed(1) : '-'}</div>
        <div class="progress-stat-label">Latest kg</div>
      </div>
      <div class="progress-stat-card">
        <div class="progress-stat-value">${entryCount}</div>
        <div class="progress-stat-label">Logged entries</div>
      </div>
      <div class="progress-stat-card">
        <div class="progress-stat-value">${activeDateCount}</div>
        <div class="progress-stat-label">Logged dates</div>
      </div>
    </div>
    <div class="progress-chart-card">
      <div class="progress-chart-title">Weight trend</div>
      ${chartHtml}
      <div class="progress-helper-text">${chartHelper}</div>
    </div>
    <div class="progress-history-section">
      <button class="progress-history-toggle">History <span class="toggle-arrow">${state.bodyHistoryExpanded ? '^' : 'v'}</span></button>
      <div class="progress-history-list${state.bodyHistoryExpanded ? '' : ' hidden'}">${historyHtml}</div>
    </div>
  `;

  wireExpandableCharts(container);

  const todayInput = container.querySelector('.body-today-input');
  attachFirstTapCursorEnd(todayInput);
  let todayTimer = null;
  const originalTodayValue = todayReading ? String(todayReading.weight_kg) : '';
  const saveTodayWeight = async () => {
    const v = parseFloat(todayInput.value);
    if (isNaN(v) || v <= 0) return;
    if (String(v) === originalTodayValue) return;
    await saveBodyWeight(today, v);
    state.bodyWeightsCache = null;
    showToast('Weight saved');
    await renderBodySection(container);
  };
  todayInput.addEventListener('change', () => { clearTimeout(todayTimer); todayTimer = setTimeout(saveTodayWeight, 600); });
  todayInput.addEventListener('blur', () => { clearTimeout(todayTimer); saveTodayWeight(); });

  const toggle = container.querySelector('.progress-history-toggle');
  const list = container.querySelector('.progress-history-list');
  toggle.addEventListener('click', () => {
    const collapsed = list.classList.toggle('hidden');
    state.bodyHistoryExpanded = !collapsed;
    toggle.querySelector('.toggle-arrow').textContent = collapsed ? 'v' : '^';
  });

  wireBodyHistoryInputs(container.querySelector('.progress-history-list'), container);
}

function buildBodyHistoryHtml(readings) {
  if (readings.length === 0) return '<div class="empty-state">No readings yet</div>';
  let html = '';
  for (const { weekStart, items: wReadings } of groupByWeek(readings)) {
    html += `<div class="history-week">
      <div class="history-week-header">Week of ${formatDate(weekStart)}</div>`;
    for (const r of wReadings) {
      html += `
        <div class="body-history-item">
          <span class="body-history-date">${formatDate(r.date)}</span>
          <span class="body-history-weight">
            <input type="number" class="body-history-input"
                   value="${r.weight_kg}" step="0.1" inputmode="decimal"
                   data-date="${r.date}" data-original="${r.weight_kg}" min="20" max="400">
            <span class="body-history-unit">kg</span>
          </span>
        </div>`;
    }
    html += '</div>';
  }
  return html;
}

function wireBodyHistoryInputs(historyContainer, sectionContainer) {
  if (!historyContainer) return;
  historyContainer.querySelectorAll('.body-history-input').forEach((input) => {
    attachFirstTapCursorEnd(input);
    const date = input.dataset.date;
    let timer = null;
    const originalValue = input.dataset.original;
    const doSave = async () => {
      const v = parseFloat(input.value);
      if (isNaN(v) || v <= 0) { input.value = input.dataset.original; return; }
      if (String(v) === originalValue) return;
      await saveBodyWeight(date, v);
      input.dataset.original = String(v);
      state.bodyWeightsCache = null;
      showToast('Weight saved');
      await renderBodySection(sectionContainer);
    };
    input.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(doSave, 600); });
    input.addEventListener('blur', () => { clearTimeout(timer); doSave(); });
  });
}

function compareExerciseSearchResults(a, b, query) {
  const favorites = new Set(getStrengthFavoriteIds());
  const aFav = favorites.has(a.id);
  const bFav = favorites.has(b.id);
  if (aFav !== bFav) return aFav ? -1 : 1;

  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  const aStarts = aName.startsWith(query);
  const bStarts = bName.startsWith(query);
  if (aStarts !== bStarts) return aStarts ? -1 : 1;

  const aIndex = aName.indexOf(query);
  const bIndex = bName.indexOf(query);
  if (aIndex !== bIndex) return aIndex - bIndex;

  const aDate = a.last_date || '';
  const bDate = b.last_date || '';
  if (aDate !== bDate) return bDate.localeCompare(aDate);

  return a.name.localeCompare(b.name);
}

async function renderStrengthSection(container) {
  if (!state.performedExercisesCache) {
    state.performedExercisesCache = await api('/api/exercises/performed');
  }
  const exercises = state.performedExercisesCache;

  container.innerHTML = `
    <div class="exercise-picker-card">
      <div class="exercise-favorites-row hidden"></div>
      <input type="text" class="exercise-search-input" placeholder="Search exercise..."
             value="${state.progressExerciseName}" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="exercise-search-results hidden"></div>
    </div>
    <div class="strength-chart-area"></div>
  `;

  const favoritesRow = container.querySelector('.exercise-favorites-row');
  const searchInput = container.querySelector('.exercise-search-input');
  const searchResults = container.querySelector('.exercise-search-results');
  const chartArea = container.querySelector('.strength-chart-area');

  attachFirstTapCursorEnd(searchInput);

  const renderFavorites = () => {
    const favoriteIds = new Set(getStrengthFavoriteIds());
    const favorites = exercises
      .filter((e) => favoriteIds.has(e.id))
      .sort((a, b) => {
        const aDate = a.last_date || '';
        const bDate = b.last_date || '';
        if (aDate !== bDate) return bDate.localeCompare(aDate);
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);

    if (favorites.length === 0) {
      favoritesRow.classList.add('hidden');
      favoritesRow.innerHTML = '';
      return;
    }

    favoritesRow.innerHTML = favorites.map((e) => `
      <button type="button" class="favorite-chip" data-id="${e.id}" data-name="${e.name}">
        <span class="favorite-chip-star">&#9733;</span>
        <span class="favorite-chip-name">${e.name}</span>
      </button>
    `).join('');
    favoritesRow.classList.remove('hidden');
  };

  const renderResults = () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) {
      searchResults.classList.add('hidden');
      searchResults.innerHTML = '';
      return;
    }

    const favoriteIds = new Set(getStrengthFavoriteIds());
    const matches = exercises
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => compareExerciseSearchResults(a, b, q))
      .slice(0, 12);

    if (matches.length === 0) {
      searchResults.classList.add('hidden');
      searchResults.innerHTML = '';
      return;
    }

    searchResults.innerHTML = matches.map((e) =>
      `<div class="exercise-result-item" data-id="${e.id}" data-name="${e.name}">
        <span class="result-name">${e.name}</span>
        ${e.last_date ? `<span class="result-last-date">${formatDateShort(e.last_date)}</span>` : ''}
        <button type="button" class="result-favorite-btn${favoriteIds.has(e.id) ? ' active' : ''}" data-id="${e.id}" aria-label="Toggle favorite">&#9733;</button>
      </div>`
    ).join('');
    searchResults.classList.remove('hidden');
  };

  const selectExercise = async (id, name) => {
    state.progressExerciseId = parseInt(id, 10);
    state.progressExerciseName = name;
    searchInput.value = name;
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    await renderStrengthChart(chartArea);
  };

  renderFavorites();

  searchInput.addEventListener('input', () => {
    renderResults();
  });

  searchResults.addEventListener('click', async (e) => {
    const favoriteBtn = e.target.closest('.result-favorite-btn');
    if (favoriteBtn) {
      e.stopPropagation();
      toggleStrengthFavorite(parseInt(favoriteBtn.dataset.id, 10));
      renderFavorites();
      renderResults();
      return;
    }

    const item = e.target.closest('.exercise-result-item');
    if (!item) return;
    await selectExercise(item.dataset.id, item.dataset.name);
  });

  favoritesRow.addEventListener('click', async (e) => {
    const chip = e.target.closest('.favorite-chip');
    if (!chip) return;
    await selectExercise(chip.dataset.id, chip.dataset.name);
  });

  document.addEventListener('click', function onOutside(ev) {
    if (!container.contains(ev.target)) {
      searchResults.classList.add('hidden');
      document.removeEventListener('click', onOutside);
    }
  });

  if (state.progressExerciseId) {
    await renderStrengthChart(chartArea);
  } else if (exercises.length > 0) {
    chartArea.innerHTML = '<div class="chart-empty">Search for an exercise above to see its trend</div>';
  }
}

async function renderStrengthChart(container) {
  if (!state.progressExerciseId) return;
  container.innerHTML = '<div class="progress-loading">Loading...</div>';

  if (!state.exerciseTrendCache[state.progressExerciseId]) {
    state.exerciseTrendCache[state.progressExerciseId] = await api(`/api/trends/exercise/${state.progressExerciseId}`);
  }
  const trend = state.exerciseTrendCache[state.progressExerciseId];
  const filtered = filterByRange(trend, state.progressTimeRange);

  if (filtered.length < 2) {
    container.innerHTML = `<div class="chart-empty">Not enough data${state.progressTimeRange !== 'all' ? ' in this range - try a wider range' : ''}</div>`;
    return;
  }

  const volChart = buildLineChart(
    filtered.map((d) => ({ date: d.date, value: d.total_volume })),
    { formatY: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))) }
  );
  const compChart = buildLineChart(
    filtered.map((d) => ({ date: d.date, value: d.completion_pct })),
    { formatY: (v) => `${Math.round(v)}%`, lineClass: 'chart-line-secondary' }
  );

  container.innerHTML = `
    <div class="progress-chart-card">
      <div class="progress-chart-title">Volume <span class="chart-title-unit">(kg x reps)</span></div>
      ${volChart}
      <div class="chart-subtitle">Total weight moved per session - the primary signal of long-term progress</div>
    </div>
    <div class="progress-chart-card">
      <div class="progress-chart-title">Set completion</div>
      ${compChart}
      <div class="chart-subtitle">How much of the prescribed work was completed - dips when weight increases are normal</div>
    </div>
  `;
  wireExpandableCharts(container);
}

async function renderWorkoutsSection(container) {
  if (!state.workoutDatesCache) {
    state.workoutDatesCache = await api('/api/trends/frequency');
  }
  const backupStatus = await getBackupStatus();
  const filtered = filterByRange(state.workoutDatesCache, state.progressTimeRange);
  const total = filtered.length;
  const bounds = getRangeBounds(state.progressTimeRange, filtered);

  const weeks = groupByWeek(filtered);
  const weeksTrained = weeks.length;
  const avgPerWeek = bounds ? (total / countWeeksInRange(bounds.start, bounds.end)).toFixed(1) : '-';

  const barData = weeks.slice(-52).map(({ weekStart, items }) => ({
    label: formatDateShort(weekStart),
    value: items.length,
    weekStart,
  }));
  const backupLabel = backupStatus.has_backup
    ? `${backupStatus.current_week_exists ? 'Current week backed up' : 'Latest backup'}${backupStatus.latest_file ? `: ${backupStatus.latest_file}` : ''}`
    : 'No weekly backup found yet';
  const backupMeta = backupStatus.latest_created_at
    ? `Updated ${new Date(backupStatus.latest_created_at).toLocaleString()}`
    : 'A weekly backup is created automatically when the server runs';

  container.innerHTML = `
    <div class="progress-stats-row">
      <div class="progress-stat-card">
        <div class="progress-stat-value">${total}</div>
        <div class="progress-stat-label">Sessions</div>
      </div>
      <div class="progress-stat-card">
        <div class="progress-stat-value">${weeksTrained}</div>
        <div class="progress-stat-label">Weeks trained</div>
      </div>
      <div class="progress-stat-card">
        <div class="progress-stat-value">${avgPerWeek}</div>
        <div class="progress-stat-label">Avg / week</div>
      </div>
    </div>
    <div class="progress-chart-card js-freq-chart">
      <div class="progress-chart-title">Sessions per week</div>
      ${buildBarChart(barData, { interactive: true })}
    </div>
    <div class="week-detail-panel hidden"></div>
    <div class="progress-chart-card progress-info-card">
      <div class="progress-chart-title">Backup status</div>
      <div class="progress-info-value">${backupLabel}</div>
      <div class="progress-helper-text">${backupMeta}</div>
    </div>
  `;

  const freqSvg = container.querySelector('.js-freq-chart .progress-chart-svg');
  const detailPanel = container.querySelector('.week-detail-panel');
  if (freqSvg && barData.length > 0) {
    freqSvg.addEventListener('click', async (e) => {
      const hit = e.target.closest('.chart-hit-target');
      if (!hit) return;
      e.stopPropagation();

      const wi = parseInt(hit.dataset.wi, 10);

      if (detailPanel.dataset.wi === String(wi) && !detailPanel.classList.contains('hidden')) {
        detailPanel.classList.add('hidden');
        detailPanel.dataset.wi = '';
        freqSvg.querySelectorAll('.chart-bar').forEach((r) => r.classList.remove('chart-bar-selected'));
        return;
      }

      freqSvg.querySelectorAll('.chart-bar').forEach((r, i) =>
        r.classList.toggle('chart-bar-selected', i === wi));
      detailPanel.dataset.wi = String(wi);

      const { weekStart } = barData[wi];
      const weekEnd = shiftDate(weekStart, 6);
      detailPanel.innerHTML = '<div class="progress-loading">Loading...</div>';
      detailPanel.classList.remove('hidden');

      const sessions = await api(`/api/workouts/range?from=${weekStart}&to=${weekEnd}`);
      renderWeekDetail(detailPanel, weekStart, sessions);
    });
  }

  wireExpandableCharts(container);
}

function renderWeekDetail(container, weekStart, sessions) {
  if (sessions.length === 0) {
    container.innerHTML = '<div class="week-detail-empty">No sessions recorded this week</div>';
    return;
  }

  const byDate = new Map();
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s.template_name);
  }

  let html = `<div class="week-detail-header">Week of ${formatDate(weekStart)}</div>`;
  for (const [date, templates] of byDate) {
    html += `
      <div class="week-detail-row">
        <span class="week-detail-date">${formatDate(date)}</span>
        <span class="week-detail-templates">${templates.join(' + ')}</span>
      </div>`;
  }
  container.innerHTML = html;
}
