<h1>Live Video Monitor</h1>

<form id="testForm">
    <input type="text" name="url" placeholder="Video URL" size="60">
    <select name="testtype">
        <option value="1">1 min</option>
        <option value="3">3 min</option>
        <option value="5">5 min</option>
        <option value="1r1">1m-r-1m</option>
        <option value="2r2">2m-r-2m</option>
        <option value="3r3">3m-r-3m</option>
        <option value="5r5">5m-r-5m</option>
    </select>
    <select name="quality">
        <option value="1080">1080</option>
        <option value="720">720</option>
        <option value="480">480</option>
        <option value="360">360</option>
        <option value="240">240</option>
    </select>
    <button type="submit">Run Test</button>
</form>

<p>Time Remaining: <span id="timer">00:00</span></p>

<h3>Requests:</h3>
<table border="1" id="requestsTable" style="width:100%; border-collapse: collapse;">
    <thead>
    <tr>
        <th>URL</th>
        <th>Type</th>
        <th>Status</th>
        <th>Speed (Mbps)</th>
        <th>Size (Mb)</th>
    </tr>
    </thead>
    <tbody></tbody>
</table>

<p id="alerts"></p>

<script>
    const form = document.getElementById('testForm');
    const timerEl = document.getElementById('timer');
    const alertsEl = document.getElementById('alerts');
    const tbody = document.querySelector('#requestsTable tbody');
    let timerInterval;

    function textToInt(text) {
        return text
            .split('r')
            .map(Number)      // convert each part to integer
            .reduce((a, b) => a + b, 0); // sum all numbers
    }


    form.addEventListener('submit', async e => {
        e.preventDefault();
        const url = form.url.value.trim();
        const testtype = form.testtype.value;
        const quality = form.quality.value;
        if (!url) return;

        tbody.innerHTML = '';
        alertsEl.innerHTML = '';
        clearInterval(timerInterval);

        // SET countdown
        var advtimeout = 30;
        if(testtype.length > 2){
            advtimeout = 60;
        }
        var tout = textToInt(testtype);
        let secondsRemaining = tout * 60 + advtimeout;
        timerEl.textContent = formatTime(secondsRemaining);
        timerInterval = setInterval(() => {
            secondsRemaining--;
            timerEl.textContent = formatTime(secondsRemaining);
            if (secondsRemaining <= 0) clearInterval(timerInterval);
        }, 1000);

        try {
            // Test URL availability first
            const testResp = await fetch(url, {method: 'HEAD', mode: 'no-cors'});
            // If fetch fails, will go to catch
        } catch (err) {
            alertsEl.innerHTML = `<div style="color:red">Error: URL cannot be reached.</div>`;
            clearInterval(timerInterval);
            return;
        }

        // SSE connection
        const sse = new EventSource(`http://localhost:3001/run?test=${testtype}&title=Manual_Test&url=${encodeURIComponent(url)}%3Fdomain%3Dpiratka.me%26autoplay%3D1%26monq%3D${quality}`);

        sse.onmessage = function (event) {
            const r = JSON.parse(event.data);
            const tr = document.createElement('tr');

            let color = 'black';
            if (r.status === 'OK') color = 'green';
            else if (r.status === 'SLOW') color = 'orange';
            else if (r.status === 'FAILED') color = 'red';
            else if (r.status === 'PARTIAL') color = 'blue';
            else if (r.status === 'PART') color = 'purple';

            tr.innerHTML = `
            <td>${r.url}</td>
            <td>${r.type}</td>
            <td style="color:${color}">${r.status}</td>
            <td>${r.mbps || ''}</td>
            <td>${r.size || ''}</td>`;
            tbody.appendChild(tr);
        };

        sse.addEventListener('done', event => {
            clearInterval(timerInterval);
            timerEl.textContent = '0:00';
            const data = JSON.parse(event.data);
            if (data.suspiciousRequests.length) {
                data.suspiciousRequests.forEach(n => {
                    alertsEl.innerHTML += `<div style="color:red">${n.status}: ${n.url} ${n.mbps ?? ''} ${n.reason ?? ''}</div>`;
                });
            } else {
                alertsEl.innerHTML = '<div style="color:green">All movie chunks - OK</div>';
            }
            sse.close();
        });

        sse.onerror = function () {
            alertsEl.innerHTML = `<div style="color:red">Error: SSE connection lost or URL cannot be reached.</div>`;
            sse.close();
            clearInterval(timerInterval);
        };
    });

    function formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }
</script>
