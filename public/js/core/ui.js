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
  input.addEventListener('pointerdown', (e) => {
    if (document.activeElement !== input) {
      e.preventDefault();
      input.focus();
      requestAnimationFrame(() => moveCursorToEnd(input));
    }
  }, { passive: false });
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
