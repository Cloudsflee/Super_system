(function bootAiWorkspace() {
  window.addEventListener('error', showBootError);
  window.addEventListener('unhandledrejection', (event) => showBootError(event.reason || event));

  var version = Date.now();
  var url = './app.js?v=' + version;

  import(url).catch(showBootError);
})();

function showBootError(error) {
  var message = error && (error.stack || error.message || String(error));
  var health = document.querySelector('#health-pill');
  var view = document.querySelector('#view');
  if (health) {
    health.textContent = 'frontend: error';
    health.className = 'pill warn';
  }
  if (!view) return;
  view.innerHTML = [
    '<article class="card">',
    '<h3>前端启动失败</h3>',
    '<p class="muted">app.js 没有成功执行，所以按钮事件没有绑定。请按 Ctrl+F5 强制刷新；如果仍失败，把下面错误发给开发者。</p>',
    '<pre class="code">' + escapeHtml(message || 'unknown frontend startup error') + '</pre>',
    '</article>'
  ].join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, function replaceChar(char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char];
  });
}
