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

// Finer-grained sub-phases within each parent phase. Ranges are clamped to
// the parent segment and dropped when empty (short cycles may lose the
// follicular sub-phases entirely, matching the parent model).
function subPhaseSegments(L, P) {
  const O = L - 14;
  const subs = [];
  const push = (key, parent, start, end) => {
    if (start <= end) subs.push({ key, parent, start, end });
  };
  for (const seg of phaseSegments(L, P)) {
    if (seg.key === 'menstrual') {
      push('menstrual-heavy', 'menstrual', seg.start, Math.min(2, seg.end));
      push('menstrual-easing', 'menstrual', Math.max(3, seg.start), seg.end);
    } else if (seg.key === 'follicular') {
      push('follicular-building', 'follicular', seg.start, Math.min(seg.end, O - 4));
      push('follicular-peak', 'follicular', Math.max(seg.start, O - 3), seg.end);
    } else if (seg.key === 'ovulation') {
      push('ovulation', 'ovulation', seg.start, seg.end);
    } else {
      push('luteal-settled', 'luteal', seg.start, Math.min(seg.end, L - 5));
      push('luteal-pms', 'luteal', Math.max(seg.start, L - 4), seg.end);
    }
  }
  return subs;
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

  const subs = subPhaseSegments(L, P);
  const subIndex = subs.findIndex(x => day >= x.start && day <= x.end);
  const sub = subs[subIndex];
  const daysToNextSub = sub.end - day + 1;
  const nextSubKey = subs[(subIndex + 1) % subs.length].key;

  const daysToNextPeriod = L - day + 1;
  const nextPeriodDate = addDays(latest, since + daysToNextPeriod);
  const daysToFertile = day < fertileStart ? fertileStart - day : null;

  return {
    day, L, P, O, segs, phase: seg.key,
    subPhase: sub.key, daysToNextSub, nextSubKey,
    fertileStart, fertileEnd: O, inFertile,
    daysToNextPhase, nextPhaseName,
    daysToNextPeriod, nextPeriodDate, daysToFertile
  };
}

// Day-specific chance of conception from a single act of unprotected sex,
// keyed by offset from the predicted ovulation day. Population averages
// (Wilcox et al., NEJM 1995), smoothed at the edges because a calendar app's
// ovulation estimate can be off by a few days — so no day reads as zero.
const CONCEPTION_TABLE = {
  '-7': 2, '-6': 4, '-5': 10, '-4': 16, '-3': 14,
  '-2': 27, '-1': 31, '0': 33, '1': 12, '2': 6, '3': 3
};

function conceptionLikelihood(day, O) {
  const off = day - O;
  const pct = CONCEPTION_TABLE[String(off)] ?? 1;
  let level, color;
  if (pct >= 28)      { level = 'Peak';     color = '#c00000'; }
  else if (pct >= 20) { level = 'High';     color = '#e07000'; }
  else if (pct >= 10) { level = 'Moderate'; color = '#b08000'; }
  else if (pct >= 3)  { level = 'Low';      color = '#008000'; }
  else                { level = 'Very low'; color = '#808080'; }
  return { pct, level, color };
}

/* ================= phase content ================= */

const PHASE_NAMES = {
  menstrual: 'Menstrual',
  follicular: 'Follicular',
  ovulation: 'Ovulation',
  luteal: 'Luteal'
};

// `target` is the phrase used when this sub-phase is the countdown destination.
const SUBPHASES = {
  'menstrual-heavy': {
    label: 'Heaviest days',
    parent: 'menstrual',
    target: 'the next period',
    hormones: 'Estrogen and progesterone are on the floor — the hormonal low point of the whole cycle.',
    energy: { level: 'Low', note: 'The lowest-energy days: cramps and heavy flow demand real rest.' },
    breasts: { size: 'Deflating', note: 'The PMS swelling is draining away fast. Any lingering soreness fades over these first days.' },
    sleep: { need: '9h+ & naps', note: 'The highest sleep need of the cycle — blood loss and cramps are draining. Early nights, and daytime naps are legitimate recovery, not laziness.' },
    libido: { level: 'Lowest', note: 'Rock bottom for most — cramps and the hormonal floor leave little interest. A minority get a brief spike as cramps ease; follow her lead and never assume either way.' },
    mood: 'Withdrawn and inward. Social battery is empty — comfort matters far more than conversation.',
    bloating: { level: 'Cramps peak', note: 'Prostaglandins drive the strongest uterine cramps, sometimes with back ache or headaches. The earlier bloating is deflating.' },
    cervical: { type: 'Menstruation', note: 'The flow masks everything — nothing to read here yet.' },
    appetite: { level: 'Normalizing', note: 'The PMS cravings have broken and appetite settles back down. Iron-rich food helps replace what’s lost to bleeding.' },
    hydration: { need: 'High', note: 'Bleeding drains fluids and iron — steady water and warm drinks ease cramps and headaches.' },
    exercise: { focus: 'Rest / gentle', note: 'Hormones are at their floor; gentle movement — walks, restorative yoga, stretching — eases cramps, but don’t force it on the worst days.' },
    suggestions: [
      'Offer the heating pad, blankets and favorite snacks without being asked.',
      'Take over all the household chores for a couple of days.',
      'Keep the calendar clear — staying in is the right call.',
      'Small gestures land big right now; grand plans don’t.'
    ]
  },
  'menstrual-easing': {
    label: 'Easing off',
    parent: 'menstrual',
    target: 'the easing-off days',
    hormones: 'Estrogen has started climbing again — the worst of the hormonal dip is over.',
    energy: { level: 'Low', note: 'Still below baseline, but recovering noticeably day by day.' },
    breasts: { size: 'Smallest', note: 'At or near their smallest of the cycle — soft, light and fully comfortable again.' },
    sleep: { need: '8–9h', note: 'Still rebuilding — keep the early bedtimes another day or two. A weekend lie-in or an afternoon nap speeds the recovery.' },
    libido: { level: 'Low', note: 'Waking up with the rising estrogen, but interest is still well below baseline. Affection without an agenda is the safer read.' },
    mood: 'Coming back out of the shell — up for gentle company, not yet for crowds.',
    bloating: { level: 'Fading', note: 'Cramps ease off and the bloat is gone — the body feels noticeably lighter and more comfortable.' },
    cervical: { type: 'Light → dry', note: 'Spotting tapers off into the dry days; low, thick and minimal.' },
    appetite: { level: 'Low', note: 'Settled and easy — cravings gone, drawn to lighter, fresher food.' },
    hydration: { need: 'Moderate', note: 'Losses are tapering; needs drift back toward baseline as the flow lightens.' },
    exercise: { focus: 'Ease back in', note: 'Energy is rebuilding fast — a good point to restart the routine gently with walking, light strength and mobility.' },
    suggestions: [
      'Suggest a gentle outing: a walk, a coffee, nothing ambitious.',
      'Keep handling the chores — the recovery isn’t done yet.',
      'A low-key film night beats a night out for another day or two.',
      'Don’t over-schedule the days ahead just yet.'
    ]
  },
  'follicular-building': {
    label: 'Energy building',
    parent: 'follicular',
    target: 'rising energy',
    hormones: 'Estrogen is rising steadily, and testosterone starts ticking up too.',
    energy: { level: 'High', note: 'Motivation, stamina and sleep quality all climbing fast.' },
    breasts: { size: 'Smallest', note: 'The smallest, lightest stretch of the month — soft, not tender at all. Least noticeable they’ll be.' },
    sleep: { need: '7–8h', note: 'Sleep is deep and efficient right now — a normal night leaves her fully charged. No naps needed this stretch.' },
    libido: { level: 'Building', note: 'Climbing steadily with estrogen and testosterone. Flirtation and anticipation land better than a direct approach right now.' },
    mood: 'Optimistic, curious and increasingly social — a great planning-and-doing stretch.',
    bloating: { level: 'Clear', note: 'The most comfortable stretch — minimal symptoms, body at its best.' },
    cervical: { type: 'Sticky → creamy', note: 'Rising estrogen shifts it from tacky to a creamy, lotion-like texture. The fertility signal is starting to climb.' },
    appetite: { level: 'Low', note: 'Rising estrogen keeps appetite in check; naturally reaching for lighter meals.' },
    hydration: { need: 'Baseline', note: 'Normal needs, rising with the extra activity as energy climbs.' },
    exercise: { focus: 'Build & lift', note: 'Rising estrogen aids muscle building and recovery — start the heavy block and ramp the loads.' },
    suggestions: [
      'Plan active dates — hikes, classes, anything new and energetic.',
      'Start the bigger joint projects and decisions now.',
      'Book things for the week ahead while enthusiasm is high.',
      'Bring ideas — novelty and future plans land especially well.'
    ]
  },
  'follicular-peak': {
    label: 'Peak energy',
    parent: 'follicular',
    target: 'the peak-energy days',
    hormones: 'Estrogen is near its top and luteinizing hormone is about to surge.',
    energy: { level: 'High', note: 'The most energetic, social days of the whole cycle.' },
    breasts: { size: 'Baseline', note: 'Still small and comfortable, with a hint of fullness arriving as estrogen nears its peak.' },
    sleep: { need: '7–8h', note: 'The lowest sleep need of the cycle — she runs great on a standard night and late evenings out cost little.' },
    libido: { level: 'High', note: 'Close to peak and rising fast, with confidence to match. Initiation is likely to be mutual this stretch.' },
    mood: 'Outgoing, confident and highly communicative — social battery at maximum.',
    bloating: { level: 'Clear', note: 'Still comfortable, maybe the first faint hint of a mid-cycle twinge on the way.' },
    cervical: { type: 'Creamy → wet', note: 'Turning watery and slippery; the first stretchy, clear traces appear as the fertile window opens.' },
    appetite: { level: 'Lowest', note: 'The estrogen peak suppresses appetite most — least hungry, least driven by cravings.' },
    hydration: { need: 'Baseline+', note: 'Busy, active days — top up around workouts and nights out.' },
    exercise: { focus: 'Strength & power', note: 'The window for intense training: chase PRs and HIIT while estrogen supports strength, recovery and pain tolerance.' },
    suggestions: [
      'This is the window for big social plans and adventurous dates.',
      'Have the important conversation or make the big decision now.',
      'Say yes to everything social — she’ll shine.',
      'Heads-up: the fertile window is opening, whichever way you’re planning.'
    ]
  },
  'ovulation': {
    label: 'Fertility peak',
    parent: 'ovulation',
    target: 'ovulation',
    hormones: 'Estrogen and luteinizing hormone are peaking — this is when fertility is highest.',
    energy: { level: 'High', note: 'Confidence and drive peak, along with libido.' },
    breasts: { size: 'Plumping', note: 'A subtle swell begins around ovulation; nipples can turn briefly sensitive at the estrogen peak.' },
    sleep: { need: '7–8h', note: 'Standard needs, though body temperature starts rising after ovulation — the bedroom running cool helps her sleep through.' },
    libido: { level: 'Peak', note: 'The high point of the cycle — biology is actively pushing in this direction. Note that peak desire and peak fertility land on exactly the same days.' },
    mood: 'Magnetic and social — likely feeling her most confident and connected.',
    bloating: { level: 'Ovulation twinge', note: 'Some feel mittelschmerz — a brief one-sided pinch as the egg releases, occasionally with light spotting. Usually mild.' },
    cervical: { type: 'Egg-white', note: 'Clear, stretchy and slippery like raw egg white — the peak-fertility signal, and the most abundant of the cycle.' },
    appetite: { level: 'Low', note: 'Still near the cycle’s low point around the estrogen peak.' },
    hydration: { need: 'Baseline+', note: 'Basal temperature ticks up just after ovulation, nudging needs slightly higher.' },
    exercise: { focus: 'Power / PRs', note: 'Strength peaks, but joints are laxer around ovulation (higher ACL and sprain risk) — warm up well and be careful with max lifts and plyos.' },
    suggestions: [
      'Fertility is peaking — the key days if you’re trying to conceive (and the days to be extra careful if you’re not).',
      'Plan a romantic night out; effort and attention go a long way right now.',
      'Prioritize physical intimacy and affection.',
      'Compliments land double this week — be specific and sincere.'
    ]
  },
  'luteal-settled': {
    label: 'Settled',
    parent: 'luteal',
    target: 'the settled stretch',
    hormones: 'Progesterone is rising — the calming, cozy hormone of the back half of the cycle.',
    energy: { level: 'Baseline', note: 'Steady and grounded; appetite starts creeping up.' },
    breasts: { size: 'Filling out', note: 'Progesterone is plumping them up day by day — noticeably fuller and heavier, mild tenderness starting.' },
    sleep: { need: '8h+', note: 'Progesterone is a natural sedative — she’ll get drowsy earlier than usual. Lean into early nights rather than fighting them.' },
    libido: { level: 'Moderate', note: 'Down off the peak as progesterone rises, but comfortably present. Warmth and familiarity matter more than novelty now.' },
    mood: 'Calm, content and home-oriented — often the most settled stretch of the month.',
    bloating: { level: 'Mild bloat', note: 'Water retention and puffiness begin as progesterone rises; the gut slows too, so some constipation.' },
    cervical: { type: 'Sticky / dry', note: 'Progesterone thickens and dries it up fast after ovulation — pasty, cloudy and much less of it.' },
    appetite: { level: 'Climbing', note: 'Progesterone lifts appetite and slightly raises metabolism — portions and hunger start creeping up.' },
    hydration: { need: 'Moderate', note: 'Temperature is up on progesterone — start front-loading water now to pre-empt the PMS bloat.' },
    exercise: { focus: 'Endurance', note: 'Progesterone raises core temperature and perceived effort — pivot from maxing to steady-state cardio, volume and technique.' },
    suggestions: [
      'Lean into quality time at home — cook together, slow evenings.',
      'Great stretch for routines, home projects and practical plans.',
      'Comfort food is welcome; keep good snacks around.',
      'Enjoy the calm — low-drama togetherness is the move this week.'
    ]
  },
  'luteal-pms': {
    label: 'PMS window',
    parent: 'luteal',
    target: 'the PMS window',
    hormones: 'Progesterone and estrogen are both falling fast — the crash behind PMS.',
    energy: { level: 'Low', note: 'Fatigue and cravings peak; sleep may run lighter.' },
    breasts: { size: 'Fullest', note: 'Peak size — swollen, heavy and often genuinely sore. Look, don’t squeeze; a hug can be enough pressure.' },
    sleep: { need: '8–9h & naps', note: 'She needs more sleep but gets worse sleep — elevated temperature keeps it light and broken. Budget longer nights and don’t begrudge a nap.' },
    libido: { level: 'Variable', note: 'The least predictable stretch: sore breasts, bloating and fatigue kill interest for many, while others get a distinct pre-period surge. Ask, don’t guess.' },
    mood: 'Patience runs short and the social battery drains fastest. Irritability is chemistry, not commentary.',
    bloating: { level: 'Peak bloat', note: 'Water retention peaks — puffy and heavy, often with pre-period cramps or back ache. Hydration and less salt genuinely help.' },
    cervical: { type: 'Dry / thick', note: 'Mostly dry or thick and sticky; some notice a brief wet feeling as progesterone falls, but it’s not fertile.' },
    appetite: { level: 'Peak', note: 'Strongest cravings of the month — carbs, sugar, salt, chocolate — as a serotonin dip drives comfort-eating. She’s genuinely hungrier, not indulgent.' },
    hydration: { need: 'Highest', note: 'Counter-intuitive: more water, plus less salt, caffeine and alcohol, reduces the bloating rather than worsening it.' },
    exercise: { focus: 'Recovery / deload', note: 'Energy and recovery are down — treat it as a deload: yoga, pilates, easy cardio, more rest, protein and hydration.' },
    suggestions: [
      'Don’t take irritability personally — it’s chemistry, not you.',
      'Cook dinner and handle the grocery run without making it a thing.',
      'Be an active listener: validate first, solve later (or never).',
      'Scale back big social plans; protect her downtime.'
    ]
  }
};

// Every intel field, defined once: its label and how to pull a badge + note
// out of a SUBPHASES entry. Both the dashboard windows and the flat phases
// reference render from this list, so a new field is added in one place.
const INTEL_FIELDS = {
  hormones:  { label: 'Hormones',              get: c => ({ note: c.hormones }) },
  mood:      { label: 'Mood & social battery', get: c => ({ note: c.mood }) },
  energy:    { label: 'Energy',                get: c => ({ badge: c.energy.level, note: c.energy.note }) },
  breasts:   { label: 'Boobs',                 get: c => ({ badge: c.breasts.size, note: c.breasts.note }) },
  sleep:     { label: 'Sleep',                 get: c => ({ badge: c.sleep.need, note: c.sleep.note }) },
  bloating:  { label: 'Bloating & cramps',     get: c => ({ badge: c.bloating.level, note: c.bloating.note }) },
  cervical:  { label: 'Cervical fluid',        get: c => ({ badge: c.cervical.type, note: c.cervical.note }) },
  libido:    { label: 'Horniness',             get: c => ({ badge: c.libido.level, note: c.libido.note }) },
  appetite:  { label: 'Appetite & cravings',   get: c => ({ badge: c.appetite.level, note: c.appetite.note }) },
  hydration: { label: 'Hydration',             get: c => ({ badge: c.hydration.need, note: c.hydration.note }) },
  exercise:  { label: 'Exercise',              get: c => ({ badge: c.exercise.focus, note: c.exercise.note }) }
};

// The dashboard splits the intel fields across three stacked Notepad windows.
const INTEL_WINDOWS = [
  { caption: 'vibe.txt - Notepad',    fields: ['hormones', 'mood', 'energy', 'libido'] },
  { caption: 'body.txt - Notepad',    fields: ['breasts', 'sleep', 'bloating', 'cervical'] },
  { caption: 'fitness.txt - Notepad', fields: ['appetite', 'hydration', 'exercise'] }
];

const TB_CONTROLS = '<span class="tb-controls"><span class="tb-btn">_</span>' +
  '<span class="tb-btn">□</span><span class="tb-btn">×</span></span>';

// Builds the four intel windows for the current sub-phase from the config above.
function intelWindowsHTML(content) {
  const row = key => {
    const f = INTEL_FIELDS[key];
    const v = f.get(content);
    const badge = v.badge ? `<span class="level-badge">${v.badge}</span> ` : '';
    return `<div class="intel-row"><dt>${f.label}</dt><dd>${badge}${v.note}</dd></div>`;
  };
  return INTEL_WINDOWS.map(w =>
    `<section class="window"><div class="titlebar">` +
    `<span class="tb-caption">${w.caption}</span>${TB_CONTROLS}</div>` +
    `<div class="window-body"><dl class="intel">${w.fields.map(row).join('')}</dl></div>` +
    `</section>`
  ).join('');
}

/* ================= calendar ================= */

// Marks every relevant day with period/ovulation info.
// Past: logged period days; ovulation back-calculated as next logged start − 14
// (the luteal phase is the stable half of the cycle, so this beats counting
// forward). Future: cycles projected from the latest start, ~6 months out.
function buildMarks(data) {
  const marks = {};
  const get = iso => (marks[iso] = marks[iso] || {});
  const starts = [...data.periodStarts].sort();
  const P = data.periodLength;
  const L = effectiveCycleLength(data);

  for (const s of starts) {
    for (let i = 0; i < P; i++) get(addDays(s, i)).period = 'logged';
  }
  for (let i = 1; i < starts.length; i++) {
    const gap = daysBetween(starts[i - 1], starts[i]);
    if (gap >= 15 && gap <= 60) get(addDays(starts[i], -14)).ov = 'est';
  }
  if (starts.length) {
    const last = starts[starts.length - 1];
    const horizon = addDays(todayISO(), 183);
    for (let k = 0; k < 12; k++) {
      const cs = addDays(last, k * L);
      if (cs > horizon) break;
      if (k > 0) {
        for (let i = 0; i < P; i++) {
          const cell = get(addDays(cs, i));
          if (!cell.period) cell.period = 'predicted';
        }
      }
      const ovCell = get(addDays(cs, L - 14));
      if (!ovCell.ov) ovCell.ov = 'pred';
    }
  }
  return marks;
}

let calYear, calMonth;

function renderCalendar(data) {
  const marks = buildMarks(data);
  const today = todayISO();
  const first = new Date(calYear, calMonth, 1, 12);
  $('calTitle').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const lead = first.getDay(); // Sunday-first grid
  const grid = $('calGrid');
  grid.innerHTML = '';

  for (const wd of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
    const el = document.createElement('div');
    el.className = 'cal-wd';
    el.textContent = wd;
    grid.appendChild(el);
  }
  for (let i = 0; i < lead; i++) grid.appendChild(document.createElement('div'));

  for (let d = 1; d <= daysInMonth; d++) {
    const iso = toISO(new Date(calYear, calMonth, d, 12));
    const m = marks[iso] || {};
    const el = document.createElement('div');
    let cls = 'cal-day';
    if (m.period === 'logged') cls += ' p-log';
    else if (m.period === 'predicted') cls += ' p-pred';
    if (m.ov === 'est') cls += ' o-est';
    else if (m.ov === 'pred') cls += ' o-pred';
    if (iso === today) cls += ' is-today';
    el.className = cls;
    el.textContent = d;
    grid.appendChild(el);
  }
}

function calGoTo(year, month) {
  calYear = year;
  calMonth = month;
  renderCalendar(loadData());
}

/* ================= rendering ================= */

const $ = id => document.getElementById(id);

function show(viewId) {
  ['setupView', 'dashboard', 'settingsView', 'phasesView'].forEach(id => {
    $(id).hidden = id !== viewId;
  });
  $('settingsBtn').hidden = viewId !== 'dashboard';
  $('phasesBtn').hidden = viewId !== 'dashboard';
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
  const content = SUBPHASES[s.subPhase];

  document.body.className = 'phase-' + s.phase;

  $('dayNum').textContent = s.day;
  $('cycleLen').textContent = s.L;
  $('phaseName').textContent = PHASE_NAMES[s.phase];
  $('subPhaseName').textContent = content.label;
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
  lines.push(`<strong>${plural(s.daysToNextSub)}</strong> until ${SUBPHASES[s.nextSubKey].target}`);
  if (s.daysToFertile !== null) {
    lines.push(`<strong>${plural(s.daysToFertile)}</strong> until the fertile window`);
  } else if (s.inFertile) {
    lines.push(`Fertile window: day ${s.fertileStart}–${s.fertileEnd} (ovulation expected day ${s.O})`);
  }
  lines.push(`Next period expected <strong>${formatDate(s.nextPeriodDate)}</strong> (${plural(s.daysToNextPeriod)})`);
  $('countdowns').innerHTML = lines.map(l => `<li>${l}</li>`).join('');

  // pregnancy likelihood
  const cl = conceptionLikelihood(s.day, s.O);
  $('pregPct').textContent = '~' + cl.pct + '%';
  $('pregLevel').textContent = cl.level;
  $('pregLevel').style.background = cl.color;
  const fill = $('pregMeter');
  fill.style.width = Math.min(100, cl.pct / 35 * 100) + '%';
  fill.style.background = cl.color;

  // intel (four stacked windows, built from INTEL_WINDOWS)
  $('intelWindows').innerHTML = intelWindowsHTML(content);

  // suggestions
  $('suggestions').innerHTML = content.suggestions
    .map(t => `<li>${t}</li>`).join('');

  // calendar (reset to the current month on full dashboard render)
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar(data);
}

// Static reference page: every phase and sub-phase with its day range and
// details, built from the same SUBPHASES content the dashboard uses. Day
// ranges reflect the user's current cycle/period lengths.
function renderPhases(data) {
  const s = getCycleStatus(data, todayISO());
  const subs = subPhaseSegments(s.L, s.P);
  const range = (a, b) => a === b ? `Day ${a}` : `Days ${a}–${b}`;

  let html = `<p class="muted">Your full ${s.L}-day cycle at a glance. ` +
    `Fertile window: days ${s.fertileStart}–${s.fertileEnd} ` +
    `(ovulation expected day ${s.O}). Day ranges adjust as your logged history updates the averages.</p>`;

  for (const seg of s.segs) {
    html += `<div class="phase-group">` +
      `<h3 class="phase-head" style="background: var(--${seg.key})">` +
      `${PHASE_NAMES[seg.key]}<span class="phase-days">${range(seg.start, seg.end)}</span></h3>`;
    for (const sub of subs.filter(x => x.parent === seg.key)) {
      const c = SUBPHASES[sub.key];
      const now = sub.key === s.subPhase;
      const details = Object.values(INTEL_FIELDS).map(f => {
        const v = f.get(c);
        const lead = v.badge ? `<strong>${v.badge}.</strong> ` : '';
        return `<div><dt>${f.label}</dt><dd>${lead}${v.note}</dd></div>`;
      }).join('');
      html += `<div class="subphase${now ? ' now' : ''}">` +
        `<p class="sp-title">${c.label}<span class="sp-days">${range(sub.start, sub.end)}</span>` +
        (now ? '<span class="sp-now">You are here</span>' : '') + `</p>` +
        `<dl class="sp-details">${details}</dl>` +
        `<ul class="sp-tips">${c.suggestions.map(t => `<li>${t}</li>`).join('')}</ul>` +
        `</div>`;
    }
    html += `</div>`;
  }
  $('phasesBody').innerHTML = html;
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
  $('settingsClose').addEventListener('click', () => render());

  $('phasesBtn').addEventListener('click', () => {
    renderPhases(loadData());
    show('phasesView');
    window.scrollTo(0, 0);
  });
  $('phasesBack').addEventListener('click', () => render());
  $('phasesClose').addEventListener('click', () => render());

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

  $('calPrev').addEventListener('click', () => {
    calGoTo(calMonth === 0 ? calYear - 1 : calYear, (calMonth + 11) % 12);
  });
  $('calNext').addEventListener('click', () => {
    calGoTo(calMonth === 11 ? calYear + 1 : calYear, (calMonth + 1) % 12);
  });
  $('calTitle').addEventListener('click', () => {
    const n = new Date();
    calGoTo(n.getFullYear(), n.getMonth());
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
