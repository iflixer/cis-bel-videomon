// ESM-compatible node-fetch
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const express = require('express');
const cron = require('node-cron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Config ----------
let config = {
  test: '5r5',                  // "2", "2r2", "5r5"
  quality: '1080',
  domain: 'tg.piratka.me',
  jsonEndpoint: 'https://master.futmax.info/test/random_movie',
  serverPort: 3002,             // где слушает puppeteer-sse.js
};

// ---------- Utils ----------
function getTestDurationMinutes(testStr) {
  if (!testStr) return 5;
  const parts = String(testStr)
    .split('r')
    .map((n) => parseInt(n, 10))
    .filter((n) => !Number.isNaN(n) && n > 0);
  const total = parts.reduce((s, n) => s + n, 0);
  return total || 5;
}

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = 10000, ...rest } = opts;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonWithRetry(url, { attempts = 4, baseDelay = 1000, timeoutMs = 10000, ...opts } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, { ...opts, timeoutMs });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.error(`[retry] ${i}/${attempts} ${e.message}`);
      if (i < attempts) await sleep(baseDelay * i); // линейный backoff
    }
  }
  throw lastErr;
}

// ---------- Main ----------
let timer = null;
async function runTest() {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] Cron triggered…`);

  try {
    const data = await fetchJsonWithRetry(config.jsonEndpoint, {
      attempts: 4,
      baseDelay: 1500,
      timeoutMs: 10000,
      headers: { 'Accept': 'application/json' },
    });

    // безопасное извлечение
    const kp = data?.kinopoisk;
    const direct = data?.direct;
    let targetUrl = kp || direct || null;

    const ruName = (data?.ru_name || '').trim();
    const enName = (data?.name || '').trim();
    const itemTitle = [ruName, enName].filter(Boolean).join(' / ') || 'Untitled';

    if (!targetUrl) {
      console.error('No valid URL (kinopoisk/direct) in JSON:', data);
      return scheduleNext();
    }

    // добавляем параметры
    const qs = new URLSearchParams({
      domain: String(config.domain || ''),
      autoplay: '1',
      monq: String(config.quality || ''),
    });
    if (targetUrl.includes('?')) {
      targetUrl = `${targetUrl}&${qs.toString()}`;
    } else {
      targetUrl = `${targetUrl}?${qs.toString()}`;
    }
    console.log('Test url:', targetUrl);

    const runUrl = `http://localhost:${config.serverPort}/run` +
      `?test=${encodeURIComponent(config.test)}` +
      `&title=${encodeURIComponent(itemTitle)}` +
      `&url=${encodeURIComponent(targetUrl)}`;

    console.log('Triggering run:', runUrl);
    const runRes = await fetchWithTimeout(runUrl, { timeoutMs: 300000 });
    if (!runRes.ok) {
      const txt = await runRes.text().catch(() => '');
      throw new Error(`Runner HTTP ${runRes.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    console.error('Cron error:', err);
  } finally {
    const ms = Date.now() - started;
    console.log(`Run took ${Math.round(ms / 1000)}s`);
    scheduleNext();
  }
}

function scheduleNext() {
  const minutes = getTestDurationMinutes(config.test);
  const intervalSec = minutes * 60 + 120; // +2 минуты на рекламу
  console.log(`Next run in ${intervalSec} sec…`);
  clearTimeout(timer);
  timer = setTimeout(runTest, intervalSec * 1000);
}

// Старт
runTest();

// ---------- API для обновления конфигурации ----------
const app = express();
app.use(express.json());

app.post('/cronrun/config', (req, res) => {
  const { test, quality, jsonEndpoint, domain } = req.body || {};
  if (typeof test === 'string' && test.trim()) config.test = test.trim();
  if (typeof domain === 'string' && domain.trim()) config.domain = domain.trim();
  if (typeof quality === 'string' && quality.trim()) config.quality = quality.trim();
  if (typeof jsonEndpoint === 'string' && jsonEndpoint.trim()) config.jsonEndpoint = jsonEndpoint.trim();

  // при обновлении — пересчитать расписание
  scheduleNext();
  res.json({ status: 'ok', config });
});

app.listen(3100, () => console.log('Cron Runner listening on port 3100'));