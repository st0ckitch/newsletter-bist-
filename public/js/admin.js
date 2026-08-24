// Confirmation dialogs for destructive forms. Inline onsubmit handlers are
// blocked by the CSP (script-src-attr 'none'), so forms declare
// data-confirm="message" instead and this listener enforces it.
document.addEventListener('submit', function (e) {
  var msg = e.target && e.target.getAttribute && e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
  }
});
