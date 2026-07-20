#!/usr/bin/env node
/**
 * transform.js — turns raw Apify dataset items into a clean, filtered jobs.json.
 *
 * STRICT FILTER RULES (must pass ALL):
 *   1. .NET match  — the literal string ".net", "dotnet", or "asp.net"
 *                    (case-insensitive) appears in the TITLE or the DESCRIPTION.
 *                    This is what drops the "net zero" / "net present value"
 *                    false positives the source query lets through.
 *   2. Contract    — employment type is CONTRACTOR or TEMPORARY (not full-time /
 *                    permanent / direct-hire).
 *   3. US only     — the job's country is "United States".
 *
 * Then: deduplicate by URL, assign a stable id (hash of the URL) so the frontend
 * can track "Applied" state across refreshes, and sort newest-first.
 *
 * Usage:
 *   node scripts/transform.js [inputDirOrFile] [outputFile]
 * Defaults:
 *   input  = ./raw           (reads and concatenates every *.json array inside)
 *   output = ./jobs.json
 */

const fs = require('fs');
const path = require('path');

const INPUT = process.argv[2] || path.join(__dirname, '..', 'raw');
const OUTPUT = process.argv[3] || path.join(__dirname, '..', 'jobs.json');

// ---- Rule 1: real .NET, not the word "net" -------------------------------
const DOTNET_RE = /(\.net|\bdotnet\b|asp\.net)/i;

// ---- Rule 2: which employment types count as "contract" ------------------
const CONTRACT_TYPES = new Set(['CONTRACTOR', 'TEMPORARY']);

// ---- Rule 3: geographic scope --------------------------------------------
const ALLOWED_COUNTRIES = new Set(['United States']);

// ---- Rolling board settings ----------------------------------------------
// The daily job pulls only the last 24h of NEW postings (to stay cheap) and
// MERGES them into the existing jobs.json, so the board accumulates a rolling
// window instead of being replaced each run. Jobs older than KEEP_DAYS (by
// posted date) are pruned so the board stays fresh. Set MERGE=0 to disable.
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 14);
const MERGE = process.env.MERGE !== '0';

// --------------------------------------------------------------------------

/** Load raw items from a file or a directory of *.json files. */
function loadRawItems(input) {
  const stat = fs.statSync(input);
  const files = stat.isDirectory()
    ? fs.readdirSync(input).filter((f) => f.endsWith('.json')).map((f) => path.join(input, f))
    : [input];

  const items = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : parsed.items || [];
    items.push(...arr);
  }
  return items;
}

/** Stable, compact id derived from the job URL (djb2 hash -> base36). */
function stableId(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  }
  return 'job_' + h.toString(36);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (Array.isArray(v) && v.length) return v[0];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return v;
  }
  return null;
}

const CURRENCY_SYMBOL = { USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$' };
const UNIT_LABEL = { HOUR: '/hr', DAY: '/day', WEEK: '/wk', MONTH: '/mo', YEAR: '/yr' };

function money(value, currency, unit) {
  if (value == null) return null;
  const sym = CURRENCY_SYMBOL[currency] || (currency ? currency + ' ' : '');
  const unitLabel = UNIT_LABEL[unit] || '';
  // Compress yearly figures like 120000 -> 120k
  let num = value;
  if (unit === 'YEAR' && value >= 1000) num = Math.round(value / 1000) + 'k';
  else num = Math.round(value).toLocaleString('en-US');
  return `${sym}${num}${unitLabel}`;
}

/** Build a human rate string from the AI salary fields. */
function rateDisplay(item) {
  const cur = item.ai_salary_currency;
  const unit = item.ai_salary_unit_text;
  const min = item.ai_salary_min_value;
  const max = item.ai_salary_max_value;
  const val = item.ai_salary_value;

  if (min != null && max != null && min !== max) {
    return `${money(min, cur, unit)} – ${money(max, cur, unit)}`.replace(/\/(hr|day|wk|mo|yr) –/, ' –');
  }
  const single = firstNonEmpty(val, min, max);
  if (single != null) return money(single, cur, unit);
  return null;
}

/** Normalize AI work arrangement to On-site / Hybrid / Remote. */
function normalizeArrangement(a) {
  if (!a) return 'Unspecified';
  if (/remote/i.test(a)) return 'Remote';
  if (/hybrid/i.test(a)) return 'Hybrid';
  if (/on-?site/i.test(a)) return 'On-site';
  return a;
}

function locationText(item) {
  const parts = [
    firstNonEmpty(item.cities_derived),
    firstNonEmpty(item.regions_derived),
    firstNonEmpty(item.countries_derived),
  ].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : 'United States';
}

function snippet(text, max = 320) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean;
}

function isContract(item) {
  const types = []
    .concat(item.ai_employment_type || [])
    .concat(item.employment_type || [])
    .map((t) => String(t).toUpperCase());
  return types.some((t) => CONTRACT_TYPES.has(t));
}

function isUS(item) {
  const countries = (item.countries_derived || []).map(String);
  return countries.some((c) => ALLOWED_COUNTRIES.has(c));
}

function matchesDotNet(item) {
  return DOTNET_RE.test(item.title || '') || DOTNET_RE.test(item.description_text || '');
}

function main() {
  const raw = loadRawItems(INPUT);
  const stats = { raw: raw.length, droppedNoUrl: 0, droppedDotNet: 0, droppedContract: 0, droppedUS: 0, duplicates: 0 };

  const byUrl = new Map();

  for (const item of raw) {
    const url = item.url;
    if (!url) { stats.droppedNoUrl++; continue; }
    if (!matchesDotNet(item)) { stats.droppedDotNet++; continue; }
    if (!isContract(item)) { stats.droppedContract++; continue; }
    if (!isUS(item)) { stats.droppedUS++; continue; }

    if (byUrl.has(url)) { stats.duplicates++; continue; } // dedupe by URL

    const job = {
      id: stableId(url),
      url,
      title: item.title || 'Untitled role',
      company: item.organization || 'Unknown company',
      location: locationText(item),
      city: firstNonEmpty(item.cities_derived),
      region: firstNonEmpty(item.regions_derived),
      arrangement: normalizeArrangement(item.ai_work_arrangement),
      employmentType: (item.ai_employment_type && item.ai_employment_type[0]) ||
        (item.employment_type && item.employment_type[0]) || 'CONTRACTOR',
      rate: rateDisplay(item),
      datePosted: item.date_posted || item.date_created || null,
      seniority: item.seniority || null,
      skills: (item.ai_key_skills || []).slice(0, 8),
      description: snippet(item.description_text),
    };
    byUrl.set(url, job);
  }

  // Merge this run's jobs with the jobs already on the board (new data wins),
  // then prune anything older than KEEP_DAYS so the board stays a rolling window.
  stats.fromThisRun = byUrl.size;
  stats.carriedOver = 0;
  stats.prunedOld = 0;

  if (MERGE && fs.existsSync(OUTPUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      const prevJobs = Array.isArray(prev) ? prev : prev.jobs || [];
      for (const pj of prevJobs) {
        if (pj && pj.url && !byUrl.has(pj.url)) {
          byUrl.set(pj.url, pj);
          stats.carriedOver++;
        }
      }
    } catch { /* corrupt/absent previous file — start fresh */ }
  }

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const jobs = [...byUrl.values()]
    .filter((j) => {
      if (!j.datePosted) return true; // keep undated jobs
      const t = Date.parse(j.datePosted);
      if (Number.isNaN(t)) return true;
      if (t < cutoff) { stats.prunedOld++; return false; }
      return true;
    })
    .sort((a, b) => {
      const da = a.datePosted ? Date.parse(a.datePosted) : 0;
      const db = b.datePosted ? Date.parse(b.datePosted) : 0;
      return db - da; // newest first
    });

  const output = {
    generatedAt: new Date().toISOString(),
    count: jobs.length,
    keepDays: KEEP_DAYS,
    filters: { dotnet: 'title or description contains .net/dotnet/asp.net', contract: [...CONTRACT_TYPES], countries: [...ALLOWED_COUNTRIES] },
    jobs,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

  console.log('transform complete');
  console.table(stats);
  console.log(`board now has ${jobs.length} jobs (kept ${KEEP_DAYS} days) -> ${OUTPUT}`);
}

main();
