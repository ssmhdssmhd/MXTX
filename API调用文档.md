# 超级嗅探 (Super Sniffer) 接口调用文档

本文档说明视频解析服务的对外调用方式，包含 **单接口（单页解析）** 与 **双接口（万能嗅探 · 官方优先多线路）** 两种调用方式，均可直接复制使用。

> 约定：`http://你的IP:1314` 为服务地址（按实际部署替换），`<视频地址>` 为要解析的视频页面链接。
> 所有接口均返回 JSON；`/api.php`、`/node.js`、`/sniff` 三个入口调用方式相同。

---

## 一、单接口（单页解析）

入口：`/api.php` 或 `/node.js`（二者等价，`api.php` 内部转发到 `node.js`），返回**一条播放直链**（官方平台命中优先，如 B 站 / 腾讯 / 搜狐）。

| 参数 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 视频页面地址（需 URL 编码） |

**浏览器直接访问（复制到地址栏）：**

```
http://你的IP:1314/api.php?url=https://www.bilibili.com/video/BV1kS8H6VERt
```

**curl 调用：**

```bash
curl "http://你的IP:1314/api.php?url=https://www.bilibili.com/video/BV1kS8H6VERt"
```

**成功返回：**

```json
{"code":200,"url":"https://.../xxx.mp4?...","allUrls":["https://..."]}
```

**失败返回：**

```json
{"code":404,"msg":"未找到播放链接"}
```

---

## 二、双接口（万能嗅探 · 官方优先多线路）

入口：`/sniff`，**官方直连 + 16 条第三方解析接口并发执行、去重合并**，返回多条备用线路（更稳）。

| 参数 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 视频页面地址 |
| `detailed` | 否 | `1` = 返回全部线路与命中明细（推荐）；缺省仅返回首选线路 |
| `refresh` | 否 | `1` = 跳过缓存强制重新嗅探 |
| `official` | 否 | `0` = 跳过官方直连，仅跑第三方接口 |
| `providers` | 否 | 只跑指定接口，逗号分隔（如 `qianqi,bd.jx`） |

**基础调用（返回首选线路）：**

```bash
curl "http://你的IP:1314/sniff?url=https://www.bilibili.com/video/BV1kS8H6VERt"
```

**获取全部线路（推荐）：**

```bash
curl "http://你的IP:1314/sniff?url=https://www.bilibili.com/video/BV1kS8H6VERt&detailed=1"
```

**强制刷新缓存：**

```bash
curl "http://你的IP:1314/sniff?url=https://www.bilibili.com/video/BV1kS8H6VERt&refresh=1&detailed=1"
```

**成功返回（detailed=1）：**

```json
{
  "code": 200,
  "urls": ["https://...m3u8", "https://...mp4"],
  "providers": [
    {"provider":"bilibili","status":"ok","urls":["..."],"official":true}
  ],
  "totalProviders": 17,
  "hitProviders": 2,
  "totalUrls": 2
}
```

---

## 三、返回格式说明

| 字段 | 单接口 | 双接口 | 说明 |
|------|--------|--------|------|
| `code` | 200/404/400/500 | 同左 | 200 成功；404 未找到；400 参数错误；500 服务异常 |
| `url` | 首选直链 | 首选直链（缺省模式） | 可直接播放的 m3u8 / mp4 地址 |
| `allUrls` | 备用线路 | - | 全部去重后的线路 |
| `urls` | - | 全部线路（detailed=1） | 官方优先 + 第三方合并 |
| `providers` | - | 各接口命中明细 | detailed=1 时返回 |
| `totalProviders` | - | 参与接口总数 | detailed=1 时返回 |
| `hitProviders` | - | 命中接口数 | detailed=1 时返回 |
| `totalUrls` | - | 线路总数 | detailed=1 时返回 |

**前端播放器接入（JS 示例）：**

```javascript
const res = await fetch('http://你的IP:1314/sniff?url=' + encodeURIComponent(videoUrl) + '&detailed=1');
const data = await res.json();
if (data.code === 200) {
  player.src = data.urls[0]; // 首选线路
}
```

**PHP 调用示例：**

```php
$resp = file_get_contents('http://你的IP:1314/api.php?url=' . urlencode($videoUrl));
$data = json_decode($resp, true);
if ($data['code'] === 200) { $playUrl = $data['url']; }
```

---

## 四、相关说明

- 单接口与双接口均有 **LRU 缓存**，重复解析直接命中缓存（双接口可用 `refresh=1` 强制刷新）。
- 双接口内部：官方平台（腾讯 / B 站 / 搜狐）直连优先，命中后同时合并第三方接口结果，实现「官方优先多线路」。
- 管理后台「快捷测试」内嵌了同样调用（万能嗅探 / 单页解析），可在后台实时验证。
- 地址为 `http://IP:1314` 时对外需开放端口或置于 PHP 反向代理之后（`api.php` 已在项目内，可与 Node 共用域名）。
