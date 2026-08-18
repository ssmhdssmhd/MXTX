# 更新日志 (Changelog)

本项目所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-08-18

### 新增

- 新增管理后台页面 `admin.html`
  - 实时显示服务状态、监听端口、Chrome 版本、当前版本
  - 浏览器更新与源码更新独立展示，互不干扰
  - 支持一键升级（浏览器 + 源码）
- 新增在线更新模块 `update.js`
  - 浏览器更新：仅更新 Chrome 浏览器，不影响源码
  - 源码更新：仅更新项目源码，不影响浏览器
  - 更新前自动备份，更新后自动验证，验证失败自动回滚
  - 源码更新完成后服务自动重启
- `node.js` 新增后台管理接口
  - `GET /admin` 管理后台页面
  - `GET /admin/api/status` 服务状态
  - `GET /admin/api/check-update` 检查更新
  - `POST /admin/api/update` 执行更新（browser / source / all）
- 更新源支持环境变量配置（`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_TOKEN`）

### 优化

- 更新 `README.md`，补充管理后台与在线更新使用说明
- 版本升级至 1.2.0

## [1.1.0] - 2026-08-18

### 新增

- 新增 `1.sh` 一键解压浏览器脚本
  - 自动查找当前目录及 `upload/`、`uploads/` 目录下的浏览器压缩包
  - 支持 `chrome-linux64.tar.xz`、`chrome-linux64.tar.gz`、`chrome-linux64.zip` 等格式
  - 自动解压到项目根目录 `chrome-linux64/` 并设置可执行权限
  - 验证 Chrome 可运行，缺失系统依赖时自动尝试安装
  - Chrome 已就绪时自动跳过解压
- 浏览器已内置进分发压缩包（`chrome-linux64.tar.xz`）

### 优化

- 更新 `README.md`，补充一键解压浏览器的使用说明

## [1.0.0] - 2026-08-18

### 新增

- 新增 `node.js` Node.js 解析服务（Express + Puppeteer）
  - 支持网络请求拦截捕获 m3u8 地址
  - 支持响应体扫描、页面内容扫描、iframe 扫描
  - 支持带查询参数的 m3u8 地址
- 新增 `package.json` 依赖配置（express、puppeteer）
- 新增 `README.md` 项目说明文档
- 新增 `.gitignore` 忽略规则

### 优化

- 优化 `api.php` 前端接口
  - 增加 URL 格式校验
  - 改进 m3u8 正则，支持带查询参数的完整地址
  - 增加 cURL 连接超时与 SSL 校验配置
  - 支持通过环境变量 `PLAYER_HOST` 配置解析服务地址
  - 解析失败时返回解析服务的具体错误信息
