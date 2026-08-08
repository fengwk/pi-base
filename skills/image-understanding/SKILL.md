---
name: image-understanding
description: Image understanding for models without native vision. Use when read cannot attach an image inline and you need to analyze screenshots, charts, diagrams, or extract text from image files.
---

# image-understanding

## What

Use this skill when the active model does **not** support image attachments and `read` returned a downgrade message instead of inline image data.

It runs a small CLI that sends images to the MiniMax Anthropic-compatible Messages API (model: `MiniMax-M3`) and returns text analysis.

## Command Summary

- `<skill-dir>` is the directory containing this `SKILL.md` file.

```bash
<skill-dir>/scripts/image-understanding-cli --prompt <text> (--image <path-or-url>)...
```

## Parameter Reference

| Parameter | Required | Description |
| --- | --- | --- |
| `--prompt` | yes | What to analyze (describe, OCR, find errors, interpret a chart, etc.) |
| `--image` | yes | Local path or HTTP(S) URL; repeatable, one or more images in one call |

## Usage Notes

- `--image` supports absolute paths, paths relative to the current working directory, and HTTP/HTTPS URLs. Pass `--image` multiple times for multi-image analysis (one or more images per call).
- Native formats: JPEG/PNG/GIF/WEBP. Other local formats (BMP/TIFF/HEIC/AVIF/SVG/ICO...) are converted to PNG automatically via Pillow or ImageMagick.
- Pass the real image path from the `read` downgrade output (`absolutePath` or `path`).
- `--prompt` should be specific; vague prompts produce vague answers.

## Template Examples

### Describe the image

```bash
<skill-dir>/scripts/image-understanding-cli \
  --prompt "Describe the main content of this image" \
  --image "/path/to/screenshot.png"
```

### OCR / extract text

```bash
<skill-dir>/scripts/image-understanding-cli \
  --prompt "Extract all visible text" \
  --image "/path/to/screenshot.png"
```

### Error screenshot

```bash
<skill-dir>/scripts/image-understanding-cli \
  --prompt "Identify error messages and likely causes" \
  --image "/path/to/error.png"
```

### Compare multiple images

```bash
<skill-dir>/scripts/image-understanding-cli \
  --prompt "Compare these two screenshots and list the differences" \
  --image "/path/to/before.png" \
  --image "/path/to/after.png"
```

## Dependencies

See `scripts/README.md`: requires `python3` (standard library) and `MINIMAX_API_KEY`; Pillow or ImageMagick are only needed for converting non-native image formats.
