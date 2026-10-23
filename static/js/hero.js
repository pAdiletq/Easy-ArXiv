import { escapeHTML, icon, normalizePaper, shortAuthors, formatDate, readUrl, questUrl, selectPaper, listenToPaper, stopSpeech } from './core.js?v=github-2';

const controllers = new WeakMap();
const SLIDE_DURATION = [9000, 9000, 16500];
const FADE_DURATION = 820;
const PAPER_DURATION = 5000;

export function percentageChange(current, previous) {
  if (!Number.isFinite(current) || current < 0 || !Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous * 100;
}

function monthIndex(period) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period || '');
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

export function prepareMonthlySeries(months) {
  const valid = (Array.isArray(months) ? months : []).filter(month => month && Number.isInteger(month.value) && month.value >= 0);
  return valid.map((month, index) => {
    const previous = valid[index - 1];
    const consecutive = previous && monthIndex(month.period) !== null && monthIndex(month.period) - monthIndex(previous.period) === 1;
    return {
      value: month.value, label: String(month.label || month.period || '').slice(0, 60), period: String(month.period || '').slice(0, 20),
      previousValue: consecutive ? previous.value : null,
      previousLabel: consecutive ? String(previous.label || previous.period || '').slice(0, 60) : '',
      change: consecutive ? percentageChange(month.value, previous.value) : null,
    };
  }).slice(-9);
}

export function shouldAdvanceHero(state) {
  return !['documentHidden', 'offscreen', 'reducedMotion', 'hovered', 'focused', 'transitioning', 'listening'].some(key => Boolean(state[key]));
}

export function comparisonText(month) {
  if (month.change === null) return month.previousValue === 0 ? 'Previous month had no submissions' : 'Previous month is outside this view';
  const sign = month.change > 0 ? '+' : month.change < 0 ? '−' : '';
  return `${sign}${Math.abs(month.change).toFixed(1)}% vs ${month.previousLabel}`;
}

function monthName(month) {
  if (monthIndex(month.period) === null) return month.label;
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month.period}-01T00:00:00Z`));
}

export function chartSvg(series, periodLabel = '') {
  const width = 650, height = 320, left = 43, right = 15, top = 40, bottom = 43, chartHeight = height - top - bottom;
  const max = Math.ceil(Math.max(0, ...series.map(month => month.value)) / 10000) * 10000 || 10000;
  const slot = (width - left - right) / Math.max(series.length, 1), barWidth = Math.min(42, slot * .59);
  let svg = `<svg class="submission-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHTML(periodLabel)} monthly arXiv submissions. Focus a column for details; use arrow keys to move between months."><title>New arXiv submissions · ${escapeHTML(periodLabel)}</title>`;
  for (let tick = 0; tick <= 4; tick++) {
    const value = max * tick / 4, y = height - bottom - chartHeight * tick / 4;
    svg += `<g aria-hidden="true"><path d="M${left} ${y}H${width - right}" class="chart-grid-line"/><text x="${left - 12}" y="${y + 4}" text-anchor="end" class="chart-axis">${value ? Math.round(value / 1000) + 'k' : '0'}</text></g>`;
  }
  series.forEach((month, index) => {
    const barHeight = month.value / max * chartHeight, x = left + slot * index + (slot - barWidth) / 2, y = height - bottom - barHeight;
    const count = month.value.toLocaleString('en-US'), latest = index === series.length - 1;
    const description = `${monthName(month)}: ${count} papers. ${comparisonText(month)}.`;
    svg += `<g class="chart-column${latest ? ' is-latest' : ''}" tabindex="0" role="img" aria-label="${escapeHTML(description)}" data-chart-month="${index}" data-anchor-x="${(x + barWidth / 2) / width * 100}" data-anchor-y="${y / height * 100}"><title>${escapeHTML(description)}</title><rect class="chart-hit-area" x="${left + index * slot}" y="${top - 8}" width="${slot}" height="${height - top - bottom + 15}"/><rect class="chart-bar" x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="2.5"/><text class="chart-count" x="${x + barWidth / 2}" y="${y - 12}" text-anchor="middle" aria-hidden="true">${count}</text><text class="chart-month" x="${x + barWidth / 2}" y="${height - 17}" text-anchor="middle" aria-hidden="true">${escapeHTML(month.label)}</text></g>`;
    if (latest) svg += `<g class="chart-rocket" aria-hidden="true" transform="translate(${x + barWidth / 2 - 7} ${Math.max(y - 41, 0)})"><path d="M7 20c-2-4-1-9 2-12 2-3 5-5 9-6 0 5-1 9-4 12L7 20Zm2-12-5 1-2 6 5-1m7 0-1 5-5 3 1-5m-4 7-3 3m6-1-2 3"/><circle cx="13" cy="8" r="2"/></g>`;
  });
  return svg + '</svg>';
}

function installChartInteraction(plot, series, signal) {
  const columns = [...plot.querySelectorAll('[data-chart-month]')];
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip'; tooltip.id = 'heroChartTooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
  plot.append(tooltip);
  const show = column => {
    const month = series[Number(column.dataset.chartMonth)];
    if (!month) return;
    columns.forEach(item => item.classList.toggle('is-selected', item === column));
    plot.classList.add('has-chart-selection');
    tooltip.innerHTML = `<strong>${escapeHTML(monthName(month))}</strong><span>${month.value.toLocaleString('en-US')} papers</span><small>${escapeHTML(comparisonText(month))}</small>`;
    tooltip.style.left = `${Math.min(79, Math.max(21, Number(column.dataset.anchorX)))}%`;
    tooltip.style.top = `${Math.max(12, Number(column.dataset.anchorY))}%`;
    tooltip.hidden = false;
    columns.forEach(item => item.removeAttribute('aria-describedby'));
    column.setAttribute('aria-describedby', tooltip.id);
  };
  const clear = () => {
    const focused = columns.find(column => column === document.activeElement || column.contains(document.activeElement));
    if (focused) { show(focused); return; }
    tooltip.hidden = true; plot.classList.remove('has-chart-selection');
    columns.forEach(column => { column.classList.remove('is-selected'); column.removeAttribute('aria-describedby'); });
  };
  columns.forEach((column, index) => {
    column.addEventListener('pointerenter', () => show(column), { signal });
    column.addEventListener('focus', () => show(column), { signal });
    column.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = Math.min(index + 1, columns.length - 1);
      else if (event.key === 'ArrowLeft') next = Math.max(index - 1, 0);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = columns.length - 1;
      else if (event.key === 'Escape') { tooltip.hidden = true; return; }
      else return;
      event.preventDefault(); columns[next]?.focus();
    }, { signal });
  });
  plot.addEventListener('pointerleave', clear, { signal });
  plot.addEventListener('focusout', () => queueMicrotask(clear), { signal });
}

export function initializeHero({ featured = [] } = {}) {
  const root = document.getElementById('heroCarousel');
  if (!root) return null;
  if (controllers.has(root)) return controllers.get(root);
  const slides = [...root.querySelectorAll('[data-slide]')];
  if (!slides.length) return null;
  const lifetime = new AbortController(), signal = lifetime.signal;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const papers = featured.map(normalizePaper).filter(Boolean).slice(0, 3);
  const sheet = root.querySelector('.sample-paper'), listen = document.getElementById('sampleListen');
  let active = 0, paperIndex = 0, slideElapsed = 0, paperElapsed = 0, lastTick = performance.now(), transitionUntil = 0;
  let destroyed = false, statsRequest, paperTimer, observer, inView = true;
  slides.forEach((slide, index) => {
    slide.hidden = false; slide.inert = index !== active;
    slide.setAttribute('aria-hidden', String(index !== active)); slide.classList.toggle('is-active', index === active);
  });
  root.classList.add('hero-ready'); root.setAttribute('aria-live', 'off');

  function paintPaper(index) {
    const paper = papers[index]; if (!sheet || !paper) return;
    const category = sheet.querySelector('.sample-meta .paper-tag');
    const year = [...sheet.querySelectorAll('.sample-meta > span')].find(item => !item.classList.contains('paper-tag'));
    const title = sheet.querySelector('h3'), authors = sheet.querySelector('.authors'), heading = sheet.querySelector('h4');
    if (category) category.textContent = paper.category;
    if (year) { const date = new Date(paper.published); year.textContent = Number.isNaN(date.getTime()) ? 'arXiv' : String(date.getUTCFullYear()); }
    if (title) title.innerHTML = `<a href="${escapeHTML(readUrl(paper))}" data-hero-paper>${escapeHTML(paper.title)}</a>`;
    if (authors) authors.textContent = shortAuthors(paper, 3);
    if (heading) heading.textContent = paper.summary_label;
    sheet.querySelectorAll('.sample-abstract').forEach((paragraph, paragraphIndex) => {
      paragraph.hidden = paragraphIndex > 0;
      if (!paragraphIndex) paragraph.textContent = paper.summary || 'Open the original paper to read the research.';
    });
    const quest = sheet.querySelector('.sample-meta a'); if (quest) quest.href = questUrl(paper);
    const pdf = sheet.querySelector('.sample-actions a'); if (pdf) pdf.href = paper.pdf_url;
    sheet.setAttribute('aria-label', `Paper preview: ${paper.title}`);
    sheet.dataset.paper = paper.id;
  }

  function turnPaper() {
    if (papers.length < 2 || !sheet) return;
    sheet.classList.add('is-page-turning'); sheet.setAttribute('aria-busy', 'true');
    paperTimer = setTimeout(() => {
      if (destroyed) return;
      if (active !== 2 || blocked(performance.now())) {
        sheet.classList.remove('is-page-turning'); sheet.setAttribute('aria-busy', 'false'); return;
      }
      paperIndex = (paperIndex + 1) % papers.length; paintPaper(paperIndex);
      sheet.classList.remove('is-page-turning'); sheet.setAttribute('aria-busy', 'false');
    }, 170);
  }

  if (papers.length) paintPaper(0);
  listen?.addEventListener('click', event => { if (papers[paperIndex]) listenToPaper(papers[paperIndex], event.currentTarget); }, { signal });
  sheet?.addEventListener('click', event => { if (event.target.closest('a') && papers[paperIndex]) selectPaper(papers[paperIndex]); }, { signal });

  const inViewport = () => {
    const box = root.getBoundingClientRect();
    return inView && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
  };
  function blocked(now) {
    return !shouldAdvanceHero({ documentHidden: document.hidden, offscreen: !inViewport(), reducedMotion: motion.matches,
      hovered: root.matches(':hover'), focused: root.contains(document.activeElement), transitioning: now < transitionUntil,
      listening: listen?.getAttribute('aria-pressed') === 'true' || Boolean(document.querySelector('#audioPlayer:not([hidden])')) });
  }
  function advanceSlide(now) {
    slides[active].inert = true; slides[active].setAttribute('aria-hidden', 'true'); slides[active].classList.remove('is-active');
    active = (active + 1) % slides.length;
    slides[active].inert = false; slides[active].setAttribute('aria-hidden', 'false'); slides[active].classList.add('is-active');
    slideElapsed = 0; paperElapsed = 0; transitionUntil = now + FADE_DURATION;
    if (active === 2) { paperIndex = 0; paintPaper(0); }
  }
  const timer = setInterval(() => {
    const now = performance.now(), elapsed = Math.min(500, Math.max(0, now - lastTick)); lastTick = now;
    if (destroyed || blocked(now)) return;
    slideElapsed += elapsed;
    if (active === 2) {
      paperElapsed += elapsed;
      if (paperElapsed >= PAPER_DURATION) { paperElapsed = 0; turnPaper(); }
    }
    if (slideElapsed >= (SLIDE_DURATION[active] || 9000)) advanceSlide(now);
  }, 250);
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? false; lastTick = performance.now(); }, { threshold: 0.05 });
    observer.observe(root);
  }
  motion.addEventListener('change', () => { lastTick = performance.now(); }, { signal });
  document.addEventListener('visibilitychange', () => { lastTick = performance.now(); }, { signal });

  async function renderStatistics() {
    const plot = document.getElementById('chartPlot'); if (!plot || destroyed) return;
    statsRequest?.abort(); statsRequest = new AbortController();
    const request = statsRequest, timeout = setTimeout(() => request.abort(), 22000);
    plot.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/stats', { signal: request.signal });
      if (!response.ok) throw new Error('Statistics unavailable');
      const stats = await response.json(), series = prepareMonthlySeries(stats.months);
      if (!series.length) throw new Error('No monthly data');
      if (destroyed || request !== statsRequest) return;
      document.getElementById('chartPeriod').textContent = String(stats.period_label || '');
      const updated = stats.updated_at ? formatDate(stats.updated_at) : 'date unavailable';
      document.getElementById('chartUpdated').textContent = `${stats.stale ? 'Cached · ' : 'Updated '}${updated}`;
      plot.classList.remove('chart-error'); plot.classList.add('interactive-chart');
      plot.innerHTML = chartSvg(series, stats.period_label || '');
      installChartInteraction(plot, series, signal);
    } catch {
      if (destroyed || request !== statsRequest) return;
      plot.classList.add('chart-error'); plot.classList.remove('interactive-chart');
      plot.innerHTML = '<p>arXiv statistics are temporarily unavailable.</p><p>New data will appear here when the archive responds.</p><button type="button" class="text-link" id="retryStats">Try again →</button>';
      document.getElementById('chartUpdated').textContent = '';
      document.getElementById('retryStats')?.addEventListener('click', renderStatistics, { signal });
    } finally { clearTimeout(timeout); if (!destroyed && request === statsRequest) plot.setAttribute('aria-busy', 'false'); }
  }
  renderStatistics();
  const controller = { destroy() {
    if (destroyed) return;
    destroyed = true; lifetime.abort(); statsRequest?.abort(); observer?.disconnect(); clearInterval(timer); clearTimeout(paperTimer); stopSpeech();
    controllers.delete(root);
  } };
  controllers.set(root, controller);
  window.addEventListener('pagehide', event => {
    if (event.persisted) { lastTick = performance.now(); stopSpeech(); }
    else controller.destroy();
  }, { signal });
  return controller;
}
