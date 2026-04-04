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

function buildPrompt({ ingredients, cuisine, difficulty, diet, goal, equipment, seasonings, pantry }) {
  const cuisinePart = cuisine && cuisine !== 'any' ? ` ${cuisine}` : '';
  const dietPart    = diet && diet !== 'none'      ? ` that is ${diet}` : '';
  const goalPart    = goal && goal !== 'none'      ? ` optimized for ${goal.replace(/-/g, ' ')}` : '';
  const diffPart    = difficulty || 'easy';

  const equipLine  = equipment?.length  ? `\nAvailable equipment: ${equipment.join(', ')}.`          : '';
  const seasonLine = seasonings?.length ? `\nAvailable seasonings/spices: ${seasonings.join(', ')}.` : '';
  const pantryLine = pantry?.length     ? `\nPantry staples on hand: ${pantry.join(', ')}.`          : '';
  const kitchenNote = (equipLine || seasonLine || pantryLine)
    ? `\n\nKitchen context — only suggest techniques and equipment the cook actually has:${equipLine}${seasonLine}${pantryLine}`
    : '';

  return `You are a world-class chef and nutritionist. Given these ingredients: ${ingredients.join(', ')}${kitchenNote}

Create a ${diffPart}${cuisinePart} recipe${dietPart}${goalPart}. Only use equipment, seasonings, and pantry items listed above (if provided). Do not assume the cook has anything else.

Respond ONLY with valid JSON — no markdown, no backticks, no extra text. Use this exact schema:
{
  "title": "Recipe Name",
  "description": "One vivid, appetizing sentence describing the dish",
  "cuisine_type": "Detected cuisine (e.g. Italian, Asian, American, Mediterranean)",
  "prep_time": "X min",
  "cook_time": "X min",
  "servings": "X",
  "dietary_goal_match": "One sentence on how this recipe aligns with the dietary goal",
  "ingredients": [{ "amount": "X cup", "name": "ingredient name" }],
  "missing_ingredients": ["up to 3 ingredients that would elevate the dish but weren't listed"],
  "steps": ["Detailed step 1 instruction", "Detailed step 2 instruction"],
  "macros": {
    "calories": 450,
    "protein": 35,
    "carbs": 42,
    "fat": 12,
    "fiber": 6
  },
  "plating_tip": "One elegant restaurant-style plating suggestion",
  "tip": "One chef tip or variation (can be empty string)"
}`;
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
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
    goal       = 'none',
    equipment  = [],
    seasonings = [],
    pantry     = [],
  } = req.body;

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'Provide at least one ingredient.' });
  }

  const prompt = buildPrompt({ ingredients, cuisine, difficulty, diet, goal, equipment, seasonings, pantry });

  let recipe;
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    recipe = parseJSON(completion.choices[0].message.content || '');
  } catch (err) {
    console.error('Recipe generation error:', err.message);
    return res.status(502).json({ error: 'Failed to generate recipe.' });
  }

  // Generate dish image via DALL-E 3 (non-fatal if it fails)
  try {
    const imagePrompt = `Professional food photography of "${recipe.title}". ${recipe.description}. Restaurant-quality plating on an elegant dark slate surface, cinematic soft lighting, garnished beautifully, shallow depth of field, award-winning food photo, 4k`;
    const imgResult = await client.images.generate({
      model: 'dall-e-3',
      prompt: imagePrompt,
      n: 1,
      size: '1792x1024',
      quality: 'standard',
    });
    recipe.image_url = imgResult.data[0].url;
  } catch (err) {
    console.error('Image generation error (non-fatal):', err.message);
    // Continue without image — frontend handles gracefully
  }

  res.json(recipe);
});

// ---------- start ----------

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Recipe API running on http://localhost:${PORT}`));
}

module.exports = app;
