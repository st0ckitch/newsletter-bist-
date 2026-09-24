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
    var files = Array.prototype.slice.call(input.files || []).slice(0, 4);
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
    // Only the content-photo picker feeds the preview grid - the section-head
    // portrait has its own single-file input and renders separately.
    if (e.target && e.target.matches && e.target.matches('input[name=photos]')) {
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

// "Copy HTML for Mailchimp" on the preview page: fetches the export version
// of the issue (no placeholders, absolute image URLs) and puts it on the
// clipboard for pasting into Mailchimp's code editor. iOS Safari only allows
// clipboard writes inside the tap, so the ClipboardItem is handed the fetch
// as a promise; browsers without that support copy after the fetch instead.
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest && e.target.closest('[data-copy-html]');
  if (!btn) return;
  var url = btn.getAttribute('data-copy-html');
  var original = btn.textContent;
  btn.disabled = true;

  function fetchHtml() {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }
  function viaClipboardItem() {
    if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) {
      return Promise.reject(new Error('no ClipboardItem'));
    }
    try {
      return navigator.clipboard.write([
        new window.ClipboardItem({
          'text/plain': fetchHtml().then(function (t) {
            return new Blob([t], { type: 'text/plain' });
          }),
        }),
      ]);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  function viaText() {
    return fetchHtml().then(function (t) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('copy rejected');
    });
  }

  viaClipboardItem()
    .catch(viaText)
    .then(
      function () {
        btn.textContent = '✓ Copied - paste into Mailchimp';
      },
      function () {
        btn.textContent = original;
        window.alert('Could not copy automatically. Open the preview full size and copy the page source instead.');
      }
    )
    .then(function () {
      btn.disabled = false;
      setTimeout(function () {
        btn.textContent = original;
      }, 4000);
    });
});

// Bulk headshot import: each selected photo is downscaled in the browser
// (~700px JPEG - so folders of multi-MB originals never travel in full),
// then sent one at a time to /api/headshots/import, where the file name is
// matched to a staff member. Results stream into the log as they happen.
(function () {
  var form = document.getElementById('headshot-import');
  if (!form) return;
  var input = form.querySelector('input[type=file]');
  var out = document.getElementById('headshot-import-log');
  var csrfValue = form.querySelector('input[name=_csrf]').value;
  var btn = form.querySelector('button[type=submit]');

  function log(line, color) {
    var p = document.createElement('p');
    p.textContent = line;
    p.style.margin = '2px 0';
    if (color) p.style.color = color;
    out.appendChild(p);
    out.scrollTop = out.scrollHeight;
  }

  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return createImageBitmap(file);
      });
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('unreadable image')); };
      img.src = URL.createObjectURL(file);
    });
  }

  function shrink(file) {
    return decode(file).then(function (img) {
      var w = img.width;
      var h = img.height;
      var scale = Math.min(1, 700 / Math.max(w, h));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('could not convert the image'));
        }, 'image/jpeg', 0.85);
      });
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return log('Choose the photo files first.', '#75809a');
    var overwrite = form.querySelector('input[name=overwrite]').checked ? '1' : '0';
    out.textContent = '';
    btn.disabled = true;
    var i = 0;
    var matched = 0;
    var skipped = 0;

    (function next() {
      if (i >= files.length) {
        btn.disabled = false;
        btn.textContent = 'Import photos';
        log('Done: ' + matched + ' matched and saved, ' + skipped + ' skipped (of ' + files.length + ').', '#1d3061');
        return;
      }
      var file = files[i++];
      btn.textContent = 'Importing ' + i + ' / ' + files.length + '…';
      shrink(file)
        .then(function (blob) {
          var fd = new FormData();
          fd.append('_csrf', csrfValue);
          fd.append('name', file.name);
          fd.append('overwrite', overwrite);
          fd.append('photo', blob, file.name.replace(/\.[^.]+$/, '') + '.jpg');
          return fetch('/api/headshots/import', { method: 'POST', body: fd }).then(function (r) { return r.json(); });
        })
        .then(function (result) {
          if (result.ok) {
            matched++;
            log('✓ ' + file.name + ' → ' + result.matched, '#2e7d52');
          } else {
            skipped++;
            log('✗ ' + file.name + ' - ' + (result.reason || result.error || 'failed'), '#c4432e');
          }
        })
        .catch(function (err) {
          skipped++;
          log('✗ ' + file.name + ' - ' + err.message, '#c4432e');
        })
        .then(next);
    })();
  });
})();

// Drag-and-drop ordering of the certificates table (/awards): grab a row's
// grip, drop it on another row to slide it in above that row, and the new
// order is saved immediately - the newsletter table follows it.
(function () {
  var rows = document.querySelectorAll('tr[data-award-row]');
  if (!rows.length) return;
  var tbody = rows[0].parentElement;
  var csrfEl = document.querySelector('input[name=_csrf]');
  var dragging = null;

  function saveOrder() {
    var ids = Array.prototype.map.call(tbody.querySelectorAll('tr[data-award-row]'), function (r) {
      return parseInt(r.getAttribute('data-award-row'), 10);
    });
    fetch('/awards/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfEl ? csrfEl.value : '' },
      body: JSON.stringify({ ids: ids }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(); })
      .catch(function () {
        window.alert('Could not save the new order - reloading the page.');
        window.location.reload();
      });
  }

  Array.prototype.forEach.call(rows, function (tr) {
    var grip = tr.querySelector('.drag-grip');
    if (!grip) return;
    grip.setAttribute('draggable', 'true');
    grip.addEventListener('dragstart', function (e) {
      dragging = tr;
      tr.style.opacity = '0.4';
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tr.getAttribute('data-award-row'));
      }
    });
    grip.addEventListener('dragend', function () {
      if (dragging) dragging.style.opacity = '';
      Array.prototype.forEach.call(document.querySelectorAll('tr.row-drop'), function (r) {
        r.classList.remove('row-drop');
      });
      dragging = null;
    });
    tr.addEventListener('dragover', function (e) {
      if (!dragging || dragging === tr) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      tr.classList.add('row-drop');
    });
    tr.addEventListener('dragleave', function () {
      tr.classList.remove('row-drop');
    });
    tr.addEventListener('drop', function (e) {
      tr.classList.remove('row-drop');
      if (!dragging || dragging === tr) return;
      e.preventDefault();
      tbody.insertBefore(dragging, tr); // lands above the row it was dropped on
      dragging.style.opacity = '';
      saveOrder();
    });
  });
})();
