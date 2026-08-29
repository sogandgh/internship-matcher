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
const RESUME_FILE = path.join(DATA_DIR, 'resume.json');
const ANALYSIS_FILE = path.join(DATA_DIR, 'analysis.json');
const SIMPLIFY_FEED = 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json';

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 12 * 1024 * 1024 }
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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

const SKILL_KEYWORDS = [
  'python',
  'pytorch',
  'tensorflow',
  'jax',
  'scikit',
  'sklearn',
  'sql',
  'r',
  'matlab',
  'spark',
  'aws',
  'gcp',
  'azure',
  'kubernetes',
  'docker',
  'llm',
  'transformer',
  'bayesian',
  'causal',
  'forecasting',
  'optimization',
  'linear programming',
  'integer programming',
  'stochastic',
  'simulation',
  'operations research',
  'deep learning',
  'computer vision',
  'nlp',
  'reinforcement learning',
  'statistics'
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
    const resume = await readJson(RESUME_FILE, null);
    const jobs = await getJobs(req.query.refresh === '1');
    const statuses = await readJson(STATUS_FILE, {});
    const analyses = await readJson(ANALYSIS_FILE, {});
    const response = jobs.map((job) => ({
      ...job,
      status: statuses[job.id] || 'new',
      score: scoreJob(job, resume?.text || ''),
      aiAnalysis: analyses[job.id] || null
    }));
    res.json({
      fetchedAt: new Date().toISOString(),
      resumeLoaded: Boolean(resume?.text),
      jobs: response
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a PDF, DOCX, TXT, or Markdown resume.' });
    const text = await extractResumeText(req.file.path, req.file.originalname);
    if (!text.trim()) return res.status(400).json({ error: 'No readable text found in the uploaded resume.' });

    const resume = {
      filename: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      text,
      summary: summarizeResume(text)
    };
    await writeJson(RESUME_FILE, resume);
    await writeJson(ANALYSIS_FILE, {});
    res.json({ filename: resume.filename, uploadedAt: resume.uploadedAt, summary: resume.summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/resume', async (_req, res) => {
  const resume = await readJson(RESUME_FILE, null);
  if (!resume) return res.json({ resumeLoaded: false });
  res.json({
    resumeLoaded: true,
    filename: resume.filename,
    uploadedAt: resume.uploadedAt,
    summary: resume.summary
  });
});

app.delete('/api/resume', async (_req, res) => {
  try {
    await fs.rm(RESUME_FILE, { force: true });
    // Past analyses were written against the removed resume, so drop them too.
    await writeJson(ANALYSIS_FILE, {});
    res.json({ resumeLoaded: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/status', async (req, res) => {
  const allowed = new Set(['new', 'saved', 'applied', 'dismissed']);
  if (!allowed.has(req.body.status)) return res.status(400).json({ error: 'Invalid status.' });
  const statuses = await readJson(STATUS_FILE, {});
  statuses[req.params.id] = req.body.status;
  await writeJson(STATUS_FILE, statuses);
  res.json({ id: req.params.id, status: req.body.status });
});

app.post('/api/analyze', async (req, res) => {
  try {
    // Analysis is meaningless without a resume, so that check comes first.
    const resume = await readJson(RESUME_FILE, null);
    if (!resume?.text) return res.status(400).json({ error: 'Upload a resume to analyze this posting.' });

    if (!anthropic) {
      return res.status(400).json({ error: 'Set ANTHROPIC_API_KEY in .env to enable Claude resume matching.' });
    }

    const jobs = await getJobs(false);
    const requestedIds = Array.isArray(req.body.jobIds) ? req.body.jobIds : [];
    const selected = jobs.filter((job) => requestedIds.includes(job.id)).slice(0, 10);
    if (!selected.length) return res.status(400).json({ error: 'Select at least one visible job to analyze.' });

    const existing = await readJson(ANALYSIS_FILE, {});
    const results = {};
    for (const job of selected) {
      results[job.id] = await analyzeWithClaude(resume, job);
      existing[job.id] = results[job.id];
    }
    await writeJson(ANALYSIS_FILE, existing);
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

function scoreJob(job, resumeText) {
  const resume = resumeText.toLowerCase();
  const jobText = [
    job.category,
    job.title,
    job.company,
    job.degrees.join(' '),
    job.relevance.join(' ')
  ].join(' ').toLowerCase();

  const fieldHits = ROLE_KEYWORDS.filter((keyword) => hasKeyword(jobText, keyword));
  const skillHits = SKILL_KEYWORDS.filter((keyword) => hasKeyword(resume, keyword) && hasKeyword(jobText, keyword));
  const resumeSkillHits = SKILL_KEYWORDS.filter((keyword) => hasKeyword(resume, keyword));
  const phdSignals = ['phd', 'ph.d', 'doctoral', 'research scientist', 'applied scientist', 'graduate'].filter((keyword) => hasKeyword(jobText, keyword));
  const freshnessDays = job.dateUpdated ? (Date.now() - new Date(job.dateUpdated).getTime()) / 86400000 : 30;

  const fieldScore = Math.min(30, fieldHits.length * 8 + (job.category === 'AI/ML/Data' ? 12 : 0));
  const skillScore = resumeText ? Math.min(30, skillHits.length * 6 + Math.min(8, resumeSkillHits.length)) : 8;
  const phdScore = Math.min(20, phdSignals.length * 8 + (job.degrees.some((degree) => /master|phd|doctor/i.test(degree)) ? 8 : 0));
  const logisticsScore = Math.min(10, job.sponsorship !== 'No' ? 5 : 0) + Math.min(5, job.locations.length ? 5 : 0);
  const freshnessScore = Math.max(0, Math.min(10, 10 - freshnessDays / 4));
  const total = Math.round(fieldScore + skillScore + phdScore + logisticsScore + freshnessScore);

  const suggestions = [];
  if (!resumeText) suggestions.push('Upload a resume to unlock personalized scoring.');
  if (fieldHits.length) suggestions.push(`Emphasize matching area: ${fieldHits.slice(0, 3).join(', ')}.`);
  if (skillHits.length) suggestions.push(`Mirror these resume skills in the application: ${skillHits.slice(0, 5).join(', ')}.`);
  if (!phdSignals.length && !job.degrees.some((degree) => /master|phd|doctor/i.test(degree))) {
    suggestions.push('Check eligibility carefully; this posting may be undergraduate-oriented.');
  }
  if (job.sponsorship === 'No') suggestions.push('Verify work authorization before spending time on this application.');

  return {
    total,
    criteria: {
      fieldFit: Math.round(fieldScore),
      resumeSkillFit: Math.round(skillScore),
      phdResearchFit: Math.round(phdScore),
      logistics: Math.round(logisticsScore),
      freshness: Math.round(freshnessScore)
    },
    matchedKeywords: [...new Set([...fieldHits, ...skillHits])].slice(0, 12),
    suggestions
  };
}

async function analyzeWithClaude(resume, job) {
  const prompt = {
    resume: resume.text.slice(0, 20000),
    job,
    scoringRubric: {
      fieldFit: 'Machine learning, data science, deep learning, operations research alignment.',
      researchFit: 'PhD/research depth, publications, methods, modeling, experimentation.',
      technicalFit: 'Specific tools, programming languages, math, ML systems, optimization.',
      eligibilityFit: 'Degree level, graduation timing, location, sponsorship and internship term.',
      applicationAdvice: 'Concrete resume edits and application positioning.'
    }
  };
  const message = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 1400,
    temperature: 0.2,
    system: 'You are a rigorous PhD internship application reviewer. This is the one detailed review the candidate will read for this posting, so ground every point in specifics from their actual resume rather than generic advice. Return strict JSON only.',
    messages: [{
      role: 'user',
      content: `Score this candidate for the internship using their full resume text below. Cite concrete resume details (projects, tools, coursework, publications) in your reasoning wherever possible. Return JSON with keys: score number 0-100, verdict string, strengths string[], gaps string[], resume_edits string[], application_angle string.\n\n${JSON.stringify(prompt)}`
    }]
  });
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

function summarizeResume(text) {
  const lower = text.toLowerCase();
  const skills = SKILL_KEYWORDS.filter((keyword) => hasKeyword(lower, keyword)).slice(0, 16);
  const fields = ROLE_KEYWORDS.filter((keyword) => hasKeyword(lower, keyword)).slice(0, 10);
  return {
    wordCount: text.trim().split(/\s+/).filter(Boolean).length,
    detectedSkills: skills,
    detectedFields: fields
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
