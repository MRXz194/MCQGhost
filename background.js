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
  
  // Set default config - qwen2.5:14b-instruct mặc định
  chrome.storage.sync.set({
    ollamaUrl: "http://localhost:11434",
    modelName: "qwen2.5:14b-instruct"
  });
});

// Track requests in-flight per tab to avoid duplicate processing
const inFlightTabs = new Set();

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
    
    // Gọi AI để giải quyết (chặn trùng lặp theo tab)
    if (inFlightTabs.has(tab.id)) {
      console.warn('Solve already in progress for tab:', tab.id);
      return;
    }
    inFlightTabs.add(tab.id);
    solveWithAI(selectedText, tab.id).finally(() => inFlightTabs.delete(tab.id));
  }
});

// Xử lý keyboard shortcut từ content script (Ctrl)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SOLVE_MCQ') {
    console.log('Keyboard shortcut triggered!');
    const selectedText = message.text;
    const tabId = sender.tab.id;
    
    console.log('Selected text (via Ctrl):', selectedText.substring(0, 100) + '...');
    
    // Gọi AI để giải quyết (chặn trùng lặp theo tab)
    if (inFlightTabs.has(tabId)) {
      console.warn('Solve already in progress for tab:', tabId);
      sendResponse({ status: 'busy' });
      return true;
    }
    inFlightTabs.add(tabId);
    solveWithAI(selectedText, tabId).finally(() => inFlightTabs.delete(tabId));
    
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
    const modelName = config.modelName || "qwen2.5:14b-instruct";
    console.log('Config:', { ollamaUrl, modelName });

    // Chuẩn hóa selection thành {type, question, options, rawText, ...}
    const parsed = normalizeSelection(rawSelection);
    console.log('Parsed selection:', parsed);

    const prompt = buildSimplePrompt(parsed);

    console.log('==========================================');
    console.log('FULL PROMPT SENT TO AI:');
    console.log(prompt);
    console.log('==========================================');

    // Chạy 1 lần duy nhất (nhanh hơn)
    const res = await callOllamaSimple(ollamaUrl, modelName, prompt, parsed);
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

// Gọi Ollama đơn giản
async function callOllamaSimple(ollamaUrl, modelName, prompt, parsed) {
  console.log(`Calling Ollama...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 200000); // 200s
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName,
        prompt: prompt,
        stream: false,
        keep_alive: -1, // Giữ model trong RAM để phản hồi cực nhanh dưới 2s
        options: {
          temperature: 0.1,      // 0.1 = deterministic, chính xác cao
          top_p: 0.95,
          top_k: 10,
          num_predict: parsed?.type === 'FILL_BLANK' ? 120 : 40, // Giới hạn token sinh ra để phản hồi tức thì
          repeat_penalty: 1.2,
          presence_penalty: 0.5,
          frequency_penalty: 0.3
        }
      })
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    console.log('AI Raw:', data.response);

    // Extract đáp án từ response
    const answer = extractAnswer(data.response, parsed);
    console.log('Extracted:', answer);
    return answer;
  } catch (err) {
    console.error('Ollama call failed:', err);
    return null;
  }
}

// Chuẩn hóa phần text user bôi đen → {type, question, options, rawText, ...}
function normalizeSelection(text) {
  const rawText = text.trim();
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Kiểm tra dấu hiệu bài đục lỗ / kéo thả code
  const hasBlankTokens = /_{2,}|\[\s*(?:\d+|blank|_|\?)\s*\]|\(\s*(?:\d+|blank|_|\?)\s*\)|<blank>|<fill>/i.test(rawText);
  const hasBlankKeywords = /(kéo\s*thả|điền\s*vào\s*chỗ\s*trống|drag\s*(?:and|&)\s*drop|fill\s*in\s*the\s*blank|complete\s*the\s*code)/i.test(rawText);

  // Nếu không có line breaks (văn bản 1 dòng), thử tách inline
  if (lines.length === 1 && !hasBlankTokens) {
    // 1. Tách inline có ký hiệu chữ/số: "A) ... B) ..." hoặc "1. ... 2. ..."
    const delimiterSplit = text.split(/\s+([a-zA-Z]|[0-9]{1,2}|[IVXLCDMivxlcdm]{1,5})\s*[\)\.\:\-]\s+/);
    if (delimiterSplit.length > 1) {
      lines = [];
      for (let i = 0; i < delimiterSplit.length; i++) {
        if (i === 0 && delimiterSplit[i].trim()) {
          lines.push(delimiterSplit[i].trim());
        } else if (i % 2 === 1 && delimiterSplit[i] && delimiterSplit[i + 1] !== undefined) {
          lines.push(`${delimiterSplit[i]}) ${delimiterSplit[i + 1].trim()}`);
          i++;
        }
      }
    } else {
      // 2. Tách inline checkboxes "[ ] text [ ] text" hoặc "☐ text ☐ text"
      const checkboxSplit = text.split(/\s*(?:\[\s*\]|\[x\]|\[X\]|☐|☑|○|●|•)\s*/);
      if (checkboxSplit.length > 2) {
        lines = [];
        if (checkboxSplit[0].trim()) lines.push(checkboxSplit[0].trim());
        for (let i = 1; i < checkboxSplit.length; i++) {
          if (checkboxSplit[i].trim()) {
            lines.push(`[ ] ${checkboxSplit[i].trim()}`);
          }
        }
      } else {
        // 3. Fallback inline dạng "a 1 b 2 c 3 d 4 e 5 else 6"
        const inlineMatches = [...text.matchAll(/\b(else|other|none|all|[A-Za-z]|[0-9]{1,2})\s*[\)\.:]?\s+([^]*?)(?=\s+(?:else|other|none|all|[A-Za-z]|[0-9]{1,2})\s*[\)\.:]?\s+|$)/gi)];
        if (inlineMatches.length > 1) {
          const firstIdx = inlineMatches[0].index ?? 0;
          const questionPart = text.slice(0, firstIdx).trim();
          lines = [];
          if (questionPart) lines.push(questionPart);
          for (const m of inlineMatches) {
            const key = (m[1] || '').toUpperCase();
            const val = (m[2] || '').trim();
            if (!key || !val) continue;
            lines.push(`${key}) ${val}`);
          }
        }
      }
    }
  }

  const optionMap = {};
  let questionLines = [];
  let autoIndex = 1;
  let hasCheckboxes = false;
  let wordBankItems = [];

  for (const line of lines) {
    let m;

    // Pattern đặc biệt: Phát hiện dòng Word bank / Từ cho trước (cho bài kéo thả)
    const wbMatch = line.match(/^(?:từ\s*(?:cho\s*trước|gợi\s*ý)|choices|options|word\s*bank|words)\s*[\:\-]\s*(.+)$/i);
    if (wbMatch) {
      const items = wbMatch[1].split(/[,;|]+/).map(s => s.trim()).filter(Boolean);
      wordBankItems.push(...items);
      continue;
    }

    // Pattern 1: Checkboxes hoặc Bullets: [ ], [x], ☐, ☑, ○, •, -
    m = line.match(/^(\[\s*\]|\[x\]|\[X\]|☐|☑|○|●|◯|⚪|🔘|•|·|\-)\s*(.+)$/i);
    if (m) {
      const key = `[${autoIndex++}]`;
      optionMap[key] = m[2].trim();
      hasCheckboxes = true;
      continue;
    }

    // Pattern 2: Dấu ngoặc: (A) text, [A] text, (1) text, [1] text, (I) text
    m = line.match(/^[\(\[]([a-zA-Z]|[0-9]{1,2}|[IVXLCDMivxlcdm]{1,5})[\)\]][\:\.\-]?\s+(.+)$/);
    if (m && !hasBlankTokens) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }

    // Pattern 3: Special keywords có dấu phân cách: else) other. none: all-
    m = line.match(/^(else|other|none|all|none of the above|all of the above)[\)\.\:\-]\s*(.+)$/i);
    if (m) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }

    // Pattern 4: Chuẩn chữ cái, số, số La Mã có dấu phân cách: A) 1. II: B -
    m = line.match(/^([a-zA-Z]|[0-9]{1,2}|[IVXLCDMivxlcdm]{1,5})[\)\.\:\-]\s+(.+)$/);
    if (m) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }

    // Pattern 5: Bare letter có ít nhất 2 khoảng trắng hoặc tab (A   text)
    m = line.match(/^([a-zA-Z])\s{2,}(.+)$/);
    if (m && !hasBlankTokens) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }

    // Pattern 6: Bare special keywords (else text, other text)
    m = line.match(/^(else|other|none|all)\s+(.+)$/i);
    if (m) {
      const key = m[1].toUpperCase();
      optionMap[key] = m[2].trim();
      continue;
    }

    // Không match pattern nào -> thuộc nội dung câu hỏi
    questionLines.push(line);
  }

  // Nếu có word bank items và chưa có optionMap
  if (wordBankItems.length > 0 && Object.keys(optionMap).length === 0) {
    wordBankItems.forEach((wb, i) => {
      optionMap[`(${i + 1})`] = wb;
    });
  }

  // Kiểm tra nếu là câu hỏi trắc nghiệm thông thường có A, B, C, D
  const hasStandardMcqOptions = Object.keys(optionMap).some(k => /^[A-D]$/.test(k));

  // Kiểm tra bài đục lỗ / kéo thả code:
  // Chỉ coi là FILL_BLANK nếu có ký hiệu ô trống VÀ không có các lựa chọn A, B, C, D (hoặc có từ khóa kéo thả)
  const isFillBlank = (hasBlankTokens || hasBlankKeywords) && (!hasStandardMcqOptions || hasBlankKeywords);

  // Xử lý dạng không có nhãn (Unlabeled Options): Các dòng trần không A B C D (chỉ áp dụng nếu KHÔNG phải bài code/đục lỗ)
  let isUnlabeled = false;
  if (!isFillBlank && Object.keys(optionMap).length === 0 && questionLines.length >= 3) {
    let qEndIdx = 0;
    for (let i = 0; i < Math.min(3, questionLines.length - 2); i++) {
      if (/[?\:]$/.test(questionLines[i]) || /(chọn|hãy|đâu là|nào|which|what|how|where|select|choose)/i.test(questionLines[i])) {
        qEndIdx = i;
        break;
      }
    }
    const potentialQ = questionLines.slice(0, qEndIdx + 1).join(' ');
    const potentialOptions = questionLines.slice(qEndIdx + 1);

    if (potentialOptions.length >= 2 && potentialOptions.length <= 10 && potentialOptions.every(l => l.length < 250)) {
      questionLines = [potentialQ];
      potentialOptions.forEach((optText, idx) => {
        optionMap[`[${idx + 1}]`] = optText.trim();
      });
      isUnlabeled = true;
    }
  }

  const question = questionLines.join('\n');
  const fullText = (question + ' ' + rawText).toLowerCase();

  // Kiểm tra câu hỏi chọn nhiều đáp án (Multi-choice)
  const isMultiKeywords = /\b(select\s+(?:all|any|\d+|two|three|four)|choose\s+(?:all|\d+|two|three)|which\s+of\s+the\s+following\s+(?:are|can\s+be)|multiple\s+(?:answers|choices)|check\s+all|more\s+than\s+one)\b/i.test(fullText) ||
    /(chọn\s+(?:tất\s+cả|các|những|\d+|hai|ba)|những\s+(?:đáp\s+án|phát\s+biểu|khẳng\s+định|câu)|các\s+(?:đáp\s+án|phát\s+biểu|khẳng\s+định|câu)\s+(?:đúng|nào)|có\s+thể\s+chọn\s+nhiều|chọn\s+(?:đúng|sai)\s+cho\s+từng)/i.test(fullText);

  const isMulti = hasCheckboxes || isMultiKeywords;

  let type = 'SINGLE_MCQ';
  if (isFillBlank) {
    type = 'FILL_BLANK';
  } else if (isMulti) {
    type = 'MULTI_MCQ';
  } else if (isUnlabeled) {
    type = 'UNLABELED';
  }

  console.log('Parsed:', { type, question: question.substring(0, 100), options: optionMap });

  return {
    type,
    question,
    options: optionMap,
    rawText,
    isUnlabeled,
    hasCheckboxes
  };
}

// Xây dựng prompt linh hoạt và tối ưu theo từng dạng câu hỏi
function buildSimplePrompt(parsed) {
  const { question, options, type, rawText } = parsed;
  const optionKeys = Object.keys(options);
  const optionsText = optionKeys.map(key => `${key}) ${options[key]}`).join('\n');
  const optionLetters = optionKeys.join(', ');

  // Dạng 1: Bài kéo thả từ / điền chỗ trống trong code
  if (type === 'FILL_BLANK') {
    return `You are an expert tutor solving a fill-in-the-blank / drag-and-drop question (possibly containing programming code).

Task:
1. Examine the question or code snippet carefully. Locate all blanks, drop zones, or missing parts (e.g. [1], [2], ___, etc.).
2. From the given choices/word bank (or from programming logic), determine the exact token or expression to fill each blank in order.
3. Output ONLY the filled values in this compact format:
[1] value1 | [2] value2 | [3] value3
(If blanks were unnumbered, number them [1], [2] in appearance order).

Question / Code:
${rawText}

${optionsText ? `Available Choices / Word Bank:\n${optionsText}\n` : ''}
Now solve it carefully.
YOUR FINAL ANSWER (strictly output ONLY the mapping format "[1] val1 | [2] val2", no code blocks, no explanation):`;
  }

  // Dạng 2: Câu hỏi chọn nhiều đáp án (Multi-choice)
  if (type === 'MULTI_MCQ') {
    return `You are an expert tutor solving a multiple-choice question that has ONE OR MORE CORRECT ANSWERS across academic/technical subjects.

Question: ${question}

Options:
${optionsText}

Task:
- Read carefully and identify ALL correct options from (${optionLetters}).
- Output ONLY the letters/labels of all correct options separated by commas (e.g. "A, C" or "1, 3").

YOUR FINAL ANSWER (write ONLY the correct letters/labels separated by commas, no explanation):`;
  }

  // Dạng 3: Câu hỏi không có nhãn A B C D (ô vuông tick [ ] hoặc các dòng trần)
  if (type === 'UNLABELED') {
    return `You are an expert tutor solving a question with unlabeled options/checkboxes listed from top to bottom.
The options have been indexed as [1], [2], [3]... based on their order.

Question: ${question}

Options:
${optionsText}

Task:
- Determine which option(s) are correct.
- If one option is correct, output its index (e.g. "[2]").
- If multiple are correct, output all correct indexes (e.g. "[1], [3]").

YOUR FINAL ANSWER (write ONLY the option index e.g. "[1]" or "[1], [3]", no explanation):`;
  }

  // Dạng 4: Câu trắc nghiệm thông thường (A-Z, 1-9, I-IV...)
  return `You are an expert tutor who solves multiple choice questions accurately across all academic subjects 
(e.g., Computer Science, Programming, Math, Physics, etc.).

Question: ${question}

Options:
${optionsText}

Task:
- Read carefully and think step by step logically to determine the correct answer.
- Output ONLY the option letter/label (${optionLetters}).
- Note: If this question happens to have multiple correct answers, output all of them separated by commas (e.g. "A, C").

YOUR FINAL ANSWER (write ONLY the letter/label, no explanation):`;
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

// Trích xuất đáp án từ response AI - Hỗ trợ A-Z, số, La Mã, đa đáp án, kéo thả code, ô vuông
function extractAnswer(text, parsed = {}) {
  console.log('Raw AI response:', text);
  if (!text) return 'N/A';

  // 1. Loại bỏ các khối suy nghĩ <think>...</think> (nếu dùng DeepSeek R1)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const cleanedUpper = cleaned.toUpperCase();

  // 2. Xử lý trường hợp bài kéo thả từ / điền chỗ trống (FILL_BLANK)
  if (parsed.type === 'FILL_BLANK') {
    const blankMatches = [...cleaned.matchAll(/(?:\[\s*(\d+)\s*\]|(?:\bblank\s*)?(\d+)[\.:\)])\s*[:\->=]?\s*([^|\n,;]+)/gi)];
    if (blankMatches.length > 0) {
      const parts = [];
      const seen = new Set();
      for (const m of blankMatches) {
        const idx = m[1] || m[2];
        const val = m[3].trim().replace(/^[`'"]+|[`'"]+$/g, '');
        if (!seen.has(idx)) {
          seen.add(idx);
          parts.push(`[${idx}] ${val}`);
        }
      }
      if (parts.length > 0) {
        return parts.join(' | ');
      }
    }
    // Nếu AI trả về định dạng [1] x | [2] y sẵn
    const pipeMatch = cleaned.match(/\[\d+\].*?\|.*?\[\d+\].*/);
    if (pipeMatch) {
      return pipeMatch[0].trim();
    }
    // Fallback cho FILL_BLANK: Lấy dòng cuối hoặc rút ngắn
    const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || cleaned;
    return lastLine.replace(/^(?:the\s+)?(?:final\s+)?answer\s*(?:is)?\s*[:\-]?\s*/i, '').substring(0, 120);
  }

  // 3. Xử lý Special keywords độc lập: ELSE, OTHER, NONE, ALL, NONE OF THE ABOVE, ALL OF THE ABOVE
  const specialKeywords = ['NONE OF THE ABOVE', 'ALL OF THE ABOVE', 'ELSE', 'OTHER', 'NONE', 'ALL'];
  for (const keyword of specialKeywords) {
    if (cleanedUpper === keyword || cleanedUpper.startsWith(keyword + ' ') || cleanedUpper.startsWith(keyword + '\n')) {
      return keyword;
    }
  }

  // 4. Bắt cụm NHIỀU ĐÁP ÁN (Multi-answers: e.g. "A, C", "A, B, D", "[1], [3]", "1, 3", "A and C", "A & C")
  // 4.1 Bắt sau "Answer:", "Đáp án:", "Correct answers are:"
  const multiAfterLabelMatch = cleaned.match(/(?:correct\s+answers?|answers?|đáp\s+án)\s*(?:are|is)?\s*[:\-]\s*([A-Za-z0-9\[\]]+(?:\s*[,;&+]\s*[A-Za-z0-9\[\]]+|\s+and\s+[A-Za-z0-9\[\]]+)+)/i);
  if (multiAfterLabelMatch) {
    const rawMulti = multiAfterLabelMatch[1].replace(/\s+and\s+/gi, ', ');
    const items = rawMulti.split(/[,;&+]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    if (items.length > 1) {
      return items.join(', ');
    }
  }

  // 4.2 Bắt trực tiếp toàn chuỗi là multi-answers: e.g. "A, C", "A, B, D", "1, 3", "A and C"
  const directMulti = cleaned.replace(/\s+and\s+/gi, ', ').match(/^([A-Za-z0-9\[\]]+(?:\s*[,;&+]\s*[A-Za-z0-9\[\]]+)+)$/);
  if (directMulti) {
    const items = directMulti[1].split(/[,;&+]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    if (items.length > 1) {
      return items.join(', ');
    }
  }

  // 5. Pattern 0: Đáp án là 1 ký tự duy nhất (A-Z hoặc 0-9)
  if (/^[A-Z0-9]$/.test(cleanedUpper)) {
    return cleanedUpper;
  }

  // 5.1 Pattern số La Mã đứng 1 mình (I, II, III, IV, V, VI...)
  if (/^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/i.test(cleanedUpper)) {
    return cleanedUpper;
  }

  // 5.2 Bắt đầu bằng 1 ký tự rồi có dấu phân cách (như "A)", "B.", "1)", "[A]", "(B)")
  const startsWithItem = cleaned.match(/^[\(\[]?([A-Za-z0-9]|[IVXLCDMivxlcdm]{1,5})[\)\]]?[\s\(\)\.\,\:\n]/);
  if (startsWithItem && startsWithItem[1].length <= 5) {
    return startsWithItem[1].toUpperCase();
  }

  // 6. Tìm cụm "The answer is X" hoặc "correct answer is: X"
  const answerIsPatterns = [
    /(?:correct\s+answers?|answers?)\s*(?:is|are)?\s*[:\-]?\s*([A-Za-z0-9\[\]]+(?:\s*[,;&+]\s*[A-Za-z0-9\[\]]+|\s+and\s+[A-Za-z0-9\[\]]+)+)/i,
    /(?:correct\s+answer|answer)\s+is\s*:\s*([A-Za-z0-9]+)\s*\)/i,
    /(?:correct\s+answer|answer)\s+is\s*:\s*([A-Za-z0-9]+)\b/i,
    /(?:correct\s+answer|answer)\s+is\s+([A-Za-z0-9]+)\s*\)/i,
    /(?:correct\s+answer|answer)\s+is\s+([A-Za-z0-9]+)\b/i,
    /(?:answer|đáp\s+án)\s*:\s*([A-Za-z0-9]+)\s*\)/i,
    /(?:answer|đáp\s+án)\s*:\s*([A-Za-z0-9]+)\b/i,
    /(?:answer|đáp\s+án)\s*:\s*\[([A-Za-z0-9]+)\]/i
  ];

  for (const pattern of answerIsPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const ans = match[1].replace(/\s+and\s+/gi, ', ').trim().toUpperCase();
      return ans;
    }
  }

  // 7. Tìm letter/number trong dấu ngoặc (A) hoặc [B] hoặc [1] gần cuối câu
  const lastPart = cleaned.slice(-120);
  const bracketMatch = lastPart.match(/[\(\[]([A-Za-z0-9]+)[\)\]]/);
  if (bracketMatch && bracketMatch[1].length <= 4) {
    return bracketMatch[1].toUpperCase();
  }

  // 8. Tìm "X)" ở cận cuối câu
  const optionMatch = lastPart.match(/\b([A-Za-z0-9])\s*\)/);
  if (optionMatch) {
    return optionMatch[1].toUpperCase();
  }

  // 9. Letter hoặc number đứng 1 mình ở cuối câu
  const lastWordMatch = cleaned.match(/\b([A-Z0-9])\b\s*$/i);
  if (lastWordMatch) {
    return lastWordMatch[1].toUpperCase();
  }

  // 10. Fallback: Standalone letter / number
  const standaloneLetters = [...cleaned.matchAll(/(?:^|\s)([A-Za-z0-9])(?:\s|$|\.|,|;)/g)];
  if (standaloneLetters.length > 0) {
    const lastLetter = standaloneLetters[standaloneLetters.length - 1][1];
    return lastLetter.toUpperCase();
  }

  return cleaned.substring(0, 80);
}
