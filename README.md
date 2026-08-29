# Internship Matcher

Finds Summer 2027 internships in machine learning, data science, deep learning,
and operations research, then scores each one against your resume.

Everything runs on your own Mac. Your resume never leaves your computer, except
when you press **Analyze** on a posting (that sends it to Claude for a review).

---

## Setup on a Mac

You do steps 1 and 2 once. After that, starting the app is a double-click.

### 1. Install Node.js

Go to **[nodejs.org/en/download](https://nodejs.org/en/download)** and download
the **macOS Installer**. Open the downloaded `.pkg` file and click through it.

> Not sure if you already have it? Skip to step 3 — the app will tell you if
> it's missing and open the download page for you.

### 2. Get the code

If you were sent a repository link, open **Terminal**
(press `Command + Space`, type `Terminal`, press Return) and paste this,
replacing the URL with the one you were given:

```bash
git clone https://github.com/YOUR-USERNAME/find-me-internship.git
cd find-me-internship
```

The first time you use `git`, macOS may pop up a box asking to install
developer tools. Click **Install** and wait for it to finish, then run the
`git clone` line again.

> **Prefer not to use Terminal?** On the repository page click the green
> **Code** button, then **Download ZIP**, and double-click the downloaded file
> to unzip it.

### 3. Start it

Open the project folder in Finder and **double-click `start.command`**.

A Terminal window opens and the app appears in your browser at
`http://localhost:3000`. The first launch takes about a minute while it
installs what it needs; after that it starts in a couple of seconds.

**Keep the Terminal window open while you use the app.** To stop, press
`Control + C` in that window or just close it.

> **If macOS says the file "cannot be opened because it is from an
> unidentified developer":** this happens when you downloaded the ZIP instead
> of cloning. Right-click `start.command`, choose **Open**, then click **Open**
> in the dialog. You only need to do this once.

---

## Using it

- **Upload** your resume (PDF, Word, or plain text) with the button at the top
  right. Scores update immediately to reflect your skills.
- **Search** and the **Active / Newest / Min score** controls narrow the list.
- Click a **job title** to open the real posting in a new tab.
- **Applied** marks a job as done and takes it out of your active list.
- **Hide** removes ones you're not interested in.
- **Analyze** asks Claude to compare your resume against that specific posting
  and returns strengths, gaps, suggested resume edits, and an angle to apply
  with. This needs an API key — see below.
- **Refresh** pulls the newest postings from the public listings feed.

Your resume, your saved marks, and any analyses stay in the `data/` and
`uploads/` folders inside the project. They are never uploaded anywhere and are
excluded from the repository.

---

## Turning on the Analyze button (optional)

Everything except **Analyze** works without this. The rest of the app — the
feed, scoring, search, applied/hidden tracking — needs no key at all.

To enable it, you need an Anthropic API key from
[console.anthropic.com](https://console.anthropic.com). It is paid per use, and
usage bills to whoever's key it is.

Once you have a key, make a file named `.env` in the project folder containing:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

The quickest way to create it: in Terminal, from inside the project folder, run

```bash
cp .env.example .env
open -e .env
```

That opens the file in TextEdit — replace `sk-ant-...` with your real key, save,
and restart the app.

---

## If something goes wrong

**"Node.js isn't installed"** — the app opens the download page for you. Install
it, then double-click `start.command` again.

**Nothing happens when I double-click `start.command`** — right-click it and
choose **Open** instead (see the note in step 3). If it opens in TextEdit
instead of running, open Terminal, type `bash ` (with a space), drag
`start.command` from Finder into the window, and press Return.

**The browser says it can't connect** — give it a few more seconds on the first
launch, then reload. The Terminal window will show
`Internship matcher running at ...` once it's ready.

**Port 3000 is already in use** — handled automatically; the app moves to 3001,
3002, and so on. Look at the Terminal window for the address it actually used.

**No jobs are listed** — click **Refresh** to fetch the feed, and check that
**Min score** isn't set too high.

---

## For developers

```bash
npm install
npm start        # or: npm run dev   (restarts on file changes)
```

Environment variables (all optional, read from `.env` or the shell):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Enables the Analyze feature |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Model used for analysis |
| `PORT` | `3000` | Port to serve on |

Postings come from the public
[SimplifyJobs Summer 2027](https://github.com/SimplifyJobs/Summer2027-Internships)
listings feed, cached for six hours in `data/jobs-cache.json`.
