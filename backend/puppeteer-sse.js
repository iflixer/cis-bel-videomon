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
const logFile = path.join(__dirname, 'puppeteer-tests.log');

let itemKey = 'item_id'; // default log key
function logRow(row, itemId, itemKey) {
    const line = `[event_type = chunk | ${itemKey}=${itemId} | ${row.status} | ${row.url} | ${row.mbps ?? 'N/A'} | ${row.size ?? 'N/A'} | ${row.reason ?? 'DONE' } | ${new Date().toISOString()}]\n`;
    fs.appendFile(logFile, line, err => {
        if (err) console.error('Log write error:', err);
    });
}

function logStart(row, itemId, itemKey) {
    const line = `[event_type = Start test | "${row.title ?? 'No title' }" | expected_quality = ${row.expected_quality} | test_type = ${row.test_type} | ${itemKey} = ${itemId} | ${new Date().toISOString()}]\n`;
    fs.appendFile(logFile, line, err => {
        if (err) console.error('Log write error:', err);
    });
}

function logEvent(row, itemId, itemKey) {
    const line = `[event_type = ${row.event_type} | "${row.title ?? 'No title' }" | ${itemKey}=${itemId} | ${new Date().toISOString()}]\n`;
    fs.appendFile(logFile, line, err => {
        if (err) console.error('Log write error:', err);
    });
}


app.get('/run', async (req, res) => {
    const url = req.query.url;
    let inparams = new URL(url).searchParams;
    let itemId = '';
    const kinopoiskMatch = url.match(/kinopoisk\/(\d+)/);
    const directMatch = url.match(/show\/(\d+)/);
    if (kinopoiskMatch) {
        itemKey = 'kp_item_id';
        itemId = kinopoiskMatch[1];
    } else if (directMatch) {
        itemId = directMatch[1];
        itemKey = 'direct_item_id';
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


    const stData = {
        title: title,
        test_type: testParam,
        expected_quality: monqValue,
    };

    // Write all rows to log
    logStart(stData, itemId, itemKey);


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

    const slowThresholdMbps = 1;
    const metrics = {requests: [], slowNodes: []};

    const isMedia = u => /\.(mp4|m3u8|ts)(\?.*)?$/i.test(u);

    let m3u8Loaded = false;


    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
    const page = await browser.newPage();
    var urlavail = false;

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

            // Write all rows to log
            logRow(reqData, itemId, itemKey);
            res.write(`data: ${JSON.stringify(reqData)}\n\n`);


            //  If 5xx → stop the test
            if (statusCode && statusCode >= 500 && statusCode < 600) {
                const eData = {
                    title: title,
                    event_type: `Test finished with server error ${statusCode}`,
                };
                logEvent(eData, itemId, itemKey);
                const endDataSF = {
                    title: title,
                    event_type: 'Test finished',
                };
                logEvent(endDataSF, itemId, itemKey);
                res.write(`event: done\ndata: ${JSON.stringify({ error: `Server error ${statusCode}` })}\n\n`);
                res.end();
                await browser.close();
                restartCronRunner();   // <-- restart cron-runner
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
        } catch (err) {
            console.log('CDNplayer not found, stopping test');
            const eData = {
                event_type: 'Test Failed, CDNplayer not found, fallback player triggered',
            };
            // Write fail event to log
            logEvent(eData, itemId, itemKey);

            const endDataF = {
                title: title,
                event_type: 'Test finished',
            };
            logEvent(endDataF, itemId, itemKey);

            // Send SSE final event
            res.write(`event: done\ndata: ${JSON.stringify({error: "Fail, fallback player"})}\n\n`);
            res.end();

            await browser.close();
            restartCronRunner();   // <-- restart cron-runner
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
            try {
                const response = await req.response();
                if (response) {
                    const headers = response.headers();
                    sizeBytes = parseInt(headers['content-length'] || '0', 10);
                    const durationMs = Date.now() - req._startTime;
                    const durationSec = durationMs / 1000;
                    if (sizeBytes > 0 && durationMs > 0) {
                        mbps = (sizeBytes * 8) / (durationSec * 1_000_000); // Mbps
                    }
                }
            } catch (e) {
                console.log('Speed calculation error', e);
            }

            let status = 'OK';

            // Only apply "SLOW" to .ts and .mp4, not .m3u8
            if (!/\.m3u8/i.test(rUrl) && mbps !== null && mbps < slowThresholdMbps) {
                status = 'SLOW';
            }

            // Exception for .mp4 partial loads
            if (/\.mp4/i.test(rUrl) && (status === 'FAILED' || status === 'PARTIAL')) {
                status = 'PART';
            }
            if (/\.mp4$/i.test(rUrl) && status === 'OK') {
                const adData = {
                    title: title,
                    event_type: 'adv_show',
                };

                // Write all rows to log
                logEvent(adData, itemId, itemKey);
            }

            const reqData = {
                url: rUrl,
                type: req.resourceType(),
                status,
                mbps: mbps ? mbps.toFixed(4) : '',
                size: sizeBytes ? sizeBytes : 'n/a'
            };

            metrics.requests.push(reqData);
            if (status !== 'OK') {
                metrics.slowNodes.push(reqData);
            }

            // Write all rows to log
            logRow(reqData, itemId, itemKey);

            res.write(`data: ${JSON.stringify(reqData)}\n\n`);
        });

        page.on('requestfailed', req => {
            const rUrl = req.url();
            if (!isMedia(rUrl)) return;

            let status = 'FAILED';
            // If it's mp4, mark as PART
            if (/\.mp4/i.test(rUrl)) {
                status = 'PART';
            }

            const reqData = {
                url: rUrl,
                type: req.resourceType(),
                status,
                mbps: '',
                size: '',
                reason: req.failure() ? req.failure().errorText : 'unknown'
            };

            metrics.requests.push(reqData);
            metrics.slowNodes.push(reqData);

            // Write all rows to log
            logRow(reqData, itemId, itemKey);

            res.write(`data: ${JSON.stringify(reqData)}\n\n`);
        });

        await page.goto(url, {waitUntil: 'networkidle2'});

        await new Promise(r => setTimeout(r, firstDuration));

        if (rewind) {
            console.log('Try rwd');
            await page.waitForFunction('typeof CDNplayer !== "undefined"', {timeout: 5000});
            console.log('CDNplayer found!');
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
                console.log('Player API data:', playerStatus);
                const eData = {
                    title: title,
                    event_type: 'Seek to middle',
                };

                // Write all rows to log
                logEvent(eData, itemId, itemKey);

            } else {
                console.log('CDNplayer.api not available');
            }
            // Phase 2
            await new Promise(r => setTimeout(r, secondDuration));
        }
        await browser.close();

        // If no .m3u8 ever loaded, log warning
        if (!m3u8Loaded) {
            const warn = {url, type: 'playlist', status: 'M3U8_NOT_LOADED'};
            metrics.requests.push(warn);
            metrics.slowNodes.push(warn);
            logRow(warn, itemId);
            res.write(`data: ${JSON.stringify(warn)}\n\n`);
        }
    }

    // Send final event
    res.write(`event: done\ndata: ${JSON.stringify(metrics)}\n\n`);
    const endData = {
        title: title,
        event_type: 'Test finished',
    };

    // Write all rows to log
    logEvent(endData, itemId, itemKey);
    res.end();
});

function writeRow(row, res) {
    const line = JSON.stringify(row);
    fs.appendFileSync(logFile, line + "\n");
    res.write(`data: ${line}\n\n`);
}

app.listen(port, () => console.log(`Puppeteer SSE server running at http://localhost:${port}`));
