import { api } from '../core/api.js';
import { formatDate, formatDuration, groupByWeek } from '../core/dates.js';
import { openAppModal } from '../core/ui.js';

export async function renderHistorySection(container) {
  container.innerHTML = '<div class="progress-loading">Loading...</div>';
  const data = await api('/api/history');

  if (data.length === 0) {
    container.innerHTML = '<div class="empty-state">No workout history yet</div>';
    return;
  }

  let html = '';
  for (const { weekStart, items: workouts } of groupByWeek(data).reverse()) {
    html += `<div class="history-week">`;
    html += `<div class="history-week-header">Week of ${formatDate(weekStart)}</div>`;
    for (const workout of workouts) {
      const isExternal = workout.item_type === 'external_workout';
      html += `
        <div class="history-item" data-date="${workout.date}" data-id="${workout.id}" data-item-type="${workout.item_type || 'tracked_workout'}">
          <span class="history-date">${formatDate(workout.date)}</span>
          <span class="history-day">${workout.day_name}${isExternal ? ' (Apple Watch)' : ''}</span>
        </div>
      `;
    }
    html += '</div>';
  }
  container.innerHTML = html;

  container.querySelectorAll('.history-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.itemType === 'external_workout') {
        renderExternalWorkoutDetail(item.dataset.id, container);
        return;
      }
      renderHistoryDetail(item.dataset.date, container);
    });
  });
}

export async function renderHistoryDetail(date, container) {
  container.innerHTML = '<div class="progress-loading">Loading...</div>';
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
    html += renderExternalLinksSummary(workout.external_links || []);

    for (const ex of workout.exercises) {
      const exIsDuration = !!ex.is_duration;
      const histDisplayName = ex.override_exercise_name || ex.exercise_name;
      html += `<div class="history-detail-card">`;
      html += `<div class="history-exercise-name" data-exercise-id="${ex.day_exercise_id}">${histDisplayName}${ex.override_exercise_name ? ` <span class="swap-badge" title="Swapped from ${ex.exercise_name}">&#x21C4;</span>` : ''}</div>`;
      if (ex.skipped) {
        html += `<div class="history-sets">Skipped</div>`;
      } else if (ex.sets.length > 0) {
        let setStr;
        if (exIsDuration) {
          setStr = ex.sets.map((s) => formatDuration(s.duration_seconds)).join(', ');
        } else {
          setStr = ex.sets.map((s) => {
            if (s.weight == null) return 'bw';
            if (s.is_amrap) {
              return `${s.weight}kg &times; ${s.reps || '?'}<span class="amrap-marker">F</span>`;
            }
            if (s.reps != null && s.target_reps != null && s.reps !== s.target_reps) {
              return `${s.weight}kg &times; <span class="partial">${s.reps}/${s.target_reps}</span>`;
            }
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

  container.querySelectorAll('.history-exercise-name').forEach((el) => {
    el.addEventListener('click', () => {
      const exId = el.dataset.exerciseId;
      if (exId) showProgression(exId, el.textContent);
    });
  });

  container.querySelectorAll('.history-apple-link-card[data-external-workout-id]').forEach((el) => {
    el.addEventListener('click', () => {
      renderExternalWorkoutDetail(el.dataset.externalWorkoutId, container);
    });
  });
}

function renderExternalLinksSummary(externalLinks) {
  if (!externalLinks || externalLinks.length === 0) return '';

  const itemsHtml = externalLinks.map(link => {
    const duration = link.derived_summary?.duration_seconds ?? link.duration_seconds ?? 0;
    const activeEnergy = link.derived_summary?.active_energy_kcal;
    const summaryBits = [
      duration > 0 ? formatDuration(duration) : null,
      activeEnergy != null ? `${activeEnergy} kcal` : null,
      link.allocation_ratio != null && link.allocation_ratio < 0.9999 ? `${Math.round(link.allocation_ratio * 100)}% allocation` : null,
    ].filter(Boolean);

    return `
      <div class="history-apple-link-card" data-external-workout-id="${link.external_workout_id}">
        <div class="history-apple-link-title">Apple Watch ${link.workout_type}</div>
        <div class="history-apple-link-summary">${summaryBits.join(' · ') || 'Imported summary available'}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="history-apple-summary">
      <div class="history-apple-summary-header">Apple Watch Summary</div>
      ${itemsHtml}
    </div>
  `;
}

async function renderExternalWorkoutDetail(id, container) {
  container.innerHTML = '<div class="progress-loading">Loading...</div>';
  const workout = await api(`/api/external-workouts/${id}`);

  const metrics = workout.metrics || {};
  const detailRows = [
    ['Type', workout.workout_type],
    ['Started', workout.start_at ? formatDate(workout.date) : workout.date],
    ['Duration', formatDuration(workout.duration_seconds || 0)],
    ['Active Energy', metrics.active_energy_kcal != null ? `${Math.round(metrics.active_energy_kcal)} kcal` : null],
    ['Avg HR', metrics.avg_heart_rate_bpm != null ? `${Math.round(metrics.avg_heart_rate_bpm)} bpm` : null],
    ['Max HR', metrics.max_heart_rate_bpm != null ? `${Math.round(metrics.max_heart_rate_bpm)} bpm` : null],
    ['Distance', metrics.distance_meters != null ? `${Math.round(metrics.distance_meters)} m` : null],
  ].filter(([, value]) => value != null);

  let html = `
    <button class="btn btn-outline history-back-btn">&larr; Back</button>
    <h3 style="margin:12px 0">${formatDate(workout.date)}</h3>
    <div class="history-template-header">Apple Watch ${workout.name}</div>
  `;

  for (const [label, value] of detailRows) {
    html += `
      <div class="history-detail-card">
        <div class="history-exercise-name">${label}</div>
        <div class="history-sets">${value}</div>
      </div>
    `;
  }

  container.innerHTML = html;
  container.querySelector('.history-back-btn').addEventListener('click', () => {
    renderHistorySection(container);
  });
}

export async function showProgression(dayExerciseId, name) {
  const templates = await api('/api/templates');
  let exerciseId = null;

  for (const tmpl of templates) {
    const exercises = await api(`/api/templates/${tmpl.id}/exercises`);
    const found = exercises.find((e) => e.id === parseInt(dayExerciseId, 10));
    if (found) {
      exerciseId = found.exercise_id;
      break;
    }
  }

  if (!exerciseId) return;

  const data = await api(`/api/history/exercise/${exerciseId}?limit=10`);
  if (data.length === 0) {
    openAppModal(name, '<div class="empty-state">No history</div>');
    return;
  }

  const isDurationExercise = data.some((session) => !session.skipped && session.sets && session.sets.some((set) => set.duration_seconds != null));

  let html;
  if (isDurationExercise) {
    html = '<table class="progression-table"><thead><tr><th>Date</th><th>Sets</th><th>Longest</th><th>Total</th></tr></thead><tbody>';
    const totals = [];
    for (const session of data) {
      if (session.skipped) {
        html += `<tr class="skipped-row"><td>${formatDate(session.date)}</td><td colspan="3">Skipped</td></tr>`;
        continue;
      }
      const setsStr = session.sets.map((s) => formatDuration(s.duration_seconds)).join(', ');
      const longest = Math.max(...session.sets.map((s) => s.duration_seconds || 0));
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

      const setsStr = session.sets.map((s) => {
        if (s.weight == null) return 'bw';
        if (s.is_amrap) {
          return `${s.weight}&times;${s.reps || '?'}<span class="amrap-marker">F</span>`;
        }
        if (s.reps != null && s.target_reps != null && s.reps < s.target_reps) {
          return `<span class="partial">${s.weight}&times;${s.reps}</span>`;
        }
        return `${s.weight}&times;${s.reps || '?'}`;
      }).join(', ');

      const fullSets = session.sets.filter((s) => s.weight != null && s.reps != null && (s.is_amrap || (s.target_reps != null && s.reps >= s.target_reps)));
      const bestSet = fullSets.length > 0 ? Math.max(...fullSets.map((s) => s.weight)) : null;
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

  openAppModal(name, html);
}
