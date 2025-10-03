const puppeteer = require('puppeteer');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3001;


const { exec } = require('child_process');

function restartCronRunner() {
    console.log('Restarting cron-runner.js...');
    exec('pm2 restart cron-runner || node backend/cron-runner.js &', (err, stdout, stderr) => {
        if (err) {
            console.error('Failed to restart cron-runner.js:', err);
        } else {
            console.log('cron-runner.js restarted:', stdout || stderr);
        }
    });
}

// Allow cross-origin requests from PHP frontend
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// Log file
const logFile = path.join(__dirname, 'puppeteer-tests.json');

function logMetrics(metrics) {
    let data = [];
    if (fs.existsSync(logFile)) {
        try {
            const content = fs.readFileSync(logFile, 'utf8');
            if (content.trim()) {
                data = JSON.parse(content);
            }
        } catch (err) {
            console.error('Error parsing JSON log file:', err);
        }
    }
    data.push(metrics);
    fs.writeFileSync(logFile, JSON.stringify(data, null, 2));
}

app.get('/run', async (req, res) => {
    var chunk_count = 0;
    var adv_debounce = false;
    var adv_shown = 0;
    const url = req.query.url;
    let inparams = new URL(url).searchParams;
    let itemId = '';
    let diritemId =  '';
    const kinopoiskMatch = url.match(/kinopoisk\/(\d+)/);
    const directMatch = url.match(/show\/(\d+)/);

    if (kinopoiskMatch) {
        itemId = kinopoiskMatch[1];
    } else if (directMatch) {
        itemId = directMatch[1];
        diritemId =  directMatch[1];
    }
    // Get the specific parameter 'monq'
    let monqValue = inparams.get('monq');
    let title = '';
    if(req.query.title){
        title = req.query.title;
    };


    if (!url) return res.status(400).send('Missing URL');

    // Extract item_id from kinopoisk path

    const testParam = req.query.test;
    if (!url || !testParam) return res.status(400).send('Missing URL or test parameter');

    // Parse test parameter
    let firstDuration = 0;
    let secondDuration = 0;
    let rewind = false;

    if (/^(\d+)r(\d+)$/.test(testParam)) {
        // Example: 5r5 → first 5 minutes, rewind, second 5 minutes
        const [, a, b] = testParam.match(/^(\d+)r(\d+)$/);
        firstDuration = parseInt(a, 10) * 60 * 1000;
        secondDuration = parseInt(b, 10) * 60 * 1000;
        rewind = true;
        console.log('Start ' + a + 'min - fwd - ' + b + 'min');
    } else if (/^\d+$/.test(testParam)) {
        // Example: 5 → run for 5 minutes
        firstDuration = parseInt(testParam, 10) * 60 * 1000;
        console.log('Start ' + testParam + 'min');
    } else {
        return res.status(400).send('Invalid test parameter');
    }

    const slowThresholdMbps = 3;
    const metrics = {test_start:'', test_finish:'',test_type:'',item_title:'',item_direct_id:'', item_kp_id:'',expected_quality:'',delivered_quality:'',test_status:'', adv_shown:'', requests: '', suspiciousRequests: []};

    const isMedia = u => /\.(mp4|m3u8|ts)(\?.*)?$/i.test(u);

    let m3u8Loaded = false;


    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
    const page = await browser.newPage();
    var urlavail = false;
    var qcheck = false;
    var delivered_quality = monqValue;


    metrics.test_status = 'OK';
    metrics.test_start = new Date().toISOString();
    metrics.adv_shown = adv_shown;
    metrics.item_direct_id = diritemId;
    metrics.item_kp_id = itemId;
    metrics.item_title = title;
    metrics.test_type = testParam;
    metrics.expected_quality = parseInt(monqValue);

    try {
        const response = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 10000});

        if (response && response.ok()) {
            urlavail = true;
        } else {
            const statusCode = response ? response.status() : null;
            var badstat = `${response ? response.status() : 'No response'}`;
            console.log(`URL returned status: ${response ? response.status() : 'No response'}`);
            const reqData = {
                url: url,
                type: 'PLAYER',
                status: badstat,
                mbps: 'NULL',
                size: 'NULL'
            };
            res.write(`data: ${JSON.stringify(reqData)}\n\n`);


            //  If 5xx → stop the test
            if (statusCode && statusCode >= 500 && statusCode < 600) {
                const eData = {
                    title: title,
                    event_type: `Test finished with server error ${statusCode}`,
                };
                metrics.test_status = `Test finished with server error ${statusCode}`;

                res.write(`event: done\ndata: ${JSON.stringify({ error: `Server error ${statusCode}` })}\n\n`);
                res.end();
                await browser.close();
                if(title != 'Manual_Test') {
                    restartCronRunner();   // <-- restart cron-runner
                }
                return;
            }



            // If not 5xx, just continue as before
            res.write(`data: ${JSON.stringify(reqData)}\n\n`);

        }
    } catch (error) {
        console.log(`URL is not available. Error: ${error.message}`);
    }

    if (urlavail) {
        await page.goto(url, {waitUntil: 'networkidle2'});
        try {
            await page.waitForFunction('typeof CDNplayer !== "undefined"', {timeout: 5000});
            console.log('CDNplayer found at start');
            metrics.test_status = 'IN PROGRESS';
            console.log(metrics);
        } catch (err) {
            console.log('CDNplayer not found, stopping test');
            metrics.test_status = `Test Failed, CDNplayer not found, fallback player triggered`;

            // Send SSE final event
            res.write(`event: done\ndata: ${JSON.stringify({error: "Fail, fallback player"})}\n\n`);
            res.end();
            await browser.close();
            if(title != 'Manual_Test') {
                restartCronRunner();   // <-- restart cron-runner
            }
            return; // stop test
        }
        await page.goto(url, {waitUntil: 'networkidle2'});

        page.on('request', req => {
            const rUrl = req.url();
            if (!isMedia(rUrl)) return;
            req._startTime = Date.now(); // start timestamp
        });

        page.on('requestfinished', async req => {
            const rUrl = req.url();
            if (!isMedia(rUrl)) return;

            if (/\.m3u8/i.test(rUrl)) {
                // Mark playlist as successfully loaded
                m3u8Loaded = true;
            }

            let mbps = null;
            let sizeBytes = 0;
            let sizeMBytes = 0;
            try {
                const response = await req.response();
                if (response) {
                    const headers = response.headers();
                    sizeBytes = parseInt(headers['content-length'] || '0', 10);
                    sizeMBytes = sizeBytes/1048576;
                    sizeMBytes = sizeMBytes.toFixed(3);
                    const durationMs = Date.now() - req._startTime;
                    const durationSec = durationMs / 1000;
                    if (sizeBytes > 0 && durationMs > 0) {
                        mbps = (sizeBytes * 8) / (durationSec * 1_000_000); // Mbps
                    }
                }
            } catch (e) {
                console.log('Speed calculation error', e);
            }

            const qualityMatch = rUrl.match(/(1080|720|480|360|240)\.mp4:hls/i);
            if (qualityMatch && !qcheck) {
                delivered_quality = parseInt(qualityMatch[1], 10);
                metrics.delivered_quality = delivered_quality;
                qcheck = true;

            }

            let status = 'OK';

            // Only apply "SLOW" to .ts and .mp4, not .m3u8
            if (!/\.m3u8/i.test(rUrl) && !/\.mp4$/i.test(rUrl) && mbps !== null && mbps < slowThresholdMbps) {
                    if (
                        !rUrl.endsWith('.mp4') &&
                        !rUrl.endsWith('.m3u8') &&
                        !rUrl.endsWith('.manifest.m3u8')
                    ) {
                        status = 'SLOW';
                    }
            }


            if (/\.mp4$/i.test(rUrl) && status === 'OK') {
                if(!adv_debounce) {
                    const adData = {
                        title: title,
                        event_type: 'adv_show',
                    };
                    adv_shown = adv_shown + 1;
                    metrics.adv_shown = adv_shown;
                    adv_debounce = true;
                }
            }

            const reqData = {
                url: rUrl,
                type: req.resourceType(),
                status,
                mbps: mbps ? mbps.toFixed(4) : '',
                size: sizeMBytes ? sizeMBytes : 'n/a'
            };

            chunk_count = chunk_count + 1;
            metrics.requests = chunk_count;
            if (status !== 'OK' && /\.mp4:hls/i.test(rUrl)) {
                if (
                    !rUrl.endsWith('.mp4') &&
                    !rUrl.endsWith('.m3u8') &&
                    !rUrl.endsWith('.manifest.m3u8')
                )
                {
                    metrics.suspiciousRequests.push(reqData);
                }
            }

            res.write(`data: ${JSON.stringify(reqData)}\n\n`);
        });

        page.on('requestfailed', req => {
            const rUrl = req.url();
            if (!isMedia(rUrl)) return;

            let status = 'FAILED';

            const reqData = {
                url: rUrl,
                type: req.resourceType(),
                status,
                mbps: '',
                size: '',
                reason: req.failure() ? req.failure().errorText : 'unknown'
            };

            if (
                !rUrl.endsWith('.mp4') &&
                !rUrl.endsWith('.m3u8') &&
                !rUrl.endsWith('.manifest.m3u8')
            ) {
                metrics.suspiciousRequests.push(reqData);
            }

            res.write(`data: ${JSON.stringify(reqData)}\n\n`);
        });

        await page.goto(url, {waitUntil: 'networkidle2'});

        await new Promise(r => setTimeout(r, firstDuration));

        if (rewind) {
            console.log('Try fwd');
            await page.waitForFunction('typeof CDNplayer !== "undefined"', {timeout: 5000});
            const playerStatus = await page.evaluate(() => {
                if (CDNplayer && CDNplayer.api) {
                    // Example: check current time
                    const dur = CDNplayer.api('duration');
                    console.log('Do seek to: ' + dur);

                    if (dur && dur > 0) {
                        CDNplayer.api("seek", dur / 2);
                        CDNplayer.api("play");
                    }
                    return {
                        currentTime: CDNplayer.api('time'),
                        duration: CDNplayer.api('duration')
                    };
                } else {
                    return null;
                }
            });

            if (playerStatus) {
                adv_debounce = false;
                console.log('FWD - OK. Player API data:', playerStatus);
            } else {
                console.log('FWD Failed. CDNplayer.api not reached');
            }
            // Phase 2
            await new Promise(r => setTimeout(r, secondDuration));
        }
        await browser.close();

        // If no .m3u8 ever loaded, log warning
        if (!m3u8Loaded) {
            const warn = {url, type: 'playlist', status: 'M3U8_NOT_LOADED'};
            metrics.suspiciousRequests.push(warn);
            metrics.test_status = 'M3U8_NOT_LOADED';
            res.write(`data: ${JSON.stringify(warn)}\n\n`);
        }
    }

    // Send final event
    res.write(`event: done\ndata: ${JSON.stringify(metrics)}\n\n`);
    metrics.test_finish = new Date().toISOString();
    metrics.test_status = 'FINISHED';
    logMetrics(metrics);
    console.log(metrics);
    res.end();
});

function writeRow(row, res) {
    const line = JSON.stringify(row);
    fs.appendFileSync(logFile, line + "\n");
    res.write(`data: ${line}\n\n`);
}

app.listen(port, () => console.log(`Puppeteer SSE server running at http://localhost:${port}`));
