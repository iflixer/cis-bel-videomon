const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
const port = 3001;

// Allow cross-origin requests from PHP frontend
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/run', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing URL');

    const slowThresholdMbps = 1;
    const metrics = { requests: [], slowNodes: [] };

    const isMedia = u => /\.(mp4|m3u8|ts)(\?.*)?$/i.test(u);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();

    page.on('request', req => {
        const url = req.url();
        if (!isMedia(url)) return;
        req._startTime = Date.now();
    });

    page.on('requestfinished', async req => {
        const url = req.url();
        if (!isMedia(url)) return;

        let mbps = null;
        let sizeStr = '';
        let status = 'OK';

        try {
            const response = await req.response();
            if (response) {
                const headers = response.headers();
                const sizeBytes = parseInt(headers['content-length'] || '0', 10);
                const durationMs = Date.now() - req._startTime;
                const durationSec = durationMs / 1000;

                if (sizeBytes > 0 && durationSec > 0) {
                    mbps = (sizeBytes * 8) / (durationSec * 1_000_000);
                }
                if (sizeBytes > 0) {
                    sizeStr = sizeBytes >= 1024 * 1024
                        ? (sizeBytes / 1024 / 1024).toFixed(2) + ' MB'
                        : (sizeBytes / 1024).toFixed(1) + ' KB';
                }

                if (response.status() === 206) {
                    status = 'PARTIAL';
                } else if (mbps !== null && mbps < slowThresholdMbps) {
                    status = 'SLOW';
                }
            }
        } catch (e) {
            console.log('Speed calculation error', e);
            status = 'FAILED';
        }

        // ✅ Special rule: if MP4 and status is FAILED or PARTIAL → force to PART
        if (url.endsWith('.mp4') && (status === 'FAILED' || status === 'PARTIAL')) {
            status = 'PART';
        }

        const reqData = {
            url,
            type: req.resourceType(),
            status,
            mbps: mbps ? mbps.toFixed(4) : '',
            size: sizeStr
        };

        metrics.requests.push(reqData);
        if (status === 'SLOW' || status === 'FAILED') metrics.slowNodes.push(reqData);

        res.write(`data: ${JSON.stringify(reqData)}\n\n`);
    });

    page.on('requestfailed', req => {
        const rUrl = req.url();
        if (!isMedia(rUrl)) return;

        let status = 'FAILED';

        // ✅ Special rule: if MP4 → show PART instead of FAILED
        if (rUrl.endsWith('.mp4')) {
            status = 'PART';
        }

        const reqData = {
            url: rUrl,
            type: req.resourceType(),
            status,
            mbps: '',
            size: '',
            reason: req.failure()
        };
        metrics.requests.push(reqData);
        metrics.slowNodes.push(reqData);
        res.write(`data: ${JSON.stringify(reqData)}\n\n`);
    });

    await page.goto(url, { waitUntil: 'networkidle2' });

    // Monitor 5 minutes
    await new Promise(r => setTimeout(r, 300_000));
    await browser.close();

    res.write(`event: done\ndata: ${JSON.stringify(metrics)}\n\n`);
    res.end();
});

app.listen(port, () => console.log(`Puppeteer SSE server running at http://localhost:${port}`));
