# PREP – AI Interview Practice

AI-powered interview app that records your answers and clips them per question.

## How it works
1. Enter a job role (e.g. "Software Engineer at Google")
2. AI generates interview questions
3. Camera records you answering
4. Say **"I'm done"** to clip & move to next question
5. Review all your video clips at the end

## Running locally

```bash
npm install
```

Add your OpenAI key to `.env.local`:
```
OPENAI_API_KEY=sk-...
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

> **Use Chrome** — Safari doesn't support the Web Speech API

## Deploy to Vercel

### Option 1: Vercel CLI (recommended)
```bash
npm install -g vercel
vercel
```
When prompted, add your env var: `OPENAI_API_KEY`

### Option 2: GitHub + Vercel Dashboard
1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → New Project → Import repo
3. In **Environment Variables**, add `OPENAI_API_KEY`
4. Click Deploy

## Notes
- Video clips are stored in browser memory (Blob URLs) — they don't upload anywhere
- Use "Download All Clips" on the review page to save them locally
- Speech recognition requires Chrome (desktop)
