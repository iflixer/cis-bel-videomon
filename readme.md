External videoplayer QoE tool

1. npm install 
2. cd backend 
3. npm install puppeteer express
4. cd..
5. npm run start  

// start both back and front

--------------------------
Start backend only:

node backend/puppeteer-sse.js

--------------------------

Frontend: localhost:8000

Backend: localhost:3001

--------------------------

Backend direct test: http://localhost:3001/run?url=<encoded_player_url>

Sample:
http://localhost:3001/run?url=https%3A%2F%2Fcdn0.cdnhub.help%2Fshow%2Fkinopoisk%2F893621%3Fdomain%3Dpiratka.me%26autoplay%3D1%26monq%3D1080