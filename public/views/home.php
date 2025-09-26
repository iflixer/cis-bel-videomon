<h1>Live Video Monitor</h1>

<form id="testForm">
    <input type="text" name="url" placeholder="Video URL" size="60">
    <button type="submit">Run Test</button>
</form>

<p>Time Remaining: <span id="timer">5:00</span></p>

<h3>Requests:</h3>
<table border="1" id="requestsTable" style="width:100%; border-collapse: collapse;">
    <thead>
    <tr>
        <th>URL</th>
        <th>Type</th>
        <th>Status</th>
        <th>Speed (Mbps)</th>
        <th>Size</th>
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

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const url = form.url.value.trim();
        if (!url) return;

        tbody.innerHTML = '';
        alertsEl.innerHTML = '';
        clearInterval(timerInterval);

        // 5-minute countdown
        let secondsRemaining = 5*60;
        timerEl.textContent = formatTime(secondsRemaining);
        timerInterval = setInterval(() => {
            secondsRemaining--;
            timerEl.textContent = formatTime(secondsRemaining);
            if (secondsRemaining <= 0) clearInterval(timerInterval);
        }, 1000);

        try {
            // Test URL availability first
            const testResp = await fetch(url, { method: 'HEAD', mode: 'no-cors' });
            // If fetch fails, will go to catch
        } catch(err) {
            alertsEl.innerHTML = `<div style="color:red">Error: URL cannot be reached.</div>`;
            clearInterval(timerInterval);
            return;
        }

        // SSE connection
        const sse = new EventSource(`http://localhost:3001/run?url=${encodeURIComponent(url)}`);

        sse.onmessage = function(event) {
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
            if (data.slowNodes.length) {
                data.slowNodes.forEach(n => {
                    alertsEl.innerHTML += `<div style="color:red">${n.status}: ${n.url} ${n.mbps??''} ${n.reason??''}</div>`;
                });
            } else {
                alertsEl.innerHTML = '<div style="color:green">All nodes OK</div>';
            }
            sse.close();
        });

        sse.onerror = function() {
            alertsEl.innerHTML = `<div style="color:red">Error: SSE connection lost or URL cannot be reached.</div>`;
            sse.close();
            clearInterval(timerInterval);
        };
    });

    function formatTime(sec){
        const m = Math.floor(sec/60);
        const s = sec%60;
        return `${m}:${s.toString().padStart(2,'0')}`;
    }
</script>
