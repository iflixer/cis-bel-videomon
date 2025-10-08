<?php
declare(strict_types=1);

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$route = trim($uri, '/');

switch($route) {
    case '':
        require __DIR__ . '/views/home.php';
        break;
    case 'results':
        require __DIR__ . '/../routes/results.php';
        break;
    default:
        http_response_code(404);
        echo "<h1>404 Not Found</h1>";
        break;
}
