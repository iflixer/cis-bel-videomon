<?php
namespace App;

class TestRunner
{
    public static function run(string $url): array
    {
        $escapedUrl = escapeshellarg($url);
        $cmd = "node " . escapeshellarg(__DIR__ . "/../backend/puppeteer-runner.js") . " $escapedUrl 2>&1";
        $output = shell_exec($cmd);
        if (!$output) return ['error' => 'No output from Puppeteer. Check Node/Puppeteer: ' . $cmd];

        $data = json_decode($output, true);
        if (!$data) return ['error' => 'Invalid JSON output', 'raw_output'=>$output];

        return $data;
    }
}
