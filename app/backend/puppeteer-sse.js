// backend/puppeteer-sse.js
// Run: node backend/puppeteer-sse.js
// Env: PORT=3002 HEADLESS=true SLOW_THRESHOLD_MBPS=3

const express = require('express');
const { URL } = require('url');
const puppeteer = require('puppeteer');

const PORT = parseInt(process.env.PORT || '3002', 10);
const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const SLOW_THRESHOLD_MBPS = parseFloat(process.env.SLOW_THRESHOLD_MBPS || '3'); // <— порог "медленно"
const TOP_N = 5; // топ-N по entrypoint/router


const client = require('prom-client');

// Отдельный реестр, префикс для всех дефолтных метрик процесса
const register = new client.Registry();
register.setDefaultLabels({ app: 'puppeteer-sse' });
client.collectDefaultMetrics({ register, prefix: 'puppeteer_sse_' });

// ---- Кастомные метрики ----
const testRunsTotal = new client.Counter({
  name: 'puppeteer_sse_runs_total',
  help: 'Total test runs by result',
  labelNames: ['result'],
  registers: [register],
});

const mediaRequestsTotal = new client.Counter({
  name: 'puppeteer_sse_media_requests_total',
  help: 'Media requests observed (finished/slow/failed)',
  labelNames: ['status'],
  registers: [register],
});

const mediaBytesTotal = new client.Counter({
  name: 'puppeteer_sse_media_bytes_total',
  help: 'Total encoded bytes for finished media requests',
  registers: [register],
});

const mediaMbpsHist = new client.Histogram({
  name: 'puppeteer_sse_media_mbps',
  help: 'Per-request download speed (Mbps)',
  buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120],
  registers: [register],
});

const ttfbMsHist = new client.Histogram({
  name: 'puppeteer_sse_ttfb_ms',
  help: 'Per-request TTFB (ms)',
  buckets: [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 800, 1200, 2000, 3000],
  registers: [register],
});

const totalMsHist = new client.Histogram({
  name: 'puppeteer_sse_total_ms',
  help: 'Per-request total load time (ms)',
  buckets: [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000],
  registers: [register],
});

const ttfm3u8Gauge = new client.Gauge({
  name: 'puppeteer_sse_ttf_m3u8_ms',
  help: 'Time to first m3u8 from test start (ms, last run)',
  registers: [register],
});

const ttfsegGauge = new client.Gauge({
  name: 'puppeteer_sse_ttf_first_segment_ms',
  help: 'Time to first TS segment from test start (ms, last run)',
  registers: [register],
});

const slowPercentGauge = new client.Gauge({
  name: 'puppeteer_sse_slow_percent',
  help: 'Slow requests percent in the last run',
  registers: [register],
});

const qualityCompareTotal = new client.Counter({
  name: 'puppeteer_sse_quality_compare_total',
  help: 'Quality comparisons by result',
  labelNames: ['ok'], // "true"/"false"
  registers: [register],
});


// ---- helpers ----
function nowIso() { return new Date().toISOString(); }
function ndjson(type, payload = {}) {
  const line = JSON.stringify({ ts: nowIso(), type, ...payload });
  // строго в stdout
  process.stdout.write(line + '\n');
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
function makeAgg() {
  return {
    startedAt: Date.now(),
    firstM3u8At: null,
    firstTsAt: null,
    total: 0,
    slow: 0,
    ok: 0,
    failed: 0,
    bytes: 0,          // суммарный encodedDataLength
    seconds: 0,        // суммарное время загрузки (сек)
    ttfb_ms: [],       // массивы для перцентилей
    total_ms: [],
    // распределения (накапливаем bytes и count)
    byEntrypoint: new Map(), // entrypoint -> {bytes,count}
    byRouter: new Map(),     // router -> {bytes,count}
  };
}
function bumpMap(map, key, bytes) {
  if (!key) return;
  const prev = map.get(key) || { bytes: 0, count: 0 };
  prev.bytes += bytes || 0;
  prev.count += 1;
  map.set(key, prev);
}
function topNFromMap(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, n)
    .map(([k, v]) => ({ key: k, bytes_mb: +(v.bytes / 1048576).toFixed(3), count: v.count }));
}
function parseTestParam(testParam) {
  let firstDuration = 0, secondDuration = 0, rewind = false;
  if (/^(\d+)r(\d+)$/.test(testParam)) {
    const [, a, b] = testParam.match(/^(\d+)r(\d+)$/);
    firstDuration = parseInt(a, 10) * 60 * 1000;
    secondDuration = parseInt(b, 10) * 60 * 1000;
    rewind = true;
  } else if (/^\d+$/.test(testParam)) {
    firstDuration = parseInt(testParam, 10) * 60 * 1000;
  } else {
    throw new Error('Invalid test parameter');
  }
  return { firstDuration, secondDuration, rewind };
}
function getExpectedQualityFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const monq = u.searchParams.get('monq');
    ndjson('monq', { monq_raw: monq, expected_quality: monq ? parseInt(monq, 10) : null });
    return monq ? parseInt(monq, 10) : null;
  } catch {
    ndjson('monq', { monq_raw: null, expected_quality: null });
    return null;
  }
}
function qualityFromUrl(url) {
  const m = url.match(/(1080|720|480|360|240)\.mp4:hls/i);
  return m ? parseInt(m[1], 10) : null;
}
function isMediaUrl(url) {
  return /\.(m3u8|mp4|ts)(\?.*)?$/i.test(url);
}

// ---- puppeteer context helper ----
async function getContextAndPage(browser) {
  let context = null;
  if (typeof browser.createIncognitoBrowserContext === 'function') {
    context = await browser.createIncognitoBrowserContext();
  } else if (typeof browser.createBrowserContext === 'function') {
    context = await browser.createBrowserContext({ incognito: true });
  }
  const page = context && typeof context.newPage === 'function'
    ? await context.newPage()
    : await browser.newPage();
  return { context, page };
}

// ---- wait for CDNplayer + M3U8 readiness ----
async function waitForPlayer(page, timeout = 8000) {
  await page.waitForFunction('typeof CDNplayer !== "undefined"', { timeout });
  ndjson('info', { msg: 'CDNplayer found at start' });
}
async function waitForM3U8(page, timeout = 8000) {
  // ждём любой переход сети на .m3u8  (через CDP у нас тоже ловится, но тут – «верхнеуровневая» гарантия)
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ndjson('playlist', { status: 'M3U8_TIMEOUT' });
        resolve(false);
      }
    }, timeout);
    const onReq = req => {
      const u = req.url();
      if (/\.m3u8(\?|$)/i.test(u)) {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          ndjson('playlist', { status: 'M3U8_OK' });
          resolve(true);
        }
      }
    };
    page.on('request', onReq);
    // safety detach
    setTimeout(() => page.off('request', onReq), timeout + 1000);
  });
}

// ---- app ----
const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

let browserSingleton = null;
async function getBrowser() {
  if (browserSingleton) return browserSingleton;
  browserSingleton = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return browserSingleton;
}

app.get('/run', async (req, res) => {
  const url = req.query.url;
  const testParam = req.query.test;
  const title = req.query.title || '';

  if (!url || !testParam) {
    res.status(400).end('Missing URL or test parameter');
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

//   res.status(202).end();


  // отправка SSE-строки
  const sse = (event, payload) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`);

  // метаданные прогона
  const metrics = {
    test_start: nowIso(),
    test_finish: '',
    test_type: testParam,
    item_title: title,
    item_direct_id: '',
    item_kp_id: '',
    expected_quality: null,
    delivered_quality: '',
    test_status: 'IN PROGRESS',
    adv_shown: 0,
    requests: 0,
    suspiciousRequests: [],
  };

  // попробуем вытащить item_id из пути (как у тебя было)
  try {
    const kinopoiskMatch = url.match(/kinopoisk\/(\d+)/);
    const directMatch = url.match(/show\/(\d+)/);
    if (kinopoiskMatch) metrics.item_kp_id = kinopoiskMatch[1];
    if (directMatch) metrics.item_direct_id = directMatch[1];
  } catch { /* noop */ }

  // ожидаемое качество из inner url
  metrics.expected_quality = getExpectedQualityFromUrl(url) ?? null;

  // парсим параметр теста
  let firstDuration = 0, secondDuration = 0, rewind = false;
  try {
    ({ firstDuration, secondDuration, rewind } = parseTestParam(testParam));
    ndjson('info', { msg: rewind ? `Start ${firstDuration/60000}min - fwd - ${secondDuration/60000}min` : `Start ${firstDuration/60000}min` });
  } catch (e) {
    ndjson('error', { msg: e.message });
    res.status(400).end(e.message);
    return;
  }

  const agg = makeAgg();

  let context = null, page = null, client = null;
  let m3u8Loaded = false;
  let detectedQuality = null;

  // карты для CDP-метрик
  const reqMeta = new Map(); // requestId -> {url, start, ttfb_ms, headers, entrypoint, router}

  try {
    const browser = await getBrowser();
    ({ context, page } = await getContextAndPage(browser));

    // -- CDP
    client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.requestWillBeSent', (e) => {
      const { requestId, request, wallTime } = e;
      const url2 = request?.url || '';
      // запомним старт (мс)
      reqMeta.set(requestId, {
        url: url2,
        start: wallTime ? wallTime * 1000 : Date.now(),
        ttfb_ms: null,
        headers: null,
        // будем позже заполнять entrypoint/router из логов, если сумеем
        entrypoint: null,
        router: null,
      });
    });

    client.on('Network.responseReceived', (e) => {
      const meta = reqMeta.get(e.requestId);
      if (!meta) return;
      // приблизительный TTFB
      const t = e.response?.timing;
      if (t && typeof t.receiveHeadersEnd === 'number' && typeof t.requestTime === 'number') {
        // requestTime — seconds, receiveHeadersEnd — ms с начала запроса
        // приведём к ms относительно wall clock:
        meta.ttfb_ms = t.receiveHeadersEnd;
      }
      meta.headers = e.response?.headers || null;
    });

    client.on('Network.loadingFinished', async (e) => {
      const meta = reqMeta.get(e.requestId);
      if (!meta) return;
      const url2 = meta.url || '';
      const encodedBytes = e.encodedDataLength || 0;

      // total_ms — от старта до окончания
      const total_ms = meta.start ? Date.now() - meta.start : null;
      const durSec = total_ms ? total_ms / 1000 : 0;

      // ттfb (мс)
      const ttfb_ms = meta.ttfb_ms != null ? meta.ttfb_ms : null;

      // качество
      const q = qualityFromUrl(url2);
      if (q && !detectedQuality) {
        detectedQuality = q;
        metrics.delivered_quality = detectedQuality;
        ndjson('quality', { detected: detectedQuality });
      }

      if (/\.m3u8(\?|$)/i.test(url2)) {
        m3u8Loaded = true;
        if (!agg.firstM3u8At) agg.firstM3u8At = Date.now();
      }
      const isTS = /\.ts(\?|$)/i.test(url2);
      if (isTS && !agg.firstTsAt) agg.firstTsAt = Date.now();

      // считать только media
      if (!isMediaUrl(url2)) return;

      // скорость
      const mbps = durSec > 0 ? (encodedBytes * 8) / (durSec * 1_000_000) : null;
      const size_mb = +(encodedBytes / 1048576).toFixed(3);

      let statusTag = 'OK';
      if (!/\.m3u8(\?|$)/i.test(url2) && !/\.mp4$/i.test(url2)) {
        if (mbps != null && mbps < SLOW_THRESHOLD_MBPS) statusTag = 'SLOW';
      }

      // аккумулируем агрегаты
      agg.total += 1;
      agg.bytes += encodedBytes;
      agg.seconds += durSec;
      if (statusTag === 'SLOW') agg.slow += 1; else agg.ok += 1;
      if (ttfb_ms != null) agg.ttfb_ms.push(ttfb_ms);
      if (total_ms != null) agg.total_ms.push(total_ms);

      // попытаемся из URL вытащить entrypoint/router (если есть)
      // часто Traefik access-лог содержит их, но сюда залетает CDN-URL.
      // Тогда просто не ставим entrypoint/router.
      // Если твои URL содержат entrypoint — добавь сюда парсер.
      const entrypoint = meta.entrypoint || null;
      const router = meta.router || null;

      bumpMap(agg.byEntrypoint, entrypoint, encodedBytes);
      bumpMap(agg.byRouter, router, encodedBytes);

      metrics.requests += 1;

      // prom metrics
      if (isMediaUrl(url2)) {
        mediaRequestsTotal.inc({ status: statusTag === 'SLOW' ? 'SLOW' : 'OK' });
        mediaBytesTotal.inc(encodedBytes);
        if (ttfb_ms != null) ttfbMsHist.observe(ttfb_ms);
        if (total_ms != null) totalMsHist.observe(total_ms);
        if (mbps != null) mediaMbpsHist.observe(mbps);
      }

      // в SSE — каждую медиа-запись
      sse('', {
        url: url2,
        type: 'request',
        http: 200, // на уровне CDP «finished» => ok
        status: statusTag,
        mbps: mbps != null ? +mbps.toFixed(4) : null,
        size_mb,
        ttfb_ms,
        total_ms: total_ms != null ? +total_ms.toFixed(1) : null,
      });

      ndjson('request', {
        url: url2,
        http: 200,
        status: statusTag,
        mbps: mbps != null ? +mbps.toFixed(4) : null,
        size_mb,
        ttfb_ms,
        total_ms: total_ms != null ? +total_ms.toFixed(1) : null,
      });
    });

    client.on('Network.loadingFailed', (e) => {
      const meta = reqMeta.get(e.requestId);
      const url2 = meta?.url || '';
      if (!isMediaUrl(url2)) return;
      agg.failed += 1;
      metrics.suspiciousRequests.push({
        url: url2,
        type: 'request',
        status: 'FAILED',
        reason: e.errorText || 'unknown',
      });

      if (isMediaUrl(url2)) {
        mediaRequestsTotal.inc({ status: 'FAILED' });
      }

      sse('', { url: url2, type: 'request', status: 'FAILED', reason: e.errorText || 'unknown' });
      ndjson('request', { url: url2, status: 'FAILED', reason: e.errorText || 'unknown' });
    });

    // --- основная логика прогона ---
    // 1. грузим страницу (быстрый DOM)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // 2. ждём появление CDNplayer
    await waitForPlayer(page);

    // 3. дожидаемся m3u8
    await waitForM3U8(page);
    if (!m3u8Loaded) {
      metrics.test_status = 'M3U8_NOT_LOADED';
      sse('', { url, type: 'playlist', status: 'M3U8_NOT_LOADED' });
      ndjson('playlist', { status: 'M3U8_NOT_LOADED' });
    }

    // 4. подождать фазу №1
    if (firstDuration > 0) {
      await new Promise(r => setTimeout(r, firstDuration));
    }

    // 5. если нужно — «перемотка» в середину и фаза №2
    if (rewind) {
      try {
        await page.waitForFunction('typeof CDNplayer !== "undefined"', { timeout: 5000 });
        await page.evaluate(() => {
          const dur = CDNplayer?.api?.('duration');
          if (dur && dur > 0) {
            CDNplayer.api('seek', dur / 2);
            CDNplayer.api('play');
          }
        });
        ndjson('info', { msg: 'FWD - OK' });
      } catch {
        ndjson('info', { msg: 'FWD Failed. CDNplayer.api not reached' });
      }
      if (secondDuration > 0) {
        await new Promise(r => setTimeout(r, secondDuration));
      }
    }

    metrics.test_finish = nowIso();
    metrics.test_status = 'FINISHED';

  } catch (e) {
    ndjson('error', { msg: e.message || String(e) });
    metrics.test_finish = nowIso();
    metrics.test_status = 'ERROR';
  } finally {
    // --- финальная сводка ---
    const avgMbps = agg.seconds > 0 ? (agg.bytes * 8) / (agg.seconds * 1_000_000) : null;
    const ttfm3u8_ms = agg.firstM3u8At ? (agg.firstM3u8At - agg.startedAt) : null;
    const ttfseg_ms = agg.firstTsAt ? (agg.firstTsAt - agg.startedAt) : null;
    const slowPct = agg.total > 0 ? +(agg.slow * 100 / agg.total).toFixed(2) : 0;

    const summary = {
      requests_total: agg.total,
      requests_ok: agg.ok,
      requests_slow: agg.slow,
      requests_failed: agg.failed,
      bytes_mb: +(agg.bytes / 1048576).toFixed(3),
      duration_sum_sec: +agg.seconds.toFixed(3),
      avg_mbps: avgMbps ? +avgMbps.toFixed(3) : null,
      ttfm3u8_ms,
      ttfseg_ms,
      slow_percent: slowPct,
      p50_ttfb_ms: percentile(agg.ttfb_ms, 0.5),
      p90_ttfb_ms: percentile(agg.ttfb_ms, 0.9),
      p50_total_ms: percentile(agg.total_ms, 0.5),
      p90_total_ms: percentile(agg.total_ms, 0.9),
      top_entrypoint_by_bytes: topNFromMap(agg.byEntrypoint, TOP_N),
      top_router_by_bytes: topNFromMap(agg.byRouter, TOP_N),
      quality_expected: metrics.expected_quality ?? null,
      quality_detected: metrics.delivered_quality ?? null,
      quality_ok: (metrics.expected_quality && metrics.delivered_quality)
        ? metrics.delivered_quality >= metrics.expected_quality
        : null,
    };

    // Gauges для последнего прогона
    if (ttfm3u8_ms != null) ttfm3u8Gauge.set(ttfm3u8_ms);
    if (ttfseg_ms  != null) ttfsegGauge.set(ttfseg_ms);
    slowPercentGauge.set(slowPct);

    // Счётчик прогонов по результату
    testRunsTotal.inc({ result: metrics.test_status || 'UNKNOWN' });

    // Сравнение качества (если было)
    if (summary.quality_ok !== null) {
      qualityCompareTotal.inc({ ok: String(!!summary.quality_ok) });
    }

    ndjson('summary', summary);
    sse('summary', summary);

    // итоговые метрики в NDJSON (как и раньше)
    ndjson('metrics', metrics);
    sse('done', {
      ...metrics,
      // test_status в финальном done — какой есть (FINISHED/ERROR/M3U8_NOT_LOADED и т.п.)
    });

    // Грейсфул закрытие страницы/контекста
    try { await page?.close(); } catch {}
    try { if (context && typeof context.close === 'function') await context.close(); } catch {}
    // Не закрываем browserSingleton — переиспользуем
    res.end();
  }
});

app.get('/', (_req, res) => {
  res.status(200).send('Puppeteer NDJSON tester is alive.\nUse GET /run?test=5 or 5r5&title=...&url=<ENCODED_URL>');
});

// --- Healthcheck endpoint для Kubernetes probes ---
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.get('/metrics', async (_req, res) => {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(String(err || 'metrics error'));
  }
});

app.listen(PORT, () => {
  ndjson('info', { msg: `Puppeteer NDJSON tester running at http://0.0.0.0:${PORT}` });
});