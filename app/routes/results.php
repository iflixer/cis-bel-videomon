<?php
header('Content-Type: application/json');
$file = __DIR__ . '/../storage/results.json';
if (!file_exists($file)) { echo json_encode(['error'=>'No results yet']); exit; }
echo file_get_contents($file);
