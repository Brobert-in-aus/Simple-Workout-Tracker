let toastTimer = null;

export function showToast(message) {
  if (!message) return;
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast hidden';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 2800);
}

export function registerGlobalErrorToasts() {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : 'Something went wrong';
    showToast(message);
  });
}

export function moveCursorToEnd(input) {
  const type = input.type;
  input.type = 'text';
  input.setSelectionRange(input.value.length, input.value.length);
  input.type = type;
}

export function attachFirstTapCursorEnd(input) {
  // On iOS Safari the browser places the caret at the tap position AFTER the
  // focus event fires, overriding any cursor move we do in the focus handler.
  // We detect a first-tap (unfocused → focused) via pointerdown, then in the
  // focus handler defer moveCursorToEnd past the browser's own caret placement.
  //
  // We deliberately do NOT call e.preventDefault() here: doing so suppresses
  // the virtual keyboard on iOS and also kills the synthesised click event,
  // which was causing taps on the last set's empty weight input to be
  // misattributed to the "+ Set" button below after a layout shift.
  let pendingCursorEnd = false;
  input.addEventListener('pointerdown', () => {
    pendingCursorEnd = document.activeElement !== input;
  });
  input.addEventListener('focus', () => {
    if (!pendingCursorEnd) return;
    pendingCursorEnd = false;
    // Defer past the browser's native caret-on-tap placement
    requestAnimationFrame(() => moveCursorToEnd(input));
  });
}

function getModalElements() {
  return {
    modal: document.getElementById('progression-modal'),
    title: document.getElementById('progression-title'),
    body: document.getElementById('progression-body'),
  };
}

export function initAppModal() {
  const { modal } = getModalElements();
  const closeBtn = document.getElementById('progression-close');
  if (!modal || !closeBtn || modal.dataset.wired === '1') return;

  closeBtn.addEventListener('click', closeAppModal);
  modal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeAppModal();
    }
  });
  modal.dataset.wired = '1';
}

export function openAppModal(titleText, html) {
  const { modal, title, body } = getModalElements();
  title.textContent = titleText;
  body.innerHTML = html;
  modal.classList.remove('hidden');
}

export function closeAppModal() {
  const { modal } = getModalElements();
  modal.classList.add('hidden');
}
