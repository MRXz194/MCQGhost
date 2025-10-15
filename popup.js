// Popup Script - Xử lý settings

// Load settings khi mở popup
document.addEventListener('DOMContentLoaded', async () => {
  const config = await chrome.storage.sync.get(['ollamaUrl', 'modelName']);
  
  document.getElementById('ollamaUrl').value = config.ollamaUrl || 'http://localhost:11434';
  document.getElementById('modelName').value = config.modelName || 'llama3.1:8b-instruct-q4_0';
});

// Lưu settings
document.getElementById('saveBtn').addEventListener('click', async () => {
  const ollamaUrl = document.getElementById('ollamaUrl').value.trim();
  const modelName = document.getElementById('modelName').value;
  
  await chrome.storage.sync.set({
    ollamaUrl,
    modelName
  });
  
  showStatus('Đã lưu cấu hình!', 'success');
});

// Test kết nối
document.getElementById('testBtn').addEventListener('click', async () => {
  const ollamaUrl = document.getElementById('ollamaUrl').value.trim();
  const modelName = document.getElementById('modelName').value;
  
  try {
    showStatus('Đang kiểm tra kết nối...', 'success');
    
    const response = await fetch(`${ollamaUrl}/api/tags`);
    
    if (!response.ok) {
      throw new Error('Không thể kết nối đến Ollama');
    }
    
    const data = await response.json();
    const models = data.models || [];
    const modelExists = models.some(m => m.name === modelName);
    
    if (modelExists) {
      showStatus(`Kết nối thành công! Model "${modelName}" đã sẵn sàng.`, 'success');
    } else {
      showStatus(`Kết nối OK nhưng model "${modelName}" chưa được pull. Chạy: ollama pull ${modelName}`, 'error');
    }
  } catch (error) {
    showStatus(`Lỗi: ${error.message}. Hãy đảm bảo Ollama đang chạy!`, 'error');
  }
});

// Hiển thị status message
function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 5000);
}
