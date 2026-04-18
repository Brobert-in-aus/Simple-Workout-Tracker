import { api } from '../core/api.js';
import { getDayNameShort } from '../core/dates.js';
import { state, CHAIN_SVG_BROKEN, CHAIN_SVG_LINKED, invalidateScheduleCache, invalidateTemplatesCache } from '../core/state.js';
import { showToast } from '../core/ui.js';
import { loadWeek } from './workout.js';

async function getSchedule() {
  if (!state.scheduleCache) state.scheduleCache = await api('/api/schedule');
  return state.scheduleCache;
}

async function getTemplates() {
  if (!state.templatesCache) state.templatesCache = await api('/api/templates');
  return state.templatesCache;
}

export async function loadTemplate() {
  invalidateScheduleCache();
  invalidateTemplatesCache();
  const schedule = await getSchedule();
  const templates = await getTemplates();

  const container = document.getElementById('template-days');
  container.innerHTML = '';

  const scheduleSection = document.createElement('div');
  scheduleSection.className = 'template-section';
  scheduleSection.innerHTML = '<h3 class="template-section-title">Weekly Schedule</h3>';

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
        loadWeek();
      });
      chipsContainer.appendChild(chip);
    }

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

  const templatesSection = document.createElement('div');
  templatesSection.className = 'template-section';
  templatesSection.innerHTML = '<h3 class="template-section-title">Templates</h3>';

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
      if (body.classList.contains('open')) {
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
  document.querySelectorAll('.schedule-dropdown').forEach((d) => d.remove());

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

  anchorBtn.parentElement.appendChild(dropdown);

  const closeHandler = (e) => {
    if (!dropdown.contains(e.target) && e.target !== anchorBtn) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function showCreateTemplateForm(section, btn) {
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
    const ssStart = hasSS && (i === 0 || exercises[i - 1].superset_group !== ex.superset_group);
    const ssEnd = hasSS && (isLast || exercises[i + 1].superset_group !== ex.superset_group);
    const ssMid = hasSS && !ssStart && !ssEnd;

    let ssClass = '';
    if (ssStart) ssClass = ' tmpl-superset-start';
    else if (ssEnd) ssClass = ' tmpl-superset-end';
    else if (ssMid) ssClass = ' tmpl-superset-mid';

    let ssLabel = '';
    if (ssStart) {
      const groupSize = exercises.filter((item) => item.superset_group === ex.superset_group).length;
      ssLabel = groupSize >= 3 ? 'Giant Set' : 'Superset';
    }

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
            ${ex.linked_templates && ex.linked_templates.length > 0 ? `<div class="linked-indicator${ex.targets_independent ? ' targets-independent' : ''}">${ex.targets_independent ? CHAIN_SVG_BROKEN : CHAIN_SVG_LINKED} ${ex.targets_independent ? 'Targets independent' : 'Synced'}: ${ex.linked_templates.join(', ')}</div>` : ''}
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
        <summary>Previously deleted (${archived.length}) - history preserved</summary>
        ${archived.map((a) => `
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
        ${allExercises.map((e) => `<option value="${e.name}">`).join('')}
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

  container.querySelectorAll('.tmpl-warmup-toggle[data-deid]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const isActive = btn.classList.contains('active');
      await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { is_warmup: isActive ? 0 : 1 } });
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.tmpl-duration-toggle[data-deid]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const isActive = btn.classList.contains('active');
      await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { is_duration: isActive ? 0 : 1 } });
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.tmpl-amrap-toggle[data-deid]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const isActive = btn.classList.contains('active');
      const updates = { is_amrap: isActive ? 0 : 1 };
      if (isActive) updates.amrap_last_only = 0;
      await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: updates });
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.tmpl-amrap-last-toggle[data-deid]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const isActive = btn.classList.contains('active');
      await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { amrap_last_only: isActive ? 0 : 1 } });
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.template-exercise-editable').forEach((info) => {
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      const deId = parseInt(info.dataset.deid, 10);
      const ex = exercises.find((item) => item.id === deId);
      if (!ex || info.querySelector('.inline-edit-form')) return;

      const isLinked = ex.linked_templates && ex.linked_templates.length > 0;
      info.innerHTML = `
        <div class="inline-edit-form">
          <input type="text" class="inline-edit-name" value="${ex.exercise_name}" placeholder="Name" autocomplete="off">
          <div class="inline-edit-row">
            <input type="number" class="inline-edit-sets" value="${ex.target_sets}" placeholder="Sets" inputmode="numeric">
            <span class="inline-edit-x">&times;</span>
            <input type="text" class="inline-edit-reps" value="${ex.target_reps}" placeholder="Reps">
          </div>
          ${isLinked ? `<button type="button" class="sync-targets-btn ${ex.targets_independent ? 'is-independent' : 'is-synced'}">${ex.targets_independent ? CHAIN_SVG_BROKEN : CHAIN_SVG_LINKED}<span class="sync-targets-label">${ex.targets_independent ? 'Targets independent' : 'Targets synced'}</span></button>` : ''}
          <input type="text" class="inline-edit-note" value="${(ex.notes || '').replace(/"/g, '&quot;')}" placeholder="Note (shown during workout)">
        </div>
      `;

      const nameInput = info.querySelector('.inline-edit-name');
      const setsInput = info.querySelector('.inline-edit-sets');
      const repsInput = info.querySelector('.inline-edit-reps');
      const noteInput = info.querySelector('.inline-edit-note');
      const syncBtn = info.querySelector('.sync-targets-btn');

      requestAnimationFrame(() => {
        nameInput.focus();
        nameInput.select();
      });

      const restoreDisplay = (name, sets, reps, notes) => {
        const linkedTemplates = ex.linked_templates || [];
        const linkedHtml = linkedTemplates.length > 0
          ? `<div class="linked-indicator${ex.targets_independent ? ' targets-independent' : ''}">${ex.targets_independent ? CHAIN_SVG_BROKEN : CHAIN_SVG_LINKED} ${ex.targets_independent ? 'Targets independent' : 'Synced'}: ${linkedTemplates.join(', ')}</div>`
          : '';
        info.innerHTML = `
          <div class="template-exercise-name">
            ${name}
            ${ex.is_warmup ? '<span class="warmup-badge">Warmup</span>' : ''}
            ${ex.is_duration ? '<span class="duration-badge">Duration</span>' : ''}
            ${ex.is_amrap ? `<span class="amrap-badge">${ex.amrap_last_only ? 'AMRAP Last' : 'AMRAP'}</span>` : ''}
          </div>
          <div class="template-exercise-detail">${ex.is_duration ? `${sets} sets` : `${sets}&times;${reps}`}</div>
          ${notes ? `<div class="template-exercise-note">${notes.replace(/</g, '&lt;')}</div>` : ''}
          ${linkedHtml}
        `;
      };

      const saveEdit = async () => {
        const newName = nameInput.value.trim();
        const newSets = parseInt(setsInput.value, 10) || ex.target_sets;
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
        if (newName !== ex.exercise_name) {
          loadTemplateExercises(templateId, container);
          return;
        }
        ex.exercise_name = newName;
        ex.target_sets = newSets;
        ex.target_reps = newReps;
        ex.notes = newNote || null;
        restoreDisplay(newName, newSets, newReps, ex.notes);
      };

      let saved = false;
      let blurEnabled = false;
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

      [nameInput, setsInput, repsInput, noteInput].forEach((input) => {
        input.addEventListener('blur', handleBlur);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { saved = true; saveEdit(); }
          if (ev.key === 'Escape') { saved = true; loadTemplateExercises(templateId, container); }
        });
        input.addEventListener('click', (ev) => ev.stopPropagation());
      });

      if (syncBtn) {
        let targetsIndependent = ex.targets_independent ? 1 : 0;
        syncBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const curSets = parseInt(setsInput.value, 10) || ex.target_sets;
          const curReps = repsInput.value.trim() || ex.target_reps;

          if (!targetsIndependent) {
            await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { targets_independent: 1 } });
            targetsIndependent = 1;
            ex.targets_independent = 1;
            syncBtn.className = 'sync-targets-btn is-independent';
            syncBtn.innerHTML = `${CHAIN_SVG_BROKEN}<span class="sync-targets-label">Targets independent</span>`;
          } else {
            const linked = await api(`/api/day-exercises/${deId}/linked-targets`);
            const syncedLinked = linked.filter((l) => !l.targets_independent);
            const differ = syncedLinked.some((l) => l.target_sets !== curSets || String(l.target_reps) !== curReps);

            if (differ && syncedLinked.length > 0) {
              const templatesList = syncedLinked.map((l) => l.template_name).join(', ');
              const confirmed = confirm(`This will update "${ex.exercise_name}" on ${templatesList} to ${curSets} sets × ${curReps} reps. Continue?`);
              if (!confirmed) return;
            }

            await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { targets_independent: 0, target_sets: curSets, target_reps: curReps } });
            targetsIndependent = 0;
            ex.targets_independent = 0;
            syncBtn.className = 'sync-targets-btn is-synced';
            syncBtn.innerHTML = `${CHAIN_SVG_LINKED}<span class="sync-targets-label">Targets synced</span>`;
          }
        });
      }
    });
  });

  container.querySelectorAll('.tmpl-move-up').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const idx = exercises.findIndex((ex) => ex.id === deId);
      if (idx <= 0) return;
      const ex = exercises[idx];
      const order = exercises.map((item) => item.id);
      const group = ex.superset_group;

      if (group != null) {
        const groupIndices = exercises.map((item, i) => item.superset_group === group ? i : -1).filter((i) => i >= 0);
        const isTopOfGroup = idx === groupIndices[0];
        if (isTopOfGroup) {
          const aboveIdx = groupIndices[0] - 1;
          const aboveEx = exercises[aboveIdx];
          if (aboveEx.superset_group != null) {
            const aboveGroupStart = exercises.findIndex((item) => item.superset_group === aboveEx.superset_group);
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(aboveGroupStart, 0, ...chunk);
          } else {
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(aboveIdx, 0, ...chunk);
          }
        } else {
          [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        }
      } else {
        const aboveEx = exercises[idx - 1];
        if (aboveEx.superset_group != null) {
          const aboveGroupStart = exercises.findIndex((item) => item.superset_group === aboveEx.superset_group);
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

  container.querySelectorAll('.tmpl-move-down').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const idx = exercises.findIndex((ex) => ex.id === deId);
      if (idx < 0 || idx >= exercises.length - 1) return;
      const ex = exercises[idx];
      const order = exercises.map((item) => item.id);
      const group = ex.superset_group;

      if (group != null) {
        const groupIndices = exercises.map((item, i) => item.superset_group === group ? i : -1).filter((i) => i >= 0);
        const isBottomOfGroup = idx === groupIndices[groupIndices.length - 1];
        if (isBottomOfGroup) {
          const belowIdx = groupIndices[groupIndices.length - 1] + 1;
          const belowEx = exercises[belowIdx];
          if (belowEx.superset_group != null) {
            const belowGroupIndices = exercises.map((item, i) => item.superset_group === belowEx.superset_group ? i : -1).filter((i) => i >= 0);
            const belowGroupEnd = belowGroupIndices[belowGroupIndices.length - 1];
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(belowGroupEnd - groupIndices.length + 1, 0, ...chunk);
          } else {
            const chunk = order.splice(groupIndices[0], groupIndices.length);
            order.splice(groupIndices[0] + 1, 0, ...chunk);
          }
        } else {
          [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        }
      } else {
        const belowEx = exercises[idx + 1];
        if (belowEx.superset_group != null) {
          const belowGroupIndices = exercises.map((item, i) => item.superset_group === belowEx.superset_group ? i : -1).filter((i) => i >= 0);
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

  container.querySelectorAll('.tmpl-ss-toggle').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const idx = exercises.findIndex((ex) => ex.id === deId);
      const ex = exercises[idx];
      const next = exercises[idx + 1];

      if (ex.superset_group != null) {
        const oldGroup = ex.superset_group;
        const groupMembers = exercises.filter((item) => item.superset_group === oldGroup);
        const lastInGroup = groupMembers[groupMembers.length - 1];
        await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { superset_group: null } });
        const firstInGroup = groupMembers[0];
        if (groupMembers.length >= 3 && ex.id !== firstInGroup.id && ex.id !== lastInGroup.id) {
          const lastIdx = exercises.findIndex((item) => item.id === lastInGroup.id);
          const order = exercises.map((item) => item.id);
          order.splice(idx, 1);
          order.splice(lastIdx, 0, deId);
          await api(`/api/templates/${templateId}/reorder`, { method: 'PUT', body: { order } });
        }
        const remaining = groupMembers.filter((item) => item.id !== deId);
        if (remaining.length === 1) {
          await api(`/api/day-exercises/${remaining[0].id}`, { method: 'PUT', body: { superset_group: null } });
        }
      } else if (next) {
        const groupNum = next.superset_group != null
          ? next.superset_group
          : (Math.max(0, ...exercises.filter((item) => item.superset_group != null).map((item) => item.superset_group)) + 1);
        await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { superset_group: groupNum } });
        if (next.superset_group == null) {
          await api(`/api/day-exercises/${next.id}`, { method: 'PUT', body: { superset_group: groupNum } });
        }
      }
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.tmpl-gs-toggle').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deId = parseInt(btn.dataset.deid, 10);
      const idx = exercises.findIndex((ex) => ex.id === deId);
      const prev = idx > 0 ? exercises[idx - 1] : null;
      const next = idx < exercises.length - 1 ? exercises[idx + 1] : null;

      const groupNum = (prev && prev.superset_group != null) ? prev.superset_group
        : (next && next.superset_group != null) ? next.superset_group
        : null;
      if (groupNum != null) {
        await api(`/api/day-exercises/${deId}`, { method: 'PUT', body: { superset_group: groupNum } });
      }
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.template-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/day-exercises/${btn.dataset.deid}`, { method: 'DELETE' });
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.archived-restore').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/day-exercises/${btn.dataset.deid}/restore`, { method: 'POST' });
      loadTemplateExercises(templateId, container);
    });
  });

  container.querySelectorAll('.archived-purge').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.archived-row');
      const name = row.querySelector('.archived-name').textContent.trim();
      if (!confirm(`Permanently delete "${name}" and all of its workout history?\n\nThis cannot be undone.`)) return;
      await api(`/api/day-exercises/${btn.dataset.deid}/permanent`, { method: 'DELETE' });
      loadTemplateExercises(templateId, container);
    });
  });

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

  document.getElementById(`add-btn-${templateId}`).addEventListener('click', async () => {
    const name = document.getElementById(`add-name-${templateId}`).value.trim();
    const sets = parseInt(document.getElementById(`add-sets-${templateId}`).value, 10) || 3;
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
