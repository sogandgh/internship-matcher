# Internship Matcher

Tracks Summer 2027 internships in ML, data science, and operations research, and scores them against your resume. Runs locally — nothing leaves your machine except what you send to Claude with the **Analyze** button.

## Setup

Install Node.js (18+):

```bash
brew install node
```

No Homebrew? Grab the macOS installer from [nodejs.org](https://nodejs.org/en/download).

Then:

```bash
npm install
```

## Run

```bash
npm start
```

Open http://localhost:3000

## Analyze button (optional)

Everything else works without this. To enable Claude analysis, add an API key from [console.anthropic.com](https://console.anthropic.com):

```bash
cp .env.example .env
open -e .env          # replace sk-ant-... with your key, then save
```

Restart the app after saving.

## Notes

- Your resume, saved jobs, and `.env` stay local — they're gitignored.
- Postings come from the public [SimplifyJobs Summer 2027](https://github.com/SimplifyJobs/Summer2027-Internships)f eed, cached 6 hours.
- Port already in use? Run `PORT=3001 npm start`.