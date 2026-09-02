// MedSafe PWA: 註冊 Service Worker（僅在支援且非 file:// 協定時執行）
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('MedSafe: Service Worker 註冊失敗', err);
    });
  });
}
