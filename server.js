import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CACHE_FILE = path.join(DATA_DIR, 'jobs-cache.json');
const STATUS_FILE = path.join(DATA_DIR, 'statuses.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const APPLICATIONS_FILE = path.join(DATA_DIR, 'applications.json');
const RESUMES_FILE = path.join(DATA_DIR, 'resumes.json');
const LEGACY_RESUME_FILE = path.join(DATA_DIR, 'resume.json'); // pre-multi-resume format, migrated on first read
const ANALYSIS_FILE = path.join(DATA_DIR, 'analysis.json');
const SIMPLIFY_FEED = 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json';

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 12 * 1024 * 1024 }
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Used only to decide which incoming feed postings are relevant enough to keep.
const ROLE_KEYWORDS = [
  'machine learning',
  'ml',
  'ai',
  'artificial intelligence',
  'deep learning',
  'data science',
  'data scientist',
  'research scientist',
  'applied scientist',
  'operations research',
  'operation research',
  'optimization',
  'quantitative',
  'statistical',
  'analytics',
  'nlp',
  'computer vision',
  'reinforcement learning'
];

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    anthropicEnabled: Boolean(anthropic),
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'
  });
});

app.get('/api/jobs', async (req, res) => {
  try {
    const resumeStore = await readResumes();
    const jobs = await getJobs(req.query.refresh === '1');
    const statuses = await readJson(STATUS_FILE, {});
    const favorites = await readJson(FAVORITES_FILE, {});
    const applications = await readJson(APPLICATIONS_FILE, {});
    const analyses = await readJson(ANALYSIS_FILE, {});
    const currentAnalyses = resumeStore.currentId ? (analyses[resumeStore.currentId] || {}) : {};
    const response = jobs.map((job) => ({
      ...job,
      status: statuses[job.id] || 'new',
      starred: Boolean(favorites[job.id]),
      application: applications[job.id] || null,
      aiAnalysis: currentAnalyses[job.id] || null
    }));
    res.json({
      fetchedAt: new Date().toISOString(),
      resumeLoaded: Boolean(resumeStore.currentId),
      jobs: response
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resumes', async (_req, res) => {
  const store = await readResumes();
  res.json(publicResumeStore(store));
});

app.post('/api/resumes', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a PDF, DOCX, TXT, or Markdown resume.' });
    const text = await extractResumeText(req.file.path, req.file.originalname);
    if (!text.trim()) return res.status(400).json({ error: 'No readable text found in the uploaded resume.' });

    const store = await readResumes();
    const existingNames = new Set(store.resumes.map((item) => item.filename));
    const resume = {
      id: crypto.randomUUID(),
      filename: uniqueFilename(existingNames, req.file.originalname),
      uploadedAt: new Date().toISOString(),
      text,
      summary: summarizeResume(text)
    };
    store.resumes.push(resume);
    store.currentId = resume.id; // newly uploaded resume becomes the current one
    await writeJson(RESUMES_FILE, store);
    res.json(publicResumeStore(store));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/resumes/current', async (req, res) => {
  const store = await readResumes();
  const id = req.body.id || null;
  if (id && !store.resumes.some((resume) => resume.id === id)) {
    return res.status(400).json({ error: 'Unknown resume.' });
  }
  store.currentId = id;
  await writeJson(RESUMES_FILE, store);
  res.json(publicResumeStore(store));
});

app.delete('/api/resumes/:id', async (req, res) => {
  try {
    const store = await readResumes();
    const before = store.resumes.length;
    store.resumes = store.resumes.filter((resume) => resume.id !== req.params.id);
    if (store.resumes.length === before) return res.status(404).json({ error: 'Resume not found.' });
    if (store.currentId === req.params.id) store.currentId = null;
    await writeJson(RESUMES_FILE, store);

    // Analyses were written against this resume's text, so drop them too.
    const analyses = await readJson(ANALYSIS_FILE, {});
    delete analyses[req.params.id];
    await writeJson(ANALYSIS_FILE, analyses);

    res.json(publicResumeStore(store));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/status', async (req, res) => {
  const allowed = new Set(['new', 'dismissed']);
  if (!allowed.has(req.body.status)) return res.status(400).json({ error: 'Invalid status.' });
  const statuses = await readJson(STATUS_FILE, {});
  statuses[req.params.id] = req.body.status;
  await writeJson(STATUS_FILE, statuses);
  res.json({ id: req.params.id, status: req.body.status });
});

app.post('/api/jobs/:id/apply', async (req, res) => {
  try {
    const store = await readResumes();
    const resumeId = req.body.resumeId || null;
    const resume = resumeId ? store.resumes.find((item) => item.id === resumeId) : null;
    if (resumeId && !resume) return res.status(400).json({ error: 'Unknown resume.' });

    const statuses = await readJson(STATUS_FILE, {});
    statuses[req.params.id] = 'applied';
    await writeJson(STATUS_FILE, statuses);

    const applications = await readJson(APPLICATIONS_FILE, {});
    const application = {
      resumeId,
      resumeFilename: resume?.filename || null,
      notes: String(req.body.notes || '').slice(0, 2000),
      appliedAt: new Date().toISOString()
    };
    applications[req.params.id] = application;
    await writeJson(APPLICATIONS_FILE, applications);

    res.json({ id: req.params.id, status: 'applied', application });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/unapply', async (req, res) => {
  try {
    const statuses = await readJson(STATUS_FILE, {});
    delete statuses[req.params.id];
    await writeJson(STATUS_FILE, statuses);

    const applications = await readJson(APPLICATIONS_FILE, {});
    delete applications[req.params.id];
    await writeJson(APPLICATIONS_FILE, applications);

    res.json({ id: req.params.id, status: 'new' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/favorite', async (req, res) => {
  try {
    const favorites = await readJson(FAVORITES_FILE, {});
    if (req.body.starred) favorites[req.params.id] = true;
    else delete favorites[req.params.id];
    await writeJson(FAVORITES_FILE, favorites);
    res.json({ id: req.params.id, starred: Boolean(req.body.starred) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    // Analysis is meaningless without a resume, so that check comes first.
    const store = await readResumes();
    const resume = store.resumes.find((item) => item.id === store.currentId);
    if (!resume) return res.status(400).json({ error: 'Pick a current resume to analyze this posting.' });

    if (!anthropic) {
      return res.status(400).json({ error: 'Set ANTHROPIC_API_KEY in .env to enable Claude resume matching.' });
    }

    const jobs = await getJobs(false);
    const requestedIds = Array.isArray(req.body.jobIds) ? req.body.jobIds : [];
    const selected = jobs.filter((job) => requestedIds.includes(job.id)).slice(0, 10);
    if (!selected.length) return res.status(400).json({ error: 'Select at least one visible job to analyze.' });

    const analyses = await readJson(ANALYSIS_FILE, {});
    const existing = analyses[resume.id] || {};
    const results = {};
    for (const job of selected) {
      const analysis = await analyzeWithClaude(resume, job);
      // Stamp the analysis with which resume produced it, so a redo or a resume
      // switch never gets confused about what it's looking at.
      results[job.id] = { ...analysis, resumeId: resume.id, resumeFilename: resume.filename, analyzedAt: new Date().toISOString() };
      existing[job.id] = results[job.id];
    }
    analyses[resume.id] = existing;
    await writeJson(ANALYSIS_FILE, analyses);
    res.json({ analyses: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function getJobs(forceRefresh) {
  const cached = await readJson(CACHE_FILE, null);
  const cacheFresh = cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < 6 * 60 * 60 * 1000;
  if (cached?.jobs?.length && cacheFresh && !forceRefresh) return cached.jobs;

  const response = await fetch(SIMPLIFY_FEED);
  if (!response.ok) throw new Error(`Could not fetch internship feed: ${response.status}`);
  const raw = await response.json();
  const jobs = normalizeSimplify(raw);
  await writeJson(CACHE_FILE, { fetchedAt: new Date().toISOString(), jobs });
  return jobs;
}

function normalizeSimplify(raw) {
  const seen = new Set();
  return raw
    .filter((item) => item.active !== false)
    .filter((item) => (item.terms || []).some((term) => String(term).includes('2027')))
    .map((item) => {
      const category = item.category || 'Internship';
      const titleHaystack = [
        item.title,
        item.company_name,
        ...(item.degrees || []),
        ...(item.locations || [])
      ].join(' ').toLowerCase();
      const categoryHaystack = category.toLowerCase();
      const relevance = ROLE_KEYWORDS.filter((keyword) => {
        if (keyword === 'ai' || keyword === 'ml') return categoryHaystack.includes('ai/ml') || hasKeyword(titleHaystack, keyword);
        return hasKeyword(`${categoryHaystack} ${titleHaystack}`, keyword);
      });
      return {
        id: item.id || stableId(item.url),
        source: item.source || 'Simplify',
        category,
        company: item.company_name || 'Unknown company',
        title: item.title || 'Internship',
        url: item.url,
        locations: item.locations || [],
        terms: item.terms || [],
        degrees: item.degrees || [],
        sponsorship: item.sponsorship || 'Unknown',
        datePosted: item.date_posted ? new Date(item.date_posted * 1000).toISOString() : null,
        dateUpdated: item.date_updated ? new Date(item.date_updated * 1000).toISOString() : null,
        relevance
      };
    })
    .filter((job) => {
      const keep = job.category === 'AI/ML/Data' || job.category === 'Quant' || job.relevance.length > 0;
      if (!keep || seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    })
    .sort((a, b) => new Date(b.dateUpdated || 0) - new Date(a.dateUpdated || 0));
}

function hasKeyword(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (keyword.length <= 3) return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

async function analyzeWithClaude(resume, job) {
  const prompt = {
    resume: resume.text.slice(0, 20000),
    job,
    reviewFocus: {
      fieldFit: 'Machine learning, data science, deep learning, operations research alignment.',
      researchFit: 'PhD/research depth, publications, methods, modeling, experimentation.',
      technicalFit: 'Specific tools, programming languages, math, ML systems, optimization.',
      eligibilityFit: 'Degree level, graduation timing, location, sponsorship and internship term.',
      applicationAdvice: 'Concrete resume edits and application positioning.'
    }
  };
  const message = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    // Sonnet 5+ think by default and thinking tokens count against max_tokens too,
    // so this needs real headroom beyond just the visible JSON. "medium" effort keeps
    // reasoning proportionate to a straightforward review instead of over-thinking it.
    max_tokens: 8192,
    output_config: { effort: 'medium' },
    system: 'You are a rigorous PhD internship application reviewer. This is the one detailed review the candidate will read for this posting, so ground every point in specifics from their actual resume rather than generic advice. Return strict JSON only.',
    messages: [{
      role: 'user',
      content: `Review this candidate for the internship using their full resume text below. Cite concrete resume details (projects, tools, coursework, publications) in your reasoning wherever possible. Return JSON with keys: verdict string, strengths string[], gaps string[], resume_edits string[], application_angle string.\n\n${JSON.stringify(prompt)}`
    }]
  });
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Claude response was truncated (hit max_tokens) before the JSON finished.');
  }
  const text = message.content.find((block) => block.type === 'text')?.text || '{}';
  return parseClaudeJson(text);
}

function parseClaudeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude returned analysis, but it was not valid JSON.');
    return JSON.parse(match[0]);
  }
}

async function extractResumeText(filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const buffer = await fs.readFile(filePath);
  if (ext === '.pdf') return (await pdf(buffer)).text;
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer })).value;
  if (['.txt', '.md', '.markdown'].includes(ext)) return buffer.toString('utf8');
  throw new Error('Unsupported resume format. Use PDF, DOCX, TXT, or Markdown.');
}

function uniqueFilename(existingNames, filename) {
  if (!existingNames.has(filename)) return filename;
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let n = 1;
  let candidate = `${base} (${n})${ext}`;
  while (existingNames.has(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

function summarizeResume(text) {
  return {
    wordCount: text.trim().split(/\s+/).filter(Boolean).length
  };
}

async function readResumes() {
  let store = await readJson(RESUMES_FILE, null);
  if (store) return store;

  // First run after the multi-resume upgrade: fold the old single-resume file in, if present.
  const legacy = await readJson(LEGACY_RESUME_FILE, null);
  if (legacy?.text) {
    const id = crypto.randomUUID();
    store = {
      currentId: id,
      resumes: [{
        id,
        filename: legacy.filename,
        uploadedAt: legacy.uploadedAt,
        text: legacy.text,
        summary: legacy.summary || summarizeResume(legacy.text)
      }]
    };
  } else {
    store = { currentId: null, resumes: [] };
  }
  await writeJson(RESUMES_FILE, store);
  return store;
}

function publicResumeStore(store) {
  return {
    currentId: store.currentId,
    resumes: store.resumes.map(({ id, filename, uploadedAt, summary }) => ({ id, filename, uploadedAt, summary }))
  };
}

function stableId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

app.listen(PORT, () => {
  console.log(`Internship matcher running at http://localhost:${PORT}`);
});
