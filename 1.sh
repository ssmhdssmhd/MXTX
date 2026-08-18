#!/bin/bash
# ============================================================
# 超级嗅探 - 一键解压浏览器脚本
#
# 功能：
#   自动查找并解压项目自带的浏览器压缩包到正确位置，
#   设置可执行权限并验证 Chrome 是否可用。
#
# 使用：
#   bash 1.sh
#   或
#   chmod +x 1.sh && ./1.sh
# ============================================================

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 脚本所在目录（项目根目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=============================================="
echo "  超级嗅探 - 浏览器自动解压脚本"
echo "=============================================="
echo "项目目录: $SCRIPT_DIR"
echo ""

# 目标目录
TARGET_DIR="$SCRIPT_DIR/chrome-linux64"
CHROME_BIN="$TARGET_DIR/chrome"

# 1. 如果 Chrome 已存在且可运行，直接跳过
if [ -x "$CHROME_BIN" ] && "$CHROME_BIN" --version >/dev/null 2>&1; then
    echo -e "${GREEN}[✓] Chrome 已就绪: $("$CHROME_BIN" --version 2>/dev/null)${NC}"
    echo -e "${GREEN}[✓] 无需解压，直接启动服务即可: npm start${NC}"
    exit 0
fi

# 1.5 检查 MX_CHROME_PATH 指定的路径是否已存在
MX_CHROME_CHECK="${MX_CHROME_PATH:-./chrome-linux64/chrome}"
if [ -f "$MX_CHROME_CHECK" ]; then
    echo "Chrome 已存在，跳过下载"
    exit 0
fi

# 2. 查找浏览器压缩包（支持多种格式）
CANDIDATES=(
    "chrome-linux64.tar.xz"
    "chrome-linux64.tar.gz"
    "chrome-linux64.tgz"
    "chrome-linux64.zip"
    "chrome.tar.xz"
    "chrome.tar.gz"
    "chrome.zip"
)

PACKAGE=""
for name in "${CANDIDATES[@]}"; do
    if [ -f "$SCRIPT_DIR/$name" ]; then
        PACKAGE="$SCRIPT_DIR/$name"
        echo -e "${GREEN}[✓] 找到浏览器压缩包: $name${NC}"
        break
    fi
done

# 3. 如果本地没有，尝试从上传目录查找
if [ -z "$PACKAGE" ]; then
    echo -e "${YELLOW}[!] 当前目录未找到浏览器压缩包，尝试查找上传文件...${NC}"
    for dir in "$SCRIPT_DIR" "$SCRIPT_DIR/upload" "$SCRIPT_DIR/uploads" "$SCRIPT_DIR/tmp"; do
        for name in "${CANDIDATES[@]}"; do
            if [ -f "$dir/$name" ]; then
                PACKAGE="$dir/$name"
                echo -e "${GREEN}[✓] 找到浏览器压缩包: $PACKAGE${NC}"
                break 2
            fi
        done
    done
fi

# 4. 仍未找到则报错退出
if [ -z "$PACKAGE" ]; then
    echo -e "${RED}[✗] 未找到浏览器压缩包！${NC}"
    echo ""
    echo "请将浏览器压缩包（chrome-linux64.tar.xz）放到以下任一位置："
    echo "  - $SCRIPT_DIR/"
    echo "  - $SCRIPT_DIR/upload/"
    echo "  - $SCRIPT_DIR/uploads/"
    echo ""
    echo "然后重新运行: bash 1.sh"
    exit 1
fi

# 5. 解压浏览器
echo -e "${YELLOW}[*] 正在解压浏览器，请稍候...${NC}"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

case "$PACKAGE" in
    *.zip)
        unzip -o "$PACKAGE" -d "$SCRIPT_DIR" >/dev/null
        ;;
    *.tar.xz | *.tar.gz | *.tgz)
        tar -xf "$PACKAGE" -C "$SCRIPT_DIR"
        ;;
    *)
        echo -e "${RED}[✗] 不支持的压缩格式: $PACKAGE${NC}"
        exit 1
        ;;
esac

# 6. 处理解压后的目录结构（兼容直接解压出 chrome-linux64/ 或 chrome/）
if [ ! -f "$CHROME_BIN" ]; then
    # 尝试查找解压出来的 chrome 可执行文件
    FOUND_CHROME=$(find "$SCRIPT_DIR" -maxdepth 3 -type f -name chrome -path "*chrome*" 2>/dev/null | head -1)
    if [ -n "$FOUND_CHROME" ]; then
        FOUND_DIR="$(dirname "$FOUND_CHROME")"
        echo -e "${YELLOW}[*] 检测到解压目录: $FOUND_DIR${NC}"
        rm -rf "$TARGET_DIR"
        mv "$FOUND_DIR" "$TARGET_DIR"
    fi
fi

# 7. 设置可执行权限
if [ -f "$CHROME_BIN" ]; then
    chmod +x "$CHROME_BIN" "$TARGET_DIR/chrome_sandbox" "$TARGET_DIR/chrome_crashpad_handler" 2>/dev/null || true
    echo -e "${GREEN}[✓] 浏览器已解压到: $TARGET_DIR${NC}"
else
    echo -e "${RED}[✗] 解压完成，但未找到 chrome 可执行文件！${NC}"
    echo "请检查压缩包内容是否为 chrome-linux64/ 目录结构。"
    exit 1
fi

# 8. 验证 Chrome 可运行
echo -e "${YELLOW}[*] 正在验证 Chrome...${NC}"
if "$CHROME_BIN" --version >/dev/null 2>&1; then
    echo -e "${GREEN}[✓] Chrome 验证通过: $("$CHROME_BIN" --version 2>/dev/null)${NC}"
else
    echo -e "${YELLOW}[!] Chrome 缺少系统依赖库，尝试自动安装...${NC}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq >/dev/null 2>&1 || true
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
            libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libxcomposite1 libxdamage1 \
            libxrandr2 libxkbcommon0 libgbm1 libnss3 libnspr4 libasound2 libcups2 \
            libdrm2 libxfixes3 libxext6 libx11-6 libxcb1 libpango-1.0-0 libcairo2 \
            libdbus-1-3 libexpat1 fonts-liberation libvulkan1 >/dev/null 2>&1 || true
        if "$CHROME_BIN" --version >/dev/null 2>&1; then
            echo -e "${GREEN}[✓] 依赖安装完成，Chrome 验证通过: $("$CHROME_BIN" --version 2>/dev/null)${NC}"
        else
            echo -e "${RED}[✗] Chrome 仍无法运行，请手动安装系统依赖库${NC}"
            exit 1
        fi
    else
        echo -e "${RED}[✗] Chrome 缺少系统依赖库，请手动安装${NC}"
        exit 1
    fi
fi

echo ""
echo "=============================================="
echo -e "${GREEN}  浏览器解压完成！启动服务:${NC}"
echo "  npm install"
echo "  npm start"
echo "=============================================="
