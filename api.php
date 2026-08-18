<?php
/**
 * 超级嗅探 - PHP 前端解析接口
 *
 * 功能：
 *   接收视频页面链接，转发给 Node.js 解析服务（Puppeteer 抓取），
 *   从返回内容中提取 .m3u8 播放地址并返回 JSON。
 *
 * 使用：
 *   http://你的域名/api.php?url=<视频页面地址>
 *
 * 性能优化（v2.0.0+）：
 *   [1] 支持本地缓存（MX_PHP_CACHE_ENABLE/TLL），相同 URL 在 TTL 内直接返回
 *   [2] cURL 多参数调优（连接复用、压缩、keep-alive）
 *   [3] 如果请求本身就是 .m3u8 地址，直接 302 或原样返回，避免浪费解析资源
 *
 * 环境变量（统一 MX_ 前缀）：
 *   MX_PLAYER_HOST              解析服务地址（如 http://127.0.0.1:1314），兼容旧 PLAYER_HOST
 *   MX_PHP_TIMEOUT              cURL 总超时秒数（默认 30）
 *   MX_PHP_CONNECT_TIMEOUT      cURL 连接超时秒数（默认 3）
 *   MX_PHP_CACHE_ENABLE         是否启用本地缓存（1=开 0=关，默认 1）
 *   MX_PHP_CACHE_TTL            缓存 TTL 秒数（默认 1800）
 *   MX_PHP_CACHE_DIR            缓存目录（默认当前目录下 .mx_cache）
 *   MX_PHP_SSL_VERIFY           是否校验 SSL（1=开 0=关，默认 0）
 *
 * 返回：
 *   {"code":200,"url":"https://.../index.m3u8"}        解析成功
 *   {"code":400,"msg":"请提供需要解析的链接"}             缺少参数
 *   {"code":404,"msg":"未找到播放链接"}                  未找到 m3u8
 *   {"code":500,"msg":"无法获取解析页面"}                解析服务异常
 */

// 设置返回 JSON 格式 & 允许跨域（可选）
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

// ============================================================
// 1. 环境变量加载（MX_ 前缀，兼容旧变量名 fallback）
// ============================================================

/**
 * 读取环境变量（支持 $_ENV / getenv / php.ini）
 * 优先顺序：$_ENV > getenv() > 默认值
 */
function mx_env($key, $legacy = null, $def = '') {
    if (isset($_ENV[$key]) && $_ENV[$key] !== '') return $_ENV[$key];
    $v = getenv($key);
    if ($v !== false && $v !== '') return $v;
    if ($legacy !== null) {
        if (isset($_ENV[$legacy]) && $_ENV[$legacy] !== '') return $_ENV[$legacy];
        $lv = getenv($legacy);
        if ($lv !== false && $lv !== '') return $lv;
    }
    return $def;
}
function mx_env_int($key, $legacy, $def) {
    $v = (int)mx_env($key, $legacy, (string)$def);
    return $v > 0 ? $v : $def;
}
function mx_env_bool($key, $legacy, $def) {
    $v = strtolower((string)mx_env($key, $legacy, $def ? '1' : '0'));
    return in_array($v, ['1', 'true', 'yes', 'on'], true);
}

// ---------- 1.1 解析服务地址 ----------
/** Node.js 解析服务地址（无末尾斜杠） */
$MX_PLAYER_HOST = rtrim((string)mx_env('MX_PLAYER_HOST', 'PLAYER_HOST', 'http://122.51.166.115:1314'), '/');
$MX_PLAYER_URL  = $MX_PLAYER_HOST . '/node.js?url=';

// ---------- 1.2 cURL 超时 ----------
/** cURL 总执行超时（秒） */
$MX_PHP_TIMEOUT = mx_env_int('MX_PHP_TIMEOUT', null, 30);
/** cURL 连接超时（秒） */
$MX_PHP_CONNECT_TIMEOUT = mx_env_int('MX_PHP_CONNECT_TIMEOUT', null, 3);

// ---------- 1.3 缓存配置 ----------
/** 是否启用 PHP 层本地缓存 */
$MX_PHP_CACHE_ENABLE = mx_env_bool('MX_PHP_CACHE_ENABLE', null, true);
/** 缓存 TTL 秒数 */
$MX_PHP_CACHE_TTL = mx_env_int('MX_PHP_CACHE_TTL', null, 1800);
/** 缓存目录 */
$MX_PHP_CACHE_DIR = (string)mx_env('MX_PHP_CACHE_DIR', null, __DIR__ . DIRECTORY_SEPARATOR . '.mx_cache');

// ---------- 1.4 SSL 校验 ----------
/** 是否校验 SSL 证书（内网/自签证书建议关） */
$MX_PHP_SSL_VERIFY = mx_env_bool('MX_PHP_SSL_VERIFY', null, false);

// ============================================================
// 2. 缓存辅助函数
// ============================================================

/** 缓存 key：基于 URL 的 md5（避免文件系统非法字符） */
function mx_cache_key($url) {
    return md5(trim($url));
}
function mx_cache_path($key) {
    global $MX_PHP_CACHE_DIR;
    if (!is_dir($MX_PHP_CACHE_DIR)) {
        @mkdir($MX_PHP_CACHE_DIR, 0755, true);
        // 放一个 index.html 防列目录
        @file_put_contents($MX_PHP_CACHE_DIR . DIRECTORY_SEPARATOR . 'index.html', '');
    }
    return $MX_PHP_CACHE_DIR . DIRECTORY_SEPARATOR . $key . '.json';
}
function mx_cache_get($url) {
    global $MX_PHP_CACHE_ENABLE, $MX_PHP_CACHE_TTL;
    if (!$MX_PHP_CACHE_ENABLE) return null;
    $path = mx_cache_path(mx_cache_key($url));
    if (!is_file($path)) return null;
    $mtime = @filemtime($path);
    if ($mtime === false || (time() - $mtime) > $MX_PHP_CACHE_TTL) {
        @unlink($path);
        return null;
    }
    $data = @file_get_contents($path);
    if ($data === false) return null;
    $arr = @json_decode($data, true);
    if (!is_array($arr)) {
        @unlink($path);
        return null;
    }
    return $arr;
}
function mx_cache_set($url, $resp) {
    global $MX_PHP_CACHE_ENABLE;
    if (!$MX_PHP_CACHE_ENABLE) return;
    if (!is_array($resp) || !isset($resp['code']) || (int)$resp['code'] !== 200) return;
    $path = mx_cache_path(mx_cache_key($url));
    @file_put_contents($path, json_encode($resp, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

// ============================================================
// 3. 参数校验
// ============================================================

// 检查是否提供了 URL 参数
if (!isset($_GET['url']) || empty($_GET['url'])) {
    echo json_encode(['code' => 400, 'msg' => '请提供需要解析的链接'], JSON_UNESCAPED_UNICODE);
    exit;
}

// 获取需要解析的链接
$video_url = trim($_GET['url']);

// 校验 URL 格式
if (!filter_var($video_url, FILTER_VALIDATE_URL)) {
    echo json_encode(['code' => 400, 'msg' => '链接格式不正确'], JSON_UNESCAPED_UNICODE);
    exit;
}

// 校验协议（只允许 http/https）
$scheme = strtolower(parse_url($video_url, PHP_URL_SCHEME));
if (!in_array($scheme, ['http', 'https'], true)) {
    echo json_encode(['code' => 400, 'msg' => '仅支持 http/https 链接'], JSON_UNESCAPED_UNICODE);
    exit;
}

// 如果传入本身就是 m3u8 地址，直接返回（最快路径，零开销）
if (preg_match('/\.m3u8(\?|$)/i', $video_url)) {
    header('X-Cache: DIRECT-M3U8');
    echo json_encode(['code' => 200, 'url' => $video_url], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// ============================================================
// 4. 查询缓存（命中直接返回）
// ============================================================
if ($MX_PHP_CACHE_ENABLE) {
    $cached = mx_cache_get($video_url);
    if ($cached !== null) {
        header('X-Cache: HIT');
        echo json_encode($cached, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}

// ============================================================
// 5. cURL 请求 Node.js 解析服务
// ============================================================

// 构造目标地址
$target_url = $MX_PLAYER_URL . urlencode($video_url);

// 使用 cURL 抓取页面内容（带连接复用、压缩等优化）
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $target_url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);          // 支持重定向
curl_setopt($ch, CURLOPT_MAXREDIRS, 5);                  // 最多跟随 5 次重定向
curl_setopt($ch, CURLOPT_TIMEOUT, $MX_PHP_TIMEOUT);      // 总超时
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $MX_PHP_CONNECT_TIMEOUT); // 连接超时
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, $MX_PHP_SSL_VERIFY);
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, $MX_PHP_SSL_VERIFY ? 2 : 0);
curl_setopt($ch, CURLOPT_ENCODING, 'gzip,deflate,br');   // 接收压缩内容，省带宽
curl_setopt($ch, CURLOPT_TCP_NODELAY, true);             // 禁用 Nagle，小包立即发
curl_setopt($ch, CURLOPT_FORBID_REUSE, false);           // 允许连接复用
curl_setopt($ch, CURLOPT_FRESH_CONNECT, false);          // 优先复用已有连接
curl_setopt($ch, CURLOPT_USERAGENT, 'SuperSniffer-PHP/2.0');
$response = curl_exec($ch);
$curl_errno = curl_errno($ch);
$curl_error = curl_error($ch);
$http_code  = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// 检查是否成功获取内容
if ($response === false) {
    echo json_encode([
        'code' => 500,
        'msg'  => '无法获取解析页面: ' . ($curl_error ?: 'curl 错误 #' . $curl_errno)
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// 若 Node.js 服务直接返回非 200（如健康检查 5xx）
if ($http_code >= 500 && $http_code < 600) {
    echo json_encode([
        'code' => 500,
        'msg'  => '解析服务异常 (HTTP ' . $http_code . '): ' . mb_substr(strip_tags($response), 0, 200)
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// ============================================================
// 6. 从响应中提取 m3u8
// ============================================================

// 方式 A：直接正则匹配（响应可能是 HTML 片段，也可能已经是 Node.js 返回的 JSON）
if (preg_match('/https?:\/\/[^\s"\'<>\\\\]+?\.m3u8[^\s"\'<>\\\\]*/', $response, $matches)) {
    $m3u8_url = $matches[0];
    $resp = ['code' => 200, 'url' => $m3u8_url];
    header('X-Cache: MISS');
    mx_cache_set($video_url, $resp);
    echo json_encode($resp, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// 方式 B：尝试解析 Node.js 直接返回的 JSON（其中 code=200 或带 msg）
$json = json_decode($response, true);
if (is_array($json) && isset($json['code'])) {
    header('X-Cache: MISS');
    if (isset($json['url']) && (int)$json['code'] === 200) {
        mx_cache_set($video_url, $json);
    }
    echo json_encode($json, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// 方式 C：没找到
echo json_encode(['code' => 404, 'msg' => '未找到播放链接'], JSON_UNESCAPED_UNICODE);
?>
