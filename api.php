<?php
declare(strict_types=1);

/**
 * Welearn Helper · 最小代理接口
 * ------------------------------------------------------------------
 * 浏览器端所有跨域请求都交给这个文件转发，只允许：
 *   - welearn.sflep.com
 *   - sso.sflep.com
 * 因此它不会被当成公开代理使用。
 *
 * 请求体（JSON）：
 *   { "action": "proxy", "url": "https://...", "method": "GET",
 *     "body": "", "headers": {...}, "cookie": "k=v; k2=v2" }
 * 响应（JSON）：
 *   { "status": 200, "body": "...", "headers": {...}, "newCookies": [...] }
 *
 * 不需要数据库，不需要 data 目录。
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');

// 任何 PHP 警告都不能混进 JSON 响应
ini_set('display_errors', '0');
error_reporting(E_ALL);

date_default_timezone_set('Asia/Shanghai');
@set_time_limit(75);

const ALLOWED_HOSTS = ['welearn.sflep.com', 'sso.sflep.com'];
const MAX_BODY = 1048576;   // 1 MB

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function fail(string $message, int $status = 400): void
{
    respond(['error' => $message], $status);
}

$rawInput = file_get_contents('php://input');
$input = is_string($rawInput) && $rawInput !== '' ? json_decode($rawInput, true) : null;
if (!is_array($input)) {
    fail('请求体不是合法 JSON');
}

$action = isset($input['action']) && is_string($input['action']) ? $input['action'] : 'proxy';
if ($action !== 'proxy') {
    fail('未知动作');
}

$url = isset($input['url']) && is_string($input['url']) ? trim($input['url']) : '';
$parts = parse_url($url);
if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
    fail('目标地址无效');
}

$scheme = strtolower((string) $parts['scheme']);
$host = strtolower((string) $parts['host']);

if (!in_array($host, ALLOWED_HOSTS, true)) {
    fail('目标域名不在允许列表内', 403);
}

/* 学校登录回调可能是 http://welearn.sflep.com/...，统一升级到 https，
   既保留 https-only 的安全约束，又不会让登录链路断掉。 */
if ($scheme === 'http') {
    $url = 'https://' . substr($url, strlen('http://'));
    $scheme = 'https';
}
if ($scheme !== 'https') {
    fail('仅支持 https 目标地址');
}
if (strlen($url) > 2048) {
    fail('目标地址过长');
}

$method = isset($input['method']) && is_string($input['method']) ? strtoupper($input['method']) : 'GET';
if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], true)) {
    $method = 'GET';
}

$body = isset($input['body']) && is_scalar($input['body']) ? (string) $input['body'] : '';
if (strlen($body) > MAX_BODY) {
    fail('请求体过大', 413);
}

$headersIn = isset($input['headers']) && is_array($input['headers']) ? $input['headers'] : [];
$cookie = isset($input['cookie']) && is_string($input['cookie']) ? $input['cookie'] : '';

$curlHeaders = [];
foreach ($headersIn as $key => $value) {
    if (!is_string($key) || $key === '' || !is_scalar($value)) {
        continue;
    }
    $name = trim($key);
    $val = (string) $value;
    if ($name === '' || preg_match('/[\r\n:]/', $name)) {
        continue;
    }
    if (in_array(strtolower($name), ['host', 'content-length', 'cookie', 'connection', 'accept-encoding'], true)) {
        continue;
    }
    if (preg_match('/[\r\n]/', $val)) {
        continue;
    }
    $curlHeaders[] = $name . ': ' . $val;
}
if ($cookie !== '' && !preg_match('/[\r\n]/', $cookie)) {
    $curlHeaders[] = 'Cookie: ' . $cookie;
}

$responseHeaders = [];
$setCookies = [];

$headerFn = function ($ch, string $line) use (&$responseHeaders, &$setCookies): int {
    $length = strlen($line);
    $trimmed = trim($line);
    if ($trimmed === '') {
        return $length;
    }
    if (strncasecmp($trimmed, 'HTTP/', 5) === 0) {
        $responseHeaders = [];
        return $length;
    }
    $pos = strpos($trimmed, ':');
    if ($pos === false) {
        return $length;
    }
    $name = strtolower(trim(substr($trimmed, 0, $pos)));
    $value = trim(substr($trimmed, $pos + 1));
    if ($name === 'set-cookie') {
        $setCookies[] = $value;
    } else {
        $responseHeaders[$name] = $value;
    }
    return $length;
};

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $url,
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER => false,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT => 60,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => 0,
    CURLOPT_ENCODING => '',
    CURLOPT_HTTPHEADER => $curlHeaders,
    CURLOPT_HEADERFUNCTION => $headerFn,
    // 统一使用现代浏览器 UA，避免个别客户端 UA 触发学校 WAF 的 405
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        . '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]);

if (in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}
if ($method === 'HEAD') {
    curl_setopt($ch, CURLOPT_NOBODY, true);
}

$responseBody = curl_exec($ch);
$errno = curl_errno($ch);
$error = curl_error($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($responseBody === false || $errno !== 0) {
    fail('上游请求失败：' . $error, 502);
}

$newCookies = [];
foreach ($setCookies as $cookieLine) {
    $first = explode(';', $cookieLine, 2)[0];
    if (strpos($first, '=') === false) {
        continue;
    }
    [$name, $value] = explode('=', $first, 2);
    $name = trim($name);
    if ($name === '') {
        continue;
    }
    $newCookies[$name] = $name . '=' . trim($value);
}

respond([
    'status' => $status,
    'body' => (string) $responseBody,
    'headers' => $responseHeaders,
    'newCookies' => array_values($newCookies),
]);
