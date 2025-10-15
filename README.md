# Intro

A minimalist Chrome/Edge extension that solves mcq directly on any webpage using your local model. Private. Fast. Accurate.
This project is optimized for the Signal and System course. You can modify the feed prompt (or remove it entirely) if you want to adapt it for other subjects.
> **Note:** This project is for learning and personal research only, not for commercial or official academic use.
Built in 24 hours. More updates coming soon.

---
## Highlights

- Fast, single-keystroke workflow (Ctrl)
- Local-only inference via Ollama (no cloud)
- Minimal popup UI (bottom-left, invisible style)
- Noise-free answer: returns only A/B/C/D
- Works on any site with selectable text

---

## Demo 

1) Select a question block (includes A/B/C/D)
2) Press Ctrl
3) A subtle popup appears with: `Answer: B`
4) Press backtick (`) to close instantly
Notes
- Minimum selection length: 20 chars (prevents accidental triggers)
- Works on most static pages; not in editable inputs
---

## Recommended Models (tested locally on my laptop 7840HS 32gb ram)

| Model                | Size | Speed  | Accuracy | Best use            |
|----------------------|------|--------|----------|---------------------|
| qwen2.5:14b-instruct | 9GB  | 2-4 s  | ~98%     | Exams, highest acc. |
| deepseek-r1:14b      | 9GB  | 2-5 s  | ~97%     | Complex reasoning   |
| gemma3:12b           | 8.1G | 1.5-3s | ~95%     | Fast + accurate     |
| llama3.1:8b-instruct-q4_0 | 4.7GB | 1-3 s | ~89% | Balanced           |
| deepseek-r1:8b       | 5.2G | 1-3 s  | ~80%     | Fast reasoning      |
| mistral:7b-instruct  | 4.4G | 1-2 s  | ~80%     | General             |
| phi3.5:3.8b          | 2.2G | 0.5-1s | ~60%     | Very fast           |
| llama3.2:3b          | 2.0G | 0.5-1s | ~50%     | Ultra light         |

Not recommended for MCQ: `deepseek-coder:6.7b-instruct` (coding-tuned)

---

## Keyboard Shortcuts

- Ctrl → Solve MCQ (with selection)
- Backtick (`) → Close popup

You can still use the context menu entry if you prefer the mouse.

---
## Troubleshooting
Connection error
- Ensure Ollama is running: `ollama serve`
- Check firewall rules for port 11434

Model not found
- Run `ollama list` to verify pulled models
- Pull the selected model (see commands above)

Inaccurate answers
- Switch to a stronger model (Qwen 2.5 14B or DeepSeek R1 14B)
- Ensure the selection includes all options A/B/C/D

Performance
- Use smaller models if needed
- Close heavy apps to free RAM

---

- `content.js`: Collects selected text, shows popup UI, keyboard shortcuts
- `background.js`: Normalizes text → builds prompt → calls Ollama → extracts answer
- `popup.html/js`: Configuration UI (Ollama URL, model selection, test)
- `content.css`: Invisible, minimal UI with smooth fade animations

Model settings 
```json
{
  "temperature": 0.1,
  "top_p": 0.95,
  "top_k": 10,
  "num_predict": 300,
  "repeat_penalty": 1.2,
  "presence_penalty": 0.5,
  "frequency_penalty": 0.3
}
```
---

## Privacy

- 100% local inference via Ollama
- No data leaves your machine
- No analytics, no logging beyond local console

---
