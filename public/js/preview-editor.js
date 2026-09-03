/* The Roar - live preview editor.
   Runs inside the newsletter preview document when a manager opens it with
   ?edit=1: click any annotated text to edit it in place, click photos to
   replace or remove them, add photos straight into an article.
   Transport: the admin server API (fetch + CSRF header), or - when the page
   runs inside the interactive demo - the parent window's DemoEditor bridge. */
(function () {
  'use strict';

  var MAX_WORDS =
    parseInt((document.body && document.body.getAttribute('data-max-words')) || '', 10) || 100;
  var demo = null;
  try {
    demo = window.parent && window.parent !== window && window.parent.DemoEditor ? window.parent.DemoEditor : null;
  } catch (e) {
    demo = null;
  }

  /* ---------------- transport ---------------- */

  // The page's CSP forbids inline scripts, so the CSRF token arrives as an
  // attribute on <body> rather than a window.CSRF assignment.
  var CSRF = (document.body && document.body.getAttribute('data-csrf')) || window.CSRF || '';

  function api(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: 'Unexpected server response.' };
      });
    });
  }

  function apiUpload(path, fields, file) {
    var form = new FormData();
    Object.keys(fields).forEach(function (k) {
      form.append(k, fields[k]);
    });
    form.append('photo', file);
    return fetch(path, { method: 'POST', headers: { 'x-csrf-token': CSRF }, body: form }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: 'Unexpected server response.' };
      });
    });
  }

  // Demo mode hands the parent a downscaled data URI instead of uploading.
  function fileToDataUri(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, 1200 / img.width);
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = function () {
          reject(new Error('That file is not a valid image.'));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  var T = {
    saveText: function (target, value) {
      if (demo) return Promise.resolve(demo.saveText(target, value));
      return api('/api/edit/text', { target: target, value: value });
    },
    addPhoto: function (newsId, file) {
      if (demo)
        return fileToDataUri(file).then(function (uri) {
          return demo.addPhoto(newsId, uri);
        });
      return apiUpload('/api/edit/photo/add', { news_id: newsId }, file);
    },
    replacePhoto: function (ref, file) {
      if (demo)
        return fileToDataUri(file).then(function (uri) {
          return demo.replacePhoto(ref, uri);
        });
      if (ref.indexOf('principal:') === 0) {
        return apiUpload('/api/edit/principal-photo', { week: ref.split(':')[1] }, file);
      }
      return apiUpload('/api/edit/photo/replace', { photo_id: ref }, file);
    },
    deletePhoto: function (ref) {
      if (demo) return Promise.resolve(demo.deletePhoto(ref));
      if (ref.indexOf('principal:') === 0) {
        return api('/api/edit/principal-photo/delete', { week: ref.split(':')[1] });
      }
      return api('/api/edit/photo/delete', { photo_id: ref });
    },
    moveSlot: function (newsId, slot) {
      if (demo) return Promise.resolve(demo.moveSlot(newsId, slot));
      return api('/api/edit/slot', { news_id: newsId, slot: slot });
    },
    setMasthead: function (file) {
      if (demo)
        return fileToDataUri(file).then(function (uri) {
          return demo.setMastheadPhoto(uri);
        });
      return apiUpload('/api/edit/masthead-photo', {}, file);
    },
    deleteMasthead: function () {
      if (demo) return Promise.resolve(demo.deleteMastheadPhoto());
      return api('/api/edit/masthead-photo/delete', {});
    },
    refresh: function () {
      if (demo) return demo.refresh();
      window.location.reload();
    },
  };

  /* ---------------- chrome ---------------- */

  var style = document.createElement('style');
  style.textContent =
    '[data-edit]{cursor:text; transition:box-shadow .12s; border-radius:4px;}' +
    '[data-edit]:hover{box-shadow:0 0 0 2px rgba(217,164,65,.85); background:rgba(217,164,65,.08);}' +
    '[data-edit].re-editing{box-shadow:0 0 0 2px #1B2F5B; background:#fff; color:#2E3A4E; outline:none; min-width:40px; display:inline-block;}' +
    'div[data-edit].re-editing{display:block;}' +
    '[data-photo]{cursor:pointer;}' +
    '.re-photo-wrap{position:relative; display:inline-block; max-width:100%;}' +
    '.re-photo-tools{position:absolute; top:6px; right:6px; display:none; gap:4px;}' +
    '.re-photo-wrap:hover .re-photo-tools{display:flex;}' +
    '.re-photo-wrap:hover img{outline:2px solid rgba(217,164,65,.9);}' +
    '.re-btn{font-family:FiraGO,Arial,sans-serif; font-size:11px; font-weight:600; border:none; border-radius:6px; padding:4px 9px; cursor:pointer; background:#101E3C; color:#fff;}' +
    '.re-btn.re-danger{background:#B23A32;}' +
    '.re-add{display:inline-block; margin:10px 0 4px 0; border:2px dashed #C9BFA8; background:#FDFBF3; color:#75809A; font-family:FiraGO,Arial,sans-serif; font-size:12px; font-weight:600; border-radius:8px; padding:8px 14px; cursor:pointer;}' +
    '.re-add:hover{border-color:#D9A441; color:#B9862B;}' +
    '.re-bar{position:sticky; top:0; z-index:60; background:#101E3C; color:#fff; font-family:FiraGO,Arial,sans-serif; font-size:12.5px; padding:9px 16px; display:flex; align-items:center; gap:10px; box-shadow:0 2px 10px rgba(0,0,0,.25);}' +
    '.re-bar b{color:#D9A441; font-weight:600; letter-spacing:1px;}' +
    '.re-status{margin-left:auto; font-size:12px; color:#9fb0d0;}' +
    '.re-status.re-ok{color:#7ddba3;}' +
    '.re-toast{position:fixed; bottom:18px; left:50%; transform:translateX(-50%); z-index:70; background:#B23A32; color:#fff; font-family:FiraGO,Arial,sans-serif; font-size:13px; padding:10px 18px; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.3); opacity:0; transition:opacity .2s;}' +
    '.re-toast.re-show{opacity:1;}' +
    '[data-masthead]{position:relative;}' +
    '.re-mast-tools{position:absolute; top:8px; left:8px; display:none; gap:4px; z-index:5;}' +
    '[data-masthead]:hover .re-mast-tools{display:flex;}' +
    '[data-masthead]:hover{outline:2px solid rgba(217,164,65,.9); outline-offset:-2px;}' +
    '[data-drag-bar]{cursor:grab;}' +
    '.re-grip{display:inline-block; margin-right:8px; color:rgba(255,255,255,.85); font-size:12px; letter-spacing:1px; vertical-align:1px;}' +
    '.re-drop{outline:3px dashed #D9A441 !important; outline-offset:3px; border-radius:10px;}' +
    '.re-dragging{opacity:.45;}';
  document.head.appendChild(style);

  var bar = document.createElement('div');
  bar.className = 're-bar';
  bar.innerHTML =
    '<b>LIVE EDITOR</b><span>Click any text to edit it. Hover a photo to replace or remove it. Drag a section by its ⠿ header onto another section to swap them. Changes save instantly.</span><span class="re-status" id="re-status"></span>';
  document.body.insertBefore(bar, document.body.firstChild);
  var statusEl = bar.querySelector('#re-status');

  var toast = document.createElement('div');
  toast.className = 're-toast';
  document.body.appendChild(toast);
  var toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('re-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove('re-show');
    }, 3500);
  }
  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = 're-status' + (ok ? ' re-ok' : '');
    if (ok)
      setTimeout(function () {
        if (statusEl.textContent === text) statusEl.textContent = '';
      }, 2000);
  }

  /* ---------------- text editing ---------------- */

  var active = null; // { el, original }

  function isBody(target) {
    return /:body$/.test(target);
  }

  function startEdit(el) {
    if (active && active.el === el) return;
    finishEdit(true);
    active = { el: el, original: el.innerHTML };
    // Links turn back into their editable source - [label](url) or the bare
    // URL - so they survive the edit round-trip (Esc restores the original).
    el.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      var label = a.textContent;
      a.replaceWith(document.createTextNode(label === href ? href : '[' + label + '](' + href + ')'));
    });
    el.classList.add('re-editing');
    el.setAttribute('contenteditable', 'true');
    el.focus();
  }

  function cancelEdit() {
    if (!active) return;
    active.el.innerHTML = active.original;
    stopEditing();
  }

  function stopEditing() {
    if (!active) return;
    active.el.removeAttribute('contenteditable');
    active.el.classList.remove('re-editing');
    active = null;
  }

  function finishEdit(save) {
    if (!active) return;
    if (!save) return cancelEdit();
    var el = active.el;
    var target = el.getAttribute('data-edit');
    var value = el.innerText.replace(/ /g, ' ').trim();
    if (!isBody(target)) value = value.replace(/\s*\n\s*/g, ' ');
    if (isBody(target)) {
      var words = (value.match(/\S+/g) || []).length;
      if (words > MAX_WORDS) {
        showToast('Article text is limited to ' + MAX_WORDS + ' words - currently ' + words + '. Keep editing or press Esc to undo.');
        el.focus();
        return;
      }
    }
    var original = active.original;
    stopEditing();
    setStatus('Saving…');
    T.saveText(target, value).then(function (res) {
      if (res && res.ok) {
        setStatus('Saved ✓', true);
      } else {
        el.innerHTML = original;
        setStatus('');
        showToast((res && res.error) || 'Could not save - try again.');
      }
    });
  }

  document.addEventListener('mousedown', function (e) {
    if (active && !active.el.contains(e.target)) finishEdit(true);
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-edit]') : null;
    if (el) {
      e.preventDefault();
      startEdit(el);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (!isBody(active.el.getAttribute('data-edit')) || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finishEdit(true);
    }
  });

  /* ---------------- photos ---------------- */

  function pickFile(cb) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/gif';
    input.onchange = function () {
      if (input.files && input.files[0]) cb(input.files[0]);
    };
    input.click();
  }

  function handle(resPromise, busyLabel) {
    setStatus(busyLabel || 'Saving…');
    resPromise.then(function (res) {
      if (res && res.ok) {
        setStatus('Saved ✓', true);
        T.refresh();
      } else {
        setStatus('');
        showToast((res && res.error) || 'Could not save - try again.');
      }
    });
  }

  document.querySelectorAll('img[data-photo]').forEach(function (img) {
    var ref = img.getAttribute('data-photo');
    var wrap = document.createElement('span');
    wrap.className = 're-photo-wrap';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    var tools = document.createElement('span');
    tools.className = 're-photo-tools';
    var replace = document.createElement('button');
    replace.className = 're-btn';
    replace.textContent = 'Replace';
    replace.onclick = function (e) {
      e.stopPropagation();
      pickFile(function (file) {
        handle(T.replacePhoto(ref, file), 'Uploading…');
      });
    };
    var remove = document.createElement('button');
    remove.className = 're-btn re-danger';
    remove.textContent = 'Remove';
    remove.onclick = function (e) {
      e.stopPropagation();
      handle(T.deletePhoto(ref), 'Removing…');
    };
    tools.appendChild(replace);
    tools.appendChild(remove);
    wrap.appendChild(tools);
  });

  document.querySelectorAll('[data-add-photo]').forEach(function (card) {
    var newsId = card.getAttribute('data-add-photo');
    var btn = document.createElement('button');
    btn.className = 're-add';
    btn.textContent = '+ Add photo';
    btn.onclick = function () {
      pickFile(function (file) {
        handle(T.addPhoto(newsId, file), 'Uploading…');
      });
    };
    card.appendChild(btn);
  });

  document.querySelectorAll('[data-masthead]').forEach(function (mast) {
    var hasBg = !mast.hasAttribute('data-no-bg');
    var tools = document.createElement('span');
    tools.className = 're-mast-tools';
    var set = document.createElement('button');
    set.className = 're-btn';
    set.textContent = hasBg ? 'Replace background' : '+ Add background image';
    set.onclick = function (e) {
      e.stopPropagation();
      pickFile(function (file) {
        handle(T.setMasthead(file), 'Uploading…');
      });
    };
    tools.appendChild(set);
    if (hasBg) {
      var clear = document.createElement('button');
      clear.className = 're-btn re-danger';
      clear.textContent = 'Remove background';
      clear.onclick = function (e) {
        e.stopPropagation();
        handle(T.deleteMasthead(), 'Removing…');
      };
      tools.appendChild(clear);
    }
    mast.appendChild(tools);
  });

  document.querySelectorAll('[data-principal-week][data-no-portrait]').forEach(function (card) {
    var week = card.getAttribute('data-principal-week');
    var btn = document.createElement('button');
    btn.className = 're-add';
    btn.textContent = '+ Add portrait photo';
    btn.onclick = function () {
      pickFile(function (file) {
        handle(T.replacePhoto('principal:' + week, file), 'Uploading…');
      });
    };
    card.appendChild(btn);
  });

  /* ---------------- section drag-and-drop (slots D-I) ---------------- */

  var CONTENT_LETTERS = ['D', 'E', 'F', 'G', 'H', 'I'];
  var dragState = null;

  document.querySelectorAll('[data-slot-block]').forEach(function (block) {
    var letter = block.getAttribute('data-slot-block');
    if (CONTENT_LETTERS.indexOf(letter) === -1) return;

    // Every D-I block - articles and empty placeholders - accepts drops.
    function over(e) {
      if (!dragState || dragState.block === block) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      block.classList.add('re-drop');
    }
    block.addEventListener('dragover', over);
    block.addEventListener('dragenter', over);
    block.addEventListener('dragleave', function () {
      block.classList.remove('re-drop');
    });
    block.addEventListener('drop', function (e) {
      block.classList.remove('re-drop');
      if (!dragState || dragState.block === block) return;
      e.preventDefault();
      var target = block.getAttribute('data-slot-block');
      var state = dragState;
      dragState = null;
      if (target !== state.slot) handle(T.moveSlot(state.id, target), 'Moving section…');
    });

    // Articles drag by their colored header bar.
    var barEl = block.querySelector('[data-drag-bar]');
    if (barEl) {
      barEl.setAttribute('draggable', 'true');
      var grip = document.createElement('span');
      grip.className = 're-grip';
      grip.textContent = '⠿';
      grip.title = 'Drag onto another section to swap';
      barEl.insertBefore(grip, barEl.firstChild);
      barEl.addEventListener('dragstart', function (e) {
        dragState = { id: barEl.getAttribute('data-drag-bar'), slot: letter, block: block };
        block.classList.add('re-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try {
            e.dataTransfer.setData('text/plain', dragState.id);
          } catch (err) {
            /* older engines */
          }
        }
      });
      barEl.addEventListener('dragend', function () {
        dragState = null;
        document.querySelectorAll('.re-drop, .re-dragging').forEach(function (b) {
          b.classList.remove('re-drop');
          b.classList.remove('re-dragging');
        });
      });
    }
  });
})();
