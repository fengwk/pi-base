# image-understanding-cli

## 说明

将本地图片或图片 URL 连同 prompt 发送到 MiniMax Anthropic 兼容 Messages API（`https://api.minimaxi.com/anthropic/v1/messages`），使用 `MiniMax-M3` 模型进行图片识别与理解，输出模型文本回答。

- 原生支持格式：JPEG、PNG、GIF、WEBP（单张最大 10 MB）
- 其他本地格式（BMP/TIFF/HEIC/AVIF/SVG/ICO 等）自动转换为 PNG 后上传
- 支持直接传 http(s) 图片 URL；支持 1-30 张图片同时传入（多图对比/批量识别；超过 30 张 CLI 会提示并拒绝）
- 加 `--json` 可输出完整 API 响应，便于调试

## 依赖

- `python3`（标准库）
- 转换非原生格式时需要：`Pillow`（优先）或 ImageMagick（`convert`/`magick`）

## 环境变量

- `MINIMAX_API_KEY`：MiniMax API Key

## 用法

```bash
image-understanding-cli --prompt <text> (--image <path-or-url>)... [--json]
```
