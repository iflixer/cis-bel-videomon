External videoplayer QoE tool

1. npm install 
2. cd backend 
3. npm install puppeteer express node-fetch child_process
4. cd..
5. npm run start  // start both back and front (no cron) | Front tests: localhost:8000
6. npm run cronback  // start back with cron runner | CRON TEST CONFIG: backend/cron-runner.js


--------------------------
Start backend only:
node backend/puppeteer-sse.js
node backend/cron-runner.js

--------------------------

Frontend: localhost:8000
Backend: localhost:3001
Backend cron port: 3100

--------------------------

Backend direct test: http://localhost:3001/run?test=3r3&title=MovieTitle&url=<encoded_player_url>

Sample:
http://localhost:3001/run?test=3r3&title=MovieTitle&url=https%3A%2F%2Fcdn0.cdnhub.help%2Fshow%2Fkinopoisk%2F893621%3Fdomain%3Dpiratka.me%26autoplay%3D1%26monq%3D1080

Params:
&test=10   // Just play 10 minutes from start
&test=3r3  // 3 minutes at start, fast forward to the middle and 3 minutes
&test=5r5  // 5 minutes, fast forward + 5 minutes etc..

&monq = 1080 // desired quality (1080, 720, 480, 360, 240) if not set - default = 360
