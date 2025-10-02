const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const cron = require('node-cron');

// ---------- Config variables ----------
let config = {
    test: "5r5",             // can be "2", "2r2", "5r5" etc.
    quality: "1080",
    domain: "piratka.me",
    jsonEndpoint: "https://master.futmax.info/test/random_movie",
    serverPort: 3001
};

// ---------- Helper: parse test param into total minutes ----------
function getTestDurationMinutes(testStr) {
    if (!testStr) return 5; // default 5 minutes
    // e.g. "2r2" → [2, 2], "5" → [5]
    const parts = testStr
        .split('r')
        .map(n => parseInt(n, 10))  // <-- decimal, not binary
        .filter(n => !isNaN(n));

    const total = parts.reduce((sum, n) => sum + n, 0);
    console.log("Parsed test duration minutes:", total);
    return total || 5;
}

// ---------- Main Runner ----------
async function runTest() {
    console.log(`[${new Date().toISOString()}] Cron triggered...`);

    try {
        const resp = await fetch(config.jsonEndpoint);
        const data = await resp.json();

        let targetUrl = null;
        if (data.kinopoisk) {
            targetUrl = data.kinopoisk;
        } else if (data.direct) {
            targetUrl = data.direct;
        }

        let itemtitle = data.ru_name+' / '+data.name;

        if (!targetUrl) {
            console.error("No valid URL found in JSON");
            return;
        }

        // Append quality param
        if (config.quality) {
            targetUrl = `${targetUrl}?domain=${config.domain}&autoplay=1&monq=${config.quality}`;
            console.log('Test url: '+targetUrl);
        }

        // Build internal run URL
        const runUrl = `http://localhost:${config.serverPort}/run?test=${config.test}&title=${encodeURIComponent(itemtitle)}&url=${encodeURIComponent(targetUrl)}`;
        console.log("Triggering run:", runUrl);

        await fetch(runUrl);

    } catch (err) {
        console.error("Cron error:", err);
    }

    // Schedule next run dynamically
    const minutes = getTestDurationMinutes(config.test);
    const intervalSec = (minutes * 60) + 120; // 2min gap for adverts
    console.log(`Next run in ${intervalSec} sec...`);

    setTimeout(runTest, intervalSec * 1000);
}

// ---------- Start first run ----------
runTest();

// ---------- API to update config ----------
const express = require('express');
const app = express();
app.use(express.json());

app.post('/cronrun/config', (req, res) => {
    const { test, quality, jsonEndpoint } = req.body;
    if (test) config.test = test;
    if (domain) config.test = domain;
    if (quality) config.quality = quality;
    if (jsonEndpoint) config.jsonEndpoint = jsonEndpoint;
    res.json({ status: "ok", config });
});

app.listen(3100, () => console.log("Cron Runner listening on port 3100"));
