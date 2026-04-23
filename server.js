const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const db = require('./database');
const { runHealthImport, normalizeImportSource, validateImportSourceRoot } = require('./import-health');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database on startup
db.getDb();

// Weekly backup: run at startup and re-check every 6 hours so a long-running server
// still creates a new snapshot when a new ISO week begins. The helper is idempotent
// (keyed by the Monday of the current week), so repeat calls within the same week are no-ops.
function runWeeklyBackup() {
  Promise.resolve(db.ensureWeeklyBackup())
    .then(result => {
      if (result && result.created) console.log(`Weekly backup created: ${result.path}`);
    })
    .catch(err => console.error('Weekly backup failed:', err));
}
runWeeklyBackup();
setInterval(runWeeklyBackup, 6 * 60 * 60 * 1000);

// --- Helper ---
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftIsoDate(date, { months = 0, years = 0, days = 0 } = {}) {
  const shifted = new Date(`${date}T00:00:00`);
  if (months) shifted.setMonth(shifted.getMonth() + months);
  if (years) shifted.setFullYear(shifted.getFullYear() + years);
  if (days) shifted.setDate(shifted.getDate() + days);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

function getEarliestNutritionSummaryDate() {
  const sqlite = db.getDb();
  const macroMin = sqlite.prepare('SELECT MIN(date) AS min_date FROM macro_logs').get()?.min_date ?? null;
  const healthMin = sqlite.prepare('SELECT MIN(date) AS min_date FROM health_daily_metrics').get()?.min_date ?? null;
  return [macroMin, healthMin].filter(Boolean).sort()[0] || null;
}

function getNutritionSummaryBounds(range = '1m') {
  const end = todayISO();
  const earliest = getEarliestNutritionSummaryDate();
  if (range === 'all') {
    return { start: earliest || end, end };
  }

  if (range === '3m') return { start: shiftIsoDate(end, { months: -3 }), end };
  if (range === '6m') return { start: shiftIsoDate(end, { months: -6 }), end };
  if (range === '1y') return { start: shiftIsoDate(end, { years: -1 }), end };
  return { start: shiftIsoDate(end, { months: -1 }), end };
}

function getBackupStatus() {
  const fs = require('fs');
  const backupDir = path.join(__dirname, 'data', 'backups');
  const files = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir)
        .filter(name => /^workouts-\d{4}-\d{2}-\d{2}\.db$/.test(name))
        .sort()
    : [];

  const now = new Date();
  const jsDay = now.getDay();
  const diffToMonday = jsDay === 0 ? -6 : 1 - jsDay;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const currentWeek = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  const expectedName = `workouts-${currentWeek}.db`;
  const latestName = files.length > 0 ? files[files.length - 1] : null;
  const latestPath = latestName ? path.join(backupDir, latestName) : null;
  const latestStat = latestPath && fs.existsSync(latestPath) ? fs.statSync(latestPath) : null;

  return {
    has_backup: files.length > 0,
    current_week: currentWeek,
    current_week_exists: files.includes(expectedName),
    latest_file: latestName,
    latest_created_at: latestStat ? latestStat.mtime.toISOString() : null,
  };
}

function buildHealthImportStatus() {
  const sqlite = db.getDb();
  const statusCounts = sqlite.prepare(`
    SELECT match_status, COUNT(*) AS count
    FROM external_workouts
    GROUP BY match_status
  `).all();
  const counts = {
    matched_single: 0,
    matched_split: 0,
    unmatched_strength: 0,
    imported_standalone: 0,
  };
  for (const row of statusCounts) {
    counts[row.match_status] = row.count;
  }
  counts.external_workouts_total = sqlite.prepare('SELECT COUNT(*) AS count FROM external_workouts').get().count;
  counts.health_daily_metrics_total = sqlite.prepare('SELECT COUNT(*) AS count FROM health_daily_metrics').get().count;
  return counts;
}

function archiveUploadedHealthFile(filename, fileContent) {
  const archiveDir = path.join(__dirname, 'data', 'health-import-uploads');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const safeName = String(filename || 'apple-health.json').replace(/[^A-Za-z0-9._-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(archiveDir, `${timestamp}-${safeName}`);
  fs.writeFileSync(archivePath, fileContent, 'utf8');
  return archivePath;
}

// --- Template API ---

app.get('/api/templates', (req, res) => {
  res.json(db.getAllTemplates());
});

app.post('/api/templates', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const id = db.createTemplate(name.trim());
  res.json({ id });
});

app.post('/api/templates/:id/duplicate', (req, res) => {
  const templateId = parseInt(req.params.id);
  const { name } = req.body || {};
  // Name is optional; the DB helper picks a clean "Name Copy"/"Name Copy 2"
  // when it's missing or collides.
  const result = db.duplicateTemplate(templateId, name);
  res.json(result);
});

app.put('/api/templates/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  db.updateTemplate(parseInt(req.params.id), name.trim());
  res.json({ ok: true });
});

app.delete('/api/templates/:id', (req, res) => {
  db.deleteTemplate(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Schedule API ---

app.get('/api/schedule', (req, res) => {
  res.json(db.getSchedule());
});

app.post('/api/schedule', (req, res) => {
  const { day_index, template_id } = req.body;
  if (day_index == null || !template_id) return res.status(400).json({ error: 'day_index and template_id required' });
  const id = db.addScheduleEntry(day_index, template_id);
  res.json({ id });
});

app.delete('/api/schedule/:id', (req, res) => {
  db.removeScheduleEntry(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Template exercise API (uses template_id = days.id) ---

app.get('/api/templates/:id/exercises', (req, res) => {
  const templateId = parseInt(req.params.id);
  const exercises = db.getDayExercises(templateId);
  // Attach linked template info
  const linkedInfo = db.getLinkedInfoForTemplate(templateId);
  for (const ex of exercises) {
    ex.linked_templates = linkedInfo[ex.id] || [];
  }
  res.json(exercises);
});

app.post('/api/templates/:id/exercises', (req, res) => {
  const { name, target_sets, target_reps, notes, superset_group, is_warmup, is_duration, is_amrap, amrap_last_only } = req.body;
  const exerciseId = db.getOrCreateExercise(name);
  const existing = db.getDayExercises(parseInt(req.params.id));
  const sortOrder = existing.length;

  // Check if this exercise exists in other templates — pre-fill from linked settings
  // Exclude same-template entries so same-template duplicates stay independent
  const templateId = parseInt(req.params.id);
  const linked = db.getDb().prepare('SELECT * FROM day_exercises WHERE exercise_id = ? AND day_id != ? AND archived = 0 LIMIT 1').get(exerciseId, templateId);
  const sets = target_sets || (linked ? linked.target_sets : 3);
  const reps = target_reps || (linked ? linked.target_reps : '10');
  const warmup = is_warmup || (linked ? !!linked.is_warmup : false);
  const duration = is_duration || (linked ? !!linked.is_duration : false);
  const amrap = is_amrap || (linked ? !!linked.is_amrap : false);
  const amrapLast = amrap_last_only || (linked ? !!linked.amrap_last_only : false);

  const id = db.addDayExercise(
    parseInt(req.params.id), exerciseId,
    sets, reps, sortOrder,
    notes || (linked ? linked.notes : null), superset_group || null, warmup, duration,
    amrap, amrapLast
  );
  res.json({ id });
});

app.put('/api/day-exercises/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.updateDayExercise(id, req.body);
  // Sync linked exercises (same exercise across templates)
  db.syncLinkedExercises(id, req.body);
  res.json({ ok: true });
});

app.get('/api/day-exercises/:id/linked', (req, res) => {
  const de = db.getDb().prepare('SELECT exercise_id, day_id FROM day_exercises WHERE id = ?').get(parseInt(req.params.id));
  if (!de) return res.status(404).json({ error: 'Not found' });
  const templates = db.getTemplatesForExercise(de.exercise_id).filter(t => t.id !== de.day_id);
  res.json(templates);
});

app.get('/api/day-exercises/:id/linked-targets', (req, res) => {
  res.json(db.getLinkedSlotTargets(parseInt(req.params.id)));
});

app.delete('/api/day-exercises/:id', (req, res) => {
  db.deleteDayExercise(parseInt(req.params.id));
  res.json({ ok: true });
});

// List archived (soft-deleted) exercises with history for a template
app.get('/api/templates/:id/archived-exercises', (req, res) => {
  res.json(db.getArchivedExercisesWithHistory(parseInt(req.params.id)));
});

// Restore a soft-deleted day_exercise
app.post('/api/day-exercises/:id/restore', (req, res) => {
  db.restoreDayExercise(parseInt(req.params.id));
  res.json({ ok: true });
});

// Permanently delete a day_exercise AND its workout history. Destructive; UI confirms.
app.delete('/api/day-exercises/:id/permanent', (req, res) => {
  db.hardDeleteDayExercise(parseInt(req.params.id));
  res.json({ ok: true });
});

app.put('/api/templates/:id/reorder', (req, res) => {
  db.reorderDayExercises(parseInt(req.params.id), req.body.order);
  res.json({ ok: true });
});

// --- Legacy Day API (kept for backward compat) ---

app.get('/api/days', (req, res) => {
  res.json(db.getAllDays());
});

app.put('/api/days/:id', (req, res) => {
  db.updateDay(parseInt(req.params.id), req.body.name);
  res.json({ ok: true });
});

app.post('/api/days', (req, res) => {
  const { day_index, name } = req.body;
  const id = db.getOrCreateDay(day_index, name);
  res.json({ id });
});

app.get('/api/days/:id/exercises', (req, res) => {
  const exercises = db.getDayExercises(parseInt(req.params.id));
  res.json(exercises);
});

app.post('/api/days/:id/exercises', (req, res) => {
  const { name, target_sets, target_reps, notes, superset_group, is_warmup, is_duration, is_amrap, amrap_last_only } = req.body;
  const exerciseId = db.getOrCreateExercise(name);
  const existing = db.getDayExercises(parseInt(req.params.id));
  const sortOrder = existing.length;
  const id = db.addDayExercise(
    parseInt(req.params.id), exerciseId,
    target_sets || 3, target_reps || '10', sortOrder,
    notes || null, superset_group || null, is_warmup || false, is_duration || false,
    is_amrap || false, amrap_last_only || false
  );
  res.json({ id });
});

app.put('/api/days/:id/reorder', (req, res) => {
  db.reorderDayExercises(parseInt(req.params.id), req.body.order);
  res.json({ ok: true });
});

// --- Exercises library ---

app.get('/api/exercises', (req, res) => {
  res.json(db.getAllExercises());
});

app.post('/api/exercises', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const id = db.getOrCreateExercise(name.trim());
  res.json({ id });
});

// --- Workout API ---

// Get all workouts/previews for a date
app.get('/api/workout/:date', (req, res) => {
  const date = req.params.date;

  // Get any existing workouts for this date
  const existingWorkouts = db.getFullWorkoutsForDate(date);

  // Get scheduled templates for this date
  const scheduled = db.getScheduleForDate(date);

  // Build response: for each scheduled template, either return existing workout or preview
  const results = [];
  const existingTemplateIds = new Set(existingWorkouts.map(w => w.day_id));

  // Helper: build prev data for a list of day_exercises.
  // targets_independent slots are scoped to the same template so cross-template history
  // from differently-programmed slots doesn't bleed into the "Previous:" display or pre-fill.
  function buildCrossTemplatePrev(dayExercises, templateId, date) {
    const prevData = [];
    for (const te of dayExercises) {
      const exerciseId = te.exercise_id;
      const scopedDayId = te.targets_independent ? templateId : null;
      const recent = db.getMostRecentExerciseData(exerciseId, date, te.is_warmup, scopedDayId);
      if (recent) {
        prevData.push({
          day_exercise_id: te.id,
          exercise_id: exerciseId,
          exercise_name: te.exercise_name || te.name,
          is_warmup: te.is_warmup,
          skipped: recent.skipped,
          note: recent.note,
          sets: recent.sets,
          from_template: recent.day_id !== templateId ? recent.template_name : null,
        });
      }
    }
    return prevData.length > 0 ? prevData : null;
  }

  for (const w of existingWorkouts) {
    const dayExercises = db.getDayExercises(w.day_id);
    const prevData = buildCrossTemplatePrev(dayExercises, w.day_id, date);
    const externalLinks = db.getExternalWorkoutLinksForWorkout(w.id).map(link => ({
      external_workout_id: link.external_workout_id,
      external_id: link.external_id,
      workout_type: link.workout_type,
      start_at: link.start_at,
      end_at: link.end_at,
      duration_seconds: link.duration_seconds,
      allocation_ratio: link.allocation_ratio,
      allocation_method: link.allocation_method,
      derived_summary: {
        duration_seconds: Math.round((link.duration_seconds || 0) * (link.allocation_ratio || 0)),
        active_energy_kcal: link.active_energy_kcal == null ? null : Math.round(link.active_energy_kcal * (link.allocation_ratio || 0)),
      },
      full_summary: {
        duration_seconds: link.duration_seconds,
        active_energy_kcal: link.active_energy_kcal == null ? null : Math.round(link.active_energy_kcal),
      },
    }));
    results.push({
      workout: {
        ...w,
        external_links: externalLinks,
      },
      previous: prevData,
    });
  }

  for (const sched of scheduled) {
    if (existingTemplateIds.has(sched.template_id)) continue; // already have a workout

    const templateId = sched.template_id;
    const templateExercises = db.getDayExercises(templateId);
    const prevData = buildCrossTemplatePrev(templateExercises, templateId, date);

    const preview = {
      id: null,
      date,
      day_id: templateId,
      template_id: templateId,
      template_name: sched.template_name,
      day_name: sched.template_name,
      preview: true,
      exercises: templateExercises.map((te, idx) => ({
        id: null,
        day_exercise_id: te.id,
        exercise_id: te.exercise_id,
        exercise_name: te.exercise_name || te.name,
        target_sets: te.target_sets,
        target_reps: te.target_reps,
        sort_order: idx,
        skipped: 0,
        note: null,
        default_note: te.notes,
        superset_group: te.superset_group,
        is_warmup: te.is_warmup,
        is_duration: te.is_duration,
        is_amrap: te.is_amrap,
        amrap_last_only: te.amrap_last_only,
        sets: Array.from({ length: te.target_sets }, (_, i) => ({
          set_number: i + 1,
          weight: null,
          reps: null,
          target_reps: parseInt(te.target_reps) || null,
          duration_seconds: null,
          completed: 0,
          is_amrap: te.is_amrap ? (te.amrap_last_only ? (i === te.target_sets - 1 ? 1 : 0) : 1) : 0,
        })),
      })),
    };
    results.push({ workout: preview, previous: prevData });
  }

  res.json(results);
});

// Begin a workout for a specific template
app.post('/api/workout/:date/begin', (req, res) => {
  const date = req.params.date;
  const { template_id } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id required' });

  const workout = db.initWorkoutFromTemplate(date, template_id);
  const day = db.getDb().prepare('SELECT * FROM days WHERE id = ?').get(template_id);
  const exercises = db.getWorkoutFull(workout.id);
  const workoutFull = {
    ...workout,
    template_id: template_id,
    template_name: day ? day.name : '',
    day_name: day ? day.name : '',
    exercises
  };

  // Build cross-template prev data
  const dayExercises = db.getDayExercises(template_id);
  const prevData = [];
  for (const te of dayExercises) {
    const recent = db.getMostRecentExerciseData(te.exercise_id, date, te.is_warmup);
    if (recent) {
      prevData.push({
        day_exercise_id: te.id,
        exercise_id: te.exercise_id,
        exercise_name: te.exercise_name,
        skipped: recent.skipped,
        note: recent.note,
        sets: recent.sets,
        from_template: recent.day_id !== template_id ? recent.template_name : null,
      });
    }
  }

  res.json({ workout: workoutFull, previous: prevData.length > 0 ? prevData : null });
});

// Save sets + notes for one exercise in a workout
app.post('/api/workout/:date/exercise/:workoutExerciseId', (req, res) => {
  const { sets, note, skipped } = req.body;
  db.saveWorkoutExercise(parseInt(req.params.workoutExerciseId), sets, note, skipped);
  res.json({ ok: true });
});

// Swap (or clear) the exercise for a workout entry
app.put('/api/workout/:date/exercise/:workoutExerciseId/swap', (req, res) => {
  const { exercise_name } = req.body;
  db.swapWorkoutExercise(parseInt(req.params.workoutExerciseId), exercise_name || null);
  res.json({ ok: true });
});

// Add an extra exercise to an active workout
app.post('/api/workout/:date/add-exercise', (req, res) => {
  const { workout_id, name, target_sets, target_reps, after_sort_order, save_to_template } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (!workout_id) return res.status(400).json({ error: 'workout_id required' });
  try {
    const weId = db.addExerciseToWorkout(
      parseInt(workout_id),
      name.trim(),
      parseInt(target_sets) || 3,
      target_reps || '10',
      after_sort_order != null ? parseInt(after_sort_order) : null,
      !!save_to_template
    );
    res.json({ id: weId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reorder exercises within a workout
app.put('/api/workout/:date/reorder', (req, res) => {
  const workoutId = parseInt(req.body.workout_id);
  if (!workoutId) {
    // Legacy: find by date (single workout)
    const workout = db.getWorkoutByDate(req.params.date);
    if (!workout) return res.status(404).json({ error: 'Workout not found' });
    db.reorderWorkoutExercises(workout.id, req.body.order);
  } else {
    db.reorderWorkoutExercises(workoutId, req.body.order);
  }
  res.json({ ok: true });
});

// Delete a workout
app.delete('/api/workout/:id', (req, res) => {
  db.deleteWorkout(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- History API ---

app.get('/api/workouts/dates', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  res.json(db.getWorkoutDatesInRange(from, to));
});

app.get('/api/workouts/range', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  res.json(db.getWorkoutsInRange(from, to));
});

app.get('/api/history', (req, res) => {
  res.json(db.getAllWorkoutDates());
});

app.get('/api/history/exercise/:exerciseId', (req, res) => {
  const limit = parseInt(req.query.limit) || 8;
  const data = db.getExerciseHistoryWithSets(parseInt(req.params.exerciseId), limit);
  res.json(data);
});

// --- Apple Health import / external workouts API ---

app.post('/api/import/health', (req, res) => {
  const { dry_run, level, min_duration_seconds } = req.body || {};
  try {
    const summary = runHealthImport({
      dryRun: !!dry_run,
      level: level || 'summary',
      minDuration: parseInt(min_duration_seconds, 10) || undefined,
    });
    res.json(summary);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/import/health/upload', (req, res) => {
  const { filename, file_content, dry_run, level, min_duration_seconds } = req.body || {};
  if (!file_content || typeof file_content !== 'string') {
    return res.status(400).json({ error: 'file_content is required' });
  }

  let root;
  try {
    root = JSON.parse(file_content);
  } catch (error) {
    return res.status(400).json({ error: 'Uploaded file is not valid JSON' });
  }

  try {
    validateImportSourceRoot(root);
    const source = normalizeImportSource(filename || 'apple-health.json', root);
    const summary = runHealthImport(
      {
        dryRun: !!dry_run,
        level: level || 'summary',
        minDuration: parseInt(min_duration_seconds, 10) || undefined,
      },
      [source]
    );

    if (!dry_run) {
      const archivePath = archiveUploadedHealthFile(filename, file_content);
      summary.archived_upload_path = path.relative(__dirname, archivePath);
    }

    res.json(summary);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/import/health/status', (req, res) => {
  res.json(buildHealthImportStatus());
});

app.get('/api/import/health/unmatched', (req, res) => {
  res.json(db.getUnmatchedExternalStrengthWorkouts());
});

app.get('/api/workouts/:id/external-links', (req, res) => {
  const links = db.getExternalWorkoutLinksForWorkout(parseInt(req.params.id)).map(link => ({
    external_workout_id: link.external_workout_id,
    external_id: link.external_id,
    workout_type: link.workout_type,
    start_at: link.start_at,
    end_at: link.end_at,
    duration_seconds: link.duration_seconds,
    allocation_ratio: link.allocation_ratio,
    allocation_method: link.allocation_method,
    derived_summary: {
      duration_seconds: Math.round((link.duration_seconds || 0) * (link.allocation_ratio || 0)),
      active_energy_kcal: link.active_energy_kcal == null ? null : Math.round(link.active_energy_kcal * (link.allocation_ratio || 0)),
    },
    full_summary: {
      duration_seconds: link.duration_seconds,
      active_energy_kcal: link.active_energy_kcal == null ? null : Math.round(link.active_energy_kcal),
    },
  }));
  res.json(links);
});

app.get('/api/external-workouts', (req, res) => {
  const { date } = req.query;
  if (date) return res.json(db.getExternalWorkoutsByDate(date));

  const sqlite = db.getDb();
  const rows = sqlite.prepare(`
    SELECT ew.*, ewm.active_energy_kcal, ewm.avg_heart_rate_bpm, ewm.max_heart_rate_bpm,
           ewm.min_heart_rate_bpm, ewm.distance_meters
    FROM external_workouts ew
    LEFT JOIN external_workout_metrics ewm ON ewm.external_workout_id = ew.id
    ORDER BY ew.date DESC, ew.start_at DESC
  `).all();
  res.json(rows);
});

app.get('/api/external-workouts/:id', (req, res) => {
  const workout = db.getExternalWorkoutById(parseInt(req.params.id));
  if (!workout) return res.status(404).json({ error: 'External workout not found' });
  res.json(workout);
});

app.get('/api/health/daily-metrics', (req, res) => {
  const { from, to } = req.query;
  if (from && to) return res.json(db.getHealthDailyMetricsRange(from, to));
  res.json(db.getRecentHealthDailyMetrics());
});

app.get('/api/health/daily-metrics/:date', (req, res) => {
  const metrics = db.getHealthDailyMetricsByDate(req.params.date);
  if (!metrics) return res.status(404).json({ error: 'Daily metrics not found' });
  res.json(metrics);
});

// --- Body Weight API ---

app.get('/api/body-weight', (req, res) => {
  res.json(db.getBodyWeights());
});

app.put('/api/body-weight/:date', (req, res) => {
  const { weight_kg } = req.body;
  const val = parseFloat(weight_kg);
  if (isNaN(val) || val <= 0) return res.status(400).json({ error: 'Valid weight_kg required' });
  db.logBodyWeight(req.params.date, val);
  res.json({ ok: true });
});

app.delete('/api/body-weight/:date', (req, res) => {
  db.deleteBodyWeight(req.params.date);
  res.json({ ok: true });
});

app.get('/api/backup/status', (req, res) => {
  res.json(getBackupStatus());
});

app.get('/api/export/json', (req, res) => {
  const sqlite = db.getDb();
  const exportData = {
    exported_at: new Date().toISOString(),
    app: 'simple-workout-tracker',
    templates: sqlite.prepare('SELECT * FROM days ORDER BY id').all(),
    schedule: sqlite.prepare('SELECT * FROM schedule ORDER BY id').all(),
    exercises: sqlite.prepare('SELECT * FROM exercises ORDER BY id').all(),
    template_exercises: sqlite.prepare('SELECT * FROM day_exercises ORDER BY day_id, sort_order, id').all(),
    workouts: sqlite.prepare('SELECT * FROM workouts ORDER BY date, id').all(),
    workout_exercises: sqlite.prepare('SELECT * FROM workout_exercises ORDER BY workout_id, sort_order, id').all(),
    workout_sets: sqlite.prepare('SELECT * FROM workout_sets ORDER BY workout_exercise_id, set_number, id').all(),
    body_weights: sqlite.prepare('SELECT * FROM body_weights ORDER BY date, id').all(),
    external_workouts: sqlite.prepare('SELECT * FROM external_workouts ORDER BY date, start_at, id').all(),
    external_workout_metrics: sqlite.prepare('SELECT * FROM external_workout_metrics ORDER BY external_workout_id').all(),
    external_workout_links: sqlite.prepare('SELECT * FROM external_workout_links ORDER BY external_workout_id, link_order, id').all(),
    external_workout_raw: sqlite.prepare('SELECT * FROM external_workout_raw ORDER BY external_workout_id, id').all(),
    health_daily_metrics: sqlite.prepare('SELECT * FROM health_daily_metrics ORDER BY date, id').all(),
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="workout-tracker-export-${todayISO()}.json"`);
  res.send(JSON.stringify(exportData, null, 2));
});

// --- Progress / Trend API ---

app.get('/api/exercises/performed', (req, res) => {
  res.json(db.getPerformedExercises());
});

app.get('/api/trends/exercise/:id', (req, res) => {
  res.json(db.getExerciseTrend(parseInt(req.params.id)));
});

app.get('/api/trends/frequency', (req, res) => {
  res.json(db.getAllWorkoutSessionDates());
});

// --- Nutrition: Meal Templates API ---

app.get('/api/nutrition/templates', (req, res) => {
  res.json(db.getMealTemplates());
});

app.post('/api/nutrition/templates', (req, res) => {
  const { name, calories_kcal, protein_g, carbs_g, fat_g, include_rest_day, use_defaults } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const id = db.createMealTemplate({
    name: name.trim(),
    calories_kcal: parseFloat(calories_kcal) || 0,
    protein_g: parseFloat(protein_g) || 0,
    carbs_g: parseFloat(carbs_g) || 0,
    fat_g: parseFloat(fat_g) || 0,
    include_rest_day: include_rest_day != null ? !!include_rest_day : true,
    use_defaults: use_defaults ? 1 : 0,
  });
  res.json({ id });
});

app.put('/api/nutrition/templates/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  db.reorderMealTemplates(order);
  res.json({ ok: true });
});

app.put('/api/nutrition/templates/:id', (req, res) => {
  db.updateMealTemplate(parseInt(req.params.id), req.body);
  res.json({ ok: true });
});

app.delete('/api/nutrition/templates/:id', (req, res) => {
  db.deleteMealTemplate(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Nutrition: Macro Logs API ---

app.get('/api/nutrition/logs/:date', (req, res) => {
  const date = req.params.date;
  const logs = db.getMacroLogsForDate(date);
  const is_workout_day = db.isWorkoutDayForNutrition(date);
  const health_metrics = db.getMacroTdeeContextForDate(date);
  const tdee_kcal = health_metrics?.tdee_kcal != null ? Math.round(health_metrics.tdee_kcal) : null;
  res.json({ logs, is_workout_day, tdee_kcal, health_metrics });
});

app.get('/api/nutrition/summary', (req, res) => {
  const range = String(req.query.range || '1m');
  const { start, end } = getNutritionSummaryBounds(range);
  const summary = db.getNutritionSummaryForRange(start, end);
  res.json({
    range,
    ...summary,
  });
});

app.post('/api/nutrition/logs', (req, res) => {
  const { date, meal_template_id, meal_name, sort_order, calories_kcal, protein_g, carbs_g, fat_g } = req.body;
  if (!date || !meal_name) return res.status(400).json({ error: 'date and meal_name required' });

  const macros = {
    calories_kcal: parseFloat(calories_kcal) || 0,
    protein_g:     parseFloat(protein_g)     || 0,
    carbs_g:       parseFloat(carbs_g)       || 0,
    fat_g:         parseFloat(fat_g)         || 0,
  };

  // Upsert for template-based logs: if an entry already exists for this
  // template+date (e.g. from a rapid double-tap), return its id and update
  // the values rather than creating a duplicate row.
  if (meal_template_id != null) {
    const existing = db.getMacroLogByTemplateAndDate(parseInt(meal_template_id), date);
    if (existing) {
      db.updateMacroLog(existing.id, macros);
      return res.json({ id: existing.id });
    }
  }

  const id = db.createMacroLog({
    date,
    meal_template_id: meal_template_id ?? null,
    meal_name,
    sort_order: parseInt(sort_order) || 0,
    ...macros,
  });
  res.json({ id });
});

app.put('/api/nutrition/logs/:id', (req, res) => {
  db.updateMacroLog(parseInt(req.params.id), req.body);
  res.json({ ok: true });
});

app.delete('/api/nutrition/logs/:id', (req, res) => {
  db.deleteMacroLog(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Nutrition: Macro Targets API ---

function normalizeMacroTargetProfile(profile = {}) {
  const normalized = { ...profile };
  if (normalized.energy_target == null && normalized.deficit_target != null) {
    normalized.energy_target = normalized.deficit_target;
  }
  delete normalized.deficit_target;
  return normalized;
}

app.get('/api/nutrition/targets', (req, res) => {
  const w = db.getUserSetting('macro_targets_workout');
  const r = db.getUserSetting('macro_targets_rest');
  const empty = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  res.json({
    workout: normalizeMacroTargetProfile(w ? JSON.parse(w) : empty),
    rest: normalizeMacroTargetProfile(r ? JSON.parse(r) : empty),
    apple_health_adjustments: db.getAppleHealthEnergyAdjustments(),
  });
});

app.put('/api/nutrition/targets', (req, res) => {
  const { workout, rest, apple_health_adjustments } = req.body;
  if (workout) db.setUserSetting('macro_targets_workout', JSON.stringify(normalizeMacroTargetProfile(workout)));
  if (rest) db.setUserSetting('macro_targets_rest', JSON.stringify(normalizeMacroTargetProfile(rest)));
  if (apple_health_adjustments) db.setAppleHealthEnergyAdjustments(apple_health_adjustments);
  res.json({ ok: true });
});

// --- Update endpoints ---

app.get('/api/update/check', async (req, res) => {
  try {
    await execAsync('git fetch', { cwd: __dirname, timeout: 15000 });
  } catch (err) {
    return res.status(503).json({ error: `Could not reach remote: ${(err.stderr || err.message).trim()}` });
  }
  try {
    const [{ stdout: headOut }, { stdout: upstreamOut }] = await Promise.all([
      execAsync('git rev-parse HEAD', { cwd: __dirname }),
      execAsync('git rev-parse @{u}', { cwd: __dirname }),
    ]);
    const head = headOut.trim();
    const upstream = upstreamOut.trim();
    if (head === upstream) {
      return res.json({ upToDate: true, commitsBehind: 0, latestMessage: null });
    }
    const { stdout: countOut } = await execAsync('git rev-list HEAD..@{u} --count', { cwd: __dirname });
    const { stdout: msgOut } = await execAsync('git log @{u} -1 --pretty=format:%s', { cwd: __dirname });
    res.json({
      upToDate: false,
      commitsBehind: parseInt(countOut.trim(), 10) || 0,
      latestMessage: msgOut.trim() || null,
    });
  } catch (err) {
    res.status(500).json({ error: (err.stderr || err.message).trim() });
  }
});

app.post('/api/update/apply', async (req, res) => {
  try {
    const { stdout: statusOut } = await execAsync('git status --porcelain', { cwd: __dirname });
    if (statusOut.trim()) {
      return res.status(409).json({ error: 'Working tree has uncommitted changes — pull aborted.' });
    }
    await execAsync('git pull', { cwd: __dirname, timeout: 30000 });
    res.json({ ok: true });
    setTimeout(shutdown, 200);
  } catch (err) {
    res.status(500).json({ error: (err.stderr || err.message).trim() || 'Pull failed' });
  }
});

// --- Graceful shutdown ---
// Closes the DB (checkpoints the WAL) before exiting so the WAL doesn't accumulate
// across restarts. Called via the /api/shutdown endpoint (used by start.bat) or
// SIGINT (Ctrl+C in console). taskkill without /f cannot deliver signals to a
// detached Windows process, so we use the HTTP endpoint as the primary mechanism.
function shutdown() {
  db.closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);

// Shutdown endpoint — only accepts requests from localhost.
// start.bat calls this via a node one-liner so the process exits cleanly,
// checkpointing the WAL, before any backup or restart happens.
app.post('/api/shutdown', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ ok: true });
  setTimeout(shutdown, 100); // let the response flush before exiting
});

// --- Start ---

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Workout Tracker running at http://0.0.0.0:${PORT} (graceful shutdown enabled)`);
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  LAN: http://${net.address}:${PORT}`);
      }
    }
  }
});
