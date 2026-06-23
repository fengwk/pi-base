---
name: image-understanding
description: Image understanding for models without native vision. Use when read cannot attach an image inline and you need to analyze screenshots, charts, diagrams, or extract text from image files.
---

# image-understanding

## What

Use this skill when the active model does **not** support image attachments and `read` returned a downgrade message instead of inline image data.

It runs a small CLI that sends the image to a vision-capable backend (MiniMax via `mmx`) and returns text analysis.

## Command Summary

- `<skill-dir>` is the directory containing this `SKILL.md` file.

```bash
<skill-dir>/scripts/image-understanding-cli --prompt <text> --image <path-or-url>
```

## Parameter Reference

| Parameter | Required | Description |
| --- | --- | --- |
| `--prompt` | yes | What to analyze (describe, OCR, find errors, interpret a chart, etc.) |
| `--image` | yes | Local path or HTTP(S) URL |

## Usage Notes

- `--image` supports absolute paths, paths relative to the current working directory, and HTTP/HTTPS URLs.
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

## Dependencies

See `scripts/README.md`: requires `python3`, `mmx` (`npm install -g mmx-cli`), and `MINIMAX_API_KEY`.