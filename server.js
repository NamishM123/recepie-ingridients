'use strict';

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());

// ---------- helpers ----------

function buildPrompt({ ingredients, cuisine, difficulty, diet }) {
  const cuisinePart = cuisine && cuisine !== 'any' ? ` ${cuisine}` : '';
  const dietPart = diet && diet !== 'none' ? ` that is ${diet}` : '';
  const difficultyPart = difficulty || 'easy';

  return `You are a world-class chef. Given these ingredients: ${ingredients.join(', ')}

Create a ${difficultyPart}${cuisinePart} recipe${dietPart}.

Respond ONLY with valid JSON — no markdown, no backticks, no extra text. Use this exact schema:
{
  "title": "Recipe Name",
  "description": "One vivid sentence describing the dish",
  "prep_time": "X min",
  "cook_time": "X min",
  "servings": "X",
  "ingredients": [{ "amount": "X cup", "name": "ingredient name" }],
  "steps": ["Step 1 instruction", "Step 2 instruction"],
  "tip": "One chef tip or variation (can be empty string)"
}`;
}

function parseRecipe(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ---------- routes ----------

app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'Recipe Ingredients API v2' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/recipe', async (req, res) => {
  const { ingredients, cuisine = 'any', difficulty = 'easy', diet = 'none' } = req.body;

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'Provide at least one ingredient.' });
  }

  const prompt = buildPrompt({ ingredients, cuisine, difficulty, diet });

  let raw;
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = message.content.map((b) => b.text || '').join('');
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    return res.status(502).json({ error: 'Failed to contact AI service.' });
  }

  let recipe;
  try {
    recipe = parseRecipe(raw);
  } catch (err) {
    console.error('JSON parse error:', err.message, '\nRaw:', raw);
    return res.status(500).json({ error: 'AI returned an unexpected format.' });
  }

  res.json(recipe);
});

// ---------- start ----------

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Recipe API running on http://localhost:${PORT}`));
}

module.exports = app;
