const fs = require('fs');
const path = require('path');
const db = require('./database');

const HISTORY_DIR = path.join(__dirname, 'Workout History');

const DAY_MAP = {
  'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
  'friday': 4, 'saturday': 5, 'sunday': 6,
};

// Normalize exercise names to prevent duplicates from spelling/case variations
const NAME_ALIASES = {
  'low to high': 'Low-to-High Fly',
  'low-to-high fly': 'Low-to-High Fly',
  'low-to-high': 'Low-to-High Fly',
  'high-to-low fly': 'High-to-Low Fly',
  'gay little ab wheel': 'Ab Wheel Rollouts',
  'ab wheel rollouts': 'Ab Wheel Rollouts',
  'incline inverted y raise': 'Incline Inverted Y Raise',
  'linear hack squat calf raises': 'Linear Hack Squat Calf Raises',
  'linear hack squat ( i.e. standing) calf raises': 'Linear Hack Squat Calf Raises',
  'single-arm cable y raise': 'Single-Arm Cable Y Raise',
  'single-arm cable y raise (egyptian)': 'Single-Arm Cable Y Raise',
  'preacher curl (alternate grips weekly)': 'Preacher Curl',
  'preacher curl': 'Preacher Curl',
  'squat': 'Squat',
  'regular squat': 'Squat',
  'box squat': 'Box Squat',
  'dl': 'Deadlift',
  'pullup': 'Pull-up',
  'assisted pullup': 'Assisted Pull-up',
  'chinup': 'Chin-up',
  'flat db bench (warmup)': 'Flat DB Bench',
  'flat db bench': 'Flat DB Bench',
  'db curl': 'DB Curl',
  'inward hammer curl': 'Inward Hammer Curl',
};

function normalizeName(name) {
  const lower = name.toLowerCase().trim();
  if (NAME_ALIASES[lower]) return NAME_ALIASES[lower];
  // Title case the original if no alias
  return name.trim();
}

function parseWeekDate(filename) {
  const m = filename.match(/Week\s+(\d+)(?:st|nd|rd|th)?\s+(\w+)/i);
  if (!m) return null;
  const day = parseInt(m[1]);
  const monthStr = m[2].toLowerCase();
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const month = months[monthStr.slice(0, 3)];
  if (month === undefined) return null;
  const date = new Date(2025, month, day);
  const jsDay = date.getDay();
  const diff = jsDay === 0 ? -6 : 1 - jsDay;
  date.setDate(date.getDate() + diff);
  return date;
}

function dateToISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDayHeader(line) {
  const trimmed = line.replace(/^>?\s*/, '').trim();
  const m = trimmed.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)[:\s]*(.*)/i);
  if (!m) return null;
  return { dayIndex: DAY_MAP[m[1].toLowerCase()], dayName: m[1], label: m[2].trim() };
}

function isDayHeader(line) {
  return /^>?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(line.trim());
}

// Determine if a line is a weight/data line (comes after exercise declarations)
function looksLikeDataLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^skipped$/i.test(t)) return true;
  if (/^bw\s*$/i.test(t)) return true;
  if (/^bar\b/i.test(t)) return true;
  // Starts with a digit or minus and is mostly numbers, commas, x, kg, s
  if (/^[\d.]/.test(t) && /^[\d.,xXsS\s+kgKG()\-]+$/.test(t)) return true;
  // Early format: "12kg: 10,8,7,6"
  if (/^\d+(\.\d+)?\s*kg\s*(\+\s*bar)?\s*:/i.test(t)) return true;
  return false;
}

function isNoteLine(line) {
  return /^\(.*\)\s*$/.test(line.trim());
}

// Parse exercise declaration: "Exercise Name: SETSxREPS" or "Exercise Name SETSxREPS"
function parseExerciseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('(') || /^stretching$/i.test(trimmed)) return null;
  if (/^cable:\s*$/i.test(trimmed)) return null; // grouping header
  if (/^week\s+\d+/i.test(trimmed)) return null;

  // Must NOT look like a data line
  if (looksLikeDataLine(trimmed)) return null;

  // Match "Exercise: SETSxREPS" or "Exercise SETSxREPS"
  // Use a more specific pattern: the sets/reps part must be at the end
  const m = trimmed.match(/^(.+?)\s*:?\s*(\d+)\s*x\s*(\S+.*)$/i);
  if (m) {
    let name = m[1].trim();
    const sets = parseInt(m[2]);
    let repsStr = m[3].trim();

    // Don't match if "name" is all digits/commas (that's a data line)
    if (/^[\d.,\s]+$/.test(name)) return null;

    // Extract parenthetical notes from name
    let note = null;
    const parenInName = name.match(/^(.+?)\s*(\([^)]+\))\s*$/);
    if (parenInName) {
      name = parenInName[1].trim();
      note = parenInName[2];
    }

    // Extract parenthetical from reps
    const parenInReps = repsStr.match(/^(.+?)\s*(\([^)]+\))\s*$/);
    if (parenInReps) {
      repsStr = parenInReps[1].trim();
      if (!note) note = parenInReps[2];
    }

    // Clean reps: remove surrounding parens for superset format
    repsStr = repsStr.replace(/^\(/, '').replace(/\)$/, '');

    // Handle "4x12kg" format (weight in reps position)
    if (/^\d+kg$/i.test(repsStr)) {
      // This means the weight is fixed and we're logging reps
      return { name: normalizeName(name), sets, reps: repsStr, note, isFixedWeight: true };
    }

    return { name: normalizeName(name), sets, reps: repsStr, note };
  }

  // Match "Exercise: N sets ..." (forearm rolls, wrist roller)
  const setsMatch = trimmed.match(/^(.+?)\s*:?\s*(\d+)\s+sets?\b(.*)$/i);
  if (setsMatch) {
    const name = setsMatch[1].trim();
    if (/^[\d.,\s]+$/.test(name)) return null;
    return { name: normalizeName(name), sets: parseInt(setsMatch[2]), reps: '1', note: setsMatch[3].trim() || null };
  }

  return null;
}

function parseWeightLine(line, targetSets, targetReps) {
  const trimmed = line.trim();

  if (/^skipped$/i.test(trimmed)) {
    return { skipped: true, sets: [] };
  }

  if (/^bw\s*$/i.test(trimmed)) {
    const repsNum = parseInt(targetReps) || 10;
    return { skipped: false, sets: Array.from({ length: targetSets }, () => ({ weight: null, reps: repsNum, targetReps: repsNum })) };
  }

  // Early format: "12kg: 10,8,7,6" or "10kg +bar:10,10,6,6"
  const earlyMatch = trimmed.match(/^([\d.]+)\s*kg\s*(?:\+\s*bar)?\s*:\s*(.+)$/i);
  if (earlyMatch) {
    const weight = parseFloat(earlyMatch[1]);
    const parts = earlyMatch[2].split(',').map(v => v.trim()).filter(v => v);
    const sets = parts.map(v => {
      const reps = parseInt(v) || 0;
      return { weight, reps, targetReps: parseInt(targetReps) || 10 };
    });
    return { skipped: false, sets, earlyFormat: true };
  }

  if (/^bar\b/i.test(trimmed)) {
    return { skipped: false, sets: [], isWarmup: true };
  }

  // Time format: "30s, 30s"
  if (/\d+s/.test(trimmed)) {
    const times = trimmed.split(',').map(v => {
      const tm = v.trim().match(/(\d+)s/);
      return tm ? parseInt(tm[1]) : null;
    }).filter(v => v !== null);
    return { skipped: false, sets: times.map(t => ({ weight: null, reps: null, targetReps: null, durationSeconds: t })) };
  }

  // Standard comma-separated values
  const parts = trimmed.split(',').map(v => v.trim()).filter(v => v);
  if (parts.length === 0) return null;

  const repsNum = parseInt(targetReps) || 10;

  // Single value for all sets (no comma, no x)
  if (parts.length === 1 && !parts[0].includes('x')) {
    const weight = parseFloat(parts[0]);
    if (isNaN(weight)) return null;
    return { skipped: false, sets: Array.from({ length: targetSets }, () => ({ weight, reps: repsNum, targetReps: repsNum })) };
  }

  const sets = [];
  for (const part of parts) {
    const xMatch = part.match(/^([\d.]+)\s*x\s*([\d.]+)$/);
    if (xMatch) {
      const a = parseFloat(xMatch[1]);
      const b = parseFloat(xMatch[2]);
      if (b === 0) {
        // "6x0" = 6 reps at 0kg
        sets.push({ weight: 0, reps: Math.round(a), targetReps: repsNum });
      } else {
        // "40x5" = weight a, reps b (didn't hit target)
        sets.push({ weight: a, reps: Math.round(b), targetReps: repsNum });
      }
    } else {
      const weight = parseFloat(part);
      if (!isNaN(weight)) {
        sets.push({ weight, reps: repsNum, targetReps: repsNum });
      }
    }
  }
  return { skipped: false, sets };
}

// Parse reps-as-data for fixed-weight exercises like "DB Curl: 4x12kg" → "10, 10, 10, 7"
function parseRepsLine(line, targetSets, fixedWeight) {
  const trimmed = line.trim();
  const weight = parseFloat(fixedWeight) || 0;
  const parts = trimmed.split(',').map(v => v.trim()).filter(v => v);
  const targetReps = 10; // default
  return {
    skipped: false,
    sets: parts.map(v => {
      const reps = parseInt(v) || 0;
      return { weight, reps, targetReps };
    })
  };
}

function importFile(filepath, monday) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n');

  let currentDay = null;
  let currentDayDate = null;
  const days = [];
  let dayExercises = [];
  let lineIdx = 0;

  while (lineIdx < lines.length) {
    const line = lines[lineIdx];
    const trimmed = line.trim();

    // Skip empty lines, week headers, alternation markers
    if (!trimmed || /^week\s+\d+\s+(jan|feb|mar)/i.test(trimmed) || /^and$/i.test(trimmed)) {
      lineIdx++;
      continue;
    }

    // Week 1:/Week 2: alternation markers
    if (/^week\s+\d+:/i.test(trimmed)) {
      lineIdx++;
      continue;
    }

    // Day header
    const dayHeader = parseDayHeader(trimmed);
    if (dayHeader) {
      if (currentDay) {
        days.push({ ...currentDay, date: currentDayDate, exercises: [...dayExercises] });
      }
      currentDay = dayHeader;
      currentDayDate = new Date(monday);
      currentDayDate.setDate(monday.getDate() + dayHeader.dayIndex);
      dayExercises = [];
      lineIdx++;
      continue;
    }

    // If we don't have a current day yet, try to infer from exercises
    if (!currentDay) {
      // Check if this could be an exercise - if so, we need to assign a day
      const ex = parseExerciseLine(trimmed);
      if (ex) {
        // Try to guess the day from exercise content
        const lower = ex.name.toLowerCase();
        if (lower.includes('curl') || lower.includes('tricep') || lower.includes('wrist')) {
          currentDay = { dayIndex: 5, dayName: 'Saturday', label: 'Arm' };
        } else if (lower.includes('squat') || lower.includes('press') || lower.includes('rdl') || lower.includes('lunge')) {
          currentDay = { dayIndex: 0, dayName: 'Monday', label: 'Leg' };
        } else {
          currentDay = { dayIndex: 0, dayName: 'Monday', label: '' };
        }
        currentDayDate = new Date(monday);
        currentDayDate.setDate(monday.getDate() + currentDay.dayIndex);
        dayExercises = [];
        // Don't increment lineIdx, let the exercise parsing handle it
        continue;
      }
      lineIdx++;
      continue;
    }

    // Try to parse as exercise
    const exercise = parseExerciseLine(trimmed);
    if (exercise) {
      // Lookahead for data lines and notes
      let dataLines = [];
      let notes = [];
      let j = lineIdx + 1;

      while (j < lines.length) {
        const nextTrimmed = lines[j].trim();
        if (!nextTrimmed) { j++; continue; }
        if (isDayHeader(nextTrimmed)) break;
        if (parseExerciseLine(nextTrimmed) && !looksLikeDataLine(nextTrimmed)) break;
        if (/^week\s+\d+:/i.test(nextTrimmed)) break;

        if (isNoteLine(nextTrimmed)) {
          notes.push(nextTrimmed.replace(/^\(/, '').replace(/\)\s*$/, ''));
          j++;
          continue;
        }
        if (looksLikeDataLine(nextTrimmed)) {
          dataLines.push(nextTrimmed);
          j++;
          continue;
        }
        // Unknown line type - stop lookahead
        break;
      }

      let parsedSets = [];
      let skipped = false;

      if (dataLines.length > 0) {
        if (exercise.isFixedWeight) {
          // "DB Curl: 4x12kg" → data is reps, not weights
          const weightNum = parseFloat(exercise.reps);
          const result = parseRepsLine(dataLines[0], exercise.sets, weightNum);
          parsedSets = result.sets;
        } else {
          const first = parseWeightLine(dataLines[0], exercise.sets, exercise.reps);
          if (first) {
            skipped = first.skipped;
            if (first.earlyFormat && dataLines.length > 1) {
              parsedSets = [...first.sets];
              for (let wi = 1; wi < dataLines.length; wi++) {
                const extra = parseWeightLine(dataLines[wi], exercise.sets, exercise.reps);
                if (extra && extra.sets) parsedSets.push(...extra.sets);
              }
            } else {
              parsedSets = first.sets || [];
            }
          }
        }
      }

      const allNotes = [];
      if (exercise.note) allNotes.push(exercise.note.replace(/^\(/, '').replace(/\)\s*$/, ''));
      allNotes.push(...notes);

      dayExercises.push({
        name: exercise.name,
        sets: exercise.sets,
        reps: exercise.isFixedWeight ? '10' : exercise.reps,
        notes: allNotes.join('; ') || null,
        parsedSets,
        skipped,
      });

      lineIdx = j;
      continue;
    }

    // Skip anything else (orphan notes, grouping headers like "Cable:", etc.)
    lineIdx++;
  }

  // Save last day
  if (currentDay) {
    days.push({ ...currentDay, date: currentDayDate, exercises: [...dayExercises] });
  }

  return days;
}

function run() {
  const database = db.getDb();

  const files = fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({ name: f, path: path.join(HISTORY_DIR, f), monday: parseWeekDate(f) }))
    .filter(f => f.monday)
    .sort((a, b) => a.monday - b.monday);

  // The template file (no workout data, just exercise list) is "Week 6 Jan"
  const isTemplateOnly = (f) => /Week 6 Jan\.txt$/i.test(f.name);

  console.log(`Found ${files.length} workout files`);

  // Use latest file as the current template
  const latestFile = files[files.length - 1];
  console.log(`Template source: ${latestFile.name}\n`);
  const latestDays = importFile(latestFile.path, latestFile.monday);

  const dayIdMap = {};
  const templateMap = {}; // dayIndex -> { normalizedName -> dayExerciseId }

  const txn = database.transaction(() => {
    // Create days and template from latest file
    for (const day of latestDays) {
      const dayId = db.getOrCreateDay(day.dayIndex, day.label);
      dayIdMap[day.dayIndex] = dayId;
      templateMap[day.dayIndex] = {};

      for (let i = 0; i < day.exercises.length; i++) {
        const ex = day.exercises[i];
        const exerciseId = db.getOrCreateExercise(ex.name);
        const deId = db.addDayExercise(dayId, exerciseId, ex.sets, ex.reps, i, ex.notes || null, null);
        templateMap[day.dayIndex][ex.name.toLowerCase()] = deId;
      }
    }

    // Import all files as workout history
    for (const file of files) {
      if (isTemplateOnly(file)) {
        console.log(`Skipping ${file.name} (template-only, no workout data)`);
        continue;
      }

      console.log(`Importing ${file.name}...`);
      const days = importFile(file.path, file.monday);

      for (const day of days) {
        if (day.exercises.length === 0) continue;
        const dateStr = dateToISO(day.date);

        if (!dayIdMap[day.dayIndex]) {
          const dayId = db.getOrCreateDay(day.dayIndex, day.label);
          dayIdMap[day.dayIndex] = dayId;
          templateMap[day.dayIndex] = templateMap[day.dayIndex] || {};
        }
        const dayId = dayIdMap[day.dayIndex];

        const workout = db.getOrCreateWorkout(dateStr, dayId);
        const existing = database.prepare('SELECT id FROM workout_exercises WHERE workout_id = ?').all(workout.id);
        if (existing.length > 0) continue;

        for (let i = 0; i < day.exercises.length; i++) {
          const ex = day.exercises[i];
          const exerciseId = db.getOrCreateExercise(ex.name);

          // Find or create template exercise
          let deId = templateMap[day.dayIndex][ex.name.toLowerCase()];
          if (!deId) {
            deId = db.addDayExercise(dayId, exerciseId, ex.sets, ex.reps, 100 + i, ex.notes || null, null);
            templateMap[day.dayIndex][ex.name.toLowerCase()] = deId;
          }

          const weInfo = database.prepare(
            'INSERT INTO workout_exercises (workout_id, day_exercise_id, sort_order, skipped, note) VALUES (?, ?, ?, ?, ?)'
          ).run(workout.id, deId, i, ex.skipped ? 1 : 0, ex.notes || null);

          if (ex.parsedSets && ex.parsedSets.length > 0) {
            const insertSet = database.prepare(
              'INSERT INTO workout_sets (workout_exercise_id, set_number, weight, reps, target_reps, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
            );
            for (let s = 0; s < ex.parsedSets.length; s++) {
              const set = ex.parsedSets[s];
              insertSet.run(
                weInfo.lastInsertRowid, s + 1,
                set.weight != null ? set.weight : null,
                set.reps != null ? set.reps : null,
                set.targetReps != null ? set.targetReps : null,
                set.durationSeconds != null ? set.durationSeconds : null
              );
            }
          }
        }

        console.log(`  ${dateStr} (${day.dayName}: ${day.label}) - ${day.exercises.length} exercises`);
      }
    }
  });

  txn();

  // Summary
  const exerciseCount = database.prepare('SELECT COUNT(*) as c FROM exercises').get().c;
  const workoutCount = database.prepare('SELECT COUNT(*) as c FROM workouts').get().c;
  const setCount = database.prepare('SELECT COUNT(*) as c FROM workout_sets').get().c;
  console.log(`\nImport complete:`);
  console.log(`  ${exerciseCount} unique exercises`);
  console.log(`  ${workoutCount} workout sessions`);
  console.log(`  ${setCount} total sets logged`);

  // List exercises
  console.log('\nExercises found:');
  database.prepare('SELECT name FROM exercises ORDER BY name').all().forEach(e => console.log(`  - ${e.name}`));

  db.closeDb();
}

run();
