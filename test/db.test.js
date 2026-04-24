// Lightweight smoke tests for the DB layer.
// Uses Node's built-in node:test; no extra dependencies.
// Covers the failure-prone paths the Personal Improvements Plan calls out:
// workout creation, ad-hoc exercises, exercise swaps, trend aggregation,
// and bodyweight helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the DB at a disposable location BEFORE requiring database.js so the
// singleton opens the test database rather than the user's real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-smoke-'));
process.env.WORKOUT_DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../database');
const { runHealthImport, normalizeImportSource, validateImportSourceRoot } = require('../import-health');
db.getDb(); // initialise schema

test.after(() => {
  db.closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

// --- Helpers ---------------------------------------------------------------

function buildTemplate(templateName, exerciseSpecs) {
  const templateId = db.createTemplate(templateName);
  const deIds = [];
  exerciseSpecs.forEach((spec, idx) => {
    const exerciseId = db.getOrCreateExercise(spec.name);
    const id = db.addDayExercise(
      templateId,
      exerciseId,
      spec.targetSets ?? 3,
      spec.targetReps ?? '10',
      idx,
      spec.notes || null,
      spec.supersetGroup || null,
      !!spec.isWarmup,
      !!spec.isDuration,
      !!spec.isAmrap,
      !!spec.amrapLastOnly
    );
    deIds.push(id);
  });
  return { templateId, deIds };
}

function resetHealthImportAndScheduleState() {
  const sqlite = db.getDb();
  sqlite.prepare('DELETE FROM external_workout_links').run();
  sqlite.prepare('DELETE FROM external_workout_raw').run();
  sqlite.prepare('DELETE FROM external_workout_metrics').run();
  sqlite.prepare('DELETE FROM external_workouts').run();
  sqlite.prepare('DELETE FROM health_daily_metrics').run();
  sqlite.prepare('DELETE FROM workout_sets').run();
  sqlite.prepare('DELETE FROM workout_exercises').run();
  sqlite.prepare('DELETE FROM workouts').run();
  sqlite.prepare('DELETE FROM day_exercises').run();
  sqlite.prepare('DELETE FROM schedule').run();
  sqlite.prepare('DELETE FROM days').run();
}

// --- Workout creation ------------------------------------------------------

test('initWorkoutFromTemplate creates workout, exercises, and sets from template', () => {
  const { templateId } = buildTemplate('Smoke-Push', [
    { name: 'Smoke Bench Press', targetSets: 3, targetReps: '8' },
    { name: 'Smoke Overhead Press', targetSets: 2, targetReps: '10' },
  ]);

  const date = '2026-01-05';
  const workout = db.initWorkoutFromTemplate(date, templateId);
  assert.ok(workout.id, 'workout should have an id');

  const full = db.getWorkoutFull(workout.id);
  assert.equal(full.length, 2, 'expected two exercises');
  assert.equal(full[0].exercise_name, 'Smoke Bench Press');
  assert.equal(full[0].sets.length, 3);
  assert.equal(full[1].sets.length, 2);
  // First session -> no prior data -> reps default to parsed target_reps
  assert.equal(full[0].sets[0].target_reps, 8);
  assert.equal(full[0].sets[0].reps, 8);

  // Idempotent: calling again for the same date/template should not duplicate.
  db.initWorkoutFromTemplate(date, templateId);
  const after = db.getWorkoutFull(workout.id);
  assert.equal(after.length, 2, 'second init must not add exercises');
});

test('initWorkoutFromTemplate pre-fills from most recent session', () => {
  const { templateId } = buildTemplate('Smoke-Legs', [
    { name: 'Smoke Squat', targetSets: 3, targetReps: '5' },
  ]);

  // Previous session
  const prev = db.initWorkoutFromTemplate('2026-02-01', templateId);
  const prevFull = db.getWorkoutFull(prev.id);
  const prevWeId = prevFull[0].id;
  db.saveWorkoutExercise(prevWeId, [
    { weight: 100, reps: 5, target_reps: 5, completed: 1 },
    { weight: 100, reps: 5, target_reps: 5, completed: 1 },
    { weight: 100, reps: 4, target_reps: 5, completed: 1 },
  ]);

  // New session — should carry weights/reps from prev
  const next = db.initWorkoutFromTemplate('2026-02-04', templateId);
  const nextFull = db.getWorkoutFull(next.id);
  assert.equal(nextFull[0].sets[0].weight, 100);
  assert.equal(nextFull[0].sets[0].reps, 5);
  assert.equal(nextFull[0].sets[2].reps, 4, 'third set should carry reps from previous session');
});

// --- Ad-hoc exercise additions --------------------------------------------

test('addExerciseToWorkout inserts at requested position and shifts sort_order', () => {
  const { templateId } = buildTemplate('Smoke-Pull', [
    { name: 'Smoke Row', targetSets: 3, targetReps: '10' },
    { name: 'Smoke Pullup', targetSets: 3, targetReps: '8' },
  ]);

  const workout = db.initWorkoutFromTemplate('2026-03-01', templateId);
  const before = db.getWorkoutFull(workout.id);
  const rowSort = before[0].sort_order;

  // Insert right after the first exercise
  const newWeId = db.addExerciseToWorkout(
    workout.id,
    'Smoke Face Pull',
    3,
    '12',
    rowSort,
    false,
  );
  assert.ok(newWeId, 'should return new workout_exercise id');

  const after = db.getWorkoutFull(workout.id);
  assert.equal(after.length, 3);
  assert.equal(after[0].exercise_name, 'Smoke Row');
  assert.equal(after[1].exercise_name, 'Smoke Face Pull');
  assert.equal(after[2].exercise_name, 'Smoke Pullup');

  // Template must remain unchanged (is_adhoc=1 hides it)
  const templateExercises = db.getDayExercises(templateId);
  assert.equal(templateExercises.length, 2, 'ad-hoc add must not appear in template editor');
});

// --- Exercise swaps --------------------------------------------------------

test('swapWorkoutExercise sets and clears override_exercise_id', () => {
  const { templateId } = buildTemplate('Smoke-Swap', [
    { name: 'Smoke Barbell Curl', targetSets: 3, targetReps: '10' },
  ]);
  const workout = db.initWorkoutFromTemplate('2026-03-08', templateId);
  const full = db.getWorkoutFull(workout.id);
  const weId = full[0].id;

  db.swapWorkoutExercise(weId, 'Smoke Dumbbell Curl');
  const swapped = db.getWorkoutFull(workout.id)[0];
  assert.equal(swapped.override_exercise_name, 'Smoke Dumbbell Curl');

  db.swapWorkoutExercise(weId, null);
  const cleared = db.getWorkoutFull(workout.id)[0];
  assert.equal(cleared.override_exercise_name, null);
});

// --- Trend aggregation -----------------------------------------------------

test('getExerciseTrend produces volume and completion, excluding warmups', () => {
  const { templateId, deIds } = buildTemplate('Smoke-Trend', [
    { name: 'Smoke Warmup Bench', targetSets: 1, targetReps: '10', isWarmup: true },
    { name: 'Smoke Trend Bench', targetSets: 3, targetReps: '8' },
  ]);

  // Session 1
  const w1 = db.initWorkoutFromTemplate('2026-04-01', templateId);
  const s1 = db.getWorkoutFull(w1.id);
  // warmup set — should be ignored by the trend
  db.saveWorkoutExercise(s1[0].id, [
    { weight: 20, reps: 10, target_reps: 10, completed: 1 },
  ]);
  // main sets
  db.saveWorkoutExercise(s1[1].id, [
    { weight: 80, reps: 8, target_reps: 8, completed: 1 },
    { weight: 80, reps: 8, target_reps: 8, completed: 1 },
    { weight: 80, reps: 6, target_reps: 8, completed: 1 },
  ]);

  // Session 2 — one AMRAP set and a missed one
  const w2 = db.initWorkoutFromTemplate('2026-04-04', templateId);
  const s2 = db.getWorkoutFull(w2.id);
  db.saveWorkoutExercise(s2[1].id, [
    { weight: 82.5, reps: 8, target_reps: 8, completed: 1 },
    { weight: 82.5, reps: 8, target_reps: 8, completed: 1 },
    { weight: 82.5, reps: 12, target_reps: 8, completed: 1, is_amrap: 1 },
  ]);

  // Resolve the underlying exercise id for the main lift
  const deRow = db.getDb()
    .prepare('SELECT exercise_id FROM day_exercises WHERE id = ?')
    .get(deIds[1]);
  const trend = db.getExerciseTrend(deRow.exercise_id);

  assert.equal(trend.length, 2, 'one point per session date');
  assert.equal(trend[0].date, '2026-04-01');
  assert.equal(trend[1].date, '2026-04-04');

  // Session 1 volume: 80*8 + 80*8 + 80*6 = 1760
  assert.equal(trend[0].total_volume, 1760);
  // Session 1 completion: (1 + 1 + 6/8) / 3 = 0.9166... -> 92%
  assert.equal(trend[0].completion_pct, 92);

  // Session 2 volume: 82.5*(8+8+12) = 2310
  assert.equal(trend[1].total_volume, 2310);
  // Session 2 completion: (1 + 1 + 1 AMRAP) / 3 = 100%
  assert.equal(trend[1].completion_pct, 100);
});

test('getPerformedExercises excludes warmups and skipped exercises', () => {
  const { templateId, deIds } = buildTemplate('Smoke-Performed', [
    { name: 'Smoke Performed Warmup', targetSets: 1, targetReps: '10', isWarmup: true },
    { name: 'Smoke Performed Main', targetSets: 3, targetReps: '8' },
  ]);

  const w = db.initWorkoutFromTemplate('2026-05-02', templateId);
  const full = db.getWorkoutFull(w.id);

  // Warmup has a completed set — should still be excluded from performed list
  db.saveWorkoutExercise(full[0].id, [
    { weight: 20, reps: 10, target_reps: 10, completed: 1 },
  ]);
  db.saveWorkoutExercise(full[1].id, [
    { weight: 60, reps: 8, target_reps: 8, completed: 1 },
  ]);

  const performed = db.getPerformedExercises();
  const names = performed.map(p => p.name);
  assert.ok(names.includes('Smoke Performed Main'), 'main lift appears');
  assert.ok(!names.includes('Smoke Performed Warmup'), 'warmup must be excluded');
});

// --- Template duplication naming ------------------------------------------

test('duplicateTemplate auto-numbers repeated copies', () => {
  const { templateId } = buildTemplate('DupSeries', [
    { name: 'DupSeries Lift', targetSets: 3, targetReps: '5' },
  ]);

  const first = db.duplicateTemplate(templateId);
  assert.equal(first.name, 'DupSeries Copy');

  const second = db.duplicateTemplate(templateId);
  assert.equal(second.name, 'DupSeries Copy 2');

  // Duplicating one of the copies should strip the suffix, not stack it.
  const third = db.duplicateTemplate(first.id);
  assert.equal(third.name, 'DupSeries Copy 3');
});

test('duplicateTemplate respects explicit unique names', () => {
  const { templateId } = buildTemplate('DupExplicit', [
    { name: 'DupExplicit Lift', targetSets: 1, targetReps: '5' },
  ]);
  const out = db.duplicateTemplate(templateId, 'DupExplicit Alt');
  assert.equal(out.name, 'DupExplicit Alt');
});

// --- Bodyweight helpers ----------------------------------------------------

test('bodyweight helpers insert, upsert, list, and delete', () => {
  // Start from a clean slate so ordering assertions are stable.
  db.getDb().prepare('DELETE FROM body_weights').run();

  db.logBodyWeight('2026-01-10', 80.5);
  db.logBodyWeight('2026-01-12', 80.2);
  db.logBodyWeight('2026-01-15', 79.8);

  let rows = db.getBodyWeights();
  assert.equal(rows.length, 3);
  // Returned DESC by date
  assert.equal(rows[0].date, '2026-01-15');
  assert.equal(rows[2].date, '2026-01-10');

  // Upsert on conflict (same date)
  db.logBodyWeight('2026-01-12', 81.0);
  rows = db.getBodyWeights();
  assert.equal(rows.length, 3, 'upsert must not add a duplicate row');
  const jan12 = rows.find(r => r.date === '2026-01-12');
  assert.equal(jan12.weight_kg, 81.0);

  db.deleteBodyWeight('2026-01-12');
  rows = db.getBodyWeights();
  assert.equal(rows.length, 2);
  assert.ok(!rows.some(r => r.date === '2026-01-12'));
});

test('health daily metrics upsert and TDEE lookup work by date', () => {
  db.upsertHealthDailyMetrics({
    date: '2026-04-20',
    sourceType: 'apple_health',
    activeEnergyKj: 3200,
    restingEnergyKj: 8400,
    activeEnergyKcal: 764.8,
    restingEnergyKcal: 2007.6,
    tdeeKcal: 2772.4,
    sampleCountActive: 1,
    sampleCountResting: 1,
    sourceFile: 'sample.json',
  });

  let row = db.getHealthDailyMetricsByDate('2026-04-20');
  assert.equal(row.sample_count_active, 1);
  assert.equal(db.getDailyTdee('2026-04-20'), 2772);

  db.upsertHealthDailyMetrics({
    date: '2026-04-20',
    sourceType: 'apple_health',
    activeEnergyKj: 4000,
    restingEnergyKj: 8000,
    activeEnergyKcal: 956.0,
    restingEnergyKcal: 1912.0,
    tdeeKcal: 2868.0,
    sampleCountActive: 2,
    sampleCountResting: 2,
    sourceFile: 'sample-2.json',
  });

  row = db.getHealthDailyMetricsByDate('2026-04-20');
  assert.equal(row.import_source_file, 'sample-2.json');
  assert.equal(row.sample_count_active, 2);
  assert.equal(db.getDailyTdee('2026-04-20'), 2868);
});

test('macro TDEE context applies Apple Health functional strength correction factor', () => {
  db.setAppleHealthEnergyAdjustments({ functional_strength_training_factor: 0.5 });
  db.upsertHealthDailyMetrics({
    date: '2026-04-21',
    sourceType: 'apple_health',
    activeEnergyKj: 4184,
    restingEnergyKj: 8368,
    activeEnergyKcal: 1000,
    restingEnergyKcal: 2000,
    tdeeKcal: 3000,
    sampleCountActive: 1,
    sampleCountResting: 1,
    sourceFile: 'macro-context.json',
    sourceSnapshotDate: '2026-04-22',
  });
  const workoutResult = db.upsertExternalWorkout({
    sourceType: 'apple_health',
    externalId: 'fst-correction-test',
    workoutType: 'Functional Strength Training',
    name: 'Functional Strength Training',
    date: '2026-04-21',
    startAt: '2026-04-21T07:00:00+10:00',
    endAt: '2026-04-21T08:00:00+10:00',
    durationSeconds: 3600,
    isIndoor: 1,
    locationLabel: 'Indoor',
    sourceFile: 'macro-context.json',
    sourceSnapshotDate: '2026-04-22',
    matchStatus: 'imported_standalone',
  }, 'summary');
  db.replaceExternalWorkoutMetrics(workoutResult.id, {
    active_energy_kcal: 400,
  });

  const context = db.getMacroTdeeContextForDate('2026-04-21');
  assert.equal(context.active_energy_kcal_raw, 1000);
  assert.equal(context.active_energy_adjustment_kcal, -200);
  assert.equal(context.active_energy_kcal, 800);
  assert.equal(context.tdee_kcal, 2800);
  assert.equal(context.apple_health_adjustments.functional_strength_training_factor, 0.5);
  db.setAppleHealthEnergyAdjustments({ functional_strength_training_factor: 1 });
});

test('macro TDEE context falls back to recent same day-type Apple history when current date is missing', () => {
  resetHealthImportAndScheduleState();
  const tuesdayTemplateId = db.createTemplate('Tuesday Program');
  db.addScheduleEntry(1, tuesdayTemplateId);

  for (const [date, active, resting] of [
    ['2026-04-07', 600, 1900],
    ['2026-04-14', 700, 2000],
    ['2026-04-21', 800, 2100],
  ]) {
    db.initWorkoutFromTemplate(date, tuesdayTemplateId);
    db.upsertHealthDailyMetrics({
      date,
      sourceType: 'apple_health',
      activeEnergyKj: active * 4.184,
      restingEnergyKj: resting * 4.184,
      activeEnergyKcal: active,
      restingEnergyKcal: resting,
      tdeeKcal: active + resting,
      sampleCountActive: 1,
      sampleCountResting: 1,
      sourceFile: 'fallback-same-type.json',
      sourceSnapshotDate: '2026-04-22',
    });
  }

  const context = db.getMacroTdeeContextForDate('2026-04-28');
  assert.equal(context.source, 'fallback_same_day_type');
  assert.equal(context.fallback_sample_count, 3);
  assert.equal(context.fallback_day_type, 'workout');
  assert.equal(context.active_energy_kcal, 700);
  assert.equal(context.resting_energy_kcal, 2000);
  assert.equal(context.tdee_kcal, 2700);
});

test('macro TDEE context falls back to recent Apple history when there are too few same day-type rows', () => {
  resetHealthImportAndScheduleState();
  const fridayTemplateId = db.createTemplate('Friday Program');
  db.addScheduleEntry(4, fridayTemplateId);

  db.initWorkoutFromTemplate('2026-04-17', fridayTemplateId);
  db.upsertHealthDailyMetrics({
    date: '2026-04-17',
    sourceType: 'apple_health',
    activeEnergyKj: 900 * 4.184,
    restingEnergyKj: 2100 * 4.184,
    activeEnergyKcal: 900,
    restingEnergyKcal: 2100,
    tdeeKcal: 3000,
    sampleCountActive: 1,
    sampleCountResting: 1,
    sourceFile: 'fallback-recent.json',
    sourceSnapshotDate: '2026-04-20',
  });
  for (const [date, active, resting] of [
    ['2026-04-18', 300, 1800],
    ['2026-04-19', 400, 1900],
  ]) {
    db.upsertHealthDailyMetrics({
      date,
      sourceType: 'apple_health',
      activeEnergyKj: active * 4.184,
      restingEnergyKj: resting * 4.184,
      activeEnergyKcal: active,
      restingEnergyKcal: resting,
      tdeeKcal: active + resting,
      sampleCountActive: 1,
      sampleCountResting: 1,
      sourceFile: 'fallback-recent.json',
      sourceSnapshotDate: '2026-04-20',
    });
  }

  const context = db.getMacroTdeeContextForDate('2026-04-24');
  assert.equal(context.source, 'fallback_recent');
  assert.equal(context.fallback_sample_count, 3);
  assert.equal(context.fallback_day_type, 'workout');
  assert.equal(context.active_energy_kcal, 533.3);
  assert.equal(context.resting_energy_kcal, 1933.3);
  assert.equal(context.tdee_kcal, 2466.7);
});

test('nutrition summary range aggregates macro logs, targets, and fallback health context', () => {
  resetHealthImportAndScheduleState();
  const sqlite = db.getDb();
  sqlite.prepare('DELETE FROM macro_logs').run();
  sqlite.prepare('DELETE FROM meal_templates').run();
  sqlite.prepare('DELETE FROM user_settings').run();

  const tuesdayTemplateId = db.createTemplate('Summary Tuesday');
  db.addScheduleEntry(1, tuesdayTemplateId);
  db.initWorkoutFromTemplate('2026-04-21', tuesdayTemplateId);

  db.setUserSetting('macro_targets_workout', JSON.stringify({ calories: 2200, protein_g: 180, energy_target: -400 }));
  db.setUserSetting('macro_targets_rest', JSON.stringify({ calories: 1900, protein_g: 160, energy_target: -300 }));

  db.createMacroLog({
    date: '2026-04-20',
    meal_name: 'Rest Meals',
    calories_kcal: 1800,
    protein_g: 165,
    carbs_g: 0,
    fat_g: 0,
  });
  db.createMacroLog({
    date: '2026-04-21',
    meal_name: 'Workout Meals',
    calories_kcal: 2100,
    protein_g: 175,
    carbs_g: 0,
    fat_g: 0,
  });

  for (const [date, active, resting] of [
    ['2026-04-19', 300, 1700],
    ['2026-04-20', 400, 1800],
    ['2026-04-21', 700, 2000],
  ]) {
    db.upsertHealthDailyMetrics({
      date,
      sourceType: 'apple_health',
      activeEnergyKj: active * 4.184,
      restingEnergyKj: resting * 4.184,
      activeEnergyKcal: active,
      restingEnergyKcal: resting,
      tdeeKcal: active + resting,
      sampleCountActive: 1,
      sampleCountResting: 1,
      sourceFile: 'summary-range.json',
      sourceSnapshotDate: '2026-04-22',
    });
  }

  const summary = db.getNutritionSummaryForRange('2026-04-20', '2026-04-22');
  assert.equal(summary.summary.total_days, 3);
  assert.equal(summary.summary.logged_days, 2);
  assert.equal(summary.summary.direct_health_days, 2);
  assert.equal(summary.summary.estimated_health_days, 1);
  assert.equal(summary.summary.avg_calories_kcal, 1950);
  assert.equal(summary.summary.avg_protein_g, 170);
  assert.equal(summary.summary.energy_target_hit_days, 1);

  const day21 = summary.days.find(day => day.date === '2026-04-21');
  assert.equal(day21.is_workout_day, true);
  assert.equal(day21.target_energy_kcal, -400);
  assert.equal(day21.health_source, 'apple_health');

  const day22 = summary.days.find(day => day.date === '2026-04-22');
  assert.equal(day22.is_workout_day, false);
  assert.equal(day22.health_source, 'fallback_recent');
  assert.equal(day22.tdee_kcal, 2300);
  assert.equal(day22.energy_balance_kcal, null);
});

test('template macro logs upsert by date and template without duplicating rows', () => {
  const sqlite = db.getDb();
  sqlite.prepare('DELETE FROM macro_logs').run();
  sqlite.prepare('DELETE FROM meal_templates').run();

  const mealTemplateId = db.createMealTemplate({
    name: 'Upsert Lunch',
    calories_kcal: 500,
    protein_g: 40,
  });

  const firstId = db.upsertMacroLogForTemplateDate({
    date: '2026-04-23',
    meal_template_id: mealTemplateId,
    meal_name: 'Upsert Lunch',
    sort_order: 1,
    calories_kcal: 500,
    protein_g: 40,
  });
  const secondId = db.upsertMacroLogForTemplateDate({
    date: '2026-04-23',
    meal_template_id: mealTemplateId,
    meal_name: 'Upsert Lunch Updated',
    sort_order: 2,
    calories_kcal: 650,
    protein_g: 55,
  });

  assert.equal(secondId, firstId);
  const rows = db.getMacroLogsForDate('2026-04-23');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meal_name, 'Upsert Lunch Updated');
  assert.equal(rows[0].sort_order, 2);
  assert.equal(rows[0].calories_kcal, 650);
  assert.equal(rows[0].protein_g, 55);

  db.createMacroLog({
    date: '2026-04-23',
    meal_template_id: null,
    meal_name: 'Custom A',
    sort_order: 999,
  });
  db.createMacroLog({
    date: '2026-04-23',
    meal_template_id: null,
    meal_name: 'Custom B',
    sort_order: 999,
  });
  assert.equal(db.getMacroLogsForDate('2026-04-23').length, 3);
});

test('merged history includes standalone external workouts', () => {
  const { templateId } = buildTemplate('Smoke-History-Tracked', [
    { name: 'Smoke History Lift', targetSets: 3, targetReps: '8' },
  ]);
  db.initWorkoutFromTemplate('2026-06-01', templateId);

  const externalResult = db.upsertExternalWorkout({
    sourceType: 'apple_health',
    externalId: 'ext-standalone-1',
    workoutType: 'Indoor Walk',
    name: 'Indoor Walk',
    date: '2026-06-02',
    startAt: '2026-06-02T08:00:00+10:00',
    endAt: '2026-06-02T08:30:00+10:00',
    durationSeconds: 1800,
    isIndoor: 1,
    locationLabel: 'Indoor',
    sourceFile: 'sample.json',
    matchStatus: 'imported_standalone',
  }, 'summary');
  db.replaceExternalWorkoutMetrics(externalResult.id, { active_energy_kcal: 200 });

  const history = db.getAllWorkoutDates();
  assert.ok(history.some(item => item.item_type === 'tracked_workout' && item.date === '2026-06-01'));
  assert.ok(history.some(item => item.item_type === 'external_workout' && item.date === '2026-06-02'));
});

test('full raw workout storage writes a JSON file into the health-raw/workouts subfolder', () => {
  const externalResult = db.upsertExternalWorkout({
    sourceType: 'apple_health',
    externalId: 'raw-storage-test',
    workoutType: 'Indoor Walk',
    name: 'Indoor Walk',
    date: '2026-06-03',
    startAt: '2026-06-03T08:00:00+10:00',
    endAt: '2026-06-03T08:30:00+10:00',
    durationSeconds: 1800,
    isIndoor: 1,
    locationLabel: 'Indoor',
    sourceFile: 'sample.json',
    matchStatus: 'imported_standalone',
  }, 'full');

  db.replaceExternalWorkoutRaw(externalResult.id, {
    heartRateData: [{ Avg: 120, date: '2026-06-03 08:01:00 +1000' }],
    activeEnergy: [{ qty: 10, units: 'kJ', date: '2026-06-03 08:01:00 +1000' }],
  });

  const rawFile = path.join(tmpDir, 'health-raw', 'workouts', 'raw-storage-test.json');
  assert.ok(fs.existsSync(rawFile), 'expected raw workout JSON file to exist');

  const payload = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  assert.equal(payload.external_id, 'raw-storage-test');
  assert.ok(Array.isArray(payload.metrics.heartRateData));

  const refRow = db.getDb()
    .prepare('SELECT metric_key, json_payload FROM external_workout_raw WHERE external_workout_id = ?')
    .get(externalResult.id);
  assert.equal(refRow.metric_key, 'workout_file');
  assert.ok(JSON.parse(refRow.json_payload).relative_path.includes(path.join('health-raw', 'workouts')));
});

test('uploaded snapshot import skips the latest metric date in the file', () => {
  resetHealthImportAndScheduleState();
  const source = normalizeImportSource('upload.json', {
    data: {
      workouts: [],
      metrics: [
        {
          name: 'active_energy',
          units: 'kJ',
          data: [
            { date: '2026-04-18 00:00:00 +1000', qty: 1000 },
            { date: '2026-04-19 00:00:00 +1000', qty: 1100 },
          ],
        },
        {
          name: 'basal_energy_burned',
          units: 'kJ',
          data: [
            { date: '2026-04-18 00:00:00 +1000', qty: 8000 },
            { date: '2026-04-19 00:00:00 +1000', qty: 8100 },
          ],
        },
      ],
    },
  });

  const summary = runHealthImport({ dryRun: false, level: 'summary' }, [source]);
  assert.equal(summary.metric_dates_aggregated, 1);
  assert.deepEqual(summary.latest_metric_dates_skipped, ['2026-04-19']);
  assert.equal(summary.metric_dates_skipped_latest, 1);
  assert.equal(db.getHealthDailyMetricsByDate('2026-04-19'), null);
  assert.ok(db.getHealthDailyMetricsByDate('2026-04-18'));
});

test('validateImportSourceRoot rejects wrong-shape uploads clearly', () => {
  assert.throws(
    () => validateImportSourceRoot({ hello: 'world' }),
    /missing both data\.workouts and data\.metrics/i
  );
  assert.throws(
    () => validateImportSourceRoot({ data: { workouts: 'nope' } }),
    /invalid data\.workouts/i
  );
});

test('newer snapshot updates an existing daily metric row while older snapshot is skipped as stale', () => {
  const newer = normalizeImportSource('newer.json', {
    data: {
      workouts: [],
      metrics: [
        {
          name: 'active_energy',
          units: 'kJ',
          data: [
            { date: '2026-07-18 00:00:00 +1000', qty: 1200 },
            { date: '2026-07-21 00:00:00 +1000', qty: 1300 },
          ],
        },
        {
          name: 'basal_energy_burned',
          units: 'kJ',
          data: [
            { date: '2026-07-18 00:00:00 +1000', qty: 8200 },
            { date: '2026-07-21 00:00:00 +1000', qty: 8300 },
          ],
        },
      ],
    },
  });
  const older = normalizeImportSource('older.json', {
    data: {
      workouts: [],
      metrics: [
        {
          name: 'active_energy',
          units: 'kJ',
          data: [
            { date: '2026-07-18 00:00:00 +1000', qty: 900 },
            { date: '2026-07-20 00:00:00 +1000', qty: 800 },
          ],
        },
        {
          name: 'basal_energy_burned',
          units: 'kJ',
          data: [
            { date: '2026-07-18 00:00:00 +1000', qty: 7800 },
            { date: '2026-07-20 00:00:00 +1000', qty: 7700 },
          ],
        },
      ],
    },
  });

  const firstSummary = runHealthImport({ dryRun: false, level: 'summary' }, [newer]);
  assert.equal(firstSummary.health_daily_metrics_inserted, 1);
  const before = db.getHealthDailyMetricsByDate('2026-07-18');
  assert.equal(before.source_snapshot_date, '2026-07-21');

  const secondSummary = runHealthImport({ dryRun: false, level: 'summary' }, [older]);
  const after = db.getHealthDailyMetricsByDate('2026-07-18');
  assert.equal(secondSummary.health_daily_metrics_skipped_stale, 1);
  assert.equal(after.source_snapshot_date, '2026-07-21');
  assert.equal(after.active_energy_kj, before.active_energy_kj);
});

test('dry-run summary reports distinct new-data days across workouts and metrics', () => {
  const source = normalizeImportSource('summary-days.json', {
    data: {
      workouts: [
        {
          id: 'summary-workout-1',
          name: 'Outdoor Walk',
          start: '2026-08-03 07:00:00 +1000',
          end: '2026-08-03 07:30:00 +1000',
          duration: 1800,
          activeEnergyBurned: { qty: 250, units: 'kcal' },
        },
      ],
      metrics: [
        {
          name: 'active_energy',
          units: 'kJ',
          data: [
            { date: '2026-08-02 00:00:00 +1000', qty: 1200 },
            { date: '2026-08-03 00:00:00 +1000', qty: 1300 },
          ],
        },
        {
          name: 'basal_energy_burned',
          units: 'kJ',
          data: [
            { date: '2026-08-02 00:00:00 +1000', qty: 8200 },
            { date: '2026-08-03 00:00:00 +1000', qty: 8300 },
          ],
        },
      ],
    },
  });

  const summary = runHealthImport({ dryRun: true, level: 'summary' }, [source]);
  assert.equal(summary.new_data_day_count, 2);
  assert.equal(summary.new_workout_day_count, 1);
  assert.equal(summary.new_metric_day_count, 1);
  assert.deepEqual(summary.sample_new_data_dates, ['2026-08-02', '2026-08-03']);
});

test('dry-run summary shows no new data when snapshot is older than stored rows', () => {
  db.upsertHealthDailyMetrics({
    date: '2026-09-02',
    sourceType: 'apple_health',
    activeEnergyKj: 1500,
    restingEnergyKj: 8000,
    activeEnergyKcal: 358.5,
    restingEnergyKcal: 1912.0,
    tdeeKcal: 2270.5,
    sampleCountActive: 1,
    sampleCountResting: 1,
    sourceFile: 'newest.json',
    sourceSnapshotDate: '2026-09-04',
  });

  const older = normalizeImportSource('older-preview.json', {
    data: {
      workouts: [],
      metrics: [
        {
          name: 'active_energy',
          units: 'kJ',
          data: [
            { date: '2026-09-02 00:00:00 +1000', qty: 900 },
            { date: '2026-09-03 00:00:00 +1000', qty: 950 },
          ],
        },
        {
          name: 'basal_energy_burned',
          units: 'kJ',
          data: [
            { date: '2026-09-02 00:00:00 +1000', qty: 7600 },
            { date: '2026-09-03 00:00:00 +1000', qty: 7700 },
          ],
        },
      ],
    },
  });

  const summary = runHealthImport({ dryRun: true, level: 'summary' }, [older]);
  assert.equal(summary.new_data_day_count, 0);
  assert.equal(summary.new_workout_day_count, 0);
  assert.equal(summary.new_metric_day_count, 0);
  assert.deepEqual(summary.sample_new_data_dates, []);
  assert.equal(summary.health_daily_metrics_skipped_stale, 1);
});

test('identical snapshot preview reports no new data after import', () => {
  const templateId = db.createTemplate('Preview Schedule');
  db.addScheduleEntry(0, templateId);

  const source = normalizeImportSource('identical.json', {
    data: {
      workouts: [
        {
          id: 'identical-workout-1',
          name: 'Functional Strength Training',
          start: '2026-10-05 07:00:00 +1000',
          end: '2026-10-05 07:30:00 +1000',
          duration: 1800,
          activeEnergyBurned: { qty: 200, units: 'kcal' },
        },
      ],
      metrics: [
        {
          name: 'active_energy',
          units: 'kJ',
          data: [
            { date: '2026-10-04 00:00:00 +1000', qty: 1000 },
            { date: '2026-10-05 00:00:00 +1000', qty: 1100 },
          ],
        },
        {
          name: 'basal_energy_burned',
          units: 'kJ',
          data: [
            { date: '2026-10-04 00:00:00 +1000', qty: 8000 },
            { date: '2026-10-05 00:00:00 +1000', qty: 8100 },
          ],
        },
      ],
    },
  });

  const firstImport = runHealthImport({ dryRun: false, level: 'summary' }, [source]);
  assert.equal(firstImport.new_data_day_count, 2);

  const preview = runHealthImport({ dryRun: true, level: 'summary' }, [source]);
  assert.equal(preview.new_data_day_count, 0);
  assert.equal(preview.external_workouts_inserted, 0);
  assert.equal(preview.external_workouts_updated, 0);
  assert.equal(preview.health_daily_metrics_inserted, 0);
  assert.equal(preview.health_daily_metrics_updated, 0);
});

test('nutrition day type uses recorded workouts for past dates and schedule for current or future dates', () => {
  const mondayTemplateId = db.createTemplate('Monday Plan');
  const tuesdayTemplateId = db.createTemplate('Tuesday Plan');
  db.addScheduleEntry(0, mondayTemplateId);
  db.addScheduleEntry(1, tuesdayTemplateId);

  assert.equal(db.isWorkoutDayForNutrition('2026-04-20', '2026-04-21'), false);
  db.initWorkoutFromTemplate('2026-04-20', mondayTemplateId);
  assert.equal(db.isWorkoutDayForNutrition('2026-04-20', '2026-04-21'), true);

  assert.equal(db.isWorkoutDayForNutrition('2026-04-21', '2026-04-21'), true);
  assert.equal(db.isWorkoutDayForNutrition('2026-04-28', '2026-04-21'), true);
});

test('newer snapshot updates an existing external workout row', () => {
  const externalId = 'overwrite-workout-test';
  const base = db.upsertExternalWorkout({
    sourceType: 'apple_health',
    externalId,
    workoutType: 'Indoor Walk',
    name: 'Indoor Walk',
    date: '2026-04-18',
    startAt: '2026-04-18T08:00:00+10:00',
    endAt: '2026-04-18T08:30:00+10:00',
    durationSeconds: 1800,
    isIndoor: 1,
    locationLabel: 'Indoor',
    sourceFile: 'older.json',
    sourceSnapshotDate: '2026-04-18',
    matchStatus: 'imported_standalone',
  }, 'summary');
  assert.equal(base.applied, true);

  const newer = db.upsertExternalWorkout({
    sourceType: 'apple_health',
    externalId,
    workoutType: 'Indoor Walk',
    name: 'Indoor Walk',
    date: '2026-04-18',
    startAt: '2026-04-18T08:00:00+10:00',
    endAt: '2026-04-18T08:45:00+10:00',
    durationSeconds: 2700,
    isIndoor: 1,
    locationLabel: 'Indoor',
    sourceFile: 'newer.json',
    sourceSnapshotDate: '2026-04-19',
    matchStatus: 'imported_standalone',
  }, 'summary');
  assert.equal(newer.applied, true);
  assert.equal(newer.inserted, false);

  const row = db.getExternalWorkoutByExternalId(externalId);
  assert.equal(row.duration_seconds, 2700);
  assert.equal(row.source_snapshot_date, '2026-04-19');
  assert.equal(row.import_source_file, 'newer.json');
});
