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
 * 返回：
 *   {"code":200,"url":"https://.../index.m3u8"}        解析成功
 *   {"code":400,"msg":"请提供需要解析的链接"}             缺少参数
 *   {"code":404,"msg":"未找到播放链接"}                  未找到 m3u8
 *   {"code":500,"msg":"无法获取解析页面"}                解析服务异常
 */

// 设置返回 JSON 格式
header('Content-Type: application/json; charset=utf-8');

// 检查是否提供了 URL 参数
if (!isset($_GET['url']) || empty($_GET['url'])) {
    echo json_encode(['code' => 400, 'msg' => '请提供需要解析的链接']);
    exit;
}

// 获取需要解析的链接
$video_url = trim($_GET['url']);

// 校验 URL 格式
if (!filter_var($video_url, FILTER_VALIDATE_URL)) {
    echo json_encode(['code' => 400, 'msg' => '链接格式不正确']);
    exit;
}

// 定义解析服务地址（Node.js 解析服务，可通过环境变量覆盖）
$player_host = getenv('PLAYER_HOST') ?: 'http://122.51.166.115:1314';
$player_url  = $player_host . '/node.js?url=';

// 构造目标地址
$target_url = $player_url . urlencode($video_url);

// 使用 cURL 抓取页面内容
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $target_url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true); // 支持重定向
curl_setopt($ch, CURLOPT_TIMEOUT, 30);          // 超时设置
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);    // 连接超时
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // 忽略 SSL 证书校验
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
$response = curl_exec($ch);
$curl_errno = curl_errno($ch);
$curl_error = curl_error($ch);
curl_close($ch);

// 检查是否成功获取内容
if ($response === false) {
    echo json_encode(['code' => 500, 'msg' => '无法获取解析页面: ' . $curl_error]);
    exit;
}

// 使用正则表达式提取 .m3u8 播放链接（支持带查询参数）
if (preg_match('/https?:\/\/[^\s"\'<>\\\\]+?\.m3u8[^\s"\'<>\\\\]*/', $response, $matches)) {
    $m3u8_url = $matches[0];
    echo json_encode(['code' => 200, 'url' => $m3u8_url]);
} else {
    // 尝试解析 JSON 返回中的错误信息
    $json = json_decode($response, true);
    if (is_array($json) && isset($json['msg'])) {
        echo json_encode(['code' => 404, 'msg' => $json['msg']]);
    } else {
        echo json_encode(['code' => 404, 'msg' => '未找到播放链接']);
    }
}
?>
