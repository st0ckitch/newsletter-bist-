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

// Live article preview beside the news form: renders the draft through the
// real newsletter template (POST /news/preview.html) as the user types.
(function () {
  var frame = document.getElementById('article-preview');
  var form = document.querySelector('form[action^="/news"]');
  if (!frame || !form) return;
  var csrfInput = form.querySelector('input[name=_csrf]');
  var filePhotos = []; // downscaled data URIs of newly selected files

  function existingPhotos() {
    return Array.prototype.map.call(document.querySelectorAll('.photo-grid img'), function (img) {
      return img.getAttribute('src');
    });
  }

  function readFiles(input, cb) {
    var files = Array.prototype.slice.call(input.files || []).slice(0, 12);
    if (!files.length) return cb([]);
    var out = [];
    var left = files.length;
    files.forEach(function (file, idx) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, 900 / img.width);
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          out[idx] = canvas.toDataURL('image/jpeg', 0.8);
          if (--left === 0) cb(out.filter(Boolean));
        };
        img.onerror = function () {
          if (--left === 0) cb(out.filter(Boolean));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  var timer = null;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var titleEl = form.querySelector('input[name=title]');
      var bodyEl = form.querySelector('textarea[name=body]');
      var sectionEl = form.querySelector('select[name=section]');
      fetch('/news/preview.html', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfInput ? csrfInput.value : '' },
        body: JSON.stringify({
          title: titleEl ? titleEl.value : '',
          body: bodyEl ? bodyEl.value : '',
          sectionLabel: sectionEl ? sectionEl.options[sectionEl.selectedIndex].text : '',
          photos: existingPhotos().concat(filePhotos),
        }),
      })
        .then(function (r) { return r.text(); })
        .then(function (html) { frame.srcdoc = html; })
        .catch(function () { /* preview is best-effort */ });
    }, 350);
  }

  form.addEventListener('input', refresh);
  form.addEventListener('change', function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type=file]')) {
      readFiles(e.target, function (uris) {
        filePhotos = uris;
        refresh();
      });
    }
  });
  refresh();
})();

// Staff import: picking a CSV file fills the paste box (the form itself
// posts plain text, so no multipart handling is needed).
(function () {
  var fileInput = document.getElementById('csv-file');
  var textarea = document.getElementById('csv-text');
  if (!fileInput || !textarea) return;
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      textarea.value = (textarea.value ? textarea.value.replace(/\s+$/, '') + '\n' : '') + reader.result;
    };
    reader.readAsText(file);
  });
})();

// The template-section dropdown only offers the positions the chosen area
// allows (Whole School = W, Primary = left column, Secondary = right column,
// Sixth Form = X, Co-Curricular = Y).
function syncSlotChoices(sectionSelect) {
  var form = sectionSelect.form;
  var slotSelect = form && form.querySelector('select[name=slot]');
  if (!slotSelect) return;
  var opt = sectionSelect.options[sectionSelect.selectedIndex];
  var allowed = ((opt && opt.getAttribute('data-slots')) || '').split(',').filter(Boolean);
  if (!allowed.length) return;
  Array.prototype.forEach.call(slotSelect.options, function (o) {
    var ok = allowed.indexOf(o.value) !== -1;
    o.hidden = !ok;
    o.disabled = !ok;
  });
  if (allowed.indexOf(slotSelect.value) === -1) slotSelect.value = allowed[0];
}
document.addEventListener('change', function (e) {
  if (e.target && e.target.matches && e.target.matches('select[name=section][data-slots-control]')) {
    syncSlotChoices(e.target);
  }
});
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('select[name=section][data-slots-control]').forEach(syncSlotChoices);
});
