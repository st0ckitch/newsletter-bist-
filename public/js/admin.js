// Confirmation dialogs for destructive forms. Inline onsubmit handlers are
// blocked by the CSP (script-src-attr 'none'), so forms declare
// data-confirm="message" instead and this listener enforces it.
document.addEventListener('submit', function (e) {
  var msg = e.target && e.target.getAttribute && e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
  }
});

// Live word counter for article textareas (server enforces the limit too).
function updateWordCount(textarea) {
  var limit = parseInt(textarea.getAttribute('data-word-limit'), 10) || 0;
  var words = (textarea.value.trim().match(/\S+/g) || []).length;
  var form = textarea.closest('form');
  var out = form && form.parentElement.querySelector('[data-word-count]');
  if (!out) out = document.querySelector('[data-word-count]');
  if (out) {
    out.textContent = words + ' / ' + limit + ' words';
    out.style.color = words > limit ? '#c4432e' : '';
    out.style.fontWeight = words > limit ? '700' : '';
  }
}
document.addEventListener('input', function (e) {
  if (e.target && e.target.matches && e.target.matches('textarea[data-word-limit]')) updateWordCount(e.target);
});
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('textarea[data-word-limit]').forEach(updateWordCount);
});
