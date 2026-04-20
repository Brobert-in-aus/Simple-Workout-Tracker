import { api } from '../core/api.js';
import { todayStr } from '../core/dates.js';
import { showToast, openAppModal } from '../core/ui.js';

// Target range constants — hardcoded, not configurable
const CAL_RANGE  = 100; // ±kcal to be considered "on target"
const PROT_RANGE = 15;  // ±g protein to be considered "on target"

// Module-level state
let currentDate = todayStr();
let templates = null;
let targets = null;
let logData = null; // { logs: [], is_workout_day: bool, tdee_kcal: number|null }

// Per-session save tracking (reset on navigation)
let saveTimers = {};
let creatingSlots = {}; // guard against concurrent POST for same slot

export async function loadNutrition() {
  currentDate = todayStr();
  const container = document.getElementById('tab-nutrition');
  renderShell(container);
  await fetchAll();
  renderContent();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="nutrition-date-nav">
      <button id="nutr-prev" class="btn-icon">&larr;</button>
      <span id="nutr-date-display"></span>
      <button id="nutr-today" class="btn-icon btn-today">Today</button>
      <button id="nutr-next" class="btn-icon">&rarr;</button>
    </div>
    <div id="nutrition-content"></div>
  `;
  document.getElementById('nutr-prev').addEventListener('click', () => navigate(-1));
  document.getElementById('nutr-next').addEventListener('click', () => navigate(1));
  document.getElementById('nutr-today').addEventListener('click', () => {
    currentDate = todayStr();
    fetchDayAndRender();
  });
}

async function navigate(days) {
  const d = new Date(currentDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  currentDate = `${y}-${m}-${day}`;
  await fetchDayAndRender();
}

async function fetchAll() {
  [templates, targets, logData] = await Promise.all([
    api('/api/nutrition/templates'),
    api('/api/nutrition/targets'),
    api(`/api/nutrition/logs/${currentDate}`),
  ]);
}

async function fetchDayAndRender() {
  saveTimers = {};
  creatingSlots = {};
  logData = await api(`/api/nutrition/logs/${currentDate}`);
  renderContent();
}

function renderContent() {
  const el = document.getElementById('nutrition-content');
  if (!el) return;
  updateDateDisplay();

  const { logs, is_workout_day: isWorkout } = logData;
  const tgt = isWorkout ? targets.workout : targets.rest;

  const logByTemplate = {};
  const customLogs = [];
  for (const log of logs) {
    if (log.meal_template_id != null) logByTemplate[log.meal_template_id] = log;
    else customLogs.push(log);
  }

  const visible = (templates || []).filter(t => isWorkout || t.include_rest_day);
  const totals = calcTotals(logs);

  el.innerHTML = `
    <div class="nutrition-day-badge ${isWorkout ? 'training' : 'rest'}">
      ${isWorkout ? 'Training Day' : 'Rest Day'}
    </div>
    ${targetsBarHTML(tgt, totals)}
    <div id="nutrition-meals">
      ${visible.map(t => mealCardHTML(t, logByTemplate[t.id] ?? null, false)).join('')}
      ${customLogs.map(log => mealCardHTML(null, log, true)).join('')}
    </div>
    <button class="btn-add-meal" id="nutr-add-custom">+ Add Custom Meal</button>
    ${totalsHTML(totals, tgt, logData.tdee_kcal)}
    <button class="btn-link nutr-settings-btn" id="nutr-settings">&#9881; Meal Settings</button>
  `;

  wireMealCards();
  document.getElementById('nutr-add-custom').addEventListener('click', addCustomMeal);
  document.getElementById('nutr-settings').addEventListener('click', openSettingsModal);
}

function updateDateDisplay() {
  const el = document.getElementById('nutr-date-display');
  if (!el) return;
  const d = new Date(currentDate + 'T00:00:00');
  const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  el.textContent = currentDate === todayStr() ? `Today · ${label}` : label;
}

// --- Option A migration point ---
// In a future Option A, this would check template.preset_id and return the linked preset's macros.
// For now it just returns the slot's own default values.
function getSlotDefaults(template) {
  return {
    calories_kcal: template.calories_kcal,
    protein_g:     template.protein_g,
    carbs_g:       template.carbs_g,
    fat_g:         template.fat_g,
  };
}

// --- HTML builders ---

function mealCardHTML(template, log, isCustom) {
  const name = log ? log.meal_name : template.name;
  const logged = log != null;
  // use_defaults only applies to non-custom template slots
  const useDefaults = !isCustom && !!(template?.use_defaults);
  const tid     = template?.id ?? '';
  const lid     = log?.id ?? '';
  const sortOrd = template?.sort_order ?? (log?.sort_order ?? 0);

  let summaryContent, inputCal, inputProt, inputCarb, inputFat, confirmBtn;

  if (logged) {
    const { calories_kcal: cal, protein_g: prot, carbs_g: carb, fat_g: fat } = log;
    summaryContent = summaryHTML(cal, prot, carb, fat, true);
    inputCal = cal; inputProt = prot; inputCarb = carb; inputFat = fat;
    confirmBtn = useDefaults
      ? '<button class="meal-confirm-btn confirmed" title="Logged">&#10003;</button>'
      : '';
  } else if (useDefaults) {
    // Quick-confirm slot, unlogged: show dimmed defaults + confirm button
    const d = getSlotDefaults(template);
    summaryContent = summaryHTML(d.calories_kcal, d.protein_g, d.carbs_g, d.fat_g, false);
    inputCal = d.calories_kcal; inputProt = d.protein_g; inputCarb = d.carbs_g; inputFat = d.fat_g;
    confirmBtn = '<button class="meal-confirm-btn" title="Log with defaults">&#10003;</button>';
  } else {
    // Manual entry slot, unlogged: blank
    summaryContent = '<span class="summary-blank">&mdash;</span>';
    inputCal = 0; inputProt = 0; inputCarb = 0; inputFat = 0;
    confirmBtn = '';
  }

  return `
    <div class="meal-card ${logged ? 'logged' : 'unlogged'}${useDefaults ? ' use-defaults' : ''}"
         data-template-id="${tid}"
         data-log-id="${lid}"
         data-sort-order="${sortOrd}"
         data-is-custom="${isCustom ? '1' : '0'}"
         data-use-defaults="${useDefaults ? '1' : '0'}">
      <div class="meal-card-header">
        <span class="meal-name">${name}</span>
        <span class="meal-summary">${summaryContent}</span>
        ${confirmBtn}
        <button class="meal-delete-btn" title="Remove">&times;</button>
      </div>
      <div class="meal-card-body hidden">
        <div class="meal-macro-inputs">
          ${macroInputHTML('calories_kcal', 'Cal', inputCal)}
          ${macroInputHTML('protein_g',     'P g', inputProt)}
          ${macroInputHTML('carbs_g',       'C g', inputCarb)}
          ${macroInputHTML('fat_g',         'F g', inputFat)}
        </div>
      </div>
    </div>`;
}

function macroInputHTML(field, label, value) {
  return `
    <div class="macro-field">
      <label class="macro-label">${label}</label>
      <input type="number" class="macro-input" data-field="${field}"
             value="${Math.round(value)}" min="0" step="1" inputmode="numeric">
    </div>`;
}

function summaryHTML(cal, prot, carb, fat, logged) {
  const s = `${Math.round(cal)} kcal · ${Math.round(prot)}P ${Math.round(carb)}C ${Math.round(fat)}F`;
  return logged ? s : `<span class="summary-dim">${s}</span>`;
}

// Returns a CSS class reflecting whether val is within ±range of target.
// Returns '' when there's no meaningful data to compare.
function targetClass(val, target, range) {
  if (!target || !val) return '';
  const diff = val - target;
  if (Math.abs(diff) <= range) return 'target-hit';
  return diff < 0 ? 'target-low' : 'target-high';
}

function calcTotals(logs) {
  return logs.reduce(
    (acc, l) => ({
      cal:  acc.cal  + (l.calories_kcal || 0),
      prot: acc.prot + (l.protein_g     || 0),
      carb: acc.carb + (l.carbs_g       || 0),
      fat:  acc.fat  + (l.fat_g         || 0),
    }),
    { cal: 0, prot: 0, carb: 0, fat: 0 }
  );
}

function targetsBarHTML(tgt, totals) {
  const hasTargets = tgt && (tgt.calories || tgt.protein_g);
  if (!hasTargets) {
    return '<p class="nutrition-no-targets">Set macro targets in &#9881; Meal Settings</p>';
  }
  const pct       = tgt.calories > 0 ? Math.min(100, Math.round((totals.cal / tgt.calories) * 100)) : 0;
  const calClass  = targetClass(totals.cal,  tgt.calories,  CAL_RANGE);
  const protClass = targetClass(totals.prot, tgt.protein_g, PROT_RANGE);
  return `
    <div class="nutrition-targets-bar">
      <div class="targets-summary">
        <span class="${calClass}">${Math.round(totals.cal)} / ${tgt.calories} kcal</span>
        <span class="${protClass}">${Math.round(totals.prot)}/${tgt.protein_g}g P</span>
      </div>
      <div class="targets-progress-bar">
        <div class="targets-progress-fill ${calClass}" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function totalsHTML(totals, tgt, tdeeKcal) {
  const hasTargets = tgt && (tgt.calories || tgt.protein_g);
  const calClass  = hasTargets ? targetClass(totals.cal,  tgt.calories,  CAL_RANGE)  : '';
  const protClass = hasTargets ? targetClass(totals.prot, tgt.protein_g, PROT_RANGE) : '';

  const rows = [
    { label: 'Calories', val: Math.round(totals.cal),  tgtVal: tgt?.calories,  unit: 'kcal', cls: calClass },
    { label: 'Protein',  val: Math.round(totals.prot), tgtVal: tgt?.protein_g, unit: 'g',    cls: protClass },
  ];

  let deficitRow = '';
  if (tdeeKcal != null) {
    const actualDeficit = Math.round(totals.cal) - tdeeKcal;
    const defTgt        = tgt?.deficit_target ?? null;
    const defClass      = defTgt != null ? targetClass(actualDeficit, defTgt, CAL_RANGE) : '';
    const tgtStr        = defTgt != null ? ` / ${defTgt}` : '';
    deficitRow = `
      <div class="totals-row">
        <span class="totals-label">Deficit</span>
        <span class="totals-value ${defClass}">${actualDeficit}${tgtStr} kcal</span>
      </div>`;
  }

  return `
    <div class="nutrition-totals">
      <div class="nutrition-totals-title">Daily Total</div>
      ${rows.map(r => `
        <div class="totals-row">
          <span class="totals-label">${r.label}</span>
          <span class="totals-value ${r.cls}">${r.val}${hasTargets ? ` / ${r.tgtVal}` : ''} ${r.unit}</span>
        </div>`).join('')}
      ${deficitRow}
    </div>`;
}

// --- Card wiring ---

function wireMealCards() {
  document.querySelectorAll('.meal-card').forEach(card => wireCard(card));
}

function wireCard(card) {
  const header     = card.querySelector('.meal-card-header');
  const body       = card.querySelector('.meal-card-body');
  const deleteBtn  = card.querySelector('.meal-delete-btn');
  const confirmBtn = card.querySelector('.meal-confirm-btn');
  const tid        = card.dataset.templateId ? parseInt(card.dataset.templateId) : null;
  const isCustom   = card.dataset.isCustom === '1';

  if (confirmBtn) {
    confirmBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirmBtn.classList.contains('confirmed')) {
        // Already logged — clicking ✓ expands/collapses to edit
        const expanding = body.classList.contains('hidden');
        body.classList.toggle('hidden', !expanding);
        if (expanding) body.querySelector('.macro-input')?.focus();
      } else {
        // Unlogged quick-confirm: one-tap log with defaults
        const template = (templates || []).find(t => t.id === tid);
        if (template) confirmDefaultMeal(card, template);
      }
    });
  }

  header.addEventListener('click', e => {
    if (e.target === deleteBtn || e.target === confirmBtn) return;
    const expanding = body.classList.contains('hidden');
    body.classList.toggle('hidden', !expanding);
    if (expanding) body.querySelector('.macro-input')?.focus();
  });

  body.querySelectorAll('.macro-input').forEach(input => {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => scheduleSave(card, tid));
  });

  deleteBtn.addEventListener('click', e => {
    e.stopPropagation();
    handleDelete(card, tid, isCustom);
  });
}

function cardKey(card, tid) {
  return tid ? `t${tid}` : `l${card.dataset.logId}`;
}

function getCardValues(card) {
  const vals = {};
  card.querySelectorAll('.macro-input').forEach(inp => {
    vals[inp.dataset.field] = parseFloat(inp.value) || 0;
  });
  return vals;
}

function updateCardDisplay(card, values) {
  const { calories_kcal: cal = 0, protein_g: p = 0, carbs_g: c = 0, fat_g: f = 0 } = values;
  card.querySelector('.meal-summary').innerHTML = summaryHTML(cal, p, c, f, true);
  card.classList.remove('unlogged');
  card.classList.add('logged');
  // Transition confirm button to confirmed state if it's a quick-confirm slot
  const confirmBtn = card.querySelector('.meal-confirm-btn');
  if (confirmBtn && !confirmBtn.classList.contains('confirmed')) {
    confirmBtn.classList.add('confirmed');
    confirmBtn.title = 'Logged';
  }
}

function updateTotalsDisplay() {
  const allLogs = [];
  document.querySelectorAll('.meal-card.logged').forEach(card => {
    allLogs.push({
      calories_kcal: parseFloat(card.querySelector('[data-field="calories_kcal"]')?.value) || 0,
      protein_g:     parseFloat(card.querySelector('[data-field="protein_g"]')?.value)     || 0,
      carbs_g:       parseFloat(card.querySelector('[data-field="carbs_g"]')?.value)       || 0,
      fat_g:         parseFloat(card.querySelector('[data-field="fat_g"]')?.value)         || 0,
    });
  });
  const totals = calcTotals(allLogs);
  const isWorkout = logData?.is_workout_day;
  const tgt = isWorkout ? targets.workout : targets.rest;

  const tBar = document.querySelector('.nutrition-targets-bar, .nutrition-no-targets');
  if (tBar) tBar.outerHTML = targetsBarHTML(tgt, totals);

  const tot = document.querySelector('.nutrition-totals');
  if (tot) tot.outerHTML = totalsHTML(totals, tgt, logData?.tdee_kcal);
}

// --- Quick confirm (Option B) ---

async function confirmDefaultMeal(card, template) {
  const logId = card.dataset.logId ? parseInt(card.dataset.logId) : null;
  if (logId) return; // already logged
  const key = cardKey(card, template.id);
  if (creatingSlots[key]) return;

  const defaults = getSlotDefaults(template);

  creatingSlots[key] = true;
  try {
    const { id } = await api('/api/nutrition/logs', {
      method: 'POST',
      body: {
        date: currentDate,
        meal_template_id: template.id,
        meal_name: template.name,
        sort_order: parseInt(card.dataset.sortOrder) || 0,
        ...defaults,
      },
    });
    card.dataset.logId = id;
  } finally {
    creatingSlots[key] = false;
  }

  // Sync inputs with the confirmed defaults
  card.querySelectorAll('.macro-input').forEach(inp => {
    inp.value = Math.round(defaults[inp.dataset.field] || 0);
  });
  updateCardDisplay(card, defaults);
  updateTotalsDisplay();
}

// --- Save logic ---

function scheduleSave(card, tid) {
  const key = cardKey(card, tid);
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => performSave(card, tid), 500);
}

async function performSave(card, tid) {
  const key = cardKey(card, tid);
  const values = getCardValues(card);
  let logId = card.dataset.logId ? parseInt(card.dataset.logId) : null;

  if (!logId) {
    if (creatingSlots[key]) {
      // Re-schedule once creation is done
      saveTimers[key] = setTimeout(() => performSave(card, tid), 200);
      return;
    }
    creatingSlots[key] = true;
    try {
      const template = (templates || []).find(t => t.id === tid);
      const { id } = await api('/api/nutrition/logs', {
        method: 'POST',
        body: {
          date: currentDate,
          meal_template_id: tid ?? null,
          meal_name: template ? template.name : 'Custom Meal',
          sort_order: parseInt(card.dataset.sortOrder) || 0,
          ...values,
        },
      });
      logId = id;
      card.dataset.logId = id;
    } finally {
      creatingSlots[key] = false;
    }
    // Apply any value changes that arrived during creation
    const latestValues = getCardValues(card);
    const changed = Object.keys(latestValues).some(k => latestValues[k] !== values[k]);
    if (changed) {
      await api(`/api/nutrition/logs/${logId}`, { method: 'PUT', body: latestValues });
      updateCardDisplay(card, latestValues);
      updateTotalsDisplay();
      return;
    }
  } else {
    await api(`/api/nutrition/logs/${logId}`, { method: 'PUT', body: values });
  }

  updateCardDisplay(card, values);
  updateTotalsDisplay();
}

// --- Delete ---

async function handleDelete(card, tid, isCustom) {
  const logId = card.dataset.logId ? parseInt(card.dataset.logId) : null;
  if (logId) {
    await api(`/api/nutrition/logs/${logId}`, { method: 'DELETE' });
  }

  if (isCustom || !tid) {
    card.remove();
  } else {
    const template = (templates || []).find(t => t.id === tid);
    if (!template) { card.remove(); return; }

    const useDefaults = card.dataset.useDefaults === '1';
    card.dataset.logId = '';
    card.classList.remove('logged');
    card.classList.add('unlogged');

    if (useDefaults) {
      // Reset to dimmed defaults + restore unconfirmed ✓ button
      card.querySelector('.meal-summary').innerHTML = summaryHTML(
        template.calories_kcal, template.protein_g, template.carbs_g, template.fat_g, false
      );
      card.querySelectorAll('.macro-input').forEach(inp => {
        const f = inp.dataset.field;
        inp.value = Math.round(
          f === 'calories_kcal' ? template.calories_kcal :
          f === 'protein_g'     ? template.protein_g :
          f === 'carbs_g'       ? template.carbs_g : template.fat_g
        );
      });
      const confirmBtn = card.querySelector('.meal-confirm-btn');
      if (confirmBtn) {
        confirmBtn.classList.remove('confirmed');
        confirmBtn.title = 'Log with defaults';
      }
    } else {
      // Reset to blank
      card.querySelector('.meal-summary').innerHTML = '<span class="summary-blank">&mdash;</span>';
      card.querySelectorAll('.macro-input').forEach(inp => { inp.value = 0; });
    }

    card.querySelector('.meal-card-body').classList.add('hidden');
    const key = cardKey(card, tid);
    clearTimeout(saveTimers[key]);
    delete saveTimers[key];
  }
  updateTotalsDisplay();
}

// --- Add custom meal ---

async function addCustomMeal() {
  const name = prompt('Meal name:');
  if (!name?.trim()) return;

  const { id } = await api('/api/nutrition/logs', {
    method: 'POST',
    body: {
      date: currentDate,
      meal_template_id: null,
      meal_name: name.trim(),
      sort_order: 999,
      calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
    },
  });

  const tempLog = { id, meal_template_id: null, meal_name: name.trim(), sort_order: 999,
                    calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const html = mealCardHTML(null, tempLog, true);
  const container = document.getElementById('nutrition-meals');
  container.insertAdjacentHTML('beforeend', html);
  const card = container.lastElementChild;
  wireCard(card);

  // Expand immediately
  card.querySelector('.meal-card-body').classList.remove('hidden');
  card.querySelector('.macro-input')?.focus();
}

// --- Settings modal ---

async function openSettingsModal() {
  const [freshTemplates, freshTargets] = await Promise.all([
    api('/api/nutrition/templates'),
    api('/api/nutrition/targets'),
  ]);
  templates = freshTemplates;
  targets = freshTargets;
  renderSettingsModal(freshTemplates, freshTargets);
}

function renderSettingsModal(tmpl, tgt) {
  openAppModal('Meal Settings', settingsBodyHTML(tmpl, tgt));
  wireSettingsModal(tmpl, tgt);
}

function settingsBodyHTML(tmpl, tgt) {
  return `
    <div class="settings-section">
      <h4 class="settings-section-title">Meal Templates</h4>
      <div id="settings-templates-list">
        ${tmpl.map(t => templateRowHTML(t)).join('')}
      </div>
      <button class="btn-add-template" id="settings-add-template">+ Add Meal Slot</button>
    </div>
    <div class="settings-section">
      <h4 class="settings-section-title">Macro Targets</h4>
      <div class="targets-profiles">
        <div class="targets-profile">
          <div class="targets-profile-label">Training Day</div>
          ${targetFieldsHTML('workout', tgt.workout)}
        </div>
        <div class="targets-profile">
          <div class="targets-profile-label">Rest Day</div>
          ${targetFieldsHTML('rest', tgt.rest)}
        </div>
      </div>
      <button class="btn-save-targets" id="settings-save-targets">Save</button>
    </div>`;
}

function templateRowHTML(t) {
  return `
    <div class="template-row" data-id="${t.id}">
      <div class="template-row-top">
        <input class="tmpl-name" type="text" value="${t.name}" placeholder="Meal name">
        <label class="tmpl-rest-toggle">
          <input type="checkbox" class="tmpl-rest-check" ${t.include_rest_day ? 'checked' : ''}> Rest day
        </label>
        <label class="tmpl-quick-toggle">
          <input type="checkbox" class="tmpl-use-defaults-check" ${t.use_defaults ? 'checked' : ''}> Quick &#10003;
        </label>
        <button class="tmpl-delete btn-link text-warn">&#10005;</button>
      </div>
      <div class="template-row-macros">
        ${tmplMacroHTML('calories_kcal', 'Cal', t.calories_kcal)}
        ${tmplMacroHTML('protein_g',     'P g', t.protein_g)}
        ${tmplMacroHTML('carbs_g',       'C g', t.carbs_g)}
        ${tmplMacroHTML('fat_g',         'F g', t.fat_g)}
      </div>
    </div>`;
}

function tmplMacroHTML(field, label, value) {
  return `<div class="tmpl-macro-field">
    <label>${label}</label>
    <input type="number" class="tmpl-macro-input" data-field="${field}"
           value="${Math.round(value)}" min="0" step="1" inputmode="numeric">
  </div>`;
}

function targetFieldsHTML(profile, tgt) {
  // carbs_g and fat_g are stored in DB but hidden from UI for now
  return `
    <div class="target-field">
      <label>Calories (kcal)</label>
      <input type="number" class="target-input" data-profile="${profile}" data-field="calories"
             value="${tgt?.calories || 0}" min="0" step="1" inputmode="numeric">
    </div>
    <div class="target-field">
      <label>Protein (g)</label>
      <input type="number" class="target-input" data-profile="${profile}" data-field="protein_g"
             value="${tgt?.protein_g || 0}" min="0" step="1" inputmode="numeric">
    </div>
    <div class="target-field">
      <label>Deficit (kcal)</label>
      <input type="number" class="target-input" data-profile="${profile}" data-field="deficit_target"
             value="${tgt?.deficit_target ?? ''}" step="1" inputmode="numeric" placeholder="—">
    </div>`;
}

function wireSettingsModal(tmpl, tgt) {
  // Wire each template row
  document.querySelectorAll('.template-row').forEach(row => {
    const id = parseInt(row.dataset.id);
    const debouncedSave = makeDebounce(async () => {
      const fields = { name: row.querySelector('.tmpl-name').value.trim() || 'Meal' };
      row.querySelectorAll('.tmpl-macro-input').forEach(inp => {
        fields[inp.dataset.field] = parseFloat(inp.value) || 0;
      });
      fields.include_rest_day = row.querySelector('.tmpl-rest-check').checked ? 1 : 0;
      fields.use_defaults     = row.querySelector('.tmpl-use-defaults-check').checked ? 1 : 0;
      await api(`/api/nutrition/templates/${id}`, { method: 'PUT', body: fields });
      // Update local templates cache
      const t = (templates || []).find(x => x.id === id);
      if (t) Object.assign(t, fields);
    }, 600);

    row.querySelectorAll('.tmpl-name, .tmpl-macro-input').forEach(inp => inp.addEventListener('input', debouncedSave));
    row.querySelector('.tmpl-rest-check').addEventListener('change', debouncedSave);
    row.querySelector('.tmpl-use-defaults-check').addEventListener('change', debouncedSave);

    row.querySelector('.tmpl-delete').addEventListener('click', async () => {
      const name = row.querySelector('.tmpl-name').value || 'this meal';
      if (!confirm(`Delete "${name}"?`)) return;
      await api(`/api/nutrition/templates/${id}`, { method: 'DELETE' });
      templates = await api('/api/nutrition/templates');
      renderSettingsModal(templates, targets);
    });
  });

  document.getElementById('settings-add-template').addEventListener('click', async () => {
    const name = prompt('Meal name:');
    if (!name?.trim()) return;
    await api('/api/nutrition/templates', {
      method: 'POST',
      body: { name: name.trim(), calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, include_rest_day: 1, use_defaults: 0 },
    });
    templates = await api('/api/nutrition/templates');
    renderSettingsModal(templates, targets);
  });

  document.getElementById('settings-save-targets').addEventListener('click', async () => {
    // Seed with existing values so hidden fields (carbs_g, fat_g) are preserved
    const workout = { ...(targets.workout || {}) };
    const rest    = { ...(targets.rest    || {}) };
    document.querySelectorAll('.target-input').forEach(inp => {
      const obj = inp.dataset.profile === 'workout' ? workout : rest;
      const raw = inp.value.trim();
      // deficit_target is optional — blank means no target (null), not zero
      if (inp.dataset.field === 'deficit_target') {
        obj[inp.dataset.field] = raw === '' ? null : parseFloat(raw);
      } else {
        obj[inp.dataset.field] = parseFloat(raw) || 0;
      }
    });
    await api('/api/nutrition/targets', { method: 'PUT', body: { workout, rest } });
    targets = { workout, rest };
    showToast('Targets saved');
    renderContent(); // update progress bar with new targets
  });
}

function makeDebounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
