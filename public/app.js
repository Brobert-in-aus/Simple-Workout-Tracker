// --- State ---
let currentDate = todayStr();
let currentWeekStart = getMonday(todayStr());
let currentWorkoutBlocks = []; // array of {workout, previous} per template
let saveTimers = {};
let scheduleCache = null;
let templatesCache = null;

// --- Helpers ---
function todayStr() {
  const d = new Date();
  return toISO(d);
}

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function formatDateShort(iso) {
  const d = new Date(iso + 'T00:00:00');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function getMonday(iso) {
  const d = new Date(iso + 'T00:00:00');
  const jsDay = d.getDay(); // 0=Sun
  const diff = jsDay === 0 ? -6 : 1 - jsDay;
  d.setDate(d.getDate() + diff);
  return toISO(d);
}

// Group an array of items by ISO week (Monday-keyed).
// getDateFn: item → ISO date string (defaults to item.date or item itself if string).
// Returns [{weekStart, items}] sorted oldest-week-first.
function groupByWeek(items, getDateFn) {
  const fn = getDateFn || (x => typeof x === 'string' ? x : x.date);
  const map = new Map();
  for (const item of items) {
    const wk = getMonday(fn(item));
    if (!map.has(wk)) map.set(wk, []);
    map.get(wk).push(item);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, items]) => ({ weekStart, items }));
}

function getDayName(idx) {
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][idx];
}

function getDayNameShort(idx) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][idx];
}

let toastTimer = null;

function showToast(message) {
  if (!message) return;
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast hidden';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 2800);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json()
    : await res.text();

  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && payload.error
        ? payload.error
        : typeof payload === 'string' && payload.trim()
          ? payload.trim()
          : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return payload;
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason && reason.message ? reason.message : 'Something went wrong';
  showToast(message);
});

function formatDuration(seconds) {
  if (seconds == null) return '?';
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

async function getSchedule() {
  if (!scheduleCache) scheduleCache = await api('/api/schedule');
  return scheduleCache;
}

function invalidateScheduleCache() {
  scheduleCache = null;
}

async function getTemplates() {
  if (!templatesCache) templatesCache = await api('/api/templates');
  return templatesCache;
}

function invalidateTemplatesCache() {
  templatesCache = null;
}

function isWarmupExercise(ex, prev) {
  // Check template is_warmup flag first, then fall back to note-based detection
  if (ex.is_warmup) return true;
  const prevNote = prev && prev.note ? prev.note : '';
  if (prevNote && /^warmup$/i.test(prevNote.trim())) return true;
  if (ex.note && /^warmup$/i.test(ex.note.trim())) return true;
  return false;
}

// --- Tab Navigation ---
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

    if (btn.dataset.tab === 'template') loadTemplate();
    if (btn.dataset.tab === 'body') loadBodyTab();
  });
});

// --- Double-tap Workout button to scroll to first uncompleted exercise ---
{
  const workoutBtn = document.querySelector('.nav-btn[data-tab="workout"]');
  let lastTap = 0;
  let lastTouchEnd = 0; // used to suppress the click that always follows touchend on mobile

  function doDoubleTapScroll() {
    const cards = document.querySelectorAll('#exercises-list .exercise-card:not(.skipped):not(.preview-card)');
    let target = null;
    for (const card of cards) {
      const checks = card.querySelectorAll('.set-check');
      if (checks.length === 0) continue;
      if (!Array.from(checks).every(c => c.classList.contains('done'))) { target = card; break; }
    }
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // All active exercises done — scroll to next unstarted workout on same day, or to bottom
    const beginDiv = document.querySelector('#exercises-list .begin-workout');
    if (beginDiv) {
      beginDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

  // touchend fires immediately with no tap delay — primary handler for iOS Safari.
  // click can be delayed 300ms or swallowed entirely by double-tap-to-zoom detection.
  workoutBtn.addEventListener('touchend', () => {
    const now = Date.now();
    lastTouchEnd = now;
    if (now - lastTap < 500) doDoubleTapScroll();
    lastTap = now;
  }, { passive: true });

  // click handles desktop / pointer devices (mouse, Apple Pencil).
  // Skipped on mobile because touchend already ran and set lastTouchEnd within the past 600ms.
  workoutBtn.addEventListener('click', () => {
    if (Date.now() - lastTouchEnd < 600) return;
    const now = Date.now();
    if (now - lastTap < 500) doDoubleTapScroll();
    lastTap = now;
  });
}

// --- Week Navigation ---
document.getElementById('week-prev').addEventListener('click', () => {
  currentWeekStart = shiftDate(currentWeekStart, -7);
  currentDate = currentWeekStart;
  loadWeek();
});
document.getElementById('week-next').addEventListener('click', () => {
  currentWeekStart = shiftDate(currentWeekStart, 7);
  currentDate = currentWeekStart;
  loadWeek();
});
document.getElementById('week-today').addEventListener('click', () => {
  currentDate = todayStr();
  currentWeekStart = getMonday(currentDate);
  loadWeek();
});

// --- Week Strip ---
async function loadWeek() {
  const schedule = await getSchedule();
  // Build day_index → template names map (for today & future days)
  const dayTemplates = {};
  for (const s of schedule) {
    if (!dayTemplates[s.day_index]) dayTemplates[s.day_index] = [];
    dayTemplates[s.day_index].push(s.template_name);
  }

  const weekEnd = shiftDate(currentWeekStart, 6);
  document.getElementById('week-display').textContent =
    `${formatDateShort(currentWeekStart)} — ${formatDateShort(weekEnd)}`;

  // Fetch actual workout data for this week (date + template_name per workout)
  const rangeData = await api(`/api/workouts/range?from=${currentWeekStart}&to=${weekEnd}`);
  // Build date → [template_name, ...] map from actual workouts
  const actualWorkouts = {};
  const startedSet = new Set();
  for (const w of rangeData) {
    startedSet.add(w.date);
    if (!actualWorkouts[w.date]) actualWorkouts[w.date] = [];
    actualWorkouts[w.date].push(w.template_name);
  }

  const strip = document.getElementById('week-strip');
  strip.innerHTML = '';
  const today = todayStr();

  for (let i = 0; i < 7; i++) {
    const dateStr = shiftDate(currentWeekStart, i);
    const isPast = dateStr < today;
    const hasStarted = startedSet.has(dateStr);

    // Past days: show what actually happened (or Rest if nothing started)
    // Today & future: show what's scheduled
    let names;
    if (isPast) {
      names = actualWorkouts[dateStr] || [];
    } else {
      names = dayTemplates[i] || [];
    }

    const el = document.createElement('div');
    el.className = 'week-day';
    if (dateStr === currentDate) el.classList.add('selected');
    if (dateStr === today) el.classList.add('today');
    if (hasStarted) el.classList.add('has-workout');
    el.dataset.date = dateStr;

    const dateObj = new Date(dateStr + 'T00:00:00');
    const workoutLabel = names.length > 0 ? names.join(', ') : '';

    el.innerHTML = `
      <div class="week-day-name">${getDayNameShort(i)}</div>
      <div class="week-day-date">${dateObj.getDate()}</div>
      <div class="week-day-workout ${workoutLabel ? '' : 'rest'}">${workoutLabel || 'Rest'}${hasStarted ? ' <span class="week-day-done">&#x2713;</span>' : ''}</div>
    `;

    el.addEventListener('click', () => {
      currentDate = dateStr;
      strip.querySelectorAll('.week-day').forEach(d => d.classList.remove('selected'));
      el.classList.add('selected');
      loadWorkout();
    });

    strip.appendChild(el);
  }

  const selected = strip.querySelector('.selected');
  if (selected) selected.scrollIntoView({ inline: 'center', block: 'nearest' });

  loadWorkout();
}

// --- Workout Tab ---
async function loadWorkout() {
  const data = await api(`/api/workout/${currentDate}`);
  currentWorkoutBlocks = data; // array of {workout, previous}

  const container = document.getElementById('exercises-list');
  container.innerHTML = '';

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">Rest day</div>';
    return;
  }

  const isFuture = currentDate > todayStr();

  for (const block of data) {
    const workout = block.workout;
    const previous = block.previous;
    const isPreview = !!workout.preview;
    const templateName = workout.template_name || workout.day_name || '';

    // Template section header (always show when multiple blocks, or when named)
    if (data.length > 1 || templateName) {
      const header = document.createElement('div');
      header.className = 'workout-section-header';
      header.innerHTML = `<span>${templateName}</span>`;
      if (!isPreview && workout.id) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-sm btn-danger workout-delete-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
          if (confirm(`Delete this ${templateName} workout? This cannot be undone.`)) {
            await api(`/api/workout/${workout.id}`, { method: 'DELETE' });
            invalidateProgressCaches();
            loadWorkout();
          }
        });
        header.appendChild(deleteBtn);
      }
      container.appendChild(header);
    }

    if (workout.exercises.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No exercises in this template';
      container.appendChild(empty);
      continue;
    }

    if (isPreview && isFuture) {
      // Future: read-only preview
      const banner = document.createElement('div');
      banner.className = 'preview-banner';
      banner.textContent = 'Upcoming workout preview';
      container.appendChild(banner);
      renderExercisesPreview(container, workout.exercises, previous);
    } else if (isPreview) {
      // Today or past: Begin Workout button
      const beginDiv = document.createElement('div');
      beginDiv.className = 'begin-workout';
      beginDiv.innerHTML = `<button class="begin-workout-btn">Begin Workout</button>`;
      beginDiv.querySelector('.begin-workout-btn').addEventListener('click', () => {
        beginWorkout(workout.day_id || workout.template_id);
      });
      container.appendChild(beginDiv);
      const previewLabel = document.createElement('div');
      previewLabel.className = 'preview-banner';
      previewLabel.textContent = 'Exercises';
      container.appendChild(previewLabel);
      renderExercisesPreview(container, workout.exercises, previous);
    } else {
      // Active workout
      renderExercises(container, workout, previous);
      // Add-exercise button
      const addExDiv = document.createElement('div');
      addExDiv.className = 'add-exercise-to-workout';
      addExDiv.innerHTML = `<button class="btn btn-sm btn-outline add-ex-to-workout-btn">+ Add Exercise</button>`;
      addExDiv.querySelector('.add-ex-to-workout-btn').addEventListener('click', () => {
        showAddExerciseToWorkoutPanel(addExDiv, workout);
      });
      container.appendChild(addExDiv);
    }
  }
}

async function beginWorkout(templateId) {
  const data = await api(`/api/workout/${currentDate}/begin`, {
    method: 'POST',
    body: { template_id: templateId }
  });
  // Reload the full page
  invalidateProgressCaches();
  loadWorkout();
}

function renderExercisesPreview(container, exercises, previous) {
  const groups = groupExercises(exercises);

  for (const group of groups) {
    const isSuperset = group.length > 1;
    group.forEach((ex, idx) => {
      const card = document.createElement('div');
      card.className = 'exercise-card preview-card';
      if (isSuperset) {
        if (idx === 0) card.classList.add('superset-start');
        else if (idx === group.length - 1) card.classList.add('superset-end');
        else card.classList.add('superset-mid');
      }

      let html = '';
      if (isSuperset && idx === 0) {
        const groupLabel = group.length >= 3 ? 'Giant Set' : 'Superset';
        html += `<div class="superset-label">${groupLabel}</div>`;
      }

      const isDuration = !!ex.is_duration;
      const prev = findPreviousExercise(ex.day_exercise_id, previous, ex.exercise_id);
      const prevStr = buildPrevString(prev, isDuration);
      const prevNote = prev && prev.note ? prev.note : '';
      const prevFrom = prev && prev.from_template ? ` (from ${prev.from_template})` : '';
      const showWarmup = isWarmupExercise(ex, prev);

      html += `
        <div class="exercise-header">
          <span class="exercise-name">${ex.exercise_name}${showWarmup ? '<span class="warmup-badge">Warmup</span>' : ''}${isDuration ? '<span class="duration-badge">Duration</span>' : ''}${ex.is_amrap ? `<span class="amrap-badge">${ex.amrap_last_only ? 'AMRAP Last' : 'AMRAP'}</span>` : ''}</span>
          <span class="exercise-target">${isDuration ? `${ex.target_sets} sets` : `${ex.target_sets}&times;${ex.target_reps}`}</span>
        </div>
      `;
      if (prevStr) html += `<div class="previous-data">${prevStr}${prevFrom}</div>`;
      if (ex.notes && !showWarmup) html += `<div class="template-note">${ex.notes.replace(/</g, '&lt;')}</div>`;
      if (prevNote && !showWarmup) html += `<div class="previous-data prev-note">${prevNote}</div>`;

      card.innerHTML = html;
      container.appendChild(card);
    });
  }
}

function findPreviousExercise(dayExerciseId, previous, exerciseId) {
  if (!previous) return null;
  // First try exact day_exercise_id match
  const exact = previous.find(e => e.day_exercise_id === dayExerciseId);
  if (exact) return exact;
  // Fallback: match by exercise_id (cross-template linking)
  if (exerciseId) {
    return previous.find(e => e.exercise_id === exerciseId);
  }
  return null;
}

function buildPrevString(prev, isDuration) {
  if (!prev || !prev.sets || prev.sets.length === 0) return '';
  if (isDuration) {
    return 'Prev: ' + prev.sets.map(s => formatDuration(s.duration_seconds)).join(', ');
  }
  return 'Prev: ' + prev.sets.map(s => {
    if (s.weight == null) return 'bw';
    if (s.reps != null && s.target_reps != null && s.reps !== s.target_reps)
      return `${s.weight}x${s.reps}`;
    return s.weight;
  }).join(', ');
}

function groupExercises(exercises) {
  const groups = [];
  let i = 0;
  while (i < exercises.length) {
    const ex = exercises[i];
    if (ex.superset_group != null) {
      const group = [ex];
      let j = i + 1;
      while (j < exercises.length && exercises[j].superset_group === ex.superset_group) {
        group.push(exercises[j]);
        j++;
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([ex]);
      i++;
    }
  }
  return groups;
}

function renderExercises(container, workout, previous) {
  const groups = groupExercises(workout.exercises);

  for (const group of groups) {
    const isSuperset = group.length > 1;
    group.forEach((ex, idx) => {
      const card = createExerciseCard(ex, workout, previous, isSuperset, idx, group.length);
      container.appendChild(card);
    });
  }
}

function createExerciseCard(ex, workout, previous, isSuperset, supersetIdx, supersetLen) {
  const card = document.createElement('div');
  card.className = 'exercise-card';
  if (ex.skipped) card.classList.add('skipped');

  if (isSuperset) {
    if (supersetIdx === 0) card.classList.add('superset-start');
    else if (supersetIdx === supersetLen - 1) card.classList.add('superset-end');
    else card.classList.add('superset-mid');
  }

  const isDuration = !!ex.is_duration;
  const prev = findPreviousExercise(ex.day_exercise_id, previous, ex.exercise_id);
  const prevStr = buildPrevString(prev, isDuration);
  const prevNote = prev && prev.note ? prev.note : '';
  const prevFrom = prev && prev.from_template ? ` (from ${prev.from_template})` : '';
  const showWarmup = isWarmupExercise(ex, prev);
  const isSwapped = !!ex.override_exercise_name;
  const displayName = isSwapped ? ex.override_exercise_name : ex.exercise_name;

  let html = '';

  if (isSuperset && supersetIdx === 0) {
    const groupLabel = supersetLen >= 3 ? 'Giant Set' : 'Superset';
    html += `<div class="superset-label">${groupLabel}</div>`;
  }

  html += `
    <div class="exercise-header">
      <span class="exercise-name">${displayName}${isSwapped ? `<span class="swap-badge" title="Swapped from ${ex.exercise_name}">&#x21C4;</span>` : ''}${showWarmup ? '<span class="warmup-badge">Warmup</span>' : ''}${isDuration ? '<span class="duration-badge">Duration</span>' : ''}${ex.is_amrap ? `<span class="amrap-badge">${ex.amrap_last_only ? 'AMRAP Last' : 'AMRAP'}</span>` : ''}</span>
      <span class="exercise-target">${isDuration ? `${ex.target_sets} sets` : `${ex.target_sets}&times;${ex.target_reps}`}</span>
      <div class="reorder-btns">
        <button class="reorder-btn move-up" data-weid="${ex.id}">&uarr;</button>
        <button class="reorder-btn move-down" data-weid="${ex.id}">&darr;</button>
      </div>
    </div>
    <div class="exercise-sub-header">
      <button class="skip-toggle ${ex.skipped ? 'is-skipped' : ''}" data-weid="${ex.id}">
        ${ex.skipped ? '&#x21A9; Unskip' : '&#x2715; Skip'}
      </button>
      <button class="swap-toggle${isSwapped ? ' is-swapped' : ''}" data-weid="${ex.id}">
        ${isSwapped ? '&#x21A9; Restore' : '&#x21C4; Alt'}
      </button>
    </div>
  `;

  if (prevStr) html += `<div class="previous-data">${prevStr}${prevFrom}</div>`;
  if (ex.default_note && !showWarmup) html += `<div class="template-note">${ex.default_note.replace(/</g, '&lt;')}</div>`;
  if (prevNote && !showWarmup) html += `<div class="previous-data prev-note">${prevNote}</div>`;

  if (!ex.skipped) {
    const targetRepsNum = parseInt(ex.target_reps) || 0;
    html += '<div class="sets-container">';
    for (const set of ex.sets) {
      const isDone = !!set.completed;
      if (isDuration) {
        const durationVal = set.duration_seconds != null ? set.duration_seconds : '';
        html += `
          <div class="set-row${isDone ? ' set-done' : ''}" data-duration="1">
            <button class="set-check${isDone ? ' done' : ''}" data-weid="${ex.id}" data-set="${set.set_number}">
              ${isDone ? '&#x2713;' : ''}
            </button>
            <span class="set-label">${set.set_number}</span>
            <input type="number" class="set-input duration-input"
                   value="${durationVal}" placeholder="sec" inputmode="numeric"
                   data-weid="${ex.id}" data-set="${set.set_number}" data-field="duration">
            <span class="set-unit">sec</span>
          </div>
        `;
      } else {
        const weightVal = set.weight != null ? set.weight : '';
        const repsVal = set.reps != null ? set.reps : (targetRepsNum || '');
        const setAmrap = !!set.is_amrap;
        const isPartial = !setAmrap && set.reps != null && set.target_reps != null && set.reps < set.target_reps;
        html += `
          <div class="set-row${isDone ? ' set-done' : ''}">
            <button class="set-check${isDone ? ' done' : ''}" data-weid="${ex.id}" data-set="${set.set_number}">
              ${isDone ? '&#x2713;' : ''}
            </button>
            <span class="set-label">${set.set_number}</span>
            <input type="number" class="set-input weight-input${isPartial ? ' partial' : ''}"
                   value="${weightVal}" placeholder="kg" step="0.5" inputmode="decimal"
                   data-weid="${ex.id}" data-set="${set.set_number}" data-field="weight">
            <span class="set-unit">kg</span>
            <span class="set-separator">&times;</span>
            <input type="number" class="set-input reps-input${isPartial ? ' partial' : ''}"
                   value="${repsVal}" placeholder="reps" inputmode="numeric"
                   data-weid="${ex.id}" data-set="${set.set_number}" data-field="reps">
            <button class="amrap-toggle${setAmrap ? ' active' : ''}" data-weid="${ex.id}" data-set="${set.set_number}">F</button>
          </div>
        `;
      }
    }
    html += '</div>';
    const showCopyWeight = !isDuration && ex.sets.length > 1;
    html += `
      <div class="set-actions">
        <button class="btn btn-sm btn-outline mark-all-done-btn" data-weid="${ex.id}">Done All</button>
        <button class="btn btn-sm btn-outline add-set-btn" data-weid="${ex.id}" data-target-reps="${targetRepsNum}">+ Set</button>
        ${ex.sets.length > 1 ? `<button class="btn btn-sm btn-outline remove-set-btn" data-weid="${ex.id}">&minus; Set</button>` : ''}
        ${showCopyWeight ? `<button class="btn btn-sm btn-outline copy-weight-btn" data-weid="${ex.id}" title="Copy first set weight to all sets">Weight &darr;</button>` : ''}
      </div>
    `;
  }

  // Note with previous note as placeholder (hide "warmup" notes since shown as badge)
  const notePlaceholder = prevNote && !showWarmup ? prevNote : 'Note...';
  const noteValue = (ex.note && /^warmup$/i.test(ex.note.trim())) ? '' : (ex.note || '');
  html += `
    <div class="exercise-note">
      <textarea rows="1" placeholder="${notePlaceholder.replace(/"/g, '&quot;')}" data-weid="${ex.id}" data-field="note">${noteValue}</textarea>
    </div>
  `;

  card.innerHTML = html;

  // Event listeners
  card.querySelector('.skip-toggle').addEventListener('click', () => toggleSkip(ex, workout));
  card.querySelector('.swap-toggle').addEventListener('click', () => handleSwap(ex, workout, card));

  // Track previous weight values for auto-match bulk update
  card.querySelectorAll('.weight-input').forEach(input => {
    attachFirstTapCursorEnd(input);
    input.addEventListener('focus', () => {
      input.dataset.prevWeight = input.value;
      moveCursorToEnd(input);
    });
    input.addEventListener('change', () => {
      autoMatchWeights(input, card);
      debounceSave(ex);
    });
    input.addEventListener('input', () => debounceSave(ex));
  });

  card.querySelectorAll('.set-input:not(.weight-input)').forEach(input => {
    attachFirstTapCursorEnd(input);
    input.addEventListener('focus', () => moveCursorToEnd(input));
    input.addEventListener('change', () => debounceSave(ex));
    input.addEventListener('input', () => debounceSave(ex));
  });

  card.querySelectorAll('.set-check').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.set-row');
      const isDone = btn.classList.contains('done');
      if (isDone) {
        btn.classList.remove('done');
        btn.innerHTML = '';
        row.classList.remove('set-done');
      } else {
        btn.classList.add('done');
        btn.innerHTML = '&#x2713;';
        row.classList.add('set-done');
      }
      debounceSave(ex);
    });
  });

  card.querySelectorAll('.amrap-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      debounceSave(ex);
    });
  });

  const noteArea = card.querySelector('textarea[data-field="note"]');
  noteArea.addEventListener('input', () => debounceSave(ex));

  const moveUp = card.querySelector('.move-up');
  const moveDown = card.querySelector('.move-down');
  moveUp.addEventListener('click', () => moveExercise(ex, workout, -1));
  moveDown.addEventListener('click', () => moveExercise(ex, workout, 1));

  const addSetBtn = card.querySelector('.add-set-btn');
  if (addSetBtn) addSetBtn.addEventListener('click', () => addSet(ex, card));
  const removeSetBtn = card.querySelector('.remove-set-btn');
  if (removeSetBtn) removeSetBtn.addEventListener('click', () => removeSet(ex, card));
  const markAllDoneBtn = card.querySelector('.mark-all-done-btn');
  if (markAllDoneBtn) markAllDoneBtn.addEventListener('click', () => markAllSetsDone(card, ex));
  const copyWeightBtn = card.querySelector('.copy-weight-btn');
  if (copyWeightBtn) copyWeightBtn.addEventListener('click', () => copyWeightToAll(card, ex));

  return card;
}

async function toggleSkip(ex, workout) {
  ex.skipped = ex.skipped ? 0 : 1;
  await api(`/api/workout/${currentDate}/exercise/${ex.id}`, {
    method: 'POST',
    body: { skipped: !!ex.skipped },
  });
  invalidateProgressCaches();
  loadWorkout();
}

async function handleSwap(ex, workout, card) {
  if (ex.override_exercise_name) {
    // Restore original exercise
    await api(`/api/workout/${currentDate}/exercise/${ex.id}/swap`, {
      method: 'PUT',
      body: { exercise_name: null },
    });
    invalidateProgressCaches();
    loadWorkout();
    return;
  }

  // Show inline swap panel
  const subHeader = card.querySelector('.exercise-sub-header');
  if (subHeader.querySelector('.swap-panel')) return;

  const allExercises = await api('/api/exercises');
  const listId = `swap-list-${ex.id}`;
  const panel = document.createElement('div');
  panel.className = 'swap-panel';
  panel.innerHTML = `
    <input type="text" class="swap-input" placeholder="Alternative exercise name" autocomplete="off" list="${listId}">
    <datalist id="${listId}">${allExercises.map(e => `<option value="${e.name}">`).join('')}</datalist>
    <button class="btn btn-sm swap-confirm">OK</button>
    <button class="btn btn-sm swap-cancel">Cancel</button>
  `;
  subHeader.appendChild(panel);

  const input = panel.querySelector('.swap-input');
  input.focus();

  panel.querySelector('.swap-cancel').addEventListener('click', () => panel.remove());
  panel.querySelector('.swap-confirm').addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) { panel.remove(); return; }
    await api(`/api/workout/${currentDate}/exercise/${ex.id}/swap`, {
      method: 'PUT',
      body: { exercise_name: name },
    });
    invalidateProgressCaches();
    loadWorkout();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('.swap-confirm').click();
    if (e.key === 'Escape') panel.remove();
  });
}

async function showAddExerciseToWorkoutPanel(container, workout) {
  if (container.querySelector('.add-ex-panel')) return;

  const allExercises = await api('/api/exercises');
  const exercises = workout.exercises;
  const listId = `add-ex-list-${workout.id}`;

  // Build "after" options: None (add at top) + each exercise
  const afterOptions = [`<option value="-1">At the top</option>`]
    .concat(exercises.map((ex, i) => {
      const label = ex.override_exercise_name || ex.exercise_name;
      return `<option value="${ex.sort_order}" ${i === exercises.length - 1 ? 'selected' : ''}>${label}</option>`;
    })).join('');

  const panel = document.createElement('div');
  panel.className = 'add-ex-panel';
  panel.innerHTML = `
    <input type="text" class="add-ex-name" placeholder="Exercise name" autocomplete="off" list="${listId}">
    <datalist id="${listId}">${allExercises.map(e => `<option value="${e.name}">`).join('')}</datalist>
    <div class="add-ex-row">
      <input type="number" class="add-ex-sets" value="3" placeholder="Sets" inputmode="numeric" min="1">
      <span>&times;</span>
      <input type="text" class="add-ex-reps" value="10" placeholder="Reps">
    </div>
    <label class="add-ex-after-label">After:
      <select class="add-ex-after">${afterOptions}</select>
    </label>
    <label class="add-ex-template-label">
      <input type="checkbox" class="add-ex-template"> Save to template
    </label>
    <div class="add-ex-actions">
      <button class="btn btn-sm add-ex-confirm">Add</button>
      <button class="btn btn-sm add-ex-cancel">Cancel</button>
    </div>
  `;
  container.appendChild(panel);

  const nameInput = panel.querySelector('.add-ex-name');
  nameInput.focus();

  panel.querySelector('.add-ex-cancel').addEventListener('click', () => panel.remove());
  panel.querySelector('.add-ex-confirm').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const targetSets = parseInt(panel.querySelector('.add-ex-sets').value) || 3;
    const targetReps = panel.querySelector('.add-ex-reps').value.trim() || '10';
    const afterSortOrder = parseInt(panel.querySelector('.add-ex-after').value);
    const saveToTemplate = panel.querySelector('.add-ex-template').checked;

    await api(`/api/workout/${currentDate}/add-exercise`, {
      method: 'POST',
      body: {
        workout_id: workout.id,
        name,
        target_sets: targetSets,
        target_reps: targetReps,
        after_sort_order: afterSortOrder >= 0 ? afterSortOrder : null,
        save_to_template: saveToTemplate,
      },
    });
    invalidateProgressCaches();
    loadWorkout();
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.remove();
  });
}

function debounceSave(ex) {
  if (saveTimers[ex.id]) clearTimeout(saveTimers[ex.id]);
  saveTimers[ex.id] = setTimeout(() => saveExercise(ex), 500);
}

async function saveExercise(ex) {
  const card = document.querySelector(`.skip-toggle[data-weid="${ex.id}"]`).closest('.exercise-card');
  const sets = [];
  const targetRepsNum = parseInt(ex.target_reps) || null;

  card.querySelectorAll('.set-row').forEach(row => {
    const checkBtn = row.querySelector('.set-check');
    const completed = checkBtn && checkBtn.classList.contains('done') ? 1 : 0;
    const durationInput = row.querySelector('.duration-input');

    if (durationInput) {
      const duration = durationInput.value !== '' ? parseInt(durationInput.value) : null;
      sets.push({ weight: null, reps: null, target_reps: null, duration_seconds: duration, completed });
    } else {
      const weightInput = row.querySelector('.weight-input');
      const repsInput = row.querySelector('.reps-input');
      if (!weightInput) return;
      const weight = weightInput.value !== '' ? parseFloat(weightInput.value) : null;
      const reps = repsInput.value !== '' ? parseInt(repsInput.value) : null;
      const amrapBtn = row.querySelector('.amrap-toggle');
      const isAmrap = amrapBtn ? amrapBtn.classList.contains('active') : false;

      if (!isAmrap && reps != null && targetRepsNum != null && reps < targetRepsNum) {
        weightInput.classList.add('partial');
        repsInput.classList.add('partial');
      } else {
        weightInput.classList.remove('partial');
        repsInput.classList.remove('partial');
      }

      sets.push({ weight, reps, target_reps: isAmrap ? null : targetRepsNum, completed, is_amrap: isAmrap ? 1 : 0 });
    }
  });

  const noteArea = card.querySelector('textarea[data-field="note"]');
  const note = noteArea ? noteArea.value : null;

  await api(`/api/workout/${currentDate}/exercise/${ex.id}`, {
    method: 'POST',
    body: { sets, note },
  });
  invalidateProgressCaches();
}

function moveCursorToEnd(input) {
  const t = input.type;
  input.type = 'text';
  input.setSelectionRange(input.value.length, input.value.length);
  input.type = t;
}

// On mobile Safari, the focus handler fires too late — the browser places the caret where
// the user tapped AFTER focus. Intercepting pointerdown on the first tap (before focus)
// lets us block native caret placement and position it ourselves.
function attachFirstTapCursorEnd(input) {
  input.addEventListener('pointerdown', (e) => {
    if (document.activeElement !== input) {
      e.preventDefault();
      input.focus();
      requestAnimationFrame(() => moveCursorToEnd(input));
    }
  }, { passive: false });
}

function autoMatchWeights(changedInput, card) {
  const prevWeight = changedInput.dataset.prevWeight;
  if (prevWeight === undefined || prevWeight === '') return;
  const newWeight = changedInput.value;
  if (newWeight === prevWeight) return;

  const allWeights = card.querySelectorAll('.weight-input');
  if (allWeights.length <= 1) return;

  // Only auto-match when the first set's weight is changed
  if (changedInput !== allWeights[0]) {
    changedInput.dataset.prevWeight = newWeight;
    return;
  }

  // Check if all OTHER inputs had the same value as the changed input's previous value
  let allSame = true;
  allWeights.forEach(input => {
    if (input !== changedInput && input.value !== prevWeight) {
      allSame = false;
    }
  });

  if (allSame) {
    allWeights.forEach(input => {
      if (input !== changedInput) {
        input.value = newWeight;
        input.dataset.prevWeight = newWeight;
      }
    });
  }
  changedInput.dataset.prevWeight = newWeight;
}

function copyWeightToAll(card, ex) {
  const allWeights = card.querySelectorAll('.weight-input');
  if (allWeights.length <= 1) return;
  const firstValue = allWeights[0].value;
  allWeights.forEach((input, i) => {
    if (i > 0) {
      input.value = firstValue;
      input.dataset.prevWeight = firstValue;
    }
  });
  debounceSave(ex);
}

function addSet(ex, card) {
  const container = card.querySelector('.sets-container');
  const currentRows = container.querySelectorAll('.set-row');
  const newSetNum = currentRows.length + 1;
  const targetRepsNum = parseInt(ex.target_reps) || 0;
  const isDuration = !!ex.is_duration;

  const row = document.createElement('div');
  row.className = 'set-row';

  if (isDuration) {
    let prevDuration = '';
    if (currentRows.length > 0) {
      const lastDur = currentRows[currentRows.length - 1].querySelector('.duration-input');
      if (lastDur && lastDur.value) prevDuration = lastDur.value;
    }
    row.dataset.duration = '1';
    row.innerHTML = `
      <button class="set-check" data-weid="${ex.id}" data-set="${newSetNum}"></button>
      <span class="set-label">${newSetNum}</span>
      <input type="number" class="set-input duration-input"
             value="${prevDuration}" placeholder="sec" inputmode="numeric"
             data-weid="${ex.id}" data-set="${newSetNum}" data-field="duration">
      <span class="set-unit">sec</span>
    `;
  } else {
    let prevWeight = '';
    if (currentRows.length > 0) {
      const lastWeight = currentRows[currentRows.length - 1].querySelector('.weight-input');
      if (lastWeight && lastWeight.value) prevWeight = lastWeight.value;
    }
    const newSetAmrap = ex.is_amrap && !ex.amrap_last_only;
    row.innerHTML = `
      <button class="set-check" data-weid="${ex.id}" data-set="${newSetNum}"></button>
      <span class="set-label">${newSetNum}</span>
      <input type="number" class="set-input weight-input"
             value="${prevWeight}" placeholder="kg" step="0.5" inputmode="decimal"
             data-weid="${ex.id}" data-set="${newSetNum}" data-field="weight">
      <span class="set-unit">kg</span>
      <span class="set-separator">&times;</span>
      <input type="number" class="set-input reps-input"
             value="${targetRepsNum || ''}" placeholder="reps" inputmode="numeric"
             data-weid="${ex.id}" data-set="${newSetNum}" data-field="reps">
      <button class="amrap-toggle${newSetAmrap ? ' active' : ''}" data-weid="${ex.id}" data-set="${newSetNum}">F</button>
    `;
  }
  container.appendChild(row);

  row.querySelectorAll('.set-input').forEach(input => {
    input.addEventListener('focus', () => moveCursorToEnd(input));
    input.addEventListener('change', () => debounceSave(ex));
    input.addEventListener('input', () => debounceSave(ex));
  });

  row.querySelector('.set-check').addEventListener('click', function() {
    const isDone = this.classList.contains('done');
    if (isDone) {
      this.classList.remove('done');
      this.innerHTML = '';
      row.classList.remove('set-done');
    } else {
      this.classList.add('done');
      this.innerHTML = '&#x2713;';
      row.classList.add('set-done');
    }
    debounceSave(ex);
  });

  const amrapBtn = row.querySelector('.amrap-toggle');
  if (amrapBtn) {
    amrapBtn.addEventListener('click', () => {
      amrapBtn.classList.toggle('active');
      debounceSave(ex);
    });
  }

  let removeBtn = card.querySelector('.remove-set-btn');
  if (!removeBtn) {
    const actions = card.querySelector('.set-actions');
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-outline remove-set-btn';
    btn.dataset.weid = ex.id;
    btn.innerHTML = '&minus; Set';
    btn.addEventListener('click', () => removeSet(ex, card));
    actions.appendChild(btn);
  }

  debounceSave(ex);
}

function removeSet(ex, card) {
  const container = card.querySelector('.sets-container');
  const rows = container.querySelectorAll('.set-row');
  if (rows.length <= 1) return;
  rows[rows.length - 1].remove();
  if (rows.length - 1 <= 1) {
    const removeBtn = card.querySelector('.remove-set-btn');
    if (removeBtn) removeBtn.remove();
  }
  debounceSave(ex);
}

function markAllSetsDone(card, ex) {
  let changed = false;
  card.querySelectorAll('.set-row').forEach(row => {
    const btn = row.querySelector('.set-check');
    if (!btn || btn.classList.contains('done')) return;
    btn.classList.add('done');
    btn.innerHTML = '&#x2713;';
    row.classList.add('set-done');
    changed = true;
  });
  if (changed) {
    showToast('Marked all sets done');
    debounceSave(ex);
  }
}

async function moveExercise(ex, workout, direction) {
  const allExercises = workout.exercises;
  const idx = allExercises.indexOf(ex);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= allExercises.length) return;

  const order = allExercises.map(e => e.id);
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];

  await api(`/api/workout/${currentDate}/reorder`, {
    method: 'PUT',
    body: { order, workout_id: workout.id },
  });
  invalidateProgressCaches();
  loadWorkout();
}

// --- History Tab ---
async function renderHistorySection(container) {
  container.innerHTML = '<div class="progress-loading">Loading…</div>';
  const data = await api('/api/history');

  if (data.length === 0) {
    container.innerHTML = '<div class="empty-state">No workout history yet</div>';
    return;
  }

  let html = '';
  for (const { weekStart, items: workouts } of groupByWeek(data)) {
    html += `<div class="history-week">`;
    html += `<div class="history-week-header">Week of ${formatDate(weekStart)}</div>`;
    for (const w of workouts) {
      html += `
        <div class="history-item" data-date="${w.date}">
          <span class="history-date">${formatDate(w.date)}</span>
          <span class="history-day">${w.day_name}</span>
        </div>
      `;
    }
    html += '</div>';
  }
  container.innerHTML = html;

  container.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => renderHistoryDetail(item.dataset.date, container));
  });
}

async function renderHistoryDetail(date, container) {
  container.innerHTML = '<div class="progress-loading">Loading…</div>';
  const data = await api(`/api/workout/${date}`);

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }

  let html = `
    <button class="btn btn-outline history-back-btn">&larr; Back</button>
    <h3 style="margin:12px 0">${formatDate(date)}</h3>
  `;

  for (const block of data) {
    const workout = block.workout;
    if (!workout || workout.preview) continue;

    html += `<div class="history-template-header">${workout.template_name || workout.day_name}</div>`;

    for (const ex of workout.exercises) {
      const exIsDuration = !!ex.is_duration;
      html += `<div class="history-detail-card">`;
      const histDisplayName = ex.override_exercise_name || ex.exercise_name;
      html += `<div class="history-exercise-name" data-exercise-id="${ex.day_exercise_id}">${histDisplayName}${ex.override_exercise_name ? ` <span class="swap-badge" title="Swapped from ${ex.exercise_name}">&#x21C4;</span>` : ''}</div>`;
      if (ex.skipped) {
        html += `<div class="history-sets">Skipped</div>`;
      } else if (ex.sets.length > 0) {
        let setStr;
        if (exIsDuration) {
          setStr = ex.sets.map(s => formatDuration(s.duration_seconds)).join(', ');
        } else {
          setStr = ex.sets.map(s => {
            if (s.weight == null) return 'bw';
            if (s.is_amrap)
              return `${s.weight}kg &times; ${s.reps || '?'}<span class="amrap-marker">F</span>`;
            if (s.reps != null && s.target_reps != null && s.reps !== s.target_reps)
              return `${s.weight}kg &times; <span class="partial">${s.reps}/${s.target_reps}</span>`;
            return `${s.weight}kg &times; ${s.reps || '?'}`;
          }).join(', ');
        }
        html += `<div class="history-sets">${setStr}</div>`;
      }
      if (ex.note) html += `<div class="default-note" style="margin-top:4px">${ex.note}</div>`;
      html += `</div>`;
    }
  }

  container.innerHTML = html;

  container.querySelector('.history-back-btn').addEventListener('click', () => {
    renderHistorySection(container);
  });

  container.querySelectorAll('.history-exercise-name').forEach(el => {
    el.addEventListener('click', () => {
      const exId = el.dataset.exerciseId;
      if (exId) showProgression(exId, el.textContent);
    });
  });
}

async function showProgression(dayExerciseId, name) {
  const templates = await api('/api/templates');
  let exerciseId = null;

  for (const tmpl of templates) {
    const exercises = await api(`/api/templates/${tmpl.id}/exercises`);
    const found = exercises.find(e => e.id === parseInt(dayExerciseId));
    if (found) {
      exerciseId = found.exercise_id;
      break;
    }
  }

  if (!exerciseId) return;

  const data = await api(`/api/history/exercise/${exerciseId}?limit=10`);
  const modal = document.getElementById('progression-modal');
  const title = document.getElementById('progression-title');
  const body = document.getElementById('progression-body');

  title.textContent = name;
  modal.classList.remove('hidden');

  if (data.length === 0) {
    body.innerHTML = '<div class="empty-state">No history</div>';
    return;
  }

  // Detect duration exercise: check if any non-skipped session has duration_seconds
  const isDurationExercise = data.some(s => !s.skipped && s.sets && s.sets.some(set => set.duration_seconds != null));

  let html;
  if (isDurationExercise) {
    html = '<table class="progression-table"><thead><tr><th>Date</th><th>Sets</th><th>Longest</th><th>Total</th></tr></thead><tbody>';
    const totals = [];
    for (const session of data) {
      if (session.skipped) {
        html += `<tr class="skipped-row"><td>${formatDate(session.date)}</td><td colspan="3">Skipped</td></tr>`;
        continue;
      }
      const setsStr = session.sets.map(s => formatDuration(s.duration_seconds)).join(', ');
      const longest = Math.max(...session.sets.map(s => s.duration_seconds || 0));
      const total = session.sets.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
      totals.push(total);
      html += `<tr><td>${formatDate(session.date)}</td><td>${setsStr}</td><td>${formatDuration(longest)}</td><td>${formatDuration(total)}</td></tr>`;
    }
    html += '</tbody></table>';
    if (totals.length >= 2) {
      const latest = totals[0];
      const prev = totals[1];
      const diff = latest - prev;
      const cls = diff > 0 ? 'trend-up' : diff < 0 ? 'trend-down' : 'trend-flat';
      const arrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '\u2192';
      html += `<div class="progression-volume">Total trend: <span class="${cls}">${arrow} ${Math.abs(diff)}s (${formatDuration(latest)} vs ${formatDuration(prev)})</span></div>`;
    }
  } else {
    html = '<table class="progression-table"><thead><tr><th>Date</th><th>Sets</th><th>Best</th><th>Volume</th></tr></thead><tbody>';
    const volumes = [];
    for (const session of data) {
      if (session.skipped) {
        html += `<tr class="skipped-row"><td>${formatDate(session.date)}</td><td colspan="3">Skipped</td></tr>`;
        continue;
      }

      const setsStr = session.sets.map(s => {
        if (s.weight == null) return 'bw';
        if (s.is_amrap) {
          return `${s.weight}&times;${s.reps || '?'}<span class="amrap-marker">F</span>`;
        }
        if (s.reps != null && s.target_reps != null && s.reps < s.target_reps) {
          return `<span class="partial">${s.weight}&times;${s.reps}</span>`;
        }
        return `${s.weight}&times;${s.reps || '?'}`;
      }).join(', ');

      const fullSets = session.sets.filter(s => s.weight != null && s.reps != null && (s.is_amrap || (s.target_reps != null && s.reps >= s.target_reps)));
      const bestSet = fullSets.length > 0 ? Math.max(...fullSets.map(s => s.weight)) : null;
      const bestStr = bestSet != null ? `${bestSet}kg` : '-';

      const vol = session.sets.reduce((sum, s) => sum + ((s.weight || 0) * (s.reps || 0)), 0);
      volumes.push(vol);

      html += `<tr><td>${formatDate(session.date)}</td><td>${setsStr}</td><td>${bestStr}</td><td>${vol}</td></tr>`;
    }

    html += '</tbody></table>';

    if (volumes.length >= 2) {
      const latest = volumes[0];
      const prev = volumes[1];
      const diff = latest - prev;
      const cls = diff > 0 ? 'trend-up' : diff < 0 ? 'trend-down' : 'trend-flat';
      const arrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '\u2192';
      html += `<div class="progression-volume">Volume trend: <span class="${cls}">${arrow} ${Math.abs(diff)} (${latest} vs ${prev})</span></div>`;
    }
  }

  body.innerHTML = html;
}

document.getElementById('progression-close').addEventListener('click', () => {
  document.getElementById('progression-modal').classList.add('hidden');
});

document.getElementById('progression-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.add('hidden');
  }
});

// --- Template Tab ---
async function loadTemplate() {
  invalidateScheduleCache();
  invalidateTemplatesCache();
  const schedule = await getSchedule();
  const templates = await getTemplates();

  const container = document.getElementById('template-days');
  container.innerHTML = '';

  // Section 1: Weekly Schedule
  const scheduleSection = document.createElement('div');
  scheduleSection.className = 'template-section';
  scheduleSection.innerHTML = '<h3 class="template-section-title">Weekly Schedule</h3>';

  // Group schedule by day
  const dayScheduleMap = {};
  for (const s of schedule) {
    if (!dayScheduleMap[s.day_index]) dayScheduleMap[s.day_index] = [];
    dayScheduleMap[s.day_index].push(s);
  }

  for (let i = 0; i < 7; i++) {
    const dayRow = document.createElement('div');
    dayRow.className = 'schedule-day-row';

    const dayLabel = document.createElement('span');
    dayLabel.className = 'schedule-day-label';
    dayLabel.textContent = getDayNameShort(i);

    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'schedule-chips';

    const assigned = dayScheduleMap[i] || [];
    for (const entry of assigned) {
      const chip = document.createElement('span');
      chip.className = 'schedule-chip';
      chip.innerHTML = `${entry.template_name} <button class="schedule-chip-remove" data-schedule-id="${entry.id}">&times;</button>`;
      chip.querySelector('.schedule-chip-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        await api(`/api/schedule/${entry.id}`, { method: 'DELETE' });
        invalidateScheduleCache();
        loadTemplate();
        loadWeek(); // refresh week strip
      });
      chipsContainer.appendChild(chip);
    }

    // Add dropdown to assign template
    const addBtn = document.createElement('button');
    addBtn.className = 'schedule-add-btn';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => {
      showScheduleDropdown(i, addBtn, templates);
    });

    chipsContainer.appendChild(addBtn);
    dayRow.appendChild(dayLabel);
    dayRow.appendChild(chipsContainer);
    scheduleSection.appendChild(dayRow);
  }

  container.appendChild(scheduleSection);

  // Section 2: Templates Library
  const templatesSection = document.createElement('div');
  templatesSection.className = 'template-section';
  templatesSection.innerHTML = '<h3 class="template-section-title">Templates</h3>';

  // Create Template button
  const createBtn = document.createElement('button');
  createBtn.className = 'btn create-template-btn';
  createBtn.textContent = '+ Create Template';
  createBtn.addEventListener('click', () => showCreateTemplateForm(templatesSection, createBtn));
  templatesSection.appendChild(createBtn);

  for (const tmpl of templates) {
    const tmplEl = document.createElement('div');
    tmplEl.className = 'template-day';

    const header = document.createElement('div');
    header.className = 'template-day-header';
    header.style.cursor = 'pointer';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'template-day-name-input';
    nameInput.value = tmpl.name;
    nameInput.placeholder = 'Template name';

    const saveTemplateName = async () => {
      const newName = nameInput.value.trim();
      if (newName && newName !== tmpl.name) {
        await api(`/api/templates/${tmpl.id}`, { method: 'PUT', body: { name: newName } });
        invalidateTemplatesCache();
        invalidateScheduleCache();
        loadTemplate();
        loadWeek();
      }
    };
    nameInput.addEventListener('blur', saveTemplateName);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    nameInput.addEventListener('click', (e) => e.stopPropagation());

    const chevron = document.createElement('span');
    chevron.className = 'template-chevron';
    chevron.innerHTML = '&rsaquo;';

    const duplicateBtn = document.createElement('button');
    duplicateBtn.className = 'btn btn-sm btn-outline template-duplicate-btn';
    duplicateBtn.textContent = 'Duplicate';
    duplicateBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Server picks a unique name ("Push Copy", "Push Copy 2", …) so repeated
      // clicks stay tidy instead of producing "Push Copy Copy Copy".
      const result = await api(`/api/templates/${tmpl.id}/duplicate`, { method: 'POST', body: {} });
      invalidateTemplatesCache();
      invalidateScheduleCache();
      showToast(`Duplicated as "${result.name}"`);
      loadTemplate();
    });

    header.appendChild(nameInput);
    header.appendChild(duplicateBtn);
    header.appendChild(chevron);

    const body = document.createElement('div');
    body.className = 'template-day-body';

    header.addEventListener('click', () => {
      body.classList.toggle('open');
      if (body.classList.contains('open') && body.children.length === 0) {
        loadTemplateExercises(tmpl.id, body);
      }
    });

    tmplEl.appendChild(header);
    tmplEl.appendChild(body);
    templatesSection.appendChild(tmplEl);
  }

  container.appendChild(templatesSection);
}

function showScheduleDropdown(dayIndex, anchorBtn, templates) {
  // Remove any existing dropdown
  document.querySelectorAll('.schedule-dropdown').forEach(d => d.remove());

  const dropdown = document.createElement('div');
  dropdown.className = 'schedule-dropdown';

  for (const tmpl of templates) {
    const option = document.createElement('div');
    option.className = 'schedule-dropdown-option';
    option.textContent = tmpl.name;
    option.addEventListener('click', async () => {
      await api('/api/schedule', { method: 'POST', body: { day_index: dayIndex, template_id: tmpl.id } });
      dropdown.remove();
      invalidateScheduleCache();
      loadTemplate();
      loadWeek();
    });
    dropdown.appendChild(option);
  }

  // Position and show
  anchorBtn.parentElement.appendChild(dropdown);

  // Close on outside click
  const closeHandler = (e) => {
    if (!dropdown.contains(e.target) && e.target !== anchorBtn) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function showCreateTemplateForm(section, btn) {
  // Replace button with form
  const form = document.createElement('div');
  form.className = 'create-template-form';
  form.innerHTML = `
    <input type="text" class="template-day-name-input" placeholder="Template name" id="new-template-name">
    <button class="btn btn-sm" id="new-template-save">Create</button>
    <button class="btn btn-sm btn-outline" id="new-template-cancel">Cancel</button>
  `;

  btn.style.display = 'none';
  section.insertBefore(form, btn.nextSibling);

  const nameInput = form.querySelector('#new-template-name');
  nameInput.focus();

  form.querySelector('#new-template-save').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    await api('/api/templates', { method: 'POST', body: { name } });
    invalidateTemplatesCache();
    btn.style.display = '';
    form.remove();
    loadTemplate();
  });

  form.querySelector('#new-template-cancel').addEventListener('click', () => {
    btn.style.display = '';
    form.remove();
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') form.querySelector('#new-template-save').click();
    if (e.key === 'Escape') form.querySelector('#new-template-cancel').click();
  });
}

async function loadTemplateExercises(templateId, container) {
  const exercises = await api(`/api/templates/${templateId}/exercises`);
  const allExercises = await api('/api/exercises');
  const archived = await api(`/api/templates/${templateId}/archived-exercises`);
  let html = '';

  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    const isFirst = i === 0;
    const isLast = i === exercises.length - 1;
    const hasSS = ex.superset_group != null;
    // Check if this is the start of a superset group
    const ssStart = hasSS && (i === 0 || exercises[i - 1].superset_group !== ex.superset_group);
    const ssEnd = hasSS && (isLast || exercises[i + 1].superset_group !== ex.superset_group);
    const ssMid = hasSS && !ssStart && !ssEnd;

    let ssClass = '';
    if (ssStart) ssClass = ' tmpl-superset-start';
    else if (ssEnd) ssClass = ' tmpl-superset-end';
    else if (ssMid) ssClass = ' tmpl-superset-mid';

    let ssLabel = '';
    if (ssStart) {
      const groupSize = exercises.filter(e => e.superset_group === ex.superset_group).length;
      ssLabel = groupSize >= 3 ? 'Giant Set' : 'Superset';
    }

    // Show GS button if ungrouped but adjacent to an existing group
    const prevEx = i > 0 ? exercises[i - 1] : null;
    const nextEx = i < exercises.length - 1 ? exercises[i + 1] : null;
    const adjacentToGroup = !hasSS && (
      (prevEx && prevEx.superset_group != null) ||
      (nextEx && nextEx.superset_group != null)
    );

    html += `
      <div class="template-exercise${ssClass}" data-deid="${ex.id}">
        ${ssStart ? `<div class="tmpl-superset-label">${ssLabel}</div>` : ''}
        <div class="template-exercise-row">
          <div class="template-reorder-btns">
            <button class="reorder-btn tmpl-move-up" data-deid="${ex.id}" ${isFirst ? 'disabled' : ''}>&uarr;</button>
            <button class="reorder-btn tmpl-move-down" data-deid="${ex.id}" ${isLast ? 'disabled' : ''}>&darr;</button>
          </div>
          <div class="template-exercise-info template-exercise-editable" data-deid="${ex.id}">
            <div class="template-exercise-name">
              ${ex.exercise_name}
              ${ex.is_warmup ? '<span class="warmup-badge">Warmup</span>' : ''}
              ${ex.is_duration ? '<span class="duration-badge">Duration</span>' : ''}
              ${ex.is_amrap ? `<span class="amrap-badge">${ex.amrap_last_only ? 'AMRAP Last' : 'AMRAP'}</span>` : ''}
            </div>
            <div class="template-exercise-detail">${ex.is_duration ? `${ex.target_sets} sets` : `${ex.target_sets}&times;${ex.target_reps}`}</div>
            ${ex.notes ? `<div class="template-exercise-note">${ex.notes.replace(/</g, '&lt;')}</div>` : ''}
            ${ex.linked_templates && ex.linked_templates.length > 0 ? `<div class="linked-indicator">Linked: ${ex.linked_templates.join(', ')}</div>` : ''}
          </div>
          <div class="template-exercise-actions">
            <button class="btn btn-sm tmpl-ss-toggle${hasSS ? ' active' : ''}" data-deid="${ex.id}">SS</button>
            ${adjacentToGroup ? `<button class="btn btn-sm tmpl-gs-toggle" data-deid="${ex.id}">GS</button>` : ''}
            <button class="btn btn-sm tmpl-warmup-toggle${ex.is_warmup ? ' active' : ''}" data-deid="${ex.id}">Warm</button>
            <button class="btn btn-sm tmpl-duration-toggle${ex.is_duration ? ' active' : ''}" data-deid="${ex.id}">Dur</button>
            <button class="btn btn-sm tmpl-amrap-toggle${ex.is_amrap ? ' active' : ''}" data-deid="${ex.id}">F</button>
            ${ex.is_amrap ? `<button class="btn btn-sm tmpl-amrap-last-toggle${ex.amrap_last_only ? ' active' : ''}" data-deid="${ex.id}">Last</button>` : ''}
            <button class="btn btn-sm btn-danger template-delete" data-deid="${ex.id}">&times;</button>
          </div>
        </div>
      </div>
    `;
  }

  if (archived.length > 0) {
    html += `
      <details class="archived-exercises" data-tmpl="${templateId}">
        <summary>Previously deleted (${archived.length}) — history preserved</summary>
        ${archived.map(a => `
          <div class="archived-row" data-deid="${a.id}">
            <div class="archived-info">
              <div class="archived-name">${a.exercise_name}${a.is_warmup ? ' <span class="warmup-badge">Warmup</span>' : ''}</div>
              <div class="archived-meta">${a.history_count} session${a.history_count === 1 ? '' : 's'}${a.last_used ? ` · last ${a.last_used}` : ''}</div>
            </div>
            <div class="archived-actions">
              <button class="btn btn-sm archived-restore" data-deid="${a.id}">Restore</button>
              <button class="btn btn-sm btn-danger archived-purge" data-deid="${a.id}" title="Permanently delete this exercise and its workout history">&times;</button>
            </div>
          </div>
        `).join('')}
      </details>
    `;
  }

  html += `
    <div class="add-exercise-form">
      <input type="text" placeholder="Exercise name" id="add-name-${templateId}" list="exercise-list-${templateId}">
      <datalist id="exercise-list-${templateId}">
        ${allExercises.map(e => `<option value="${e.name}">`).join('')}
      </datalist>
      <div class="add-exercise-row">
        <input type="number" placeholder="Sets" value="4" id="add-sets-${templateId}" inputmode="numeric">
        <input type="text" placeholder="Reps" value="10" id="add-reps-${templateId}">
      </div>
      <div class="add-toggles-row">
        <button type="button" class="btn btn-sm tmpl-warmup-toggle" id="add-warmup-${templateId}">Warmup</button>
        <button type="button" class="btn btn-sm tmpl-duration-toggle" id="add-duration-${templateId}">Duration</button>
        <button type="button" class="btn btn-sm tmpl-amrap-toggle" id="add-amrap-${templateId}">AMRAP</button>
      </div>
      <div class="template-footer-actions">
        <button class="btn" id="add-btn-${templateId}">Add Exercise</button>
        <button class="btn btn-sm btn-danger template-delete-btn" id="delete-template-${templateId}">Delete Template</button>
      </div>
    </div>
  `;

  container.innerHTML = html;

  // Warmup toggle handlers (only for existing exercises with data-deid)
  container.querySelectorAll('.tmpl-warmup-toggle[data-deid]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const isActive = btn.classList.contains('active');
      await api(`/api/day-exercises/${deId}`, {
        method: 'PUT',
        body: { is_warmup: isActive ? 0 : 1 }
      });
      loadTemplateExercises(templateId, container);
    });
  });

  // Duration toggle handlers (only for existing exercises with data-deid)
  container.querySelectorAll('.tmpl-duration-toggle[data-deid]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const isActive = btn.classList.contains('active');
      await api(`/api/day-exercises/${deId}`, {
        method: 'PUT',
        body: { is_duration: isActive ? 0 : 1 }
      });
      loadTemplateExercises(templateId, container);
    });
  });

  // AMRAP toggle handlers (only for existing exercises with data-deid)
  container.querySelectorAll('.tmpl-amrap-toggle[data-deid]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const isActive = btn.classList.contains('active');
      const updates = { is_amrap: isActive ? 0 : 1 };
      if (isActive) updates.amrap_last_only = 0;
      await api(`/api/day-exercises/${deId}`, {
        method: 'PUT',
        body: updates
      });
      loadTemplateExercises(templateId, container);
    });
  });

  // AMRAP last-set-only toggle handlers
  container.querySelectorAll('.tmpl-amrap-last-toggle[data-deid]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const isActive = btn.classList.contains('active');
      await api(`/api/day-exercises/${deId}`, {
        method: 'PUT',
        body: { amrap_last_only: isActive ? 0 : 1 }
      });
      loadTemplateExercises(templateId, container);
    });
  });

  // Inline edit handlers
  container.querySelectorAll('.template-exercise-editable').forEach(info => {
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      const deId = parseInt(info.dataset.deid);
      const ex = exercises.find(e => e.id === deId);
      if (!ex || info.querySelector('.inline-edit-form')) return;

      info.innerHTML = `
        <div class="inline-edit-form">
          <input type="text" class="inline-edit-name" value="${ex.exercise_name}" placeholder="Name" autocomplete="off">
          <div class="inline-edit-row">
            <input type="number" class="inline-edit-sets" value="${ex.target_sets}" placeholder="Sets" inputmode="numeric">
            <span class="inline-edit-x">&times;</span>
            <input type="text" class="inline-edit-reps" value="${ex.target_reps}" placeholder="Reps">
          </div>
          <input type="text" class="inline-edit-note" value="${(ex.notes || '').replace(/"/g, '&quot;')}" placeholder="Note (shown during workout)">
        </div>
      `;

      const nameInput = info.querySelector('.inline-edit-name');
      const setsInput = info.querySelector('.inline-edit-sets');
      const repsInput = info.querySelector('.inline-edit-reps');
      const noteInput = info.querySelector('.inline-edit-note');

      // Delay focus to avoid the current click event causing immediate blur
      requestAnimationFrame(() => {
        nameInput.focus();
        nameInput.select();
      });

      const restoreDisplay = (name, sets, reps, notes) => {
        info.innerHTML = `
          <div class="template-exercise-name">
            ${name}
            ${ex.is_warmup ? '<span class="warmup-badge">Warmup</span>' : ''}
            ${ex.is_duration ? '<span class="duration-badge">Duration</span>' : ''}
            ${ex.is_amrap ? `<span class="amrap-badge">${ex.amrap_last_only ? 'AMRAP Last' : 'AMRAP'}</span>` : ''}
          </div>
          <div class="template-exercise-detail">${ex.is_duration ? `${sets} sets` : `${sets}&times;${reps}`}</div>
          ${notes ? `<div class="template-exercise-note">${notes.replace(/</g, '&lt;')}</div>` : ''}
        `;
      };

      const saveEdit = async () => {
        const newName = nameInput.value.trim();
        const newSets = parseInt(setsInput.value) || ex.target_sets;
        const newReps = repsInput.value.trim() || ex.target_reps;
        const newNote = noteInput.value.trim();
        if (!newName) { restoreDisplay(ex.exercise_name, ex.target_sets, ex.target_reps, ex.notes); return; }

        const updates = {};
        if (newSets !== ex.target_sets) updates.target_sets = newSets;
        if (newReps !== ex.target_reps) updates.target_reps = newReps;
        if (newNote !== (ex.notes || '')) updates.notes = newNote || null;
        if (newName !== ex.exercise_name) {
          const result = await api('/api/exercises', { method: 'POST', body: { name: newName } });
          updates.exercise_id = result.id;
        }
        if (Object.keys(updates).length > 0) {
          await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: updates });
        }
        // If name changed (exercise_id changed), reload to refresh linked indicators
        if (newName !== ex.exercise_name) {
          loadTemplateExercises(templateId, container);
          return;
        }
        // Update in-place instead of reloading to avoid destroying other open edit forms
        ex.exercise_name = newName;
        ex.target_sets = newSets;
        ex.target_reps = newReps;
        ex.notes = newNote || null;
        restoreDisplay(newName, newSets, newReps, ex.notes);
      };

      let saved = false;
      let blurEnabled = false;

      // Delay enabling blur handlers to avoid the initial click causing immediate close
      setTimeout(() => { blurEnabled = true; }, 300);

      const handleBlur = () => {
        if (!blurEnabled) return;
        setTimeout(() => {
          if (saved) return;
          if (!info.contains(document.activeElement)) {
            saved = true;
            saveEdit();
          }
        }, 150);
      };

      [nameInput, setsInput, repsInput, noteInput].forEach(input => {
        input.addEventListener('blur', handleBlur);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { saved = true; saveEdit(); }
          if (e.key === 'Escape') { saved = true; loadTemplateExercises(templateId, container); }
        });
        input.addEventListener('click', (e) => e.stopPropagation());
      });
    });
  });

  // Reorder handlers (superset-aware)
  container.querySelectorAll('.tmpl-move-up').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const idx = exercises.findIndex(ex => ex.id === deId);
      if (idx <= 0) return;
      const ex = exercises[idx];
      const order = exercises.map(ex => ex.id);
      const group = ex.superset_group;

      if (group != null) {
        const groupIndices = exercises.map((e, i) => e.superset_group === group ? i : -1).filter(i => i >= 0);
        const isTopOfGroup = idx === groupIndices[0];
        if (isTopOfGroup) {
          // Move entire group up past the element/group above
          const aboveIdx = groupIndices[0] - 1;
          const aboveEx = exercises[aboveIdx];
          if (aboveEx.superset_group != null) {
            // Above is also a group — find its start
            const aboveGroupStart = exercises.findIndex(e => e.superset_group === aboveEx.superset_group);
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(aboveGroupStart, 0, ...chunk);
          } else {
            // Above is a single exercise — swap group above it
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(aboveIdx, 0, ...chunk);
          }
        } else {
          // Move exercise up within group (simple swap)
          [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        }
      } else {
        // Ungrouped exercise — check if above is a group
        const aboveEx = exercises[idx - 1];
        if (aboveEx.superset_group != null) {
          const aboveGroupStart = exercises.findIndex(e => e.superset_group === aboveEx.superset_group);
          const item = order.splice(idx, 1)[0];
          order.splice(aboveGroupStart, 0, item);
        } else {
          [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        }
      }

      await api(`/api/templates/${templateId}/reorder`, { method: 'PUT', body: { order } });
      loadTemplateExercises(templateId, container);
    });
  });
  container.querySelectorAll('.tmpl-move-down').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const idx = exercises.findIndex(ex => ex.id === deId);
      if (idx < 0 || idx >= exercises.length - 1) return;
      const ex = exercises[idx];
      const order = exercises.map(ex => ex.id);
      const group = ex.superset_group;

      if (group != null) {
        const groupIndices = exercises.map((e, i) => e.superset_group === group ? i : -1).filter(i => i >= 0);
        const isBottomOfGroup = idx === groupIndices[groupIndices.length - 1];
        if (isBottomOfGroup) {
          // Move entire group down past the element/group below
          const belowIdx = groupIndices[groupIndices.length - 1] + 1;
          const belowEx = exercises[belowIdx];
          if (belowEx.superset_group != null) {
            // Below is also a group — find its end
            const belowGroupIndices = exercises.map((e, i) => e.superset_group === belowEx.superset_group ? i : -1).filter(i => i >= 0);
            const belowGroupEnd = belowGroupIndices[belowGroupIndices.length - 1];
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(belowGroupEnd - groupIndices.length + 1, 0, ...chunk);
          } else {
            // Below is a single exercise — swap group below it
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(groupIndices[0] + 1, 0, ...chunk);
          }
        } else {
          // Move exercise down within group (simple swap)
          [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        }
      } else {
        // Ungrouped exercise — check if below is a group
        const belowEx = exercises[idx + 1];
        if (belowEx.superset_group != null) {
          const belowGroupIndices = exercises.map((e, i) => e.superset_group === belowEx.superset_group ? i : -1).filter(i => i >= 0);
          const belowGroupEnd = belowGroupIndices[belowGroupIndices.length - 1];
          const item = order.splice(idx, 1)[0];
          order.splice(belowGroupEnd, 0, item);
        } else {
          [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        }
      }

      await api(`/api/templates/${templateId}/reorder`, { method: 'PUT', body: { order } });
      loadTemplateExercises(templateId, container);
    });
  });

  // Superset toggle handlers — always pairs with next exercise
  container.querySelectorAll('.tmpl-ss-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const idx = exercises.findIndex(ex => ex.id === deId);
      const ex = exercises[idx];
      const next = exercises[idx + 1];

      if (ex.superset_group != null) {
        // Remove from superset
        const oldGroup = ex.superset_group;
        const groupMembers = exercises.filter(e => e.superset_group === oldGroup);
        const lastInGroup = groupMembers[groupMembers.length - 1];
        await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { superset_group: null } });
        // If removed from the middle of a giant set, move it below the group
        const firstInGroup = groupMembers[0];
        if (groupMembers.length >= 3 && ex.id !== firstInGroup.id && ex.id !== lastInGroup.id) {
          const lastIdx = exercises.findIndex(e => e.id === lastInGroup.id);
          const order = exercises.map(e => e.id);
          order.splice(idx, 1);
          order.splice(lastIdx, 0, deId);
          await api(`/api/templates/${templateId}/reorder`, { method: 'PUT', body: { order } });
        }
        // Clean up orphans: if only one exercise remains in the group, remove it too
        const remaining = groupMembers.filter(e => e.id !== deId);
        if (remaining.length === 1) {
          await api(`/api/day-exercises/${remaining[0].id}`, { method: 'PUT', body: { superset_group: null } });
        }
      } else if (next) {
        // Create new pair or join next exercise's group
        const groupNum = next.superset_group != null
          ? next.superset_group
          : (Math.max(0, ...exercises.filter(e => e.superset_group != null).map(e => e.superset_group)) + 1);
        await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { superset_group: groupNum } });
        if (next.superset_group == null) {
          await api(`/api/day-exercises/${next.id}`, { method: 'PUT', body: { superset_group: groupNum } });
        }
      }
      loadTemplateExercises(templateId, container);
    });
  });

  // Giant Set toggle handlers — joins the nearest adjacent group
  container.querySelectorAll('.tmpl-gs-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid);
      const idx = exercises.findIndex(ex => ex.id === deId);
      const prev = idx > 0 ? exercises[idx - 1] : null;
      const next = idx < exercises.length - 1 ? exercises[idx + 1] : null;

      // Prefer joining the group above, fall back to group below
      const groupNum = (prev && prev.superset_group != null) ? prev.superset_group
        : (next && next.superset_group != null) ? next.superset_group
        : null;
      if (groupNum != null) {
        await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { superset_group: groupNum } });
      }
      loadTemplateExercises(templateId, container);
    });
  });

  // Delete handlers
  container.querySelectorAll('.template-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/day-exercises/${btn.dataset.deid}`, { method: 'DELETE' });
      loadTemplateExercises(templateId, container);
    });
  });

  // Archived exercise: restore
  container.querySelectorAll('.archived-restore').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/day-exercises/${btn.dataset.deid}/restore`, { method: 'POST' });
      loadTemplateExercises(templateId, container);
    });
  });

  // Archived exercise: permanent delete (destroys history)
  container.querySelectorAll('.archived-purge').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.archived-row');
      const name = row.querySelector('.archived-name').textContent.trim();
      if (!confirm(`Permanently delete "${name}" and all of its workout history?\n\nThis cannot be undone.`)) return;
      await api(`/api/day-exercises/${btn.dataset.deid}/permanent`, { method: 'DELETE' });
      loadTemplateExercises(templateId, container);
    });
  });

  // Add exercise toggle handlers
  document.getElementById(`add-warmup-${templateId}`).addEventListener('click', (e) => {
    e.preventDefault();
    e.currentTarget.classList.toggle('active');
  });
  document.getElementById(`add-duration-${templateId}`).addEventListener('click', (e) => {
    e.preventDefault();
    e.currentTarget.classList.toggle('active');
  });
  document.getElementById(`add-amrap-${templateId}`).addEventListener('click', (e) => {
    e.preventDefault();
    e.currentTarget.classList.toggle('active');
  });

  // Add exercise handler
  document.getElementById(`add-btn-${templateId}`).addEventListener('click', async () => {
    const name = document.getElementById(`add-name-${templateId}`).value.trim();
    const sets = parseInt(document.getElementById(`add-sets-${templateId}`).value) || 3;
    const reps = document.getElementById(`add-reps-${templateId}`).value.trim() || '10';
    const isWarmup = document.getElementById(`add-warmup-${templateId}`).classList.contains('active');
    const isDuration = document.getElementById(`add-duration-${templateId}`).classList.contains('active');
    const isAmrap = document.getElementById(`add-amrap-${templateId}`).classList.contains('active');
    if (!name) return;

    await api(`/api/templates/${templateId}/exercises`, {
      method: 'POST',
      body: { name, target_sets: sets, target_reps: reps, is_warmup: isWarmup, is_duration: isDuration, is_amrap: isAmrap },
    });
    document.getElementById(`add-name-${templateId}`).value = '';
    document.getElementById(`add-warmup-${templateId}`).classList.remove('active');
    document.getElementById(`add-duration-${templateId}`).classList.remove('active');
    document.getElementById(`add-amrap-${templateId}`).classList.remove('active');
    loadTemplateExercises(templateId, container);
  });

  // Delete template handler
  document.getElementById(`delete-template-${templateId}`).addEventListener('click', async () => {
    const tmplName = container.closest('.template-day').querySelector('.template-day-name-input').value;
    if (confirm(`Delete template "${tmplName}" and all its exercises?\n\nThis will also delete all workout history for this template.`)) {
      await api(`/api/templates/${templateId}`, { method: 'DELETE' });
      invalidateTemplatesCache();
      invalidateScheduleCache();
      loadTemplate();
      loadWeek();
    }
  });
}

// --- Progress Tab ---

// Cache
let bodyWeightsCache = null;
let exerciseTrendCache = {};   // exerciseId → [{date, total_volume, completion_pct}]
let performedExercisesCache = null;
let workoutDatesCache = null;  // [date string, ...] sorted ASC

// Section/range state persisted across tab switches
let progressSection = 'body';     // 'body' | 'strength' | 'workouts'
let progressTimeRange = '3m';     // '1m' | '3m' | '6m' | '1y' | 'all'
let progressExerciseId = null;
let progressExerciseName = '';
let bodyHistoryExpanded = false;

function invalidateBodyCache() {
  bodyWeightsCache = null;
}

function invalidateProgressCaches() {
  performedExercisesCache = null;
  exerciseTrendCache = {};
  workoutDatesCache = null;
}

async function saveBodyWeight(date, weightKg) {
  await api(`/api/body-weight/${date}`, { method: 'PUT', body: { weight_kg: weightKg } });
  invalidateBodyCache();
}

// ---- Shared chart utilities ----

function filterByRange(data, range) {
  // data items must have a .date property (or be plain date strings)
  if (range === 'all') return data;
  const now = new Date();
  const cutoff = new Date(now);
  if (range === '1m') cutoff.setMonth(now.getMonth() - 1);
  else if (range === '3m') cutoff.setMonth(now.getMonth() - 3);
  else if (range === '6m') cutoff.setMonth(now.getMonth() - 6);
  else if (range === '1y') cutoff.setFullYear(now.getFullYear() - 1);
  const cutoffStr = toISO(cutoff);
  return data.filter(d => (typeof d === 'string' ? d : d.date) >= cutoffStr);
}

function getRangeBounds(range, allDates = []) {
  const end = todayStr();
  if (range === 'all') {
    if (allDates.length === 0) return null;
    return { start: allDates[0], end: allDates[allDates.length - 1] };
  }

  const now = new Date();
  const startDate = new Date(now);
  if (range === '1m') startDate.setMonth(now.getMonth() - 1);
  else if (range === '3m') startDate.setMonth(now.getMonth() - 3);
  else if (range === '6m') startDate.setMonth(now.getMonth() - 6);
  else if (range === '1y') startDate.setFullYear(now.getFullYear() - 1);

  return { start: toISO(startDate), end };
}

function countWeeksInRange(start, end) {
  const startDate = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  const diffMs = endDate - startDate;
  if (diffMs <= 0) return 1;
  return Math.max(1, Math.ceil((diffMs + 1) / (7 * 24 * 60 * 60 * 1000)));
}

function getEffectiveWeightForDate(readingsAsc, date) {
  if (readingsAsc.length === 0) return null;

  let effective = readingsAsc[0].weight_kg;
  for (const reading of readingsAsc) {
    if (reading.date > date) break;
    effective = reading.weight_kg;
  }

  return effective;
}

async function getBodyTrendSeries(range) {
  if (!bodyWeightsCache) bodyWeightsCache = await api('/api/body-weight');
  const readings = bodyWeightsCache;
  if (readings.length === 0) return [];

  if (!workoutDatesCache) {
    workoutDatesCache = await api('/api/trends/frequency');
  }

  const displayDates = [...new Set([
    ...workoutDatesCache,
    ...readings.map(r => r.date),
    todayStr(),
  ])].sort((a, b) => a.localeCompare(b));

  const filteredDates = filterByRange(displayDates, range);
  const readingsAsc = [...readings].sort((a, b) => a.date.localeCompare(b.date));

  return filteredDates.map(date => ({
    date,
    weight_kg: getEffectiveWeightForDate(readingsAsc, date),
  })).filter(point => point.weight_kg != null);
}

// Build a responsive SVG line chart.
// points: [{date, value}] sorted oldest→newest
// opts: { formatY, lineClass, emptyMsg }
// Returns an HTML string (svg or empty-state div).
function buildLineChart(points, opts = {}) {
  if (points.length === 0) {
    return `<div class="chart-empty">${opts.emptyMsg || 'Not enough data'}</div>`;
  }
  const W = 320, H = 110;
  const pt = 10, pb = 22, pl = 38, pr = 8;
  const plotW = W - pl - pr, plotH = H - pt - pb;

  const values = points.map(p => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const vRange = maxV - minV || 1;

  const n = points.length;
  const toX = i => pl + (i / (n - 1)) * plotW;
  const toY = v => pt + (1 - (v - minV) / vRange) * plotH;

  if (points.length === 1) {
    const x = pl + plotW / 2;
    const y = pt + plotH / 2;
    const fmtSingle = opts.formatY || (v => String(Math.round(v)));
    return `
      <svg class="progress-chart-svg" viewBox="0 0 ${W} ${H}"
           preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <text x="${pl - 3}" y="${pt + 4}" class="chart-label" text-anchor="end">${fmtSingle(points[0].value)}</text>
        <text x="${pl}" y="${H}" class="chart-label" text-anchor="start">${formatDateShort(points[0].date)}</text>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="chart-dot"/>
      </svg>
    `;
  }

  const pathD = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.value).toFixed(1)}`
  ).join(' ');

  const dots = n <= 40 ? points.map((p, i) =>
    `<circle cx="${toX(i).toFixed(1)}" cy="${toY(p.value).toFixed(1)}" r="2.5" class="chart-dot"/>`
  ).join('') : '';

  const fmt = opts.formatY || (v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
  const yLabelMax = fmt(maxV);
  const yLabelMin = fmt(minV);
  const xFirst = formatDateShort(points[0].date);
  const xLast  = formatDateShort(points[n - 1].date);

  return `
    <svg class="progress-chart-svg" viewBox="0 0 ${W} ${H}"
         preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <text x="${pl - 3}" y="${pt + 4}" class="chart-label" text-anchor="end">${yLabelMax}</text>
      <text x="${pl - 3}" y="${pt + plotH + 4}" class="chart-label" text-anchor="end">${yLabelMin}</text>
      <text x="${pl}" y="${H}" class="chart-label" text-anchor="start">${xFirst}</text>
      <text x="${W - pr}" y="${H}" class="chart-label" text-anchor="end">${xLast}</text>
      <path d="${pathD}" class="chart-line ${opts.lineClass || ''}"
            fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
  `;
}

// Build a responsive SVG bar chart.
// bars: [{label, value}] sorted oldest→newest
// Returns an HTML string (svg or empty-state div).
function buildBarChart(bars, opts = {}) {
  if (bars.length === 0) return `<div class="chart-empty">No data</div>`;
  const W = 320, H = opts.height || 90;
  const pt = 6, pb = 20, pl = 24, pr = 8;
  const plotW = W - pl - pr, plotH = H - pt - pb;

  const maxV = Math.max(...bars.map(b => b.value), 1);
  const gap = plotW / bars.length;
  const barW = Math.max(2, gap - 2);

  const rects = bars.map((b, i) => {
    const bH = (b.value / maxV) * plotH;
    const x = pl + i * gap + (gap - barW) / 2;
    const y = pt + plotH - bH;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}"
                  width="${barW.toFixed(1)}" height="${Math.max(bH, 1).toFixed(1)}"
                  class="chart-bar" rx="1"/>`;
  }).join('');

  return `
    <svg class="progress-chart-svg" viewBox="0 0 ${W} ${H}"
         preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <text x="${pl - 2}" y="${pt + 4}" class="chart-label" text-anchor="end">${maxV}</text>
      <text x="${pl - 2}" y="${pt + plotH + 4}" class="chart-label" text-anchor="end">0</text>
      <text x="${pl}" y="${H}" class="chart-label" text-anchor="start">${bars[0].label}</text>
      <text x="${W - pr}" y="${H}" class="chart-label" text-anchor="end">${bars[bars.length - 1].label}</text>
      ${rects}
    </svg>
  `;
}

// ---- Progress tab shell ----

async function loadBodyTab() {
  const tab = document.getElementById('tab-body');
  if (!tab.querySelector('.progress-shell')) {
    renderProgressShell(tab);
  } else {
    // Restore active states from current state vars
    tab.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.section === progressSection));
    tab.querySelectorAll('.range-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.range === progressTimeRange));
    tab.querySelector('.progress-range-row').classList.toggle('hidden', progressSection === 'history');
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
      </div>
      <div class="progress-content"></div>
    </div>
  `;

  container.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      progressSection = btn.dataset.section;
      // Range picker is irrelevant for History
      container.querySelector('.progress-range-row').classList.toggle('hidden', progressSection === 'history');
      loadProgressSection();
    });
  });

  container.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      progressTimeRange = btn.dataset.range;
      loadProgressSection();
    });
  });
}

async function loadProgressSection() {
  const content = document.querySelector('#tab-body .progress-content');
  if (!content) return;
  content.innerHTML = '<div class="progress-loading">Loading…</div>';
  if (progressSection === 'body') await renderBodySection(content);
  else if (progressSection === 'strength') await renderStrengthSection(content);
  else if (progressSection === 'workouts') await renderWorkoutsSection(content);
  else await renderHistorySection(content);
}

// ---- Body section ----

async function renderBodySection(container) {
  if (!bodyWeightsCache) bodyWeightsCache = await api('/api/body-weight');
  const readings = bodyWeightsCache; // DESC order from server
  const today = todayStr();
  const todayReading = readings.find(r => r.date === today) || null;
  const latestReading = readings[0] || null;
  const entryCount = readings.length;

  // Filtered for chart (oldest→newest)
  const filtered = await getBodyTrendSeries(progressTimeRange);
  const activeDateCount = filtered.length;
  const chartHtml = buildLineChart(
    filtered.map(r => ({ date: r.date, value: r.weight_kg })),
    { formatY: v => v.toFixed(1), emptyMsg: 'Log your weight to see it across your workout history' }
  );

  // History HTML (grouped by week, collapsible)
  const historyHtml = buildBodyHistoryHtml(readings);
  const hint = latestReading
    ? `Latest logged: ${latestReading.weight_kg} kg on ${formatDate(latestReading.date)} - carries forward to today`
    : 'Enter your weight to start tracking';

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
        <div class="progress-stat-label">Trend dates</div>
      </div>
    </div>
    <div class="progress-chart-card">
      <div class="progress-chart-title">Weight trend</div>
      ${chartHtml}
      <div class="progress-helper-text">Your first logged weight fills earlier history. Later weights apply forward until the next logged weight, with the latest carrying forward to today.</div>
    </div>
    <div class="progress-history-section">
      <button class="progress-history-toggle">History <span class="toggle-arrow">${bodyHistoryExpanded ? '^' : 'v'}</span></button>
      <div class="progress-history-list${bodyHistoryExpanded ? '' : ' hidden'}">${historyHtml}</div>
    </div>
  `;

  // Today input
  const todayInput = container.querySelector('.body-today-input');
  attachFirstTapCursorEnd(todayInput);
  let todayTimer = null;
  const originalTodayValue = todayReading ? String(todayReading.weight_kg) : '';
  const saveTodayWeight = async () => {
    const v = parseFloat(todayInput.value);
    if (isNaN(v) || v <= 0) return;
    if (String(v) === originalTodayValue) return;
    await saveBodyWeight(today, v);
    // Refresh body section in-place
    bodyWeightsCache = null;
    showToast('Weight saved');
    await renderBodySection(container);
  };
  todayInput.addEventListener('change', () => { clearTimeout(todayTimer); todayTimer = setTimeout(saveTodayWeight, 600); });
  todayInput.addEventListener('blur',   () => { clearTimeout(todayTimer); saveTodayWeight(); });

  // History toggle
  const toggle = container.querySelector('.progress-history-toggle');
  const list   = container.querySelector('.progress-history-list');
  toggle.addEventListener('click', () => {
    const collapsed = list.classList.toggle('hidden');
    bodyHistoryExpanded = !collapsed;
    toggle.querySelector('.toggle-arrow').textContent = collapsed ? 'v' : '^';
  });

  // History inputs
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
  historyContainer.querySelectorAll('.body-history-input').forEach(input => {
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
      bodyWeightsCache = null;
      showToast('Weight saved');
      await renderBodySection(sectionContainer);
    };
    input.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(doSave, 600); });
    input.addEventListener('blur',   () => { clearTimeout(timer); doSave(); });
  });
}

// ---- Strength section ----

async function renderStrengthSection(container) {
  if (!performedExercisesCache) {
    performedExercisesCache = await api('/api/exercises/performed');
  }
  const exercises = performedExercisesCache;

  container.innerHTML = `
    <div class="exercise-picker-card">
      <input type="text" class="exercise-search-input" placeholder="Search exercise…"
             value="${progressExerciseName}" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="exercise-search-results hidden"></div>
    </div>
    <div class="strength-chart-area"></div>
  `;

  const searchInput   = container.querySelector('.exercise-search-input');
  const searchResults = container.querySelector('.exercise-search-results');
  const chartArea     = container.querySelector('.strength-chart-area');

  attachFirstTapCursorEnd(searchInput);

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) { searchResults.classList.add('hidden'); searchResults.innerHTML = ''; return; }
    const matches = exercises.filter(e => e.name.toLowerCase().includes(q)).slice(0, 12);
    if (matches.length === 0) { searchResults.classList.add('hidden'); return; }
    searchResults.innerHTML = matches.map(e =>
      `<div class="exercise-result-item" data-id="${e.id}" data-name="${e.name}">
        <span class="result-name">${e.name}</span>
        ${e.last_date ? `<span class="result-last-date">${formatDateShort(e.last_date)}</span>` : ''}
      </div>`
    ).join('');
    searchResults.classList.remove('hidden');
  });

  searchResults.addEventListener('click', async e => {
    const item = e.target.closest('.exercise-result-item');
    if (!item) return;
    progressExerciseId   = parseInt(item.dataset.id);
    progressExerciseName = item.dataset.name;
    searchInput.value    = item.dataset.name;
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    await renderStrengthChart(chartArea);
  });

  // Close results when clicking outside
  document.addEventListener('click', function onOutside(ev) {
    if (!container.contains(ev.target)) {
      searchResults.classList.add('hidden');
      document.removeEventListener('click', onOutside);
    }
  });

  if (progressExerciseId) {
    await renderStrengthChart(chartArea);
  } else if (exercises.length > 0) {
    chartArea.innerHTML = '<div class="chart-empty">Search for an exercise above to see its trend</div>';
  }
}

async function renderStrengthChart(container) {
  if (!progressExerciseId) return;
  container.innerHTML = '<div class="progress-loading">Loading…</div>';

  if (!exerciseTrendCache[progressExerciseId]) {
    exerciseTrendCache[progressExerciseId] = await api(`/api/trends/exercise/${progressExerciseId}`);
  }
  const trend = exerciseTrendCache[progressExerciseId];
  const filtered = filterByRange(trend, progressTimeRange);

  if (filtered.length < 2) {
    container.innerHTML = `<div class="chart-empty">Not enough data${progressTimeRange !== 'all' ? ' in this range — try a wider range' : ''}</div>`;
    return;
  }

  const volChart = buildLineChart(
    filtered.map(d => ({ date: d.date, value: d.total_volume })),
    { formatY: v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)) }
  );
  const compChart = buildLineChart(
    filtered.map(d => ({ date: d.date, value: d.completion_pct })),
    { formatY: v => `${Math.round(v)}%`, lineClass: 'chart-line-secondary' }
  );

  container.innerHTML = `
    <div class="progress-chart-card">
      <div class="progress-chart-title">Volume <span class="chart-title-unit">(kg × reps)</span></div>
      ${volChart}
      <div class="chart-subtitle">Total weight moved per session — the primary signal of long-term progress</div>
    </div>
    <div class="progress-chart-card">
      <div class="progress-chart-title">Set completion</div>
      ${compChart}
      <div class="chart-subtitle">How much of the prescribed work was completed — dips when weight increases are normal</div>
    </div>
  `;
}

// ---- Workouts section ----

async function renderWorkoutsSection(container) {
  if (!workoutDatesCache) {
    workoutDatesCache = await api('/api/trends/frequency'); // [date, ...] ASC
  }
  const filtered = filterByRange(workoutDatesCache, progressTimeRange); // plain strings
  const total = filtered.length;
  const bounds = getRangeBounds(progressTimeRange, filtered);

  const weeks = groupByWeek(filtered);
  const avgPerWeek = bounds ? (total / countWeeksInRange(bounds.start, bounds.end)).toFixed(1) : '–';

  // Bar chart (cap at 52 bars)
  const barData = weeks.slice(-52).map(({ weekStart, items }) => ({
    label: formatDateShort(weekStart),
    value: items.length
  }));

  container.innerHTML = `
    <div class="progress-stats-row">
      <div class="progress-stat-card">
        <div class="progress-stat-value">${total}</div>
        <div class="progress-stat-label">Sessions</div>
      </div>
      <div class="progress-stat-card">
        <div class="progress-stat-value">${avgPerWeek}</div>
        <div class="progress-stat-label">Avg / week</div>
      </div>
    </div>
    <div class="progress-chart-card">
      <div class="progress-chart-title">Sessions per week</div>
      ${buildBarChart(barData)}
    </div>
  `;
}

// --- Init ---
loadWeek();
