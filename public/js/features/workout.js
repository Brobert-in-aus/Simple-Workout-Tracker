import { api } from '../core/api.js';
import { formatDateShort, getDayNameShort, shiftDate, todayStr } from '../core/dates.js';
import { state } from '../core/state.js';
import { attachFirstTapCursorEnd, moveCursorToEnd, showToast } from '../core/ui.js';
import { invalidateProgressCaches } from './progress/index.js';

async function getSchedule() {
  if (!state.scheduleCache) state.scheduleCache = await api('/api/schedule');
  return state.scheduleCache;
}

function isWarmupExercise(ex, prev) {
  if (ex.is_warmup) return true;
  const prevNote = prev && prev.note ? prev.note : '';
  if (prevNote && /^warmup$/i.test(prevNote.trim())) return true;
  if (ex.note && /^warmup$/i.test(ex.note.trim())) return true;
  return false;
}

export async function loadWeek() {
  const schedule = await getSchedule();
  const dayTemplates = {};
  for (const s of schedule) {
    if (!dayTemplates[s.day_index]) dayTemplates[s.day_index] = [];
    dayTemplates[s.day_index].push(s.template_name);
  }

  const weekEnd = shiftDate(state.currentWeekStart, 6);
  document.getElementById('week-display').textContent =
    `${formatDateShort(state.currentWeekStart)} - ${formatDateShort(weekEnd)}`;

  const rangeData = await api(`/api/workouts/range?from=${state.currentWeekStart}&to=${weekEnd}`);
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
    const dateStr = shiftDate(state.currentWeekStart, i);
    const isPast = dateStr < today;
    const hasStarted = startedSet.has(dateStr);

    let names;
    if (isPast) {
      names = actualWorkouts[dateStr] || [];
    } else {
      names = dayTemplates[i] || [];
    }

    const el = document.createElement('div');
    el.className = 'week-day';
    if (dateStr === state.currentDate) el.classList.add('selected');
    if (dateStr === today) el.classList.add('today');
    if (hasStarted) el.classList.add('has-workout');
    el.dataset.date = dateStr;

    const dateObj = new Date(`${dateStr}T00:00:00`);
    const workoutLabel = names.length > 0 ? names.join(', ') : '';

    el.innerHTML = `
      <div class="week-day-name">${getDayNameShort(i)}</div>
      <div class="week-day-date">${dateObj.getDate()}</div>
      <div class="week-day-workout ${workoutLabel ? '' : 'rest'}">${workoutLabel || 'Rest'}${hasStarted ? ' <span class="week-day-done">&#x2713;</span>' : ''}</div>
    `;

    el.addEventListener('click', () => {
      state.currentDate = dateStr;
      strip.querySelectorAll('.week-day').forEach((d) => d.classList.remove('selected'));
      el.classList.add('selected');
      loadWorkout();
    });

    strip.appendChild(el);
  }

  const selected = strip.querySelector('.selected');
  if (selected) selected.scrollIntoView({ inline: 'center', block: 'nearest' });

  loadWorkout();
}

export async function loadWorkout() {
  const data = await api(`/api/workout/${state.currentDate}`);
  state.currentWorkoutBlocks = data;

  const container = document.getElementById('exercises-list');
  container.innerHTML = '';

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">Rest day</div>';
    return;
  }

  const isFuture = state.currentDate > todayStr();

  for (const block of data) {
    const workout = block.workout;
    const previous = block.previous;
    const isPreview = !!workout.preview;
    const templateName = workout.template_name || workout.day_name || '';

    if (data.length > 1 || templateName) {
      const header = document.createElement('div');
      header.className = 'workout-section-header';
      header.innerHTML = `<span>${templateName}</span>`;
      if (!isPreview && workout.id) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-sm btn-danger workout-delete-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
          if (!confirm(`Delete workout "${templateName}" for ${state.currentDate}?`)) return;
          await api(`/api/workout/${workout.id}`, { method: 'DELETE' });
          invalidateProgressCaches();
          loadWeek();
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

    if (isPreview) {
      const preview = document.createElement('div');
      preview.className = 'begin-workout';
      if (isFuture) {
        preview.innerHTML = '<div class="empty-state">Scheduled for later</div>';
      } else {
        preview.innerHTML = '<button class="btn">Begin Workout</button>';
        preview.querySelector('button').addEventListener('click', () => beginWorkout(workout.template_id));
      }
      container.appendChild(preview);
      renderExercisesPreview(container, workout.exercises, previous);
      continue;
    }

    renderExercises(container, workout, previous);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-outline add-exercise-btn';
    addBtn.textContent = '+ Exercise';
    addBtn.addEventListener('click', () => showAddExerciseToWorkoutPanel(container, workout));
    container.appendChild(addBtn);
  }
}

async function beginWorkout(templateId) {
  await api(`/api/workout/${state.currentDate}/begin`, {
    method: 'POST',
    body: { template_id: templateId },
  });
  invalidateProgressCaches();
  loadWorkout();
}

function renderExercisesPreview(container, exercises, previous) {
  const groups = groupExercises(exercises);

  for (const group of groups) {
    const isSuperset = group.length > 1;
    group.forEach((ex, idx) => {
      const prev = findPreviousExercise(ex.day_exercise_id, previous, ex.exercise_id, ex.is_warmup);
      const prevStr = buildPrevString(prev, !!ex.is_duration);
      const prevNote = prev && prev.note ? prev.note : '';
      const prevFrom = prev && prev.from_template ? ` (from ${prev.from_template})` : '';
      const showWarmup = isWarmupExercise(ex, prev);

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

      html += `
        <div class="exercise-header">
          <span class="exercise-name">${ex.exercise_name}${showWarmup ? '<span class="warmup-badge">Warmup</span>' : ''}${ex.is_duration ? '<span class="duration-badge">Duration</span>' : ''}${ex.is_amrap ? `<span class="amrap-badge">${ex.amrap_last_only ? 'AMRAP Last' : 'AMRAP'}</span>` : ''}</span>
          <span class="exercise-target">${ex.is_duration ? `${ex.target_sets} sets` : `${ex.target_sets}&times;${ex.target_reps}`}</span>
        </div>
        ${prevStr ? `<div class="previous-data">${prevStr}${prevFrom}</div>` : ''}
        ${prevNote && !showWarmup ? `<div class="previous-data prev-note">${prevNote}</div>` : ''}
        ${ex.default_note && !showWarmup ? `<div class="template-note">${ex.default_note.replace(/</g, '&lt;')}</div>` : ''}
      `;

      card.innerHTML = html;
      container.appendChild(card);
    });
  }
}

function findPreviousExercise(dayExerciseId, previous, exerciseId, isWarmup) {
  if (!previous) return null;
  let prev = previous.find((e) => e.day_exercise_id === dayExerciseId);
  if (!prev && exerciseId != null) {
    // Fallback: match by exercise_id, but respect warmup role so a warmup slot
    // never picks up working-set history (and vice versa).
    prev = previous.find(
      (e) => e.exercise_id === exerciseId && (isWarmup == null || e.is_warmup == null || e.is_warmup === isWarmup),
    );
  }
  return prev || null;
}

function buildPrevString(prev, isDuration) {
  if (!prev || !prev.sets || prev.sets.length === 0) return '';
  if (isDuration) {
    return `Previous: ${prev.sets.map((s) => s.duration_seconds != null ? `${s.duration_seconds}s` : '?').join(', ')}`;
  }
  return `Previous: ${prev.sets.map((s) => {
    if (s.weight == null) return 'bw';
    const reps = s.reps != null ? s.reps : '?';
    if (s.is_amrap) return `${s.weight}kg × ${reps}F`;
    if (s.target_reps != null && s.reps != null && s.reps < s.target_reps) return `${s.weight}kg × ${s.reps}/${s.target_reps}`;
    return `${s.weight}kg × ${reps}`;
  }).join(', ')}`;
}

function groupExercises(exercises) {
  const groups = [];
  let i = 0;
  while (i < exercises.length) {
    const ex = exercises[i];
    if (ex.superset_group == null) {
      groups.push([ex]);
      i++;
      continue;
    }
    const group = [ex];
    i++;
    while (i < exercises.length && exercises[i].superset_group === ex.superset_group) {
      group.push(exercises[i]);
      i++;
    }
    groups.push(group);
  }
  return groups;
}

function renderExercises(container, workout, previous) {
  const groups = groupExercises(workout.exercises);

  for (const group of groups) {
    const isSuperset = group.length > 1;
    const cardPairs = group.map((ex, idx) => {
      const card = createExerciseCard(ex, workout, previous, isSuperset, idx, group.length);
      container.appendChild(card);
      return { card, ex };
    });
    // Link superset siblings so set completion propagates across the group
    if (isSuperset) {
      cardPairs.forEach(({ card }, i) => {
        card._supersetSiblings = cardPairs.filter((_, j) => j !== i);
      });
    }
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
  const prev = findPreviousExercise(ex.day_exercise_id, previous, ex.exercise_id, ex.is_warmup);
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
    const targetRepsNum = parseInt(ex.target_reps, 10) || 0;
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

  const notePlaceholder = prevNote && !showWarmup ? prevNote : 'Note...';
  const noteValue = (ex.note && /^warmup$/i.test(ex.note.trim())) ? '' : (ex.note || '');
  html += `
    <div class="exercise-note">
      <textarea rows="1" placeholder="${notePlaceholder.replace(/"/g, '&quot;')}" data-weid="${ex.id}" data-field="note">${noteValue}</textarea>
    </div>
  `;

  card.innerHTML = html;
  wireExerciseCard(card, ex, workout);
  return card;
}

function wireExerciseCard(card, ex, workout) {
  card.querySelector('.skip-toggle').addEventListener('click', () => toggleSkip(ex));
  card.querySelector('.swap-toggle').addEventListener('click', () => handleSwap(ex, card));

  card.querySelectorAll('.weight-input').forEach((input) => {
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

  card.querySelectorAll('.set-input:not(.weight-input)').forEach((input) => {
    attachFirstTapCursorEnd(input);
    input.addEventListener('focus', () => moveCursorToEnd(input));
    input.addEventListener('change', () => debounceSave(ex));
    input.addEventListener('input', () => debounceSave(ex));
  });

  card.querySelectorAll('.set-check').forEach((btn) => {
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
      // Propagate completion state to same set number across superset group
      const setNum = btn.dataset.set;
      const newDone = !isDone;
      (card._supersetSiblings || []).forEach(({ card: sibCard, ex: sibEx }) => {
        const sibBtn = sibCard.querySelector(`.set-check[data-set="${setNum}"]`);
        if (!sibBtn) return;
        const sibRow = sibBtn.closest('.set-row');
        if (sibBtn.classList.contains('done') === newDone) return;
        if (newDone) {
          sibBtn.classList.add('done');
          sibBtn.innerHTML = '&#x2713;';
          sibRow.classList.add('set-done');
        } else {
          sibBtn.classList.remove('done');
          sibBtn.innerHTML = '';
          sibRow.classList.remove('set-done');
        }
        debounceSave(sibEx);
      });
    });
  });

  card.querySelectorAll('.amrap-toggle').forEach((btn) => {
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
}

async function toggleSkip(ex) {
  ex.skipped = ex.skipped ? 0 : 1;
  await api(`/api/workout/${state.currentDate}/exercise/${ex.id}`, {
    method: 'POST',
    body: { skipped: !!ex.skipped },
  });
  invalidateProgressCaches();
  loadWorkout();
}

async function handleSwap(ex, card) {
  if (ex.override_exercise_name) {
    await api(`/api/workout/${state.currentDate}/exercise/${ex.id}/swap`, {
      method: 'PUT',
      body: { exercise_name: null },
    });
    invalidateProgressCaches();
    loadWorkout();
    return;
  }

  const subHeader = card.querySelector('.exercise-sub-header');
  if (subHeader.querySelector('.swap-panel')) return;

  const allExercises = await api('/api/exercises');
  const listId = `swap-list-${ex.id}`;
  const panel = document.createElement('div');
  panel.className = 'swap-panel';
  panel.innerHTML = `
    <input type="text" class="swap-input" placeholder="Alternative exercise name" autocomplete="off" list="${listId}">
    <datalist id="${listId}">${allExercises.map((e) => `<option value="${e.name}">`).join('')}</datalist>
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
    await api(`/api/workout/${state.currentDate}/exercise/${ex.id}/swap`, {
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

  const afterOptions = [`<option value="-1">At the top</option>`]
    .concat(exercises.map((ex, i) => {
      const label = ex.override_exercise_name || ex.exercise_name;
      return `<option value="${ex.sort_order}" ${i === exercises.length - 1 ? 'selected' : ''}>${label}</option>`;
    })).join('');

  const panel = document.createElement('div');
  panel.className = 'add-ex-panel';
  panel.innerHTML = `
    <input type="text" class="add-ex-name" placeholder="Exercise name" autocomplete="off" list="${listId}">
    <datalist id="${listId}">${allExercises.map((e) => `<option value="${e.name}">`).join('')}</datalist>
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
    const targetSets = parseInt(panel.querySelector('.add-ex-sets').value, 10) || 3;
    const targetReps = panel.querySelector('.add-ex-reps').value.trim() || '10';
    const afterSortOrder = parseInt(panel.querySelector('.add-ex-after').value, 10);
    const saveToTemplate = panel.querySelector('.add-ex-template').checked;

    await api(`/api/workout/${state.currentDate}/add-exercise`, {
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
  if (state.saveTimers[ex.id]) clearTimeout(state.saveTimers[ex.id]);
  state.saveTimers[ex.id] = setTimeout(() => saveExercise(ex), 500);
}

async function saveExercise(ex) {
  const card = document.querySelector(`.skip-toggle[data-weid="${ex.id}"]`).closest('.exercise-card');
  const sets = [];
  const targetRepsNum = parseInt(ex.target_reps, 10) || null;

  card.querySelectorAll('.set-row').forEach((row) => {
    const checkBtn = row.querySelector('.set-check');
    const completed = checkBtn && checkBtn.classList.contains('done') ? 1 : 0;
    const durationInput = row.querySelector('.duration-input');

    if (durationInput) {
      const duration = durationInput.value !== '' ? parseInt(durationInput.value, 10) : null;
      sets.push({ weight: null, reps: null, target_reps: null, duration_seconds: duration, completed });
    } else {
      const weightInput = row.querySelector('.weight-input');
      const repsInput = row.querySelector('.reps-input');
      if (!weightInput) return;
      const weight = weightInput.value !== '' ? parseFloat(weightInput.value) : null;
      const reps = repsInput.value !== '' ? parseInt(repsInput.value, 10) : null;
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

  await api(`/api/workout/${state.currentDate}/exercise/${ex.id}`, {
    method: 'POST',
    body: { sets, note },
  });
  invalidateProgressCaches();
}

function autoMatchWeights(changedInput, card) {
  const prevWeight = changedInput.dataset.prevWeight;
  if (prevWeight === undefined || prevWeight === '') return;
  const newWeight = changedInput.value;
  if (newWeight === prevWeight) return;

  const allWeights = card.querySelectorAll('.weight-input');
  if (allWeights.length <= 1) return;

  if (changedInput !== allWeights[0]) {
    changedInput.dataset.prevWeight = newWeight;
    return;
  }

  let allSame = true;
  allWeights.forEach((input) => {
    if (input !== changedInput && input.value !== prevWeight) {
      allSame = false;
    }
  });

  if (allSame) {
    allWeights.forEach((input) => {
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
  const targetRepsNum = parseInt(ex.target_reps, 10) || 0;
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

  row.querySelectorAll('.set-input').forEach((input) => {
    input.addEventListener('focus', () => moveCursorToEnd(input));
    input.addEventListener('change', () => debounceSave(ex));
    input.addEventListener('input', () => debounceSave(ex));
  });

  row.querySelector('.set-check').addEventListener('click', function onCheckClick() {
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
    // Propagate to superset siblings
    const setNum = this.dataset.set;
    const newDone = !isDone;
    (card._supersetSiblings || []).forEach(({ card: sibCard, ex: sibEx }) => {
      const sibBtn = sibCard.querySelector(`.set-check[data-set="${setNum}"]`);
      if (!sibBtn) return;
      const sibRow = sibBtn.closest('.set-row');
      if (sibBtn.classList.contains('done') === newDone) return;
      if (newDone) {
        sibBtn.classList.add('done');
        sibBtn.innerHTML = '&#x2713;';
        sibRow.classList.add('set-done');
      } else {
        sibBtn.classList.remove('done');
        sibBtn.innerHTML = '';
        sibRow.classList.remove('set-done');
      }
      debounceSave(sibEx);
    });
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
    removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-sm btn-outline remove-set-btn';
    removeBtn.dataset.weid = ex.id;
    removeBtn.innerHTML = '&minus; Set';
    removeBtn.addEventListener('click', () => removeSet(ex, card));
    actions.appendChild(removeBtn);
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

function markAllSetsDone(card, ex, propagate = true) {
  let changed = false;
  card.querySelectorAll('.set-row').forEach((row) => {
    const btn = row.querySelector('.set-check');
    if (!btn || btn.classList.contains('done')) return;
    btn.classList.add('done');
    btn.innerHTML = '&#x2713;';
    row.classList.add('set-done');
    changed = true;
  });
  if (changed) debounceSave(ex);
  if (propagate) {
    (card._supersetSiblings || []).forEach(({ card: sibCard, ex: sibEx }) => {
      markAllSetsDone(sibCard, sibEx, false);
    });
    if (changed) showToast('Marked all sets done');
  }
}

async function moveExercise(ex, workout, direction) {
  const allExercises = workout.exercises;
  const idx = allExercises.indexOf(ex);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= allExercises.length) return;

  const order = allExercises.map((item) => item.id);
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];

  await api(`/api/workout/${state.currentDate}/reorder`, {
    method: 'PUT',
    body: { order, workout_id: workout.id },
  });
  invalidateProgressCaches();
  loadWorkout();
}
