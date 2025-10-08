External videoplayer QoE tool

```
обновление тега major/minor/patch автоматическое при пуше
если ничего - это patch
например если в комментарии к коммиту есть [major] - увеличится vX.0.0
если [minor] - v.0.X.0
```

запуск для отладки локально
```
npm install 
npm run start  // Manual tests - start back and front (no cron) 
npm run cronback  // start back with cron runner | CRON TEST CONFIG: backend/cron-runner.js
```

запуск в докере
```
docker-compose up
```

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


