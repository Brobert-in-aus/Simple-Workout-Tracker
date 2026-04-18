import { formatDateShort, todayStr, toISO } from '../../core/dates.js';
import { openAppModal } from '../../core/ui.js';

export function filterByRange(data, range) {
  if (range === 'all') return data;
  const now = new Date();
  const cutoff = new Date(now);
  if (range === '1m') cutoff.setMonth(now.getMonth() - 1);
  else if (range === '3m') cutoff.setMonth(now.getMonth() - 3);
  else if (range === '6m') cutoff.setMonth(now.getMonth() - 6);
  else if (range === '1y') cutoff.setFullYear(now.getFullYear() - 1);
  const cutoffStr = toISO(cutoff);
  return data.filter((d) => (typeof d === 'string' ? d : d.date) >= cutoffStr);
}

export function getRangeBounds(range, allDates = []) {
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

export function countWeeksInRange(start, end) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const diffMs = endDate - startDate;
  if (diffMs <= 0) return 1;
  return Math.max(1, Math.ceil((diffMs + 1) / (7 * 24 * 60 * 60 * 1000)));
}

function toChartTime(iso) {
  return new Date(`${iso}T00:00:00`).getTime();
}

function getNiceStep(rawStep) {
  if (!isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function buildNiceTicks(minValue, maxValue, targetCount = 4) {
  if (minValue === maxValue) {
    if (minValue === 0) return [0, 1];
    const pad = Math.abs(minValue) * 0.1 || 1;
    return [minValue - pad, minValue, minValue + pad];
  }

  const rawStep = (maxValue - minValue) / Math.max(1, targetCount - 1);
  const step = getNiceStep(rawStep);
  const niceMin = Math.floor(minValue / step) * step;
  const niceMax = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let value = niceMin; value <= niceMax + step * 0.5; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

function pickDateTicks(points, targetCount = 4) {
  if (points.length <= 1) return points.map((p) => p.date);
  const lastIndex = points.length - 1;
  const indexes = new Set([0, lastIndex]);
  const step = lastIndex / Math.max(1, targetCount - 1);
  for (let i = 1; i < targetCount - 1; i++) {
    indexes.add(Math.round(i * step));
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((i) => points[i].date)
    .filter((date, idx, arr) => arr.indexOf(date) === idx);
}

export function buildLineChart(points, opts = {}) {
  if (points.length === 0) {
    return `<div class="chart-empty">${opts.emptyMsg || 'Not enough data'}</div>`;
  }

  const W = opts.width || 360;
  const H = opts.height || 150;
  const pt = 14;
  const pb = 30;
  const pl = 44;
  const pr = 12;
  const plotW = W - pl - pr;
  const plotH = H - pt - pb;
  const dotFilter = typeof opts.dotFilter === 'function' ? opts.dotFilter : ((point, index, allPoints) => allPoints.length <= 40);
  const dotClass = opts.dotClass || 'chart-dot';
  const formatY = opts.formatY || ((v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))));

  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const yTicks = buildNiceTicks(rawMin, rawMax, 4);
  const yMin = yTicks[0];
  const yMax = yTicks[yTicks.length - 1];
  const yRange = yMax - yMin || 1;

  const times = points.map((p) => toChartTime(p.date));
  const xMin = Math.min(...times);
  const xMax = Math.max(...times);
  const xRange = xMax - xMin || 1;

  const toX = (time) => (points.length === 1 ? pl + plotW / 2 : pl + ((time - xMin) / xRange) * plotW);
  const toY = (value) => pt + (1 - ((value - yMin) / yRange)) * plotH;

  const linePath = points.map((point, index) => {
    const x = toX(times[index]).toFixed(1);
    const y = toY(point.value).toFixed(1);
    return `${index === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');
  const areaPath = `${linePath} L${toX(times[times.length - 1]).toFixed(1)},${(pt + plotH).toFixed(1)} L${toX(times[0]).toFixed(1)},${(pt + plotH).toFixed(1)} Z`;

  const yGrid = yTicks.map((tick) => {
    const y = toY(tick).toFixed(1);
    return `
      <line x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}" class="chart-grid-line"/>
      <text x="${pl - 6}" y="${Number(y) + 3}" class="chart-label" text-anchor="end">${formatY(tick)}</text>
    `;
  }).join('');

  const xLabels = pickDateTicks(points, 4).map((date) => {
    const x = toX(toChartTime(date)).toFixed(1);
    return `<text x="${x}" y="${H - 6}" class="chart-label" text-anchor="middle">${formatDateShort(date)}</text>`;
  }).join('');

  const dots = points.map((point, index) => {
    if (!dotFilter(point, index, points)) return '';
    return `<circle cx="${toX(times[index]).toFixed(1)}" cy="${toY(point.value).toFixed(1)}" r="3.2" class="${dotClass}"/>`;
  }).join('');

  return `
    <svg class="progress-chart-svg" viewBox="0 0 ${W} ${H}"
         preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      ${yGrid}
      <path d="${areaPath}" class="chart-area ${opts.lineClass || ''}"/>
      <path d="${linePath}" class="chart-line ${opts.lineClass || ''}"
            fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${xLabels}
    </svg>
  `;
}

export function buildBarChart(bars, opts = {}) {
  if (bars.length === 0) return `<div class="chart-empty">No data</div>`;

  const W = opts.width || 360;
  const H = opts.height || 130;
  const pt = 14;
  const pb = 30;
  const pl = 34;
  const pr = 12;
  const plotW = W - pl - pr;
  const plotH = H - pt - pb;
  const values = bars.map((b) => b.value);
  const yTicks = buildNiceTicks(0, Math.max(...values, 1), 4);
  const yMax = yTicks[yTicks.length - 1] || 1;
  const gap = plotW / bars.length;
  const barW = Math.max(4, Math.min(18, gap * 0.72));

  const yGrid = yTicks.map((tick) => {
    const y = pt + (1 - (tick / yMax)) * plotH;
    return `
      <line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" class="chart-grid-line"/>
      <text x="${pl - 6}" y="${(y + 3).toFixed(1)}" class="chart-label" text-anchor="end">${Math.round(tick)}</text>
    `;
  }).join('');

  const rects = bars.map((bar, index) => {
    const x = pl + gap * index + (gap - barW) / 2;
    const h = (bar.value / yMax) * plotH;
    const y = pt + plotH - h;
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 2).toFixed(1)}"
            rx="3" class="chart-bar" />
      ${opts.interactive ? `<rect x="${(pl + gap * index).toFixed(1)}" y="${pt}" width="${gap.toFixed(1)}" height="${plotH.toFixed(1)}" class="chart-hit-target" data-wi="${index}"/>` : ''}
    `;
  }).join('');

  const labelStep = bars.length > 10 ? Math.ceil(bars.length / 6) : 1;
  const xLabels = bars.map((bar, index) => {
    if (index % labelStep !== 0 && index !== bars.length - 1) return '';
    const x = pl + gap * index + gap / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 6}" class="chart-label" text-anchor="middle">${bar.label}</text>`;
  }).join('');

  return `
    <svg class="progress-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      ${yGrid}
      ${rects}
      ${xLabels}
    </svg>
  `;
}

function openChartModal(card) {
  const titleText = card.querySelector('.progress-chart-title')?.textContent?.trim() || 'Chart';
  const svg = card.querySelector('.progress-chart-svg');
  const subtitle = card.querySelector('.chart-subtitle, .progress-helper-text');
  openAppModal(titleText, `
    <div class="chart-modal-view">
      ${svg ? svg.outerHTML : ''}
      ${subtitle ? `<div class="chart-modal-copy">${subtitle.textContent}</div>` : ''}
    </div>
  `);
}

export function wireExpandableCharts(container) {
  container.querySelectorAll('.progress-chart-card').forEach((card) => {
    if (!card.querySelector('.progress-chart-svg')) return;
    card.classList.add('progress-chart-expandable');
    card.addEventListener('click', () => openChartModal(card));
  });
}
