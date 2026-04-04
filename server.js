'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function imagePayload(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mimeType = meta.match(/data:(image\/\w+);/)[1];
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } };
}

function buildPrompt({ ingredients, cuisine, difficulty, diet, equipment, seasonings, pantry }) {
  const cuisinePart = cuisine && cuisine !== 'any' ? ` ${cuisine}` : '';
  const dietPart    = diet && diet !== 'none'      ? ` that is ${diet}` : '';
  const diffPart    = difficulty || 'easy';

  const equipLine     = equipment?.length  ? `\nAvailable equipment: ${equipment.join(', ')}.`   : '';
  const seasonLine    = seasonings?.length ? `\nAvailable seasonings/spices: ${seasonings.join(', ')}.` : '';
  const pantryLine    = pantry?.length     ? `\nPantry staples on hand: ${pantry.join(', ')}.`    : '';
  const kitchenNote   = (equipLine || seasonLine || pantryLine)
    ? `\n\nKitchen context — only suggest techniques and equipment the cook actually has:${equipLine}${seasonLine}${pantryLine}`
    : '';

  return `You are a world-class chef. Given these ingredients: ${ingredients.join(', ')}${kitchenNote}

Create a ${diffPart}${cuisinePart} recipe${dietPart}. Only use equipment, seasonings, and pantry items listed above (if provided). Do not assume the cook has anything else.

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

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// ---------- routes ----------

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Scan food ingredients from a photo
app.post('/api/scan', async (req, res) => {
  const { image } = req.body;
  if (!image?.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Provide a valid base64 image.' });
  }
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 256,
      messages: [{ role: 'user', content: [
        imagePayload(image),
        { type: 'text', text: 'List every food ingredient visible in this image. Respond ONLY with a JSON array of lowercase strings, e.g. ["chicken","garlic","lemon"]. No markdown, no explanation.' },
      ]}],
    });
    res.json({ ingredients: parseJSON(completion.choices[0].message.content || '[]') });
  } catch (err) {
    console.error('Ingredient scan error:', err.message);
    res.status(500).json({ error: 'Failed to identify ingredients from image.' });
  }
});

// Scan kitchen equipment from a photo
app.post('/api/scan-kitchen', async (req, res) => {
  const { image } = req.body;
  if (!image?.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Provide a valid base64 image.' });
  }
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 512,
      messages: [{ role: 'user', content: [
        imagePayload(image),
        { type: 'text', text: `Look at this kitchen image and identify every piece of cooking equipment you can see (e.g. oven, stovetop, microwave, air fryer, blender, stand mixer, wok, cast iron pan, instant pot, etc.).
Respond ONLY with a JSON array of short lowercase equipment name strings.
Example: ["oven","stovetop","blender","cast iron pan"]
No markdown, no explanation.` },
      ]}],
    });
    res.json({ equipment: parseJSON(completion.choices[0].message.content || '[]') });
  } catch (err) {
    console.error('Kitchen scan error:', err.message);
    res.status(500).json({ error: 'Failed to identify kitchen equipment from image.' });
  }
});

// Generate a recipe
app.post('/api/recipe', async (req, res) => {
  const {
    ingredients,
    cuisine    = 'any',
    difficulty = 'easy',
    diet       = 'none',
    equipment  = [],
    seasonings = [],
    pantry     = [],
  } = req.body;

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'Provide at least one ingredient.' });
  }

  const prompt = buildPrompt({ ingredients, cuisine, difficulty, diet, equipment, seasonings, pantry });

  let raw;
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = completion.choices[0].message.content || '';
  } catch (err) {
    console.error('OpenAI API error:', err.message);
    return res.status(502).json({ error: 'Failed to contact AI service.' });
  }

  try {
    res.json(parseJSON(raw));
  } catch (err) {
    console.error('JSON parse error:', err.message, '\nRaw:', raw);
    res.status(500).json({ error: 'AI returned an unexpected format.' });
  }
});

// ---------- start ----------

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Recipe API running on http://localhost:${PORT}`));
}

module.exports = app;
