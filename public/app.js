const state = {
  jobs: [],
  resumeLoaded: false,
  query: '',
  statusFilter: 'active',
  sortBy: 'score',
  showHidden: false,
  fetchedAt: null
};

const jobsEl = document.querySelector('#jobs');
const resumePanel = document.querySelector('#resumePanel');
const fetchedNote = document.querySelector('#fetchedNote');
const uploadBtn = document.querySelector('#uploadBtn');
const template = document.querySelector('#jobTemplate');
const skeletonTemplate = document.querySelector('#skeletonTemplate');
const fileInput = document.querySelector('#resume');
const toggleHidden = document.querySelector('#toggleHidden');
const refreshButton = document.querySelector('#refresh');
const modalOverlay = document.querySelector('#analysisModal');
const modalBody = document.querySelector('#modalBody');
const modalClose = document.querySelector('#modalClose');

let lastFocused = null;

refreshButton.addEventListener('click', () => loadJobs(true));
document.querySelector('#query').addEventListener('input', debounce((event) => {
  state.query = event.target.value.toLowerCase();
  render();
}, 150));
document.querySelector('#statusFilter').addEventListener('change', (event) => {
  state.statusFilter = event.target.value;
  render();
});
document.querySelector('#sortBy').addEventListener('change', (event) => {
  state.sortBy = event.target.value;
  render();
});
toggleHidden.addEventListener('click', () => {
  state.showHidden = !state.showHidden;
  toggleHidden.classList.toggle('is-on', state.showHidden);
  toggleHidden.setAttribute('aria-pressed', String(state.showHidden));
  render();
});
// One control: the button opens the picker, and choosing a file uploads it.
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadResume();
});

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (event) => {
  if (event.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalOverlay.hidden) closeModal();
});

renderSkeletons();
loadResume();
loadJobs(false);

async function loadJobs(refresh) {
  if (refresh) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
    renderSkeletons();
  }
  try {
    const response = await fetch(`/api/jobs${refresh ? '?refresh=1' : ''}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load jobs.');
    state.jobs = data.jobs;
    state.resumeLoaded = data.resumeLoaded;
    state.fetchedAt = data.fetchedAt;
    render();
  } catch (error) {
    if (state.jobs.length) {
      toast(error.message, 'error');
    } else {
      showEmpty(error.message);
    }
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh';
  }
}

async function loadResume() {
  try {
    const response = await fetch('/api/resume');
    const data = await response.json();
    if (!data.resumeLoaded) return;
    renderResume(data);
  } catch {
    // Resume line just stays in its default "No resume" state.
  }
}

async function uploadResume() {
  const file = fileInput.files[0];
  if (!file) return;
  const body = new FormData();
  body.append('resume', file);
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading…';
  resumePanel.textContent = 'Reading resume…';
  try {
    const response = await fetch('/api/resume', { method: 'POST', body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Resume upload failed.');
    renderResume({ resumeLoaded: true, ...data });
    await loadJobs(false);
    toast('Resume uploaded — scores updated.');
  } catch (error) {
    resumePanel.textContent = error.message;
    toast(error.message, 'error');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload resume';
    // Clear it so picking the same file again still fires a change event.
    fileInput.value = '';
  }
}

async function setStatus(id, status) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  // Clicking the already-active status button clears it back to "new".
  const nextStatus = job.status === status ? 'new' : status;
  const previousStatus = job.status;
  job.status = nextStatus;
  render();
  try {
    const response = await fetch(`/api/jobs/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Could not update status.');
    }
  } catch (error) {
    job.status = previousStatus;
    render();
    toast(error.message, 'error');
  }
}

// Claude is only ever called here, in direct response to an Analyze click.
async function analyzeJob(job, triggerButton) {
  lastFocused = triggerButton;
  if (job.aiAnalysis) {
    openModal(jobModalContent(job));
    return;
  }
  openModal(loadingModalContent(job));
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds: [job.id] })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Claude analysis failed.');
    job.aiAnalysis = data.analyses[job.id];
    openModal(jobModalContent(job));
    render();
  } catch (error) {
    openModal(errorModalContent(job, error.message));
  }
}

function renderResume(data) {
  resumePanel.textContent = `${data.filename} · ${relativeDate(data.uploadedAt)}`;
}

function visibleJobs() {
  return state.jobs.filter((job) => {
    const text = [job.company, job.title, job.locations.join(' '), job.category, job.relevance.join(' ')].join(' ').toLowerCase();
    const statusMatch = state.statusFilter === 'all'
      || (state.statusFilter === 'active' && job.status !== 'applied')
      || job.status === state.statusFilter;
    // Hidden jobs are excluded unless the "Show hidden" toggle is on.
    const hiddenMatch = job.status !== 'dismissed' || state.showHidden;
    return statusMatch && hiddenMatch && text.includes(state.query);
  });
}

function sortJobs(jobs, sortBy) {
  const sorted = [...jobs];
  if (sortBy === 'company') {
    sorted.sort((a, b) => a.company.localeCompare(b.company));
  } else if (sortBy === 'date') {
    sorted.sort((a, b) => new Date(b.dateUpdated || 0) - new Date(a.dateUpdated || 0));
  } else {
    sorted.sort((a, b) => b.score.total - a.score.total);
  }
  return sorted;
}

function render() {
  const jobs = sortJobs(visibleJobs(), state.sortBy);
  fetchedNote.textContent = state.fetchedAt ? `Feed updated ${relativeDate(state.fetchedAt)}` : '';

  jobsEl.innerHTML = '';
  if (!jobs.length) {
    showEmpty(
      state.jobs.length ? 'Nothing matches' : 'No postings yet',
      state.jobs.length ? 'Try clearing the search or changing the filter.' : 'Hit Refresh to fetch the latest listings.'
    );
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const job of jobs) {
    fragment.append(renderJob(job));
  }
  jobsEl.append(fragment);
}

function renderJob(job) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.status = job.status;

  const titleLink = node.querySelector('.title-link');
  titleLink.textContent = job.title;
  titleLink.href = job.url;
  titleLink.title = job.title;

  node.querySelector('.job-sub').innerHTML = [
    `<b>${escapeHtml(job.company)}</b>`,
    escapeHtml(job.locations.join(', ') || 'Location unknown'),
    job.dateUpdated ? escapeHtml(relativeDate(job.dateUpdated)) : ''
  ].filter(Boolean).join(' · ');

  node.querySelectorAll('button[data-status]').forEach((button) => {
    button.classList.toggle('is-active', job.status === button.dataset.status);
    // A hidden job's Hide button becomes the way to put it back.
    if (button.dataset.status === 'dismissed') {
      button.textContent = job.status === 'dismissed' ? 'Unhide' : 'Hide';
    }
    button.addEventListener('click', () => setStatus(job.id, button.dataset.status));
  });

  const analyzeButton = node.querySelector('[data-action="analyze"]');
  analyzeButton.textContent = job.aiAnalysis ? 'View' : 'Analyze';
  analyzeButton.addEventListener('click', () => analyzeJob(job, analyzeButton));

  return node;
}

function scoreTier(total) {
  if (total >= 70) return { key: 'strong', label: 'Strong match' };
  if (total >= 45) return { key: 'mid', label: 'Fair match' };
  return { key: 'weak', label: 'Weak match' };
}

function listBlock(title, items) {
  if (!items?.length) return '';
  return `<section><strong>${escapeHtml(title)}</strong><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
}

// Header shared by every modal state, carrying the local relevance score —
// the only place it is surfaced.
function modalHeader(job) {
  const tier = scoreTier(job.score.total);
  return `
    <h4 id="modalTitle">${escapeHtml(job.title)}</h4>
    <p class="modal-company">${escapeHtml(job.company)}</p>
    <p class="modal-relevance" data-tier="${tier.key}">
      Relevance <b>${job.score.total}</b><span>/100</span> · ${escapeHtml(tier.label)}
    </p>
  `;
}

function jobModalContent(job) {
  const analysis = job.aiAnalysis;
  return `
    ${modalHeader(job)}
    <div class="modal-verdict"><strong>${Number(analysis.score || 0)}</strong> ${escapeHtml(analysis.verdict || 'Reviewed')}</div>
    ${listBlock('Strengths', analysis.strengths || [])}
    ${listBlock('Gaps', analysis.gaps || [])}
    ${listBlock('Resume edits', analysis.resume_edits || [])}
    ${analysis.application_angle ? `<section><strong>Application angle</strong><p>${escapeHtml(analysis.application_angle)}</p></section>` : ''}
  `;
}

function loadingModalContent(job) {
  return `
    ${modalHeader(job)}
    <div class="modal-loading">
      <div class="spinner" aria-hidden="true"></div>
      <p>Weighing this posting against your resume…</p>
    </div>
  `;
}

function errorModalContent(job, message) {
  return `
    ${modalHeader(job)}
    <p>${escapeHtml(message)}</p>
  `;
}

function openModal(html) {
  modalBody.innerHTML = html;
  modalOverlay.hidden = false;
  modalClose.focus();
}

function closeModal() {
  modalOverlay.hidden = true;
  modalBody.innerHTML = '';
  if (lastFocused) {
    lastFocused.focus();
    lastFocused = null;
  }
}

function renderSkeletons() {
  jobsEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 6; i++) {
    fragment.append(skeletonTemplate.content.firstElementChild.cloneNode(true));
  }
  jobsEl.append(fragment);
}

function showEmpty(headline, detail) {
  jobsEl.innerHTML = `
    <div class="empty-state">
      <strong>${escapeHtml(headline)}</strong>
      ${detail ? `<span>${escapeHtml(detail)}</span>` : ''}
    </div>
  `;
}

function toast(message, kind = 'info') {
  const toastRoot = document.querySelector('#toast');
  const item = document.createElement('div');
  item.className = `toast-item${kind === 'error' ? ' error' : ''}`;
  item.textContent = message;
  toastRoot.append(item);
  setTimeout(() => item.remove(), 4000);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function relativeDate(value) {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}
