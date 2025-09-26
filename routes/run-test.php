<?php
// run-test.php
// /routes/run-test.php
header('Content-Type: text/event-stream');
header('Cache-Control: no-cache');
header('Connection: keep-alive');

// open SSE to Node.js server
$nodeUrl = "http://localhost:3001/run?url=" . urlencode($_GET['url']);
$ch = curl_init($nodeUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function($ch, $data) {
    echo $data;
    ob_flush();
    flush();
    return strlen($data);
});
curl_exec($ch);
curl_close($ch);
