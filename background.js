// Background Service Worker - Xử lý context menu và gọi AI

// Khởi tạo context menu khi extension được cài đặt
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed!');
  chrome.contextMenus.create({
    id: "solveMCQ",
    title: "Solve MCQ with AI",
    contexts: ["selection"]
  });
  console.log('Context menu created!');
  
  // Set default config
  chrome.storage.sync.set({
    ollamaUrl: "http://localhost:11434",
    modelName: "qwen2.5:14b-instruct"  // BEST model cho STEM MCQ!
  });
});

// Xử lý khi user click vào context menu
chrome.contextMenus.onClicked.addListener((info, tab) => {
  console.log('Context menu clicked:', info.menuItemId);
  if (info.menuItemId === "solveMCQ") {
    const selectedText = info.selectionText;
    console.log('Selected text:', selectedText.substring(0, 100) + '...');
    
    // Gửi text đến content script để hiển thị loading
    chrome.tabs.sendMessage(tab.id, {
      type: "SHOW_LOADING"
    }).catch(err => console.warn('Could not send loading message:', err));
    
    // Gọi AI để giải quyết
    solveWithAI(selectedText, tab.id);
  }
});

// Xử lý keyboard shortcut từ content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SOLVE_MCQ') {
    console.log('Keyboard shortcut triggered!');
    const selectedText = message.text;
    const tabId = sender.tab.id;
    
    console.log('Selected text (via Shift):', selectedText.substring(0, 100) + '...');
    
    // Gọi AI để giải quyết
    solveWithAI(selectedText, tabId);
    
    // Response để content script biết message đã được nhận
    sendResponse({ status: 'processing' });
  }
  return true; // Keep channel open for async response
});

// Hàm gọi Ollama API
async function solveWithAI(rawSelection, tabId) {
  console.log('Starting AI solve...');
  try {
    // Lấy cấu hình từ storage
    const config = await chrome.storage.sync.get(['ollamaUrl', 'modelName']);
    const ollamaUrl = config.ollamaUrl || "http://localhost:11434";
    const modelName = config.modelName || "deepseek-coder:6.7b-instruct";
    console.log('Config:', { ollamaUrl, modelName });

    // Chuẩn hóa selection thành {question, options}
    const parsed = normalizeSelection(rawSelection);
    console.log('Parsed selection:', parsed);

    const prompt = buildSimplePrompt(parsed);

    console.log('==========================================');
    console.log('FULL PROMPT SENT TO AI:');
    console.log(prompt);
    console.log('==========================================');

    // Chạy 1 lần duy nhất (nhanh hơn)
    const res = await callOllamaSimple(ollamaUrl, modelName, prompt);
    const finalAnswer = res || 'A';
    console.log('Final answer:', finalAnswer);

    // Gửi kết quả đến content script
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_ANSWER', answer: finalAnswer });
    } catch (err) {
      console.warn('Could not send message to tab, falling back to injected alert:', err);
      await safeShowAlert(tabId, `MCQ Solver\n\nĐáp án: ${finalAnswer}`);
    }
  } catch (error) {
    console.error('Error solving MCQ:', error);
    const msg = error?.message || String(error);
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_ERROR', error: msg });
    } catch (e) {
      console.error('Could not send error message, showing alert:', e);
      await safeShowAlert(tabId, `Lỗi: ${msg}`);
    }
  }
}

// Gọi Ollama đơn giản - KHÔNG dùng JSON format
async function callOllamaSimple(ollamaUrl, modelName, prompt) {
  console.log(`Calling Ollama...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName,
        prompt: prompt,
        stream: false,
        // KHÔNG dùng format: 'json' - để model tự do trả lời
        options: {
          temperature: 0.1,      // 0 = deterministic, không random
          top_p: 0.95,            // Chỉ chọn top 50% tokens có xác suất cao nhất
          top_k: 10,             // Chỉ xét 10 tokens tốt nhất
          num_predict: 300,       // Giảm xuống 30 (chỉ cần 1 chữ cái)
          repeat_penalty: 1.2,   // Tăng lên để tránh lặp
          presence_penalty: 0.5, // Tránh lặp lại từ đã dùng
          frequency_penalty: 0.3 // Khuyến khích đa dạng nhưng không quá
        }
      })
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    console.log('AI Raw:', data.response);

    // Extract đáp án từ response
    const answer = extractAnswer(data.response);
    console.log('Extracted:', answer);
    return answer;
  } catch (err) {
    console.error('Ollama call failed:', err);
    return null;
  }
}

// Chuẩn hóa phần text user bôi đen → {question, options:{A,B,C,D}}
function normalizeSelection(text) {
  // Thử split theo nhiều patterns
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  
  // Nếu không có line breaks, thử tách theo pattern a) b) c) d)
  if (lines.length === 1) {
    // Tách theo pattern: "... a) text1 b) text2 c) text3 d) text4"
    const parts = text.split(/\s+([a-dA-D])\)\s+/);
    if (parts.length > 1) {
      lines = [];
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0 && parts[i].trim()) {
          lines.push(parts[i].trim());
        } else if (i % 2 === 1 && parts[i] && parts[i+1]) {
          lines.push(`${parts[i]}) ${parts[i+1].trim()}`);
          i++; // Skip next
        }
      }
    }
  }
  
  const optionMap = { A: '', B: '', C: '', D: '' };
  let questionLines = [];
  
  for (const line of lines) {
    // Pattern 1: "a) text" hoặc "A) text"
    let m = line.match(/^([a-dA-D])\)\s*(.+)$/);
    if (m) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }
    
    // Pattern 2: "a. text" hoặc "A. text"
    m = line.match(/^([a-dA-D])\.\s*(.+)$/);
    if (m) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }
    
    // Pattern 3: "a: text" hoặc "A: text"
    m = line.match(/^([a-dA-D]):\s*(.+)$/);
    if (m) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }
    
    // Không match pattern nào → đây là phần câu hỏi
    questionLines.push(line);
  }
  
  const question = questionLines.join(' ');
  
  console.log('Parsed:', { question: question.substring(0, 100), options: optionMap });
  
  return {
    question,
    options: optionMap
  };
}

// Xây prompt với structured thinking - anti-hallucination
function buildSimplePrompt(parsed) {
  const { question, options } = parsed;
  const a = options.A || options.a || '';
  const b = options.B || options.b || '';
  const c = options.C || options.c || '';
  const d = options.D || options.d || '';
  return `You are an expert professor in Signal and Systems engineering with deep knowledge of:
- Fourier Transform, Laplace Transform, Z-Transform
- Linear Time-Invariant (LTI) Systems
- Convolution, Causality, Stability
- Frequency Domain Analysis
- System Properties and Characteristics

CRITICAL INSTRUCTIONS:
1. Read the question carefully and identify the core concept
2. Analyze each option based ONLY on fundamental Signal & Systems theory
3. Do NOT add assumptions or external information
4. Think step-by-step internally but OUTPUT only ONE letter
5. Choose the MOST technically accurate answer

Question: ${question}

Options:
A) ${a}
B) ${b}
C) ${c}
D) ${d}

REASONING PROCESS (internal - do not write this):
- What concept is being tested?
- Which option matches the fundamental definition/property?
- Eliminate clearly wrong answers
- Select the most precise answer

YOUR ANSWER (write ONLY this - one letter A, B, C, or D):`;
}


// Hiển thị alert an toàn nếu không gửi message được
async function safeShowAlert(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => alert(msg),
      args: [message]
    });
  } catch (e) {
    console.error('Unable to show alert via scripting:', e);
  }
}

// Trích xuất đáp án từ response
function extractAnswer(text) {
  console.log('Raw AI response:', text);
  
  // Cảnh báo nếu response quá dài (dấu hiệu hallucination)
  if (text.length > 100) {
    console.warn('Response quá dài (có thể hallucination):', text.length, 'chars');
  }
  
  // Làm sạch text
  const cleaned = text.trim();
  const cleanedUpper = cleaned.toUpperCase();
  
  // Pattern 0: Nếu response chỉ có 1 ký tự và là A/B/C/D (IDEAL!)
  if (cleanedUpper.length === 1 && /^[ABCD]$/.test(cleanedUpper)) {
    console.log('Perfect! Single character answer:', cleanedUpper);
    return cleanedUpper;
  }
  
  // Pattern 0.5: Bắt đầu bằng A/B/C/D rồi có ký tự khác (như "A (", "B)", etc)
  const startsWithLetter = cleaned.match(/^([ABCDabcd])[\s\(\)\.\,\n]/);
  if (startsWithLetter) {
    console.log('Starts with letter:', startsWithLetter[1]);
    return startsWithLetter[1].toUpperCase();
  }
  
  // Pattern 0.6: "The answer is X" ngay từ đầu
  const theAnswerIs = cleaned.match(/^(?:the\s+)?answer\s+is\s+([ABCDabcd])\b/i);
  if (theAnswerIs) {
    console.log('"The answer is" pattern:', theAnswerIs[1]);
    return theAnswerIs[1].toUpperCase();
  }
  
  // Pattern 1: Tìm "correct answer is X" hoặc "answer is X" (ưu tiên cao nhất)
  // Tìm pattern "answer is [letter]" với nhiều variations
  const answerIsPatterns = [
    /correct\s+answer\s+is\s+([abcdABCD])\s*\)/i,  // "correct answer is c)"
    /correct\s+answer\s+is\s+([abcdABCD])\b/i,      // "correct answer is c"
    /answer\s+is\s+([abcdABCD])\s*\)/i,             // "answer is c)"
    /answer\s+is\s+([abcdABCD])\b/i,                 // "answer is c"
    /answer:\s*([abcdABCD])\s*\)/i,                  // "answer: c)"
    /answer:\s*([abcdABCD])\b/i                      // "answer: c"
  ];
  
  for (const pattern of answerIsPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      console.log('Found answer pattern:', match[0], '->', match[1]);
      return match[1].toUpperCase();
    }
  }
  
  // Pattern 2: Tìm "Answer: X" hoặc "Đáp án: X"
  const colonAnswerMatch = cleaned.match(/(?:answer|đáp án)\s*:\s*([abcdABCD])/i);
  if (colonAnswerMatch) {
    console.log('Found colon answer:', colonAnswerMatch[1]);
    return colonAnswerMatch[1].toUpperCase();
  }
  
  // Pattern 3: Tìm "X)" ở CẬN CUỐI câu (để tránh nhầm với câu hỏi)
  // Chỉ tìm trong 100 ký tự cuối
  const lastPart = cleaned.slice(-100);
  const optionMatch = lastPart.match(/\b([abcdABCD])\s*\)/);
  if (optionMatch) {
    console.log('Found option in last part:', optionMatch[1]);
    return optionMatch[1].toUpperCase();
  }
  
  // Pattern 4: Letter đứng một mình ở cuối
  const lastWordMatch = cleaned.match(/\b([ABCD])\b\s*$/i);
  if (lastWordMatch) {
    console.log('Found last word letter:', lastWordMatch[1]);
    return lastWordMatch[1].toUpperCase();
  }
  
  // Pattern 5: Tìm trong ngoặc (A) hoặc [B] gần cuối
  const bracketMatch = lastPart.match(/[\(\[]([abcdABCD])[\)\]]/i);
  if (bracketMatch) {
    console.log('Found in brackets:', bracketMatch[1]);
    return bracketMatch[1].toUpperCase();
  }
  
  // Pattern 6: CHỈ tìm chữ cái STANDALONE (có space hoặc dấu câu xung quanh)
  // Tránh tìm "a" trong "a unit" hoặc "an answer"
  const standaloneLetters = [...cleaned.matchAll(/(?:^|\s)([ABCDabcd])(?:\s|$|\.|,|;)/g)];
  if (standaloneLetters.length > 0) {
    const lastLetter = standaloneLetters[standaloneLetters.length - 1][1];
    console.warn('Using fallback - found standalone letter:', lastLetter);
    return lastLetter.toUpperCase();
  }
  
  // Pattern 7: Tìm UPPERCASE A/B/C/D trong text (ưu tiên uppercase)
  const uppercaseMatch = cleaned.match(/\b([ABCD])\b/);
  if (uppercaseMatch) {
    console.warn('Found uppercase letter:', uppercaseMatch[1]);
    return uppercaseMatch[1];
  }
  
  console.error('Could not extract answer at all, returning raw text');
  return cleaned.substring(0, 100);
}
