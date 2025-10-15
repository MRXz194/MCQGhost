// Content Script - Inject UI để hiển thị đáp án

console.log('Content script loaded!');

let answerPopup = null;

// Lắng nghe message từ background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received:', message.type);
  if (message.type === "SHOW_LOADING") {
    showPopup('<span class="mcq-spinner"></span>Analyzing...', "loading");
  } else if (message.type === "SHOW_ANSWER") {
    showPopup(`Answer: ${message.answer}`, "success");
  } else if (message.type === "SHOW_ERROR") {
    showPopup(`Error: ${message.error}`, "error");
  }
});

// Hiển thị popup với đáp án
function showPopup(text, type) {
  console.log('Showing popup:', text, 'Type:', type);
  // Xóa popup cũ nếu có
  if (answerPopup) {
    answerPopup.remove();
  }
  
  // Tạo popup mới
  answerPopup = document.createElement('div');
  answerPopup.className = `mcq-solver-popup mcq-${type}`;
  answerPopup.innerHTML = `
    <div class="mcq-content">
      ${text}
    </div>
    <button class="mcq-close" onclick="this.parentElement.remove()">×</button>
  `;
  
  // Popup được định vị bởi CSS (fixed bottom-left)
  document.body.appendChild(answerPopup);
  
  // Auto-hide sau 10 giây (trừ loading)
  if (type !== "loading") {
    setTimeout(() => {
      if (answerPopup && answerPopup.parentElement) {
        answerPopup.classList.add('fade-out');
        setTimeout(() => answerPopup.remove(), 400);
      }
    }, 10000);
  }
}

// Cho phép đóng popup bằng click vào button
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('mcq-close')) {
    const popup = e.target.parentElement;
    popup.classList.add('fade-out');
    setTimeout(() => popup.remove(), 400);
  }
});

// Keyboard shortcut: Shift key sau khi bôi đen
document.addEventListener('keydown', (e) => {
  // Phím ` để đóng popup
  if (e.key === '`' || e.key === '~') {
    if (answerPopup && answerPopup.parentElement) {
      console.log('Backtick pressed, closing popup...');
      answerPopup.classList.add('fade-out');
      setTimeout(() => {
        if (answerPopup) answerPopup.remove();
      }, 400);
    }
    return;
  }
  
  // Chỉ xử lý khi bấm Ctrl
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight')) {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    // Nếu có text được bôi đen (ít nhất 20 ký tự để chắc là câu hỏi)
    if (selectedText && selectedText.length > 20) {
      console.log('Ctrl pressed with selection, solving MCQ...');
      
      // Hiển thị loading
      showPopup('<span class="mcq-spinner"></span>Analyzing...', "loading");
      
      // Gửi message tới background để solve
      chrome.runtime.sendMessage({
        type: 'SOLVE_MCQ',
        text: selectedText
      });
    }
  }
});
