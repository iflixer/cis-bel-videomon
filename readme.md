External videoplayer QoE tool

1. npm install 
2. cd backend 
3. npm install puppeteer express node-fetch child_process
4. cd..
5. npm run start  // Manual tests - start back and front (no cron) 
6. npm run cronback  // start back with cron runner | CRON TEST CONFIG: backend/cron-runner.js

--------------------------
Start backend separately:

node backend/puppeteer-sse.js
node backend/cron-runner.js

--------------------------

Frontend (Manual tests): localhost:8000  // Sample url for test: https://cdn0.cdnhub.help/show/kinopoisk/766363 
Backend: localhost:3001
Backend cron port: 3100

--------------------------
Tests Log:
backend/puppeteer-tests.json


