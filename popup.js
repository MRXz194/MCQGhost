// Popup Script - Xử lý settings

// Load settings khi mở popup + xử lý Custom model
document.addEventListener('DOMContentLoaded', async () => {
  const config = await chrome.storage.sync.get(['ollamaUrl', 'modelName', 'customModelName']);

  const ollamaUrlInput = document.getElementById('ollamaUrl');
  const modelSelect = document.getElementById('modelName');
  const customGroup = document.getElementById('customModelGroup');
  const customInput = document.getElementById('customModelInput');

  ollamaUrlInput.value = config.ollamaUrl || 'http://localhost:11434';

  const storedModel = config.modelName || 'llama3.1:8b-instruct-q4_0';
  const predefinedOption = modelSelect.querySelector(`option[value="${CSS.escape(storedModel)}"]`);

  // Nếu model không có trong danh sách -> chọn Custom và hiển thị input
  if (!predefinedOption) {
    modelSelect.value = '__custom__';
    customGroup.style.display = '';
    customInput.value = storedModel || config.customModelName || '';
  } else {
    modelSelect.value = storedModel;
    customGroup.style.display = 'none';
    customInput.value = config.customModelName || '';
  }

  // Toggle hiển thị input khi đổi select
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value === '__custom__') {
      customGroup.style.display = '';
      if (!customInput.value && config.customModelName) {
        customInput.value = config.customModelName;
      }
    } else {
      customGroup.style.display = 'none';
    }
  });
});

// Lưu settings
document.getElementById('saveBtn').addEventListener('click', async () => {
  const ollamaUrl = document.getElementById('ollamaUrl').value.trim();
  const selectVal = document.getElementById('modelName').value;
  const customVal = document.getElementById('customModelInput').value.trim();

  let effectiveModel = selectVal;
  const toSave = { ollamaUrl };

  if (selectVal === '__custom__') {
    if (!customVal) {
      showStatus('Vui lòng nhập tên model tùy chỉnh!', 'error');
      return;
    }
    effectiveModel = customVal;
    toSave.customModelName = customVal;
  } else {
    toSave.customModelName = '';
  }

  toSave.modelName = effectiveModel;

  await chrome.storage.sync.set(toSave);
  showStatus('Đã lưu cấu hình!', 'success');
});

// Test kết nối
document.getElementById('testBtn').addEventListener('click', async () => {
  const ollamaUrl = document.getElementById('ollamaUrl').value.trim();
  const selectVal = document.getElementById('modelName').value;
  const customVal = document.getElementById('customModelInput').value.trim();

  const modelName = (selectVal === '__custom__') ? customVal : selectVal;
  if (selectVal === '__custom__' && !customVal) {
    showStatus('Vui lòng nhập tên model tùy chỉnh trước khi test!', 'error');
    return;
  }

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
