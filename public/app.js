const state = {
  jobs: [],
  resumes: [],
  currentResumeId: null,
  resumeLoaded: false,
  query: '',
  statusFilter: 'active',
  locationFilter: '',
  sortBy: 'date',
  showHidden: false,
  showFavoritesOnly: false,
  fetchedAt: null
};

const jobsEl = document.querySelector('#jobs');
const resumeSelect = document.querySelector('#resumeSelect');
const locationFilter = document.querySelector('#locationFilter');
const removeResumeBtn = document.querySelector('#removeResume');
const fetchedNote = document.querySelector('#fetchedNote');
const uploadBtn = document.querySelector('#uploadBtn');
const template = document.querySelector('#jobTemplate');
const skeletonTemplate = document.querySelector('#skeletonTemplate');
const fileInput = document.querySelector('#resume');
const toggleHidden = document.querySelector('#toggleHidden');
const toggleFavorites = document.querySelector('#toggleFavorites');
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
locationFilter.addEventListener('change', (event) => {
  state.locationFilter = event.target.value;
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
toggleFavorites.addEventListener('click', () => {
  state.showFavoritesOnly = !state.showFavoritesOnly;
  toggleFavorites.classList.toggle('is-on', state.showFavoritesOnly);
  toggleFavorites.setAttribute('aria-pressed', String(state.showFavoritesOnly));
  render();
});
// One control: the button opens the picker, and choosing a file uploads it.
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadResume();
});
resumeSelect.addEventListener('change', () => selectResume(resumeSelect.value || null));
removeResumeBtn.addEventListener('click', removeResume);

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (event) => {
  if (event.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalOverlay.hidden) closeModal();
});

renderSkeletons();
loadResumes();
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

async function loadResumes() {
  try {
    const response = await fetch('/api/resumes');
    const data = await response.json();
    renderResumeStore(data);
  } catch {
    // Resume switcher just stays in its default "No resume" state.
  }
}

async function uploadResume() {
  const file = fileInput.files[0];
  if (!file) return;
  const body = new FormData();
  body.append('resume', file);
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading…';
  try {
    const response = await fetch('/api/resumes', { method: 'POST', body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Resume upload failed.');
    renderResumeStore(data);
    await loadJobs(false);
    toast('Resume uploaded and set as current.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload resume';
    // Clear it so picking the same file again still fires a change event.
    fileInput.value = '';
  }
}

async function selectResume(id) {
  const previousId = state.currentResumeId;
  state.currentResumeId = id;
  try {
    const response = await fetch('/api/resumes/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not switch resumes.');
    renderResumeStore(data);
    await loadJobs(false);
  } catch (error) {
    state.currentResumeId = previousId;
    resumeSelect.value = previousId || '';
    toast(error.message, 'error');
  }
}

async function removeResume() {
  const id = state.currentResumeId;
  if (!id) return;
  removeResumeBtn.disabled = true;
  try {
    const response = await fetch(`/api/resumes/${id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not remove the resume.');
    renderResumeStore(data);
    await loadJobs(false);
    toast('Resume removed.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    removeResumeBtn.disabled = false;
  }
}

function renderResumeStore(data) {
  state.resumes = data.resumes || [];
  state.currentResumeId = data.currentId || null;
  resumeSelect.innerHTML = '<option value="">No resume (no analyze)</option>' + state.resumes.map((resume) => (
    `<option value="${escapeHtml(resume.id)}">${escapeHtml(resume.filename)}</option>`
  )).join('');
  resumeSelect.value = state.currentResumeId || '';
  removeResumeBtn.hidden = !state.currentResumeId;
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

async function toggleStar(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  const nextStarred = !job.starred;
  job.starred = nextStarred;
  render();
  try {
    const response = await fetch(`/api/jobs/${id}/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: nextStarred })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Could not update favorite.');
    }
  } catch (error) {
    job.starred = !nextStarred;
    render();
    toast(error.message, 'error');
  }
}

async function submitApply(job, resumeId, notes, triggerButton) {
  try {
    const response = await fetch(`/api/jobs/${job.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId, notes })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not mark this posting as applied.');
    job.status = 'applied';
    job.application = data.application;
    closeModal();
    render();
    toast('Marked as applied.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function undoApply(job) {
  try {
    const response = await fetch(`/api/jobs/${job.id}/unapply`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not undo applied status.');
    job.status = 'new';
    job.application = null;
    closeModal();
    render();
    toast('Applied status undone.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

// Claude is only ever called here, in direct response to an Analyze/Redo click.
async function analyzeJob(job, triggerButton) {
  lastFocused = triggerButton;
  if (job.aiAnalysis) {
    showAnalysisModal(job);
    return;
  }
  await runAnalysis(job);
}

async function runAnalysis(job) {
  // No current resume, no analysis — fail here rather than round-tripping to the server.
  if (!state.currentResumeId) {
    openModal(errorModalContent(job, 'Pick a current resume to analyze this posting.'));
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
    showAnalysisModal(job);
    render();
  } catch (error) {
    openModal(errorModalContent(job, error.message));
  }
}

function showAnalysisModal(job) {
  openModal(jobModalContent(job));
  modalBody.querySelector('#redoAnalysis').addEventListener('click', () => runAnalysis(job));
}

function visibleJobs() {
  return state.jobs.filter((job) => {
    const text = [job.company, job.title, job.locations.join(' '), job.category, job.relevance.join(' ')].join(' ').toLowerCase();
    const statusMatch = state.statusFilter === 'all'
      || (state.statusFilter === 'active' && job.status !== 'applied')
      || job.status === state.statusFilter;
    // Hidden jobs are excluded unless the "Show hidden" toggle is on.
    const hiddenMatch = job.status !== 'dismissed' || state.showHidden;
    const favoriteMatch = !state.showFavoritesOnly || Boolean(job.starred);
    const locationMatch = !state.locationFilter || job.locations.includes(state.locationFilter);
    return statusMatch && hiddenMatch && favoriteMatch && locationMatch && text.includes(state.query);
  });
}

function sortJobs(jobs, sortBy) {
  const sorted = [...jobs];
  if (sortBy === 'company') {
    sorted.sort((a, b) => a.company.localeCompare(b.company));
  } else {
    sorted.sort((a, b) => new Date(b.dateUpdated || 0) - new Date(a.dateUpdated || 0));
  }
  return sorted;
}

function renderLocationOptions() {
  const locations = [...new Set(
    state.jobs.flatMap((job) => job.locations).map((loc) => String(loc).trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  // A refresh can drop the location the user had picked; fall back to "all".
  if (state.locationFilter && !locations.includes(state.locationFilter)) {
    state.locationFilter = '';
  }
  locationFilter.innerHTML = '<option value="">All locations</option>' + locations.map((loc) => (
    `<option value="${escapeHtml(loc)}">${escapeHtml(loc)}</option>`
  )).join('');
  locationFilter.value = state.locationFilter;
}

function render() {
  renderLocationOptions();
  const jobs = sortJobs(visibleJobs(), state.sortBy);
  fetchedNote.textContent = state.fetchedAt ? ` · updated ${relativeDate(state.fetchedAt)}` : '';

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

  const starButton = node.querySelector('[data-action="star"]');
  starButton.classList.toggle('is-starred', Boolean(job.starred));
  starButton.setAttribute('aria-pressed', String(Boolean(job.starred)));
  starButton.addEventListener('click', () => toggleStar(job.id));

  const titleLink = node.querySelector('.title-link');
  titleLink.textContent = job.title;
  titleLink.href = job.url;
  titleLink.title = job.title;

  node.querySelector('.job-sub').innerHTML = [
    `<b>${escapeHtml(job.company)}</b>`,
    escapeHtml(job.locations.join(', ') || 'Location unknown'),
    job.dateUpdated ? escapeHtml(relativeDate(job.dateUpdated)) : ''
  ].filter(Boolean).join(' · ');

  const dismissButton = node.querySelector('[data-status="dismissed"]');
  dismissButton.classList.toggle('is-active', job.status === 'dismissed');
  // A hidden job's Hide button becomes the way to put it back.
  dismissButton.textContent = job.status === 'dismissed' ? 'Unhide' : 'Hide';
  dismissButton.addEventListener('click', () => setStatus(job.id, 'dismissed'));

  const appliedButton = node.querySelector('[data-action="applied"]');
  appliedButton.classList.toggle('is-active', job.status === 'applied');
  appliedButton.textContent = job.status === 'applied' ? 'Applied ✓' : 'Applied';
  appliedButton.addEventListener('click', () => {
    if (job.status === 'applied') openAppliedInfo(job, appliedButton);
    else openApplyPrompt(job, appliedButton);
  });

  const analyzeButton = node.querySelector('[data-action="analyze"]');
  analyzeButton.textContent = job.aiAnalysis ? 'View' : 'Analyze';
  analyzeButton.addEventListener('click', () => analyzeJob(job, analyzeButton));

  return node;
}

function listBlock(title, items) {
  if (!items?.length) return '';
  return `<section><strong>${escapeHtml(title)}</strong><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
}

function modalHeader(job) {
  return `
    <h4 id="modalTitle">${escapeHtml(job.title)}</h4>
    <p class="modal-company">${escapeHtml(job.company)}</p>
  `;
}

function jobModalContent(job) {
  const analysis = job.aiAnalysis;
  return `
    ${modalHeader(job)}
    <p class="modal-analyzed-with">Analyzed with <b>${escapeHtml(analysis.resumeFilename || 'an unknown resume')}</b>${analysis.analyzedAt ? ` · ${escapeHtml(relativeDate(analysis.analyzedAt))}` : ''}</p>
    <div class="modal-verdict">${escapeHtml(analysis.verdict || 'Reviewed')}</div>
    ${listBlock('Strengths', analysis.strengths || [])}
    ${listBlock('Gaps', analysis.gaps || [])}
    ${listBlock('Resume edits', analysis.resume_edits || [])}
    ${analysis.application_angle ? `<section><strong>Application angle</strong><p>${escapeHtml(analysis.application_angle)}</p></section>` : ''}
    <div class="modal-form-actions">
      <button type="button" class="btn btn-ghost" id="redoAnalysis">Redo analysis</button>
    </div>
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

function openApplyPrompt(job, triggerButton) {
  lastFocused = triggerButton;
  const resumeOptions = state.resumes.map((resume) => (
    `<option value="${escapeHtml(resume.id)}">${escapeHtml(resume.filename)}</option>`
  )).join('');
  openModal(`
    ${modalHeader(job)}
    <form id="applyForm" class="apply-form">
      <label class="field">
        <span>Resume version used</span>
        <select id="applyResume">
          <option value="">None selected</option>
          ${resumeOptions}
        </select>
      </label>
      <label class="field">
        <span>Notes</span>
        <textarea id="applyNotes" rows="4" placeholder="Referral, cover letter angle, portal used…"></textarea>
      </label>
      <div class="modal-form-actions">
        <button type="button" class="btn btn-quiet" id="applyCancel">Cancel</button>
        <button type="submit" class="btn btn-accent">Mark applied</button>
      </div>
    </form>
  `);
  const resumeField = modalBody.querySelector('#applyResume');
  if (state.currentResumeId) resumeField.value = state.currentResumeId;
  modalBody.querySelector('#applyCancel').addEventListener('click', closeModal);
  modalBody.querySelector('#applyForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const notes = modalBody.querySelector('#applyNotes').value.trim();
    submitApply(job, resumeField.value || null, notes);
  });
}

function openAppliedInfo(job, triggerButton) {
  lastFocused = triggerButton;
  const application = job.application;
  openModal(`
    ${modalHeader(job)}
    <section>
      <strong>Applied</strong>
      <p>${application?.appliedAt ? escapeHtml(relativeDate(application.appliedAt)) : 'Unknown date'} · resume used: ${escapeHtml(application?.resumeFilename || 'None selected')}</p>
    </section>
    ${application?.notes ? `<section><strong>Notes</strong><p>${escapeHtml(application.notes)}</p></section>` : ''}
    <div class="modal-form-actions">
      <button type="button" class="btn btn-ghost" id="undoApply">Undo applied</button>
    </div>
  `);
  modalBody.querySelector('#undoApply').addEventListener('click', () => undoApply(job));
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
