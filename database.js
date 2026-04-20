const Database = require('better-sqlite3');
const path = require('path');

// Allow tests and dev scripts to point at a disposable DB without touching data/workouts.db.
const DB_PATH = process.env.WORKOUT_DB_PATH || path.join(__dirname, 'data', 'workouts.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_index INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS day_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id),
      target_sets INTEGER NOT NULL DEFAULT 3,
      target_reps TEXT NOT NULL DEFAULT '10',
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      superset_group INTEGER
    );

    CREATE TABLE IF NOT EXISTS workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      day_id INTEGER NOT NULL REFERENCES days(id)
    );

    CREATE TABLE IF NOT EXISTS workout_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
      day_exercise_id INTEGER NOT NULL REFERENCES day_exercises(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS workout_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_exercise_id INTEGER NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
      set_number INTEGER NOT NULL,
      weight REAL,
      reps INTEGER,
      target_reps INTEGER,
      duration_seconds INTEGER,
      completed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_index INTEGER NOT NULL,
      template_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS body_weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      weight_kg REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meal_templates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      calories_kcal    REAL    NOT NULL DEFAULT 0,
      protein_g        REAL    NOT NULL DEFAULT 0,
      carbs_g          REAL    NOT NULL DEFAULT 0,
      fat_g            REAL    NOT NULL DEFAULT 0,
      include_rest_day INTEGER NOT NULL DEFAULT 1,
      active           INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS macro_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      date             TEXT    NOT NULL,
      meal_template_id INTEGER REFERENCES meal_templates(id) ON DELETE SET NULL,
      meal_name        TEXT    NOT NULL,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      calories_kcal    REAL    NOT NULL DEFAULT 0,
      protein_g        REAL    NOT NULL DEFAULT 0,
      carbs_g          REAL    NOT NULL DEFAULT 0,
      fat_g            REAL    NOT NULL DEFAULT 0
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_macro_logs_date ON macro_logs(date)');

  // --- Migrations ---

  // Migration: add completed column to workout_sets if missing
  try {
    db.prepare("SELECT completed FROM workout_sets LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE workout_sets ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_warmup column to day_exercises if missing
  try {
    db.prepare("SELECT is_warmup FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN is_warmup INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_duration column to day_exercises if missing
  try {
    db.prepare("SELECT is_duration FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN is_duration INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_amrap and amrap_last_only columns to day_exercises
  try {
    db.prepare("SELECT is_amrap FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN is_amrap INTEGER NOT NULL DEFAULT 0");
  }
  try {
    db.prepare("SELECT amrap_last_only FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN amrap_last_only INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_amrap column to workout_sets
  try {
    db.prepare("SELECT is_amrap FROM workout_sets LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE workout_sets ADD COLUMN is_amrap INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add override_exercise_id to workout_exercises (for temporary exercise swaps)
  try {
    db.prepare("SELECT override_exercise_id FROM workout_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE workout_exercises ADD COLUMN override_exercise_id INTEGER REFERENCES exercises(id)");
  }

  // Migration: add is_adhoc to day_exercises (for exercises added only to an active workout)
  try {
    db.prepare("SELECT is_adhoc FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN is_adhoc INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add archived flag to day_exercises (soft-delete preserves workout history)
  try {
    db.prepare("SELECT archived FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add targets_independent flag to day_exercises (per-slot opt-out from target sync)
  try {
    db.prepare("SELECT targets_independent FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN targets_independent INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add use_defaults flag to meal_templates (one-tap confirm vs manual entry)
  try {
    db.prepare("SELECT use_defaults FROM meal_templates LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE meal_templates ADD COLUMN use_defaults INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: populate schedule table from days if schedule is empty
  const scheduleCount = db.prepare("SELECT COUNT(*) as c FROM schedule").get().c;
  if (scheduleCount === 0) {
    const days = db.prepare("SELECT id, day_index, name FROM days WHERE name != ''").all();
    if (days.length > 0) {
      const insertSchedule = db.prepare("INSERT INTO schedule (day_index, template_id, sort_order) VALUES (?, ?, 0)");
      const txn = db.transaction(() => {
        for (const d of days) {
          insertSchedule.run(d.day_index, d.id);
        }
      });
      txn();
    }
  }

  // Migration: change workouts unique index from (date) to (date, day_id)
  // Check if old unique index exists by trying to see if there's a unique constraint on date alone
  try {
    db.exec("DROP INDEX IF EXISTS idx_workouts_date");
  } catch (e) { /* ignore */ }
  // Create new composite unique index (safe if already exists)
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_date_template ON workouts(date, day_id)");

  // Migration: sync linked exercises (same exercise_id across different templates)
  // Pick the highest-id day_exercise as canonical and sync to others in DIFFERENT templates
  // Same-template duplicates are intentionally distinct (e.g. warmup + main sets)
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");
  const migrated = db.prepare("SELECT 1 FROM _migrations WHERE name = 'sync_linked_exercises'").get();
  if (!migrated) {
    const groups = db.prepare(`
      SELECT exercise_id FROM day_exercises GROUP BY exercise_id HAVING COUNT(DISTINCT day_id) > 1
    `).all();
    const syncFields = ['target_sets', 'target_reps', 'is_warmup', 'is_duration', 'is_amrap', 'amrap_last_only', 'notes'];
    const txn = db.transaction(() => {
      for (const { exercise_id } of groups) {
        // Group by template — pick one canonical per exercise across templates
        const all = db.prepare('SELECT * FROM day_exercises WHERE exercise_id = ? ORDER BY id DESC').all(exercise_id);
        const canonical = all[0];
        for (let i = 1; i < all.length; i++) {
          // Only sync if in a different template
          if (all[i].day_id === canonical.day_id) continue;
          const sets = [];
          const vals = [];
          for (const f of syncFields) {
            sets.push(`${f} = ?`);
            vals.push(canonical[f]);
          }
          vals.push(all[i].id);
          db.prepare(`UPDATE day_exercises SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        }
      }
      db.prepare("INSERT INTO _migrations (name) VALUES ('sync_linked_exercises')").run();
    });
    txn();
  }
}

// --- Exercise helpers ---

function getOrCreateExercise(name) {
  const trimmed = name.trim();
  let row = db.prepare('SELECT id FROM exercises WHERE name = ?').get(trimmed);
  if (!row) {
    const info = db.prepare('INSERT INTO exercises (name) VALUES (?)').run(trimmed);
    return info.lastInsertRowid;
  }
  return row.id;
}

function getAllExercises() {
  return db.prepare('SELECT * FROM exercises ORDER BY name').all();
}

// --- Template helpers (templates = days table) ---

function getAllTemplates() {
  return db.prepare('SELECT * FROM days ORDER BY name').all();
}

function createTemplate(name) {
  const info = db.prepare('INSERT INTO days (day_index, name) VALUES (-1, ?)').run(name);
  return info.lastInsertRowid;
}

// Given "Push", "Push Copy", or "Push Copy 4", return the base root (e.g. "Push")
// so repeated duplications stay "Push Copy", "Push Copy 2" instead of piling
// up "Push Copy Copy Copy".
function stripCopySuffix(name) {
  return name.replace(/\s+Copy(\s+\d+)?$/i, '').trim() || name.trim();
}

function computeUniqueTemplateName(sourceName) {
  const root = stripCopySuffix(sourceName);
  const existing = new Set(
    db.prepare('SELECT name FROM days').all().map(r => r.name)
  );
  let candidate = `${root} Copy`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${root} Copy ${n}`;
    n++;
  }
  return candidate;
}

function duplicateTemplate(id, name) {
  const template = db.prepare('SELECT * FROM days WHERE id = ?').get(id);
  if (!template) throw new Error('Template not found');

  // Pick a clean, unique name based on the source template. Honour an explicit
  // caller-provided name when it's free; otherwise fall back to the auto-computed
  // series so repeated clicks don't stutter into "Name Copy Copy".
  const provided = typeof name === 'string' ? name.trim() : '';
  const existingNames = new Set(
    db.prepare('SELECT name FROM days').all().map(r => r.name)
  );
  const finalName = (provided && !existingNames.has(provided))
    ? provided
    : computeUniqueTemplateName(provided || template.name);

  const exercises = db.prepare(`
    SELECT *
    FROM day_exercises
    WHERE day_id = ? AND archived = 0
    ORDER BY sort_order
  `).all(id);

  const txn = db.transaction(() => {
    const info = db.prepare('INSERT INTO days (day_index, name) VALUES (-1, ?)').run(finalName);
    const newTemplateId = info.lastInsertRowid;

    const insertExercise = db.prepare(`
      INSERT INTO day_exercises (
        day_id, exercise_id, target_sets, target_reps, sort_order, notes,
        superset_group, is_warmup, is_duration, is_amrap, amrap_last_only,
        is_adhoc, archived, targets_independent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `);

    for (const ex of exercises) {
      insertExercise.run(
        newTemplateId,
        ex.exercise_id,
        ex.target_sets,
        ex.target_reps,
        ex.sort_order,
        ex.notes || null,
        ex.superset_group || null,
        ex.is_warmup ? 1 : 0,
        ex.is_duration ? 1 : 0,
        ex.is_amrap ? 1 : 0,
        ex.amrap_last_only ? 1 : 0,
        ex.targets_independent ? 1 : 0
      );
    }

    return newTemplateId;
  });

  const newTemplateId = txn();
  return { id: newTemplateId, name: finalName };
}

function updateTemplate(id, name) {
  db.prepare('UPDATE days SET name = ? WHERE id = ?').run(name, id);
}

function deleteTemplate(id) {
  // Remove workout history that references this template's exercises
  db.prepare(`
    DELETE FROM workout_sets WHERE workout_exercise_id IN (
      SELECT we.id FROM workout_exercises we
      JOIN day_exercises de ON de.id = we.day_exercise_id
      WHERE de.day_id = ?
    )
  `).run(id);
  db.prepare(`
    DELETE FROM workout_exercises WHERE day_exercise_id IN (
      SELECT id FROM day_exercises WHERE day_id = ?
    )
  `).run(id);
  db.prepare('DELETE FROM workouts WHERE day_id = ?').run(id);
  // Remove from schedule
  db.prepare('DELETE FROM schedule WHERE template_id = ?').run(id);
  // day_exercises will cascade delete due to FK
  db.prepare('DELETE FROM days WHERE id = ?').run(id);
}

// --- Schedule helpers ---

function getSchedule() {
  return db.prepare(`
    SELECT s.*, d.name as template_name
    FROM schedule s
    JOIN days d ON d.id = s.template_id
    ORDER BY s.day_index, s.sort_order
  `).all();
}

function addScheduleEntry(dayIndex, templateId) {
  const existing = db.prepare(
    'SELECT MAX(sort_order) as mx FROM schedule WHERE day_index = ?'
  ).get(dayIndex);
  const sortOrder = existing && existing.mx != null ? existing.mx + 1 : 0;
  const info = db.prepare(
    'INSERT INTO schedule (day_index, template_id, sort_order) VALUES (?, ?, ?)'
  ).run(dayIndex, templateId, sortOrder);
  return info.lastInsertRowid;
}

function removeScheduleEntry(id) {
  db.prepare('DELETE FROM schedule WHERE id = ?').run(id);
}

function getScheduleForDate(date) {
  const d = new Date(date + 'T00:00:00');
  const jsDay = d.getDay(); // 0=Sun
  const dayIndex = jsDay === 0 ? 6 : jsDay - 1; // convert to 0=Mon
  return db.prepare(`
    SELECT s.id as schedule_id, s.sort_order, d.id as template_id, d.name as template_name
    FROM schedule s
    JOIN days d ON d.id = s.template_id
    WHERE s.day_index = ?
    ORDER BY s.sort_order
  `).all(dayIndex);
}

// --- Day/Template helpers (kept for backward compat) ---

function getOrCreateDay(dayIndex, name) {
  let row = db.prepare('SELECT id FROM days WHERE day_index = ?').get(dayIndex);
  if (!row) {
    const info = db.prepare('INSERT INTO days (day_index, name) VALUES (?, ?)').run(dayIndex, name || '');
    return info.lastInsertRowid;
  }
  if (name && name !== row.name) {
    db.prepare('UPDATE days SET name = ? WHERE id = ?').run(name, row.id);
  }
  return row.id;
}

function getAllDays() {
  return db.prepare('SELECT * FROM days ORDER BY day_index').all();
}

function updateDay(id, name) {
  db.prepare('UPDATE days SET name = ? WHERE id = ?').run(name, id);
}

// --- Template exercise helpers ---

function addDayExercise(dayId, exerciseId, targetSets, targetReps, sortOrder, notes, supersetGroup, isWarmup, isDuration, isAmrap, amrapLastOnly) {
  const info = db.prepare(`
    INSERT INTO day_exercises (day_id, exercise_id, target_sets, target_reps, sort_order, notes, superset_group, is_warmup, is_duration, is_amrap, amrap_last_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(dayId, exerciseId, targetSets, targetReps, sortOrder, notes || null, supersetGroup || null, isWarmup ? 1 : 0, isDuration ? 1 : 0, isAmrap ? 1 : 0, amrapLastOnly ? 1 : 0);
  return info.lastInsertRowid;
}

function getDayExercises(dayId, includeAdhoc = false) {
  const adhocFilter = includeAdhoc ? '' : 'AND de.is_adhoc = 0';
  return db.prepare(`
    SELECT de.*, e.name as exercise_name
    FROM day_exercises de
    JOIN exercises e ON e.id = de.exercise_id
    WHERE de.day_id = ? AND de.archived = 0 ${adhocFilter}
    ORDER BY de.sort_order
  `).all(dayId);
}

function updateDayExercise(id, fields) {
  const allowed = ['target_sets', 'target_reps', 'sort_order', 'notes', 'superset_group', 'exercise_id', 'is_warmup', 'is_duration', 'is_amrap', 'amrap_last_only', 'targets_independent'];
  const updates = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (updates.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE day_exercises SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function deleteDayExercise(id) {
  // Soft-delete: if the exercise has any workout history, archive it so the data is preserved.
  // Otherwise hard-delete to avoid clutter in the "previously deleted" list.
  const hasHistory = db.prepare('SELECT 1 FROM workout_exercises WHERE day_exercise_id = ? LIMIT 1').get(id);
  if (hasHistory) {
    db.prepare('UPDATE day_exercises SET archived = 1 WHERE id = ?').run(id);
  } else {
    db.prepare('DELETE FROM day_exercises WHERE id = ?').run(id);
  }
}

function restoreDayExercise(id) {
  // Place at the end of the template's sort order on restore
  const de = db.prepare('SELECT day_id FROM day_exercises WHERE id = ?').get(id);
  if (!de) return;
  const maxSort = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) as m FROM day_exercises WHERE day_id = ? AND archived = 0'
  ).get(de.day_id).m;
  db.prepare('UPDATE day_exercises SET archived = 0, sort_order = ? WHERE id = ?').run(maxSort + 1, id);
}

function hardDeleteDayExercise(id) {
  // Permanently removes the day_exercise AND its workout history. Destructive.
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM workout_exercises WHERE day_exercise_id = ?').run(id);
    db.prepare('DELETE FROM day_exercises WHERE id = ?').run(id);
  });
  txn();
}

function getArchivedExercisesWithHistory(templateId) {
  return db.prepare(`
    SELECT de.*, e.name as exercise_name,
           (SELECT COUNT(*) FROM workout_exercises WHERE day_exercise_id = de.id) as history_count,
           (SELECT MAX(w.date) FROM workout_exercises we
              JOIN workouts w ON w.id = we.workout_id
              WHERE we.day_exercise_id = de.id) as last_used
    FROM day_exercises de
    JOIN exercises e ON e.id = de.exercise_id
    WHERE de.day_id = ? AND de.archived = 1
    ORDER BY last_used DESC
  `).all(templateId);
}

function reorderDayExercises(dayId, orderedIds) {
  const stmt = db.prepare('UPDATE day_exercises SET sort_order = ? WHERE id = ? AND day_id = ?');
  const txn = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, dayId));
  });
  txn();
}

// --- Workout helpers ---

function getOrCreateWorkout(date, dayId) {
  let row = db.prepare('SELECT * FROM workouts WHERE date = ? AND day_id = ?').get(date, dayId);
  if (!row) {
    const info = db.prepare('INSERT INTO workouts (date, day_id) VALUES (?, ?)').run(date, dayId);
    row = { id: info.lastInsertRowid, date, day_id: dayId };
  }
  return row;
}

function getWorkoutByDate(date) {
  return db.prepare('SELECT * FROM workouts WHERE date = ?').get(date);
}

function getWorkoutsForDate(date) {
  return db.prepare('SELECT * FROM workouts WHERE date = ?').all(date);
}

function getWorkoutFull(workoutId) {
  const exercises = db.prepare(`
    SELECT we.*, de.exercise_id, de.target_sets, de.target_reps, de.superset_group, de.notes as default_note, de.is_warmup, de.is_duration, de.is_amrap, de.amrap_last_only,
           e.name as exercise_name,
           oe.name as override_exercise_name
    FROM workout_exercises we
    JOIN day_exercises de ON de.id = we.day_exercise_id
    JOIN exercises e ON e.id = de.exercise_id
    LEFT JOIN exercises oe ON oe.id = we.override_exercise_id
    WHERE we.workout_id = ?
    ORDER BY we.sort_order
  `).all(workoutId);

  for (const ex of exercises) {
    ex.sets = db.prepare(`
      SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number
    `).all(ex.id);
  }
  return exercises;
}

function swapWorkoutExercise(workoutExerciseId, exerciseName) {
  if (!exerciseName) {
    db.prepare('UPDATE workout_exercises SET override_exercise_id = NULL WHERE id = ?').run(workoutExerciseId);
    return;
  }
  const exerciseId = getOrCreateExercise(exerciseName);
  db.prepare('UPDATE workout_exercises SET override_exercise_id = ? WHERE id = ?').run(exerciseId, workoutExerciseId);
}

function getWorkoutForDate(date) {
  const workout = getWorkoutByDate(date);
  if (!workout) return null;
  const day = db.prepare('SELECT * FROM days WHERE id = ?').get(workout.day_id);
  return {
    ...workout,
    day_name: day ? day.name : '',
    day_index: day ? day.day_index : 0,
    exercises: getWorkoutFull(workout.id)
  };
}

function getFullWorkoutsForDate(date) {
  const workouts = getWorkoutsForDate(date);
  return workouts.map(w => {
    const day = db.prepare('SELECT * FROM days WHERE id = ?').get(w.day_id);
    return {
      ...w,
      template_id: w.day_id,
      template_name: day ? day.name : '',
      exercises: getWorkoutFull(w.id)
    };
  });
}

function getDayForDate(date) {
  const d = new Date(date + 'T00:00:00');
  const jsDay = d.getDay(); // 0=Sun
  const dayIndex = jsDay === 0 ? 6 : jsDay - 1; // convert to 0=Mon
  return db.prepare('SELECT * FROM days WHERE day_index = ?').get(dayIndex);
}

function initWorkoutFromTemplate(date, templateId) {
  const workout = getOrCreateWorkout(date, templateId);
  const existing = db.prepare('SELECT id FROM workout_exercises WHERE workout_id = ?').all(workout.id);
  if (existing.length > 0) return workout;

  const templateExercises = getDayExercises(templateId);

  // Get previous session's data for pre-fill (cross-template: use most recent for each exercise)
  let prevDataMap = {};
  for (const te of templateExercises) {
    const recent = getMostRecentExerciseData(te.exercise_id, date);
    if (recent && recent.sets && recent.sets.length > 0) {
      prevDataMap[te.id] = recent.sets;
    }
  }

  const insertWe = db.prepare(`
    INSERT INTO workout_exercises (workout_id, day_exercise_id, sort_order, skipped, note)
    VALUES (?, ?, ?, 0, NULL)
  `);
  const insertWs = db.prepare(`
    INSERT INTO workout_sets (workout_exercise_id, set_number, weight, reps, target_reps, duration_seconds, is_amrap)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    for (const te of templateExercises) {
      const weInfo = insertWe.run(workout.id, te.id, te.sort_order);
      const targetRepsNum = parseInt(te.target_reps);
      const numSets = te.target_sets || 3;
      const prevSets = prevDataMap[te.id] || [];

      for (let s = 1; s <= numSets; s++) {
        const prev = prevSets[s - 1];
        const isDuration = te.is_duration;
        const weight = isDuration ? null : (prev ? prev.weight : null);
        const reps = isDuration ? null : (prev && prev.reps != null ? prev.reps : (isNaN(targetRepsNum) ? null : targetRepsNum));
        const tReps = isDuration ? null : (isNaN(targetRepsNum) ? null : targetRepsNum);
        const duration = prev ? prev.duration_seconds : null;
        const setIsAmrap = te.is_amrap ? (te.amrap_last_only ? (s === numSets ? 1 : 0) : 1) : 0;
        insertWs.run(weInfo.lastInsertRowid, s, weight, reps, tReps, duration, setIsAmrap);
      }
    }
  });
  txn();
  return workout;
}

function getMostRecentWorkoutForDay(dayId, beforeDate) {
  return db.prepare(`
    SELECT * FROM workouts WHERE day_id = ? AND date < ? ORDER BY date DESC LIMIT 1
  `).get(dayId, beforeDate);
}

// --- Workout exercise helpers ---

function saveWorkoutExercise(workoutExerciseId, sets, note, skipped) {
  if (note !== undefined) {
    db.prepare('UPDATE workout_exercises SET note = ? WHERE id = ?').run(note, workoutExerciseId);
  }
  if (skipped !== undefined) {
    db.prepare('UPDATE workout_exercises SET skipped = ? WHERE id = ?').run(skipped ? 1 : 0, workoutExerciseId);
  }

  if (sets && sets.length > 0) {
    db.prepare('DELETE FROM workout_sets WHERE workout_exercise_id = ?').run(workoutExerciseId);
    const stmt = db.prepare(`
      INSERT INTO workout_sets (workout_exercise_id, set_number, weight, reps, target_reps, duration_seconds, completed, is_amrap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = db.transaction(() => {
      sets.forEach((s, i) => {
        stmt.run(
          workoutExerciseId,
          i + 1,
          s.weight != null ? s.weight : null,
          s.reps != null ? s.reps : null,
          s.target_reps != null ? s.target_reps : null,
          s.duration_seconds != null ? s.duration_seconds : null,
          s.completed ? 1 : 0,
          s.is_amrap ? 1 : 0
        );
      });
    });
    txn();
  }
}

// Add an ad-hoc exercise to an active workout, inserting after a given sort_order position.
// Always creates a day_exercise so the FK is satisfied; is_adhoc=1 hides it from the template editor.
// If save_to_template=true, is_adhoc=0, so it appears in the template permanently.
function addExerciseToWorkout(workoutId, exerciseName, targetSets, targetReps, afterSortOrder, saveToTemplate) {
  const workout = db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId);
  if (!workout) throw new Error('Workout not found');

  const exerciseId = getOrCreateExercise(exerciseName);
  const isAdhoc = saveToTemplate ? 0 : 1;

  // Determine sort_order for the new exercise (after the specified position)
  const existing = db.prepare('SELECT id, sort_order FROM workout_exercises WHERE workout_id = ? ORDER BY sort_order').all(workoutId);
  // afterSortOrder = null means "at the top" (insert before all); otherwise insert after that sort_order
  const insertSortOrder = afterSortOrder != null ? afterSortOrder + 1 : 0;

  const txn = db.transaction(() => {
    // Shift sort_orders of exercises that come after the insertion point
    db.prepare('UPDATE workout_exercises SET sort_order = sort_order + 1 WHERE workout_id = ? AND sort_order >= ?')
      .run(workoutId, insertSortOrder);

    // Create day_exercise in the template
    const templateMaxSort = db.prepare('SELECT MAX(sort_order) as mx FROM day_exercises WHERE day_id = ?').get(workout.day_id);
    const deSortOrder = (templateMaxSort && templateMaxSort.mx != null) ? templateMaxSort.mx + 1 : 0;
    const deInfo = db.prepare(`
      INSERT INTO day_exercises (day_id, exercise_id, target_sets, target_reps, sort_order, is_adhoc)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workout.day_id, exerciseId, targetSets || 3, targetReps || '10', deSortOrder, isAdhoc);
    const dayExerciseId = deInfo.lastInsertRowid;

    // Create workout_exercise at the insertion sort_order
    const weInfo = db.prepare(`
      INSERT INTO workout_exercises (workout_id, day_exercise_id, sort_order, skipped, note)
      VALUES (?, ?, ?, 0, NULL)
    `).run(workoutId, dayExerciseId, insertSortOrder);
    const workoutExerciseId = weInfo.lastInsertRowid;

    // Create initial empty sets
    const targetRepsNum = parseInt(targetReps) || null;
    const insertWs = db.prepare(`
      INSERT INTO workout_sets (workout_exercise_id, set_number, weight, reps, target_reps)
      VALUES (?, ?, NULL, NULL, ?)
    `);
    for (let s = 1; s <= (targetSets || 3); s++) {
      insertWs.run(workoutExerciseId, s, targetRepsNum);
    }

    return workoutExerciseId;
  });

  return txn();
}

function deleteWorkout(id) {
  db.prepare('DELETE FROM workouts WHERE id = ?').run(id);
}

function reorderWorkoutExercises(workoutId, orderedIds) {
  const stmt = db.prepare('UPDATE workout_exercises SET sort_order = ? WHERE id = ? AND workout_id = ?');
  const txn = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, workoutId));
  });
  txn();
}

// --- Exercise linking helpers ---

function syncLinkedExercises(dayExerciseId, fields) {
  const de = db.prepare('SELECT exercise_id, day_id, is_warmup, targets_independent FROM day_exercises WHERE id = ?').get(dayExerciseId);
  if (!de) return;

  const baseWhere = 'exercise_id = ? AND id != ? AND day_id != ? AND is_warmup = ? AND archived = 0';
  const baseParams = [de.exercise_id, dayExerciseId, de.day_id, de.is_warmup];

  // targets_independent is an all-or-nothing property: every slot of the same exercise
  // must agree on whether targets are synced or independent. If the flag is changing,
  // broadcast the new value to ALL linked slots FIRST — before processing anything else —
  // so subsequent queries see the final state.
  const independentChanging = 'targets_independent' in fields;
  const effectiveIndependent = independentChanging
    ? (fields.targets_independent ? 1 : 0)
    : de.targets_independent;

  if (independentChanging) {
    db.prepare(`UPDATE day_exercises SET targets_independent = ? WHERE ${baseWhere}`)
      .run(effectiveIndependent, ...baseParams);
  }

  // Propagate target fields (target_sets, target_reps) only when effectively synced.
  // Because step 1 already set targets_independent = 0 on all linked slots for the
  // re-link case, the AND targets_independent = 0 guard now matches all of them.
  if (!effectiveIndependent) {
    const targetUpdates = [], targetValues = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'target_sets' || key === 'target_reps') {
        targetUpdates.push(`${key} = ?`);
        targetValues.push(val);
      }
    }
    if (targetUpdates.length > 0) {
      db.prepare(`UPDATE day_exercises SET ${targetUpdates.join(', ')} WHERE ${baseWhere} AND targets_independent = 0`)
        .run(...targetValues, ...baseParams);
    }
  }

  // Propagate other fields (notes, workout-type flags) to all linked slots regardless
  // of independence state — these are always shared.
  const otherSyncable = ['is_warmup', 'is_duration', 'is_amrap', 'amrap_last_only', 'notes'];
  const otherUpdates = [], otherValues = [];
  for (const [key, val] of Object.entries(fields)) {
    if (otherSyncable.includes(key)) {
      otherUpdates.push(`${key} = ?`);
      otherValues.push(val);
    }
  }
  if (otherUpdates.length > 0) {
    db.prepare(`UPDATE day_exercises SET ${otherUpdates.join(', ')} WHERE ${baseWhere}`)
      .run(...otherValues, ...baseParams);
  }
}

function getTemplatesForExercise(exerciseId) {
  return db.prepare(`
    SELECT DISTINCT d.id, d.name
    FROM day_exercises de
    JOIN days d ON d.id = de.day_id
    WHERE de.exercise_id = ? AND de.archived = 0
    ORDER BY d.name
  `).all(exerciseId);
}

function getLinkedSlotTargets(dayExerciseId) {
  const de = db.prepare('SELECT exercise_id, day_id, is_warmup FROM day_exercises WHERE id = ?').get(dayExerciseId);
  if (!de) return [];
  return db.prepare(`
    SELECT de.id, de.target_sets, de.target_reps, de.targets_independent, d.name as template_name
    FROM day_exercises de
    JOIN days d ON d.id = de.day_id
    WHERE de.exercise_id = ? AND de.id != ? AND de.day_id != ? AND de.is_warmup = ? AND de.archived = 0
    ORDER BY d.name
  `).all(de.exercise_id, dayExerciseId, de.day_id, de.is_warmup);
}

function getLinkedInfoForTemplate(templateId) {
  // Returns day_exercise_id -> list of other template names for all exercises in this template
  // Only matches by role (warmup↔warmup, main↔main) so links are accurate
  const exercises = db.prepare('SELECT id, exercise_id, is_warmup FROM day_exercises WHERE day_id = ? AND archived = 0').all(templateId);
  const result = {};
  for (const ex of exercises) {
    const others = db.prepare(`
      SELECT DISTINCT d.name
      FROM day_exercises de
      JOIN days d ON d.id = de.day_id
      WHERE de.exercise_id = ? AND de.day_id != ? AND de.is_warmup = ? AND de.archived = 0
      ORDER BY d.name
    `).all(ex.exercise_id, templateId, ex.is_warmup);
    if (others.length > 0) {
      result[ex.id] = others.map(o => o.name);
    }
  }
  return result;
}

function getMostRecentExerciseData(exerciseId, beforeDate, isWarmup) {
  // Match by role (warmup↔warmup, main↔main) so prev data is relevant
  const warmupFilter = isWarmup != null ? 'AND de.is_warmup = ?' : '';
  const params = isWarmup != null ? [exerciseId, beforeDate, isWarmup] : [exerciseId, beforeDate];
  const row = db.prepare(`
    SELECT we.id as we_id, w.date, w.day_id, d.name as template_name,
           we.day_exercise_id, we.skipped, we.note, de.exercise_id
    FROM workout_exercises we
    JOIN day_exercises de ON de.id = we.day_exercise_id
    JOIN workouts w ON w.id = we.workout_id
    JOIN days d ON d.id = w.day_id
    WHERE de.exercise_id = ? AND w.date < ? AND we.skipped = 0 ${warmupFilter}
    ORDER BY w.date DESC
    LIMIT 1
  `).get(...params);
  if (!row) return null;
  row.sets = db.prepare('SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number').all(row.we_id);
  return row;
}

// --- History helpers ---

function getExerciseHistory(exerciseId, limit = 8) {
  return db.prepare(`
    SELECT w.date, we.skipped, we.note, de.target_sets, de.target_reps
    FROM workout_exercises we
    JOIN workouts w ON w.id = we.workout_id
    JOIN day_exercises de ON de.id = we.day_exercise_id
    WHERE de.exercise_id = ?
    ORDER BY w.date DESC
    LIMIT ?
  `).all(exerciseId, limit);
}

function getExerciseHistoryWithSets(exerciseId, limit = 8) {
  const sessions = db.prepare(`
    SELECT we.id as we_id, w.date, we.skipped, we.note, de.target_sets, de.target_reps
    FROM workout_exercises we
    JOIN workouts w ON w.id = we.workout_id
    JOIN day_exercises de ON de.id = we.day_exercise_id
    WHERE de.exercise_id = ?
    ORDER BY w.date DESC
    LIMIT ?
  `).all(exerciseId, limit);

  for (const s of sessions) {
    s.sets = db.prepare('SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number').all(s.we_id);
  }
  return sessions;
}

function getAllWorkoutDates() {
  return db.prepare(`
    SELECT w.date, w.id, d.name as day_name, d.day_index
    FROM workouts w
    JOIN days d ON d.id = w.day_id
    ORDER BY w.date DESC
  `).all();
}

function getWorkoutDatesInRange(fromDate, toDate) {
  return db.prepare(`
    SELECT DISTINCT date FROM workouts WHERE date >= ? AND date <= ?
  `).all(fromDate, toDate).map(r => r.date);
}

function getWorkoutsInRange(fromDate, toDate) {
  return db.prepare(`
    SELECT w.date, d.name as template_name
    FROM workouts w
    JOIN days d ON d.id = w.day_id
    WHERE w.date >= ? AND w.date <= ?
    ORDER BY w.date
  `).all(fromDate, toDate);
}

// --- Trend / Progress helpers ---

function getPerformedExercises() {
  // All effective exercises with at least one completed set, excluding warmups.
  // If a workout exercise was swapped, attribute it to the override exercise.
  // last_date = most recent workout date for the exercise (for the Strength picker).
  return db.prepare(`
    SELECT effective.id, effective.name, MAX(w.date) as last_date
    FROM workout_exercises we
    JOIN day_exercises de ON de.id = we.day_exercise_id AND de.is_warmup = 0
    JOIN workout_sets ws ON ws.workout_exercise_id = we.id AND ws.completed = 1
    JOIN exercises effective ON effective.id = COALESCE(we.override_exercise_id, de.exercise_id)
    JOIN workouts w ON w.id = we.workout_id
    WHERE we.skipped = 0
    GROUP BY effective.id, effective.name
    ORDER BY effective.name
  `).all();
}

function getExerciseTrend(exerciseId) {
  // Returns [{date, total_volume, completion_pct}] sorted ASC, excluding warmup sets.
  // total_volume = SUM(weight * reps) for completed sets that have both values.
  // completion_pct = per-set avg where AMRAP=100%, others = min(reps/target,1)*100.
  const rows = db.prepare(`
    SELECT w.date,
           ws.weight, ws.reps, ws.target_reps, ws.is_amrap, ws.completed
    FROM workout_exercises we
    JOIN workouts w ON w.id = we.workout_id
    JOIN day_exercises de ON de.id = we.day_exercise_id
    JOIN workout_sets ws ON ws.workout_exercise_id = we.id
    WHERE COALESCE(we.override_exercise_id, de.exercise_id) = ?
      AND de.is_warmup = 0
      AND we.skipped = 0
    ORDER BY w.date ASC, ws.set_number ASC
  `).all(exerciseId);

  const dateMap = new Map();
  for (const row of rows) {
    if (!dateMap.has(row.date)) dateMap.set(row.date, []);
    dateMap.get(row.date).push(row);
  }

  const result = [];
  for (const [date, sets] of dateMap) {
    const completedSets = sets.filter(s => s.completed);
    if (completedSets.length === 0) continue;

    // Volume: only sets with both weight and reps
    const totalVolume = completedSets.reduce((sum, s) => {
      if (s.weight == null || s.reps == null) return sum;
      return sum + s.weight * s.reps;
    }, 0);

    // Completion: all scheduled sets (completed or not) as denominator
    const totalSets = sets.length;
    const completionSum = sets.reduce((sum, s) => {
      if (s.is_amrap) return sum + 1;
      if (!s.completed || s.reps == null) return sum + 0;
      if (s.target_reps == null || s.target_reps === 0) return sum + 1;
      return sum + Math.min(s.reps / s.target_reps, 1);
    }, 0);
    const completionPct = Math.round(completionSum / totalSets * 100);

    result.push({ date, total_volume: Math.round(totalVolume), completion_pct: completionPct });
  }
  return result;
}

function getAllWorkoutSessionDates() {
  return db.prepare('SELECT date FROM workouts ORDER BY date ASC, id ASC').all().map(r => r.date);
}

// --- Body weight helpers ---

function logBodyWeight(date, weightKg) {
  db.prepare(`
    INSERT INTO body_weights (date, weight_kg) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg
  `).run(date, weightKg);
}

function getBodyWeights() {
  return db.prepare('SELECT date, weight_kg FROM body_weights ORDER BY date DESC').all();
}

function deleteBodyWeight(date) {
  db.prepare('DELETE FROM body_weights WHERE date = ?').run(date);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- User settings helpers ---

function getUserSetting(key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setUserSetting(key, value) {
  db.prepare(
    'INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// --- Meal template helpers ---

function getMealTemplates() {
  return db.prepare('SELECT * FROM meal_templates WHERE active = 1 ORDER BY sort_order, id').all();
}

function createMealTemplate({ name, calories_kcal = 0, protein_g = 0, carbs_g = 0, fat_g = 0, include_rest_day = 1, use_defaults = 0 }) {
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM meal_templates WHERE active = 1').get().m;
  const info = db.prepare(`
    INSERT INTO meal_templates (name, sort_order, calories_kcal, protein_g, carbs_g, fat_g, include_rest_day, use_defaults, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(name, maxSort + 1, calories_kcal, protein_g, carbs_g, fat_g, include_rest_day ? 1 : 0, use_defaults ? 1 : 0);
  return info.lastInsertRowid;
}

function updateMealTemplate(id, fields) {
  const allowed = ['name', 'calories_kcal', 'protein_g', 'carbs_g', 'fat_g', 'include_rest_day', 'use_defaults', 'sort_order', 'active'];
  const updates = [], values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) { updates.push(`${key} = ?`); values.push(val); }
  }
  if (updates.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE meal_templates SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function deleteMealTemplate(id) {
  db.prepare('UPDATE meal_templates SET active = 0 WHERE id = ?').run(id);
}

function reorderMealTemplates(orderedIds) {
  const stmt = db.prepare('UPDATE meal_templates SET sort_order = ? WHERE id = ?');
  const txn = db.transaction(() => { orderedIds.forEach((id, idx) => stmt.run(idx, id)); });
  txn();
}

// --- Macro log helpers ---

function getMacroLogsForDate(date) {
  return db.prepare('SELECT * FROM macro_logs WHERE date = ? ORDER BY sort_order, id').all(date);
}

function createMacroLog({ date, meal_template_id = null, meal_name, sort_order = 0, calories_kcal = 0, protein_g = 0, carbs_g = 0, fat_g = 0 }) {
  const info = db.prepare(`
    INSERT INTO macro_logs (date, meal_template_id, meal_name, sort_order, calories_kcal, protein_g, carbs_g, fat_g)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, meal_template_id ?? null, meal_name, sort_order, calories_kcal, protein_g, carbs_g, fat_g);
  return info.lastInsertRowid;
}

function updateMacroLog(id, fields) {
  const allowed = ['calories_kcal', 'protein_g', 'carbs_g', 'fat_g', 'meal_name', 'sort_order'];
  const updates = [], values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) { updates.push(`${key} = ?`); values.push(val); }
  }
  if (updates.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE macro_logs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function deleteMacroLog(id) {
  db.prepare('DELETE FROM macro_logs WHERE id = ?').run(id);
}

function getDailyTdee(date) {
  // Returns TDEE (BMR + active energy) in kcal for the given date,
  // or null if no data exists (health_daily_metrics table may not exist yet).
  try {
    const row = db.prepare(
      'SELECT bmr_kcal + active_energy_kcal AS tdee_kcal FROM health_daily_metrics WHERE date = ?'
    ).get(date);
    return row ? Math.round(row.tdee_kcal) : null;
  } catch (e) {
    return null; // table doesn't exist yet — Phase 2 feature
  }
}

// Create a weekly backup of the DB if one doesn't already exist for the current week.
// Keyed by the Monday of the current week so running the server any day that week is a no-op
// after the first successful run.
function ensureWeeklyBackup() {
  const fs = require('fs');
  const now = new Date();
  const jsDay = now.getDay(); // 0=Sun
  const diffToMonday = jsDay === 0 ? -6 : 1 - jsDay;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const iso = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;

  const backupDir = path.join(__dirname, 'data', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `workouts-${iso}.db`);
  if (fs.existsSync(backupPath)) return { created: false, path: backupPath };

  // Uses SQLite's online backup API via better-sqlite3 — handles the WAL correctly.
  return getDb().backup(backupPath).then(() => ({ created: true, path: backupPath }));
}

module.exports = {
  getDb,
  closeDb,
  ensureWeeklyBackup,
  getOrCreateExercise,
  getAllExercises,
  // Template management
  getAllTemplates,
  createTemplate,
  duplicateTemplate,
  updateTemplate,
  deleteTemplate,
  // Schedule management
  getSchedule,
  addScheduleEntry,
  removeScheduleEntry,
  getScheduleForDate,
  // Legacy day helpers
  getOrCreateDay,
  getAllDays,
  updateDay,
  // Template exercise helpers
  addDayExercise,
  getDayExercises,
  updateDayExercise,
  deleteDayExercise,
  restoreDayExercise,
  hardDeleteDayExercise,
  getArchivedExercisesWithHistory,
  reorderDayExercises,
  // Workout helpers
  getOrCreateWorkout,
  getWorkoutByDate,
  getWorkoutsForDate,
  getWorkoutFull,
  getWorkoutForDate,
  getFullWorkoutsForDate,
  getDayForDate,
  initWorkoutFromTemplate,
  getMostRecentWorkoutForDay,
  saveWorkoutExercise,
  swapWorkoutExercise,
  addExerciseToWorkout,
  deleteWorkout,
  reorderWorkoutExercises,
  // Exercise linking helpers
  syncLinkedExercises,
  getTemplatesForExercise,
  getLinkedInfoForTemplate,
  getLinkedSlotTargets,
  getMostRecentExerciseData,
  // History helpers
  getExerciseHistory,
  getExerciseHistoryWithSets,
  getAllWorkoutDates,
  getWorkoutDatesInRange,
  getWorkoutsInRange,
  // Body weight helpers
  logBodyWeight,
  getBodyWeights,
  deleteBodyWeight,
  // Trend / Progress helpers
  getPerformedExercises,
  getExerciseTrend,
  getAllWorkoutSessionDates,
  // User settings
  getUserSetting,
  setUserSetting,
  // Meal templates
  getMealTemplates,
  createMealTemplate,
  updateMealTemplate,
  deleteMealTemplate,
  reorderMealTemplates,
  // Macro logs
  getMacroLogsForDate,
  createMacroLog,
  updateMacroLog,
  deleteMacroLog,
  // TDEE / health metrics
  getDailyTdee,
};
