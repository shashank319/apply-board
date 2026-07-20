/* .NET Contract Jobs dashboard — no backend, no dependencies. */
(function () {
  'use strict';

  const STORAGE_KEY = 'dotnet-jobs-applied-v1';
  const els = {
    generatedAt: document.getElementById('generated-at'),
    statOpen: document.getElementById('stat-open'),
    statNew: document.getElementById('stat-new'),
    statApplied: document.getElementById('stat-applied'),
    search: document.getElementById('search'),
    filterLocation: document.getElementById('filter-location'),
    filterArrangement: document.getElementById('filter-arrangement'),
    toggleApplied: document.getElementById('toggle-applied'),
    jobs: document.getElementById('jobs'),
    empty: document.getElementById('empty'),
    activeCount: document.getElementById('active-count'),
    appliedSection: document.getElementById('applied-section'),
    appliedJobs: document.getElementById('applied-jobs'),
    appliedToggle: document.getElementById('applied-toggle'),
    appliedSectionCount: document.getElementById('applied-section-count'),
    template: document.getElementById('card-template'),
  };

  let ALL_JOBS = [];

  // ---- Applied state (persisted, keyed by stable job id / URL) ------------
  function loadApplied() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveApplied(map) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  }
  let applied = loadApplied();

  function markApplied(id) {
    applied[id] = new Date().toISOString();
    saveApplied(applied);
    render();
  }
  function unmarkApplied(id) {
    delete applied[id];
    saveApplied(applied);
    render();
  }

  // ---- Date helpers -------------------------------------------------------
  function isToday(iso) {
    if (!iso) return false;
    const d = new Date(iso);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }
  function relativeDate(iso) {
    if (!iso) return 'Date unknown';
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const day = 24 * 60 * 60 * 1000;
    const days = Math.floor(diffMs / day);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---- Filtering ----------------------------------------------------------
  function matchesFilters(job) {
    const q = els.search.value.trim().toLowerCase();
    if (q) {
      const hay = (job.title + ' ' + job.company + ' ' + job.location + ' ' +
        (job.skills || []).join(' ') + ' ' + (job.description || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const loc = els.filterLocation.value;
    if (loc && job.region !== loc) return false;

    const arr = els.filterArrangement.value;
    if (arr && job.arrangement !== arr) return false;

    return true;
  }

  // ---- Card rendering -----------------------------------------------------
  function buildCard(job) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    const isApplied = !!applied[job.id];

    node.dataset.id = job.id;
    if (isApplied) node.classList.add('is-applied');

    const arrBadge = node.querySelector('.badge-arrangement');
    arrBadge.textContent = job.arrangement;
    arrBadge.dataset.a = job.arrangement;

    node.querySelector('.badge-applied').hidden = !isApplied;
    node.querySelector('.card-title').textContent = job.title;
    node.querySelector('.card-company').textContent = job.company;
    node.querySelector('.meta-location').textContent = '📍 ' + job.location;

    const rateEl = node.querySelector('.meta-rate');
    if (job.rate) rateEl.textContent = '💷 ' + job.rate.replace('💷 ', '');
    else rateEl.remove();

    node.querySelector('.card-desc').textContent = job.description || '';

    const skillsEl = node.querySelector('.card-skills');
    (job.skills || []).slice(0, 5).forEach((s) => {
      const chip = document.createElement('span');
      chip.className = 'skill-chip';
      chip.textContent = s;
      skillsEl.appendChild(chip);
    });

    const dateEl = node.querySelector('.card-date');
    if (isToday(job.datePosted)) {
      dateEl.innerHTML = '<span class="today">● New today</span>';
    } else {
      dateEl.textContent = 'Posted ' + relativeDate(job.datePosted);
    }

    const applyBtn = node.querySelector('.btn-apply');
    applyBtn.href = job.url;
    applyBtn.textContent = isApplied ? 'View ↗' : 'Apply ↗';
    // Clicking Apply opens the posting (default anchor behavior) AND marks applied.
    applyBtn.addEventListener('click', function () {
      if (!applied[job.id]) markApplied(job.id);
    });

    const undoBtn = node.querySelector('.btn-undo');
    undoBtn.hidden = !isApplied;
    undoBtn.addEventListener('click', function () { unmarkApplied(job.id); });

    return node;
  }

  // ---- Main render --------------------------------------------------------
  function render() {
    const showApplied = els.toggleApplied.checked;
    const filtered = ALL_JOBS.filter(matchesFilters);

    const active = filtered.filter((j) => !applied[j.id]);
    const appliedJobs = filtered.filter((j) => applied[j.id]);

    // Active grid
    els.jobs.innerHTML = '';
    active.forEach((j) => els.jobs.appendChild(buildCard(j)));

    // Applied section (collapsible, at the bottom)
    els.appliedJobs.innerHTML = '';
    if (showApplied && appliedJobs.length) {
      appliedJobs.forEach((j) => els.appliedJobs.appendChild(buildCard(j)));
      els.appliedSection.hidden = false;
      els.appliedSectionCount.textContent = appliedJobs.length;
    } else {
      els.appliedSection.hidden = true;
    }

    // Empty state
    els.empty.hidden = active.length !== 0 || (showApplied && appliedJobs.length !== 0);

    // Result count line
    const totalShown = active.length + (showApplied ? appliedJobs.length : 0);
    els.activeCount.textContent =
      `Showing ${active.length} open role${active.length === 1 ? '' : 's'}` +
      (appliedJobs.length ? ` · ${appliedJobs.length} applied ${showApplied ? '(shown below)' : '(hidden)'}` : '');

    updateStats();
  }

  function updateStats() {
    const openCount = ALL_JOBS.filter((j) => !applied[j.id]).length;
    const newToday = ALL_JOBS.filter((j) => isToday(j.datePosted) && !applied[j.id]).length;
    const appliedCount = ALL_JOBS.filter((j) => applied[j.id]).length;
    els.statOpen.textContent = openCount;
    els.statNew.textContent = newToday;
    els.statApplied.textContent = appliedCount;
  }

  // ---- Populate location filter ------------------------------------------
  function populateLocations() {
    const regions = [...new Set(ALL_JOBS.map((j) => j.region).filter(Boolean))].sort();
    regions.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      els.filterLocation.appendChild(opt);
    });
  }

  // ---- Wire events --------------------------------------------------------
  function wireEvents() {
    let t;
    els.search.addEventListener('input', function () {
      clearTimeout(t); t = setTimeout(render, 120);
    });
    els.filterLocation.addEventListener('change', render);
    els.filterArrangement.addEventListener('change', render);
    els.toggleApplied.addEventListener('change', render);
    els.appliedToggle.addEventListener('click', function () {
      const expanded = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', String(!expanded));
      els.appliedJobs.style.display = expanded ? 'none' : '';
    });
    // Re-sync applied state if another tab changes it.
    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY) { applied = loadApplied(); render(); }
    });
  }

  // ---- Boot ---------------------------------------------------------------
  async function boot() {
    try {
      const res = await fetch('jobs.json?_=' + Date.now());
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      ALL_JOBS = Array.isArray(data) ? data : data.jobs || [];
      if (data.generatedAt) {
        els.generatedAt.textContent = 'updated ' + new Date(data.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      }
    } catch (err) {
      els.jobs.innerHTML = '';
      els.empty.hidden = false;
      els.empty.textContent = 'Could not load jobs.json — ' + err.message;
      return;
    }
    populateLocations();
    wireEvents();
    render();
  }

  boot();
})();
