const key = node => {
  if (node?.nodeType !== 1) return null;
  const liveKey = node.getAttribute('data-live-key');
  if (liveKey) return `k:${liveKey}`;
  if (node.id) return `id:${node.id}`;
  const dataId = node.getAttribute('data-id');
  if (dataId) return `${node.tagName}:${dataId}`;
  return null;
};

function captureScrolls(root) {
  const saved = new Map();
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollTop > 0 || el.scrollLeft > 0) {
      saved.set(el, { top: el.scrollTop, left: el.scrollLeft });
    }
  }
  return saved;
}

function captureSelection(root) {
  const active = document.activeElement;
  if (!active || !root.contains(active)) return null;
  const info = {
    el: active,
    liveKey: key(active),
    name: active.getAttribute?.('name') ?? null,
    tagName: active.tagName,
    start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
  };
  return info;
}

export function patchLiveDom(root, html) {
  if (!root) return;
  const scrolls = captureScrolls(root);
  const sel = captureSelection(root);
  const template = document.createElement('template');
  template.innerHTML = html;

  function patch(current, next) {
    if (current.nodeType !== next.nodeType || (current.nodeType === 1 && current.tagName !== next.tagName)) {
      current.replaceWith(next.cloneNode(true));
      return;
    }
    if (current.nodeType === 3) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    if (current.nodeType !== 1) return;

    const isFormControl = current.matches('input,textarea,select');
    const preserveControl = isFormControl && (current === document.activeElement || current.dataset.userEdited === '1');
    const isDetails = current.tagName === 'DETAILS';

    for (const attribute of [...current.attributes]) {
      if (preserveControl && ['value', 'checked'].includes(attribute.name)) continue;
      if (isDetails && attribute.name === 'open') continue;
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of next.attributes) {
      if (preserveControl && ['value', 'checked'].includes(attribute.name)) continue;
      if (isDetails && attribute.name === 'open') continue;
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    if (current.id === 'solar-stage') return;
    if (isFormControl) {
      if (!preserveControl) {
        if (current.tagName === 'SELECT') children(current, next);
        current.value = next.value;
        if (current.tagName === 'INPUT') current.checked = next.checked;
      }
      return;
    }
    children(current, next);
  }

  function children(current, next) {
    const wanted = [...next.childNodes];
    let position = 0;
    for (const desired of wanted) {
      let existing = current.childNodes[position];
      const desiredKey = key(desired);
      if (desiredKey && key(existing) !== desiredKey) {
        const match = [...current.childNodes].slice(position + 1).find(n => key(n) === desiredKey);
        if (match) {
          current.insertBefore(match, existing ?? null);
          existing = match;
        }
      }
      if (!existing) {
        current.appendChild(desired.cloneNode(true));
      } else if (desiredKey && key(existing) && desiredKey !== key(existing)) {
        current.insertBefore(desired.cloneNode(true), existing);
      } else {
        patch(existing, desired);
      }
      position++;
    }
    while (current.childNodes.length > wanted.length) current.lastChild.remove();
  }

  children(root, template.content);

  for (const [el, pos] of scrolls) {
    if (el.isConnected) {
      el.scrollTop = pos.top;
      el.scrollLeft = pos.left;
    }
  }
  if (sel?.el?.isConnected && document.activeElement !== sel.el) {
    sel.el.focus({ preventScroll: true });
    if (sel.start !== null && sel.end !== null && typeof sel.el.setSelectionRange === 'function') {
      try { sel.el.setSelectionRange(sel.start, sel.end); } catch {}
    }
  }
}
