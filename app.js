'use strict';

/* ================= storage ================= */

const STORAGE_KEY = 'cycleData';

function defaultData() {
  return { periodStarts: [], manualCycleLength: 28, periodLength: 5 };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultData(), parsed);
  } catch (e) {
    return defaultData();
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/* ================= date helpers ================= */

const DAY_MS = 24 * 60 * 60 * 1000;

// Parse "YYYY-MM-DD" at local noon so DST shifts can't cause off-by-one days.
function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayISO() {
  return toISO(new Date());
}

function daysBetween(fromIso, toIso) {
  return Math.round((parseDate(toIso) - parseDate(fromIso)) / DAY_MS);
}

function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function formatDate(iso) {
  return parseDate(iso).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

/* ================= cycle math (pure) ================= */

// Average the gaps between the most recent logged starts (up to 6 gaps),
// ignoring implausible gaps (double-logs or missed cycles).
function autoCycleLength(periodStarts) {
  const starts = [...periodStarts].sort();
  if (starts.length < 2) return null;
  const recent = starts.slice(-7);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    const g = daysBetween(recent[i - 1], recent[i]);
    if (g >= 15 && g <= 60) gaps.push(g);
  }
  if (!gaps.length) return null;
  const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  return Math.min(40, Math.max(21, avg));
}

function effectiveCycleLength(data) {
  return autoCycleLength(data.periodStarts) || data.manualCycleLength;
}

// Phase layout for a cycle of length L with period length P.
// Ovulation day O = L - 14; ovulation phase spans O-1..O+1 and wins overlaps.
function phaseSegments(L, P) {
  const O = L - 14;
  const ovStart = Math.max(1, O - 1);
  const ovEnd = Math.min(L, O + 1);
  const segs = [];
  const menEnd = Math.min(P, ovStart - 1);
  if (menEnd >= 1) segs.push({ key: 'menstrual', start: 1, end: menEnd });
  if (ovStart - 1 >= menEnd + 1) segs.push({ key: 'follicular', start: menEnd + 1, end: ovStart - 1 });
  segs.push({ key: 'ovulation', start: ovStart, end: ovEnd });
  if (ovEnd + 1 <= L) segs.push({ key: 'luteal', start: ovEnd + 1, end: L });
  return segs;
}

// Everything the dashboard needs for a given day.
function getCycleStatus(data, today) {
  const starts = [...data.periodStarts].sort();
  const latest = starts[starts.length - 1];
  const L = effectiveCycleLength(data);
  const P = Math.min(data.periodLength, L - 16); // keep period clear of ovulation on short cycles
  const O = L - 14;

  const since = daysBetween(latest, today);
  const day = ((since % L) + L) % L + 1;

  const segs = phaseSegments(L, P);
  const segIndex = segs.findIndex(s => day >= s.start && day <= s.end);
  const seg = segs[segIndex];

  const fertileStart = Math.max(1, O - 5);
  const inFertile = day >= fertileStart && day <= O;

  const nextSeg = segs[(segIndex + 1) % segs.length];
  const daysToNextPhase = seg.end - day + 1;
  const nextPhaseName = segIndex === segs.length - 1 ? 'menstrual' : nextSeg.key;

  const daysToNextPeriod = L - day + 1;
  const nextPeriodDate = addDays(latest, since + daysToNextPeriod);
  const daysToFertile = day < fertileStart ? fertileStart - day : null;

  return {
    day, L, P, O, segs, phase: seg.key,
    fertileStart, fertileEnd: O, inFertile,
    daysToNextPhase, nextPhaseName,
    daysToNextPeriod, nextPeriodDate, daysToFertile
  };
}

/* ================= phase content ================= */

const PHASES = {
  menstrual: {
    name: 'Menstrual',
    hormones: 'Estrogen and progesterone are both at their lowest point. Estrogen starts climbing again toward the end.',
    energy: { level: 'Low', note: 'Stamina and sleep quality dip — rest matters more than usual.' },
    mood: 'Likely withdrawn with a low social battery. Comfort and quiet time beat big plans.',
    suggestions: [
      'Prioritize comfort — offer the heating pad, blankets and favorite snacks.',
      'Take over the household chores without being asked.',
      'Suggest staying in: a film night beats a night out right now.',
      'Keep plans flexible and low-pressure.'
    ]
  },
  follicular: {
    name: 'Follicular',
    hormones: 'Estrogen is rising steadily, and testosterone starts ticking up too.',
    energy: { level: 'High', note: 'Physical stamina, motivation and sleep are all at their best.' },
    mood: 'Outgoing, optimistic and highly communicative. Social battery is full.',
    suggestions: [
      'Plan active dates — hikes, classes, anything new and energetic.',
      'Say yes to social plans; people are more fun this week.',
      'Great week to tackle bigger projects and decisions together.',
      'Bring ideas — novelty and future plans land especially well now.'
    ]
  },
  ovulation: {
    name: 'Ovulation',
    hormones: 'Estrogen and luteinizing hormone are peaking — this is when fertility is highest.',
    energy: { level: 'High', note: 'Confidence and drive peak, along with libido.' },
    mood: 'Magnetic and social — likely feeling her most confident and connected.',
    suggestions: [
      'Fertility is peaking — the key days if you’re trying to conceive (and the days to be extra careful if you’re not).',
      'Plan a romantic night out; effort and attention go a long way right now.',
      'Prioritize physical intimacy and affection.',
      'Compliments land double this week — be specific and sincere.'
    ]
  },
  luteal: {
    name: 'Luteal',
    hormones: 'Progesterone peaks, then both hormones fall sharply in the final days before the next period.',
    energy: { level: 'Baseline', note: 'Sliding toward low — fatigue and cravings build near the end.' },
    mood: 'Patience may run short and the social battery drains faster. Irritability is hormonal — not personal.',
    suggestions: [
      'Don’t take irritability personally — it’s chemistry, not you.',
      'Cook dinner and handle the grocery run without making it a thing.',
      'Be an active listener: validate first, solve later (or never).',
      'Scale back big social plans; protect her downtime.'
    ]
  }
};

/* ================= rendering ================= */

const $ = id => document.getElementById(id);

function show(viewId) {
  ['setupView', 'dashboard', 'settingsView'].forEach(id => {
    $(id).hidden = id !== viewId;
  });
  $('settingsBtn').hidden = viewId !== 'dashboard';
}

function render() {
  const data = loadData();
  if (!data.periodStarts.length) {
    document.body.className = '';
    $('setupDate').max = todayISO();
    show('setupView');
    return;
  }
  renderDashboard(data);
  show('dashboard');
}

function renderDashboard(data) {
  const s = getCycleStatus(data, todayISO());
  const content = PHASES[s.phase];

  document.body.className = 'phase-' + s.phase;

  $('dayNum').textContent = s.day;
  $('cycleLen').textContent = s.L;
  $('phaseName').textContent = content.name;
  $('fertileBadge').hidden = !s.inFertile;

  // timeline
  const tl = $('timeline');
  tl.innerHTML = '';
  for (const seg of s.segs) {
    const el = document.createElement('div');
    el.className = 'seg' + (seg.key === s.phase ? ' current' : '');
    el.style.width = ((seg.end - seg.start + 1) / s.L * 100) + '%';
    el.style.background = `var(--${seg.key})`;
    tl.appendChild(el);
  }
  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.style.left = ((s.day - 0.5) / s.L * 100) + '%';
  tl.appendChild(marker);

  // countdowns
  const lines = [];
  const plural = n => n === 1 ? '1 day' : `${n} days`;
  lines.push(`<strong>${plural(s.daysToNextPhase)}</strong> until the ${PHASES[s.nextPhaseName].name.toLowerCase()} phase`);
  if (s.daysToFertile !== null) {
    lines.push(`<strong>${plural(s.daysToFertile)}</strong> until the fertile window`);
  } else if (s.inFertile) {
    lines.push(`Fertile window: day ${s.fertileStart}–${s.fertileEnd} (ovulation expected day ${s.O})`);
  }
  lines.push(`Next period expected <strong>${formatDate(s.nextPeriodDate)}</strong> (${plural(s.daysToNextPeriod)})`);
  $('countdowns').innerHTML = lines.map(l => `<li>${l}</li>`).join('');

  // intel
  $('hormones').textContent = content.hormones;
  $('energyLevel').textContent = content.energy.level;
  $('energyNote').textContent = content.energy.note;
  $('mood').textContent = content.mood;

  // suggestions
  $('suggestions').innerHTML = content.suggestions
    .map(t => `<li>${t}</li>`).join('');
}

function renderSettings(data) {
  const auto = autoCycleLength(data.periodStarts);
  $('logDate').value = todayISO();
  $('logDate').max = todayISO();
  $('cycleLenInput').value = auto || data.manualCycleLength;
  $('cycleLenInput').disabled = !!auto;
  $('cycleLenHint').textContent = auto
    ? `Auto-calculated from your logged history (${data.periodStarts.length} entries). Log more periods to keep it accurate.`
    : 'Used until at least two period starts are logged, then averaged automatically.';
  $('periodLenInput').value = data.periodLength;

  const list = $('historyList');
  const starts = [...data.periodStarts].sort().reverse();
  list.innerHTML = '';
  if (!starts.length) {
    list.innerHTML = '<li class="muted">No entries yet</li>';
  }
  for (const iso of starts) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = formatDate(iso) + ', ' + iso.slice(0, 4);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete ' + iso);
    del.addEventListener('click', () => {
      const d = loadData();
      d.periodStarts = d.periodStarts.filter(x => x !== iso);
      saveData(d);
      renderSettings(d);
    });
    li.append(span, del);
    list.appendChild(li);
  }
}

/* ================= actions ================= */

function addPeriodStart(iso) {
  const data = loadData();
  if (!data.periodStarts.includes(iso)) {
    data.periodStarts.push(iso);
    data.periodStarts.sort();
    saveData(data);
  }
  return data;
}

function initEvents() {
  $('setupForm').addEventListener('submit', e => {
    e.preventDefault();
    const date = $('setupDate').value;
    const len = parseInt($('setupLength').value, 10);
    if (!date) return;
    const data = loadData();
    data.periodStarts = [date];
    data.manualCycleLength = Math.min(40, Math.max(21, len || 28));
    saveData(data);
    render();
  });

  $('periodBtn').addEventListener('click', () => {
    if (confirm('Log a period start for today?')) {
      addPeriodStart(todayISO());
      render();
    }
  });

  $('settingsBtn').addEventListener('click', () => {
    renderSettings(loadData());
    show('settingsView');
  });

  $('backBtn').addEventListener('click', () => render());

  $('logBtn').addEventListener('click', () => {
    const iso = $('logDate').value;
    if (!iso || iso > todayISO()) return;
    const data = addPeriodStart(iso);
    renderSettings(data);
  });

  $('cycleLenInput').addEventListener('change', () => {
    const data = loadData();
    const v = parseInt($('cycleLenInput').value, 10);
    if (v >= 21 && v <= 40) {
      data.manualCycleLength = v;
      saveData(data);
    }
    renderSettings(data);
  });

  $('periodLenInput').addEventListener('change', () => {
    const data = loadData();
    const v = parseInt($('periodLenInput').value, 10);
    if (v >= 2 && v <= 10) {
      data.periodLength = v;
      saveData(data);
    }
    renderSettings(data);
  });

  $('clearBtn').addEventListener('click', () => {
    if (confirm('Erase all data on this device? This cannot be undone.')) {
      localStorage.removeItem(STORAGE_KEY);
      render();
    }
  });

  // refresh when the app is brought back to the foreground on a new day
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('dashboard').hidden) render();
  });
}

/* ================= boot ================= */

if (typeof document !== 'undefined') {
  initEvents();
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
