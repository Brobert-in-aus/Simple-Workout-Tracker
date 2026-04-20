const fs = require('fs');
const path = require('path');
const db = require('./database');

const HEALTH_EXPORT_DIR = path.join(__dirname, 'data', 'HealthExport');
const MIN_IMPORT_DURATION_SECONDS = 300;
const KJ_PER_KCAL = 4.184;
const METRIC_NAME_ALIASES = {
  active_energy: 'active_energy',
  resting_energy: 'resting_energy',
  basal_energy_burned: 'resting_energy',
};

function parseArgs(argv) {
  const options = {
    dryRun: false,
    level: 'summary',
    minDuration: MIN_IMPORT_DURATION_SECONDS,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith('--level=')) {
      options.level = arg.split('=')[1] || options.level;
      continue;
    }
    if (arg.startsWith('--min-duration=')) {
      const value = parseInt(arg.split('=')[1], 10);
      if (!Number.isNaN(value)) options.minDuration = value;
    }
  }

  if (!['summary', 'derived', 'full'].includes(options.level)) {
    throw new Error(`Invalid --level value: ${options.level}`);
  }

  return options;
}

function round1(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

function round4(value) {
  return value == null ? null : Math.round(value * 10000) / 10000;
}

function sumQty(items) {
  if (!Array.isArray(items)) return null;
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (typeof item?.qty === 'number') {
      total += item.qty;
      count += 1;
    }
  }
  return count > 0 ? total : null;
}

function sampleCount(items) {
  return Array.isArray(items) ? items.filter(item => typeof item?.qty === 'number').length : 0;
}

function parseAppleDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  return {
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetHour}:${offsetMinute}`,
    date: `${year}-${month}-${day}`,
  };
}

function extractHeartRateRecovery(workout) {
  const values = Array.isArray(workout.heartRateRecovery)
    ? workout.heartRateRecovery
        .map(item => item?.Avg ?? item?.avg ?? item?.qty ?? null)
        .filter(value => typeof value === 'number')
    : [];
  if (values.length === 0) return null;
  return Math.max(...values) - Math.min(...values);
}

function toMeters(distance) {
  if (!distance || typeof distance.qty !== 'number') return null;
  if (distance.units === 'km') return distance.qty * 1000;
  return distance.qty;
}

function toKcal(value, units) {
  if (typeof value !== 'number') return null;
  if (units === 'kJ') return round1(value / KJ_PER_KCAL);
  return round1(value);
}

function normalizeWorkout(workout, sourceFile) {
  const start = parseAppleDate(workout.start);
  const end = parseAppleDate(workout.end);
  if (!start || !end || !workout.id) return null;

  const activeEnergyKcal = toKcal(workout.activeEnergyBurned?.qty ?? null, workout.activeEnergyBurned?.units);
  const summary = {
    active_energy_kcal: activeEnergyKcal,
    avg_heart_rate_bpm: workout.avgHeartRate?.qty ?? workout.heartRate?.avg?.qty ?? null,
    max_heart_rate_bpm: workout.maxHeartRate?.qty ?? workout.heartRate?.max?.qty ?? null,
    min_heart_rate_bpm: workout.heartRate?.min?.qty ?? null,
    distance_meters: toMeters(workout.distance),
    step_count_total: sumQty(workout.stepCount),
    avg_step_cadence: workout.stepCadence?.qty ?? null,
    intensity_avg: workout.intensity?.qty ?? null,
    temperature_avg: workout.temperature?.qty ?? null,
    humidity_avg: workout.humidity?.qty ?? null,
    elevation_up_meters: workout.elevationUp?.qty ?? null,
    heart_rate_recovery_bpm: extractHeartRateRecovery(workout),
  };

  return {
    sourceType: 'apple_health',
    externalId: String(workout.id),
    workoutType: String(workout.name || '').trim() || 'Unknown',
    name: String(workout.name || '').trim() || 'Unknown',
    date: start.date,
    startAt: start.iso,
    endAt: end.iso,
    durationSeconds: Math.round(workout.duration || 0),
    isIndoor: workout.isIndoor == null ? (workout.location === 'Indoor' ? 1 : null) : (workout.isIndoor ? 1 : 0),
    locationLabel: workout.location || null,
    summary,
    raw: {
      heartRateData: workout.heartRateData || null,
      activeEnergy: workout.activeEnergy || null,
      stepCount: workout.stepCount || null,
      walkingAndRunningDistance: workout.walkingAndRunningDistance || null,
      heartRateRecovery: workout.heartRateRecovery || null,
    },
    sourceSnapshotDate: null,
    sourceFile,
  };
}

function aggregateDailyMetrics(metricSeries, sourceFile) {
  const byDate = new Map();

  for (const metric of metricSeries) {
    const normalizedName = METRIC_NAME_ALIASES[metric?.name] || null;
    if (!normalizedName) continue;
    const units = metric?.units || null;
    const dataPoints = Array.isArray(metric?.data) ? metric.data : [];

    for (const point of dataPoints) {
      const parsed = parseAppleDate(point?.date);
      if (!parsed || typeof point?.qty !== 'number') continue;
      const key = parsed.date;
      if (!byDate.has(key)) {
        byDate.set(key, {
          date: key,
          sourceType: 'apple_health',
          activeEnergyKj: null,
          restingEnergyKj: null,
          activeEnergyKcal: null,
          restingEnergyKcal: null,
          tdeeKcal: null,
          sampleCountActive: 0,
        sampleCountResting: 0,
        sourceSnapshotDate: null,
        sourceFile,
      });
      }

      const row = byDate.get(key);
      if (normalizedName === 'active_energy') {
        row.activeEnergyKj = (row.activeEnergyKj || 0) + point.qty;
        row.sampleCountActive += 1;
      } else if (normalizedName === 'resting_energy') {
        row.restingEnergyKj = (row.restingEnergyKj || 0) + point.qty;
        row.sampleCountResting += 1;
      }

      if (units && units !== 'kJ') {
        throw new Error(`Unsupported daily metric units for ${metric.name}: ${units}`);
      }
    }
  }

  return [...byDate.values()].map(row => {
    row.activeEnergyKcal = toKcal(row.activeEnergyKj, 'kJ');
    row.restingEnergyKcal = toKcal(row.restingEnergyKj, 'kJ');
    row.tdeeKcal = round1((row.activeEnergyKcal || 0) + (row.restingEnergyKcal || 0));
    return row;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function computeLinksAndStatus(normalizedWorkout) {
  if (normalizedWorkout.workoutType !== 'Functional Strength Training') {
    return { matchStatus: 'imported_standalone', links: [] };
  }

  const inputs = db.getTrackedWorkoutAllocationInputs(normalizedWorkout.date);
  if (inputs.length === 0) {
    return { matchStatus: 'unmatched_strength', links: [] };
  }

  if (inputs.length === 1) {
    return {
      matchStatus: 'matched_single',
      links: [{
        workout_id: inputs[0].workout_id,
        allocation_ratio: 1,
        allocation_method: 'equal_split',
        link_order: 0,
      }],
    };
  }

  const exerciseTotal = inputs.reduce((sum, item) => sum + (item.exercise_count || 0), 0);
  const setTotal = inputs.reduce((sum, item) => sum + (item.completed_set_count || 0), 0);
  let divisor = 0;
  let method = 'equal_split';

  if (exerciseTotal > 0) {
    divisor = exerciseTotal;
    method = 'exercise_count';
  } else if (setTotal > 0) {
    divisor = setTotal;
    method = 'completed_set_count';
  }

  const links = inputs.map((item, index) => {
    let ratio = 1 / inputs.length;
    if (method === 'exercise_count') ratio = item.exercise_count / divisor;
    if (method === 'completed_set_count') ratio = item.completed_set_count / divisor;
    return {
      workout_id: item.workout_id,
      allocation_ratio: ratio,
      allocation_method: method,
      link_order: index,
    };
  });

  const totalRatio = links.reduce((sum, link) => sum + link.allocation_ratio, 0) || 1;
  links.forEach(link => {
    link.allocation_ratio = round4(link.allocation_ratio / totalRatio) || (1 / links.length);
  });

  return { matchStatus: 'matched_split', links };
}

function loadHealthFiles() {
  if (!fs.existsSync(HEALTH_EXPORT_DIR)) return [];
  return fs.readdirSync(HEALTH_EXPORT_DIR)
    .filter(name => name.toLowerCase().endsWith('.json'))
    .sort()
    .map(name => path.join(HEALTH_EXPORT_DIR, name));
}

function readHealthFile(filePath) {
  const root = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return normalizeImportSource(path.basename(filePath), root);
}

function normalizeImportSource(sourceFile, root) {
  const data = root?.data || root || {};
  return {
    sourceFile,
    workouts: Array.isArray(data.workouts) ? data.workouts : [],
    metrics: Array.isArray(data.metrics) ? data.metrics : [],
  };
}

function validateImportSourceRoot(root) {
  const hasNestedData = !!root && typeof root === 'object' && root.data && typeof root.data === 'object';
  const candidate = hasNestedData ? root.data : root;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Uploaded JSON must contain an object with workouts and/or metrics data');
  }

  const hasWorkoutsKey = Object.prototype.hasOwnProperty.call(candidate, 'workouts');
  const hasMetricsKey = Object.prototype.hasOwnProperty.call(candidate, 'metrics');

  if (!hasWorkoutsKey && !hasMetricsKey) {
    throw new Error('Uploaded JSON is missing both data.workouts and data.metrics');
  }

  if (hasWorkoutsKey && !Array.isArray(candidate.workouts)) {
    throw new Error('Uploaded JSON has an invalid data.workouts value; expected an array');
  }

  if (hasMetricsKey && !Array.isArray(candidate.metrics)) {
    throw new Error('Uploaded JSON has an invalid data.metrics value; expected an array');
  }

  const workoutsLength = Array.isArray(candidate.workouts) ? candidate.workouts.length : 0;
  const metricsLength = Array.isArray(candidate.metrics) ? candidate.metrics.length : 0;
  if (workoutsLength === 0 && metricsLength === 0) {
    throw new Error('Uploaded JSON contains no workouts or metrics to import');
  }
}

function buildImportSourcesFromDisk() {
  return loadHealthFiles().map(filePath => readHealthFile(filePath));
}

function aggregateImportSource(fileData) {
  const normalizedWorkouts = fileData.workouts
    .map(workout => normalizeWorkout(workout, fileData.sourceFile))
    .filter(Boolean);
  const aggregatedDailyMetrics = aggregateDailyMetrics(fileData.metrics, fileData.sourceFile);
  const latestMetricDate = aggregatedDailyMetrics.length > 0
    ? aggregatedDailyMetrics[aggregatedDailyMetrics.length - 1].date
    : null;
  const latestWorkoutDate = normalizedWorkouts.length > 0
    ? normalizedWorkouts.reduce((maxDate, workout) => !maxDate || workout.date > maxDate ? workout.date : maxDate, null)
    : null;
  const sourceSnapshotDate = [latestMetricDate, latestWorkoutDate].filter(Boolean).sort().slice(-1)[0] || null;
  const dailyMetrics = latestMetricDate
    ? aggregatedDailyMetrics
        .filter(metricRow => metricRow.date !== latestMetricDate)
        .map(metricRow => ({ ...metricRow, sourceSnapshotDate }))
    : aggregatedDailyMetrics;

  for (const workout of normalizedWorkouts) {
    workout.sourceSnapshotDate = sourceSnapshotDate;
  }

  return {
    ...fileData,
    normalizedWorkouts,
    aggregatedDailyMetrics,
    latestMetricDate,
    latestWorkoutDate,
    sourceSnapshotDate,
    dailyMetrics,
  };
}

function buildSummary() {
  return {
    files_scanned: 0,
    workouts_discovered: 0,
    metric_series_discovered: 0,
    metric_dates_aggregated: 0,
    metric_dates_skipped_latest: 0,
    metric_dates_upserted: 0,
    external_workouts_inserted: 0,
    external_workouts_updated: 0,
    external_workouts_skipped_stale: 0,
    health_daily_metrics_inserted: 0,
    health_daily_metrics_updated: 0,
    health_daily_metrics_skipped_stale: 0,
    skipped_short_duration: 0,
    matched_single: 0,
    matched_split: 0,
    unmatched_strength: 0,
    imported_standalone: 0,
    latest_metric_dates_skipped: [],
    sample_unmatched_strength_sessions: [],
    sample_multi_workout_split_cases: [],
    sample_daily_energy_totals: [],
    new_data_day_count: 0,
    new_workout_day_count: 0,
    new_metric_day_count: 0,
    sample_new_data_dates: [],
  };
}

function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  return a === b;
}

function normalizeLinksForCompare(links) {
  return (Array.isArray(links) ? links : [])
    .map(link => ({
      workout_id: link.workout_id,
      allocation_ratio: round4(link.allocation_ratio),
      allocation_method: link.allocation_method,
      link_order: link.link_order,
    }))
    .sort((a, b) => {
      if (a.link_order !== b.link_order) return a.link_order - b.link_order;
      if (a.workout_id !== b.workout_id) return a.workout_id - b.workout_id;
      return String(a.allocation_method).localeCompare(String(b.allocation_method));
    });
}

function hasSameExternalWorkoutData(existingExternalId, normalizedWorkout, importLevel, matchStatus, links) {
  const existing = db.getExternalWorkoutByExternalId(existingExternalId);
  if (!existing) return false;
  const existingDetail = db.getExternalWorkoutById(existing.id);
  if (!existingDetail) return false;

  const sameWorkoutRow =
    valuesEqual(existing.source_type, normalizedWorkout.sourceType) &&
    valuesEqual(existing.workout_type, normalizedWorkout.workoutType) &&
    valuesEqual(existing.name, normalizedWorkout.name) &&
    valuesEqual(existing.date, normalizedWorkout.date) &&
    valuesEqual(existing.start_at, normalizedWorkout.startAt) &&
    valuesEqual(existing.end_at, normalizedWorkout.endAt) &&
    valuesEqual(existing.duration_seconds, normalizedWorkout.durationSeconds) &&
    valuesEqual(existing.is_indoor, normalizedWorkout.isIndoor) &&
    valuesEqual(existing.location_label, normalizedWorkout.locationLabel) &&
    valuesEqual(existing.import_level, importLevel) &&
    valuesEqual(existing.match_status, matchStatus);

  const metrics = normalizedWorkout.summary || {};
  const existingMetrics = existingDetail.metrics || {};
  const sameMetrics =
    valuesEqual(existingMetrics.active_energy_kcal, metrics.active_energy_kcal) &&
    valuesEqual(existingMetrics.avg_heart_rate_bpm, metrics.avg_heart_rate_bpm) &&
    valuesEqual(existingMetrics.max_heart_rate_bpm, metrics.max_heart_rate_bpm) &&
    valuesEqual(existingMetrics.min_heart_rate_bpm, metrics.min_heart_rate_bpm) &&
    valuesEqual(existingMetrics.distance_meters, metrics.distance_meters) &&
    valuesEqual(existingMetrics.step_count_total, metrics.step_count_total) &&
    valuesEqual(existingMetrics.avg_step_cadence, metrics.avg_step_cadence) &&
    valuesEqual(existingMetrics.intensity_avg, metrics.intensity_avg) &&
    valuesEqual(existingMetrics.temperature_avg, metrics.temperature_avg) &&
    valuesEqual(existingMetrics.humidity_avg, metrics.humidity_avg) &&
    valuesEqual(existingMetrics.elevation_up_meters, metrics.elevation_up_meters) &&
    valuesEqual(existingMetrics.heart_rate_recovery_bpm, metrics.heart_rate_recovery_bpm);

  const sameLinks =
    JSON.stringify(normalizeLinksForCompare(existingDetail.links)) ===
    JSON.stringify(normalizeLinksForCompare(links));

  return sameWorkoutRow && sameMetrics && sameLinks;
}

function hasSameDailyMetricData(existingMetric, metricRow) {
  if (!existingMetric) return false;
  return (
    valuesEqual(existingMetric.source_type, metricRow.sourceType) &&
    valuesEqual(existingMetric.active_energy_kj, metricRow.activeEnergyKj) &&
    valuesEqual(existingMetric.resting_energy_kj, metricRow.restingEnergyKj) &&
    valuesEqual(existingMetric.active_energy_kcal, metricRow.activeEnergyKcal) &&
    valuesEqual(existingMetric.resting_energy_kcal, metricRow.restingEnergyKcal) &&
    valuesEqual(existingMetric.tdee_kcal, metricRow.tdeeKcal) &&
    valuesEqual(existingMetric.sample_count_active, metricRow.sampleCountActive) &&
    valuesEqual(existingMetric.sample_count_resting, metricRow.sampleCountResting)
  );
}

function runHealthImport(options = {}, importSources = null) {
  const settings = {
    dryRun: !!options.dryRun,
    level: options.level || 'summary',
    minDuration: options.minDuration || MIN_IMPORT_DURATION_SECONDS,
  };

  const files = importSources || buildImportSourcesFromDisk();
  const summary = buildSummary();
  const appliedWorkoutDates = new Set();
  const appliedMetricDates = new Set();
  summary.files_scanned = files.length;

  if (files.length === 0) return summary;

  const database = db.getDb();
  const importFileTxn = database.transaction(fileResult => {
    for (const metricRow of fileResult.dailyMetrics) {
      const existingMetric = db.getHealthDailyMetricsByDate(metricRow.date);
      if (
        existingMetric &&
        existingMetric.source_snapshot_date === metricRow.sourceSnapshotDate &&
        hasSameDailyMetricData(existingMetric, metricRow)
      ) {
        continue;
      }
      const metricResult = db.upsertHealthDailyMetrics(metricRow);
      if (metricResult.applied) {
        summary.metric_dates_upserted += 1;
        if (metricResult.inserted) summary.health_daily_metrics_inserted += 1;
        else summary.health_daily_metrics_updated += 1;
        appliedMetricDates.add(metricRow.date);
      } else if (metricResult.stale) {
        summary.health_daily_metrics_skipped_stale += 1;
      }
    }

    for (const normalizedWorkout of fileResult.normalizedWorkouts) {
      if (normalizedWorkout.durationSeconds < settings.minDuration) {
        summary.skipped_short_duration += 1;
        continue;
      }

      const { matchStatus, links } = computeLinksAndStatus(normalizedWorkout);
      normalizedWorkout.matchStatus = matchStatus;
      const existingWorkout = db.getExternalWorkoutByExternalId(normalizedWorkout.externalId);
      if (
        existingWorkout &&
        existingWorkout.source_snapshot_date === normalizedWorkout.sourceSnapshotDate &&
        hasSameExternalWorkoutData(normalizedWorkout.externalId, normalizedWorkout, settings.level, matchStatus, links)
      ) {
        continue;
      }
      const workoutResult = db.upsertExternalWorkout(normalizedWorkout, settings.level);
      if (!workoutResult.applied) {
        if (workoutResult.stale) summary.external_workouts_skipped_stale += 1;
        continue;
      }
      db.replaceExternalWorkoutMetrics(workoutResult.id, normalizedWorkout.summary);
      if (settings.level === 'full') {
        db.replaceExternalWorkoutRaw(workoutResult.id, normalizedWorkout.raw);
      }
      db.replaceExternalWorkoutLinks(workoutResult.id, links);
      if (workoutResult.inserted) summary.external_workouts_inserted += 1;
      else summary.external_workouts_updated += 1;
      appliedWorkoutDates.add(normalizedWorkout.date);
    }
  });

  for (const source of files) {
    const fileData = aggregateImportSource(source);
    summary.workouts_discovered += fileData.workouts.length;
    summary.metric_series_discovered += fileData.metrics.length;
    summary.metric_dates_aggregated += fileData.dailyMetrics.length;
    if (fileData.latestMetricDate) {
      summary.metric_dates_skipped_latest += 1;
      summary.latest_metric_dates_skipped.push(fileData.latestMetricDate);
    }

    for (const normalizedWorkout of fileData.normalizedWorkouts) {
      if (normalizedWorkout.durationSeconds < settings.minDuration) {
        summary.skipped_short_duration += 1;
        if (summary.sample_unmatched_strength_sessions.length < 3 && normalizedWorkout.workoutType === 'Functional Strength Training') {
          summary.sample_unmatched_strength_sessions.push({
            external_id: normalizedWorkout.externalId,
            date: normalizedWorkout.date,
            reason: 'skipped_short_duration',
          });
        }
        continue;
      }

      const { matchStatus, links } = computeLinksAndStatus(normalizedWorkout);
      summary[matchStatus] += 1;

      if (matchStatus === 'unmatched_strength' && summary.sample_unmatched_strength_sessions.length < 3) {
        summary.sample_unmatched_strength_sessions.push({
          external_id: normalizedWorkout.externalId,
          date: normalizedWorkout.date,
          workout_type: normalizedWorkout.workoutType,
        });
      }

      if (matchStatus === 'matched_split' && summary.sample_multi_workout_split_cases.length < 3) {
        summary.sample_multi_workout_split_cases.push({
          external_id: normalizedWorkout.externalId,
          date: normalizedWorkout.date,
          linked_workouts: links.map(link => ({
            workout_id: link.workout_id,
            allocation_ratio: link.allocation_ratio,
            allocation_method: link.allocation_method,
          })),
        });
      }
    }

    for (const metricRow of fileData.dailyMetrics.slice(0, Math.max(0, 3 - summary.sample_daily_energy_totals.length))) {
      summary.sample_daily_energy_totals.push({
        date: metricRow.date,
        active_energy_kcal: metricRow.activeEnergyKcal,
        resting_energy_kcal: metricRow.restingEnergyKcal,
        tdee_kcal: metricRow.tdeeKcal,
      });
    }

    if (!settings.dryRun) {
      importFileTxn(fileData);
    }
  }

  if (settings.dryRun) {
    summary.matched_single = 0;
    summary.matched_split = 0;
    summary.unmatched_strength = 0;
    summary.imported_standalone = 0;
    summary.skipped_short_duration = 0;
    summary.external_workouts_inserted = 0;
    summary.external_workouts_updated = 0;
    summary.external_workouts_skipped_stale = 0;
    summary.health_daily_metrics_inserted = 0;
    summary.health_daily_metrics_updated = 0;
    summary.health_daily_metrics_skipped_stale = 0;

    for (const source of files) {
      const fileData = aggregateImportSource(source);
      for (const normalizedWorkout of fileData.normalizedWorkouts) {
        if (normalizedWorkout.durationSeconds < settings.minDuration) {
          summary.skipped_short_duration += 1;
          continue;
        }
        const { matchStatus, links } = computeLinksAndStatus(normalizedWorkout);
        summary[matchStatus] += 1;
        const existingWorkout = db.getExternalWorkoutByExternalId(normalizedWorkout.externalId);
        if (!existingWorkout) {
          summary.external_workouts_inserted += 1;
          appliedWorkoutDates.add(normalizedWorkout.date);
        } else if (
          (!existingWorkout.source_snapshot_date || !normalizedWorkout.sourceSnapshotDate || normalizedWorkout.sourceSnapshotDate > existingWorkout.source_snapshot_date) ||
          (
            normalizedWorkout.sourceSnapshotDate === existingWorkout.source_snapshot_date &&
            !hasSameExternalWorkoutData(normalizedWorkout.externalId, normalizedWorkout, settings.level, matchStatus, links)
          )
        ) {
          summary.external_workouts_updated += 1;
          appliedWorkoutDates.add(normalizedWorkout.date);
        } else {
          summary.external_workouts_skipped_stale += 1;
        }
      }
      for (const metricRow of fileData.dailyMetrics) {
        const existingMetric = db.getHealthDailyMetricsByDate(metricRow.date);
        if (!existingMetric) {
          summary.health_daily_metrics_inserted += 1;
          appliedMetricDates.add(metricRow.date);
        } else if (
          (!existingMetric.source_snapshot_date || !metricRow.sourceSnapshotDate || metricRow.sourceSnapshotDate > existingMetric.source_snapshot_date) ||
          (
            metricRow.sourceSnapshotDate === existingMetric.source_snapshot_date &&
            !hasSameDailyMetricData(existingMetric, metricRow)
          )
        ) {
          summary.health_daily_metrics_updated += 1;
          appliedMetricDates.add(metricRow.date);
        } else {
          summary.health_daily_metrics_skipped_stale += 1;
        }
      }
    }
  }

  const combinedDates = [...appliedWorkoutDates, ...appliedMetricDates].sort();
  summary.new_workout_day_count = appliedWorkoutDates.size;
  summary.new_metric_day_count = appliedMetricDates.size;
  summary.new_data_day_count = new Set(combinedDates).size;
  summary.sample_new_data_dates = [...new Set(combinedDates)].slice(0, 5);

  return summary;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = runHealthImport(options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  } finally {
    db.closeDb();
  }
}

module.exports = {
  MIN_IMPORT_DURATION_SECONDS,
  runHealthImport,
  normalizeImportSource,
  validateImportSourceRoot,
  parseAppleDate,
  normalizeWorkout,
  aggregateDailyMetrics,
};
