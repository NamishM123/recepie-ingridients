# Recipe Ingredients API

AI-powered recipe generation API using Claude. Given a list of ingredients, it returns a structured recipe.

## Endpoints

- `POST /api/recipe` — Generate a recipe from ingredients
- `GET /health` — Health check

### POST /api/recipe

**Body:**
```json
{
  "ingredients": ["chicken", "garlic", "lemon"],
  "cuisine": "italian",
  "difficulty": "easy",
  "diet": "none"
}
```

**Response:** JSON recipe object with title, description, prep/cook time, ingredients, steps, and a chef's tip.

## Running locally

```bash
npm install
```

Set your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm start
```

API runs on [http://localhost:3001](http://localhost:3001)

## Deploy to Vercel

### Option 1: Vercel CLI
```bash
npm install -g vercel
vercel
```
When prompted, add env var: `ANTHROPIC_API_KEY`

### Option 2: GitHub + Vercel Dashboard
1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import repo
3. In **Environment Variables**, add `ANTHROPIC_API_KEY`
4. Click Deploy
