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

function buildRecipePrompt({ ingredients, equipment, seasonings, pantry, cuisine, difficulty, diet, dietary_goal }) {
  const cuisinePart    = cuisine     && cuisine     !== 'any'  ? ` ${cuisine}`       : '';
  const dietPart       = diet        && diet        !== 'none' ? ` that is ${diet}`  : '';
  const diffPart       = difficulty  || 'easy';
  const goalPart       = dietary_goal && dietary_goal !== 'balanced'
    ? `The user's primary dietary goal is: ${dietary_goal}. Optimise ingredient quantities, cooking method, and macros around this goal.`
    : 'No specific goal given — aim for a balanced, nutritious meal.';

  const equipLine   = equipment?.length  ? `\nAvailable equipment: ${equipment.join(', ')}.`            : '';
  const seasonLine  = seasonings?.length ? `\nAvailable seasonings/spices: ${seasonings.join(', ')}.`   : '';
  const pantryLine  = pantry?.length     ? `\nPantry staples available: ${pantry.join(', ')}.`          : '';
  const kitchenCtx  = (equipLine || seasonLine || pantryLine)
    ? `\n\nKitchen context (ONLY use what is listed — flag anything else as optional):${equipLine}${seasonLine}${pantryLine}`
    : '';

  return {
    system: `You are a world-class personal chef, culinary assistant, and nutrition coach. Generate complete, practical recipes tailored EXACTLY to what the user has available. CRITICAL RULES: (1) ONLY use ingredients the user explicitly listed — do NOT add, substitute, or assume any ingredient not on their list. (2) If an ingredient would improve the dish but wasn't listed, put it in missing_optional — never sneak it into the recipe. (3) Work creatively within the constraint of only what was provided. Always make food feel delicious and premium — never like "diet food". Be precise with nutrition estimates.`,
    user: `Ingredients I have: ${ingredients.join(', ')}${kitchenCtx}

IMPORTANT: Build the recipe using ONLY the ingredients listed above. Do not use anything else.
${goalPart}
Difficulty: ${diffPart}${cuisinePart}${dietPart ? ', diet: ' + dietPart : ''}

Respond ONLY with valid JSON — no markdown, no backticks, no extra text. Exact schema:
{
  "title": "Creative recipe name",
  "cuisine_style": "e.g. Italian, Asian-Fusion",
  "dietary_goal_match": "e.g. High Protein ✓  or  Balanced ✓",
  "difficulty": "Beginner|Intermediate|Advanced",
  "prep_time": "X min",
  "cook_time": "X min",
  "servings": 2,
  "ingredients": [{ "amount": "200g", "name": "chicken breast" }],
  "missing_optional": [{ "name": "lemon", "reason": "adds brightness" }],
  "steps": [{ "instruction": "Full step text referencing the utensil.", "utensil": "cast iron pan" }],
  "plating_tip": "One sentence on presentation.",
  "nutrition": {
    "calories": 520,
    "protein": 45,
    "carbohydrates": 38,
    "fat": 16,
    "fiber": 3,
    "sugar": 4,
    "sodium": 780,
    "macro_summary": "High protein, moderate carb — ideal for muscle building."
  }
}`
  };
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// ---------- routes ----------

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Scan food ingredients from photo
app.post('/api/scan', async (req, res) => {
  const { image } = req.body;
  if (!image?.startsWith('data:image/')) return res.status(400).json({ error: 'Provide a valid base64 image.' });
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 256,
      messages: [{ role: 'user', content: [
        imagePayload(image),
        { type: 'text', text: 'List every food ingredient visible. Respond ONLY with a JSON array of lowercase strings e.g. ["chicken","garlic","lemon"]. No markdown.' },
      ]}],
    });
    res.json({ ingredients: parseJSON(completion.choices[0].message.content || '[]') });
  } catch (err) {
    console.error('Ingredient scan error:', err.message);
    res.status(500).json({ error: 'Failed to identify ingredients from image.' });
  }
});

// Scan kitchen equipment from photo
app.post('/api/scan-kitchen', async (req, res) => {
  const { image } = req.body;
  if (!image?.startsWith('data:image/')) return res.status(400).json({ error: 'Provide a valid base64 image.' });
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 512,
      messages: [{ role: 'user', content: [
        imagePayload(image),
        { type: 'text', text: 'Identify every piece of cooking equipment visible (oven, stovetop, air fryer, blender, wok, instant pot, etc.). Respond ONLY with a JSON array of short lowercase strings. No markdown.' },
      ]}],
    });
    res.json({ equipment: parseJSON(completion.choices[0].message.content || '[]') });
  } catch (err) {
    console.error('Kitchen scan error:', err.message);
    res.status(500).json({ error: 'Failed to identify kitchen equipment from image.' });
  }
});

// Generate recipe
app.post('/api/recipe', async (req, res) => {
  const {
    ingredients, cuisine = 'any', difficulty = 'easy',
    diet = 'none', dietary_goal = 'balanced',
    equipment = [], seasonings = [], pantry = [],
  } = req.body;

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'Provide at least one ingredient.' });
  }

  const { system, user } = buildRecipePrompt({ ingredients, equipment, seasonings, pantry, cuisine, difficulty, diet, dietary_goal });

  let raw;
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 1500,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    raw = completion.choices[0].message.content || '';
  } catch (err) {
    console.error('OpenAI error:', err.message);
    return res.status(502).json({ error: 'Failed to contact AI service.' });
  }

  try {
    res.json(parseJSON(raw));
  } catch (err) {
    console.error('JSON parse error:', err.message, '\nRaw:', raw);
    res.status(500).json({ error: 'AI returned an unexpected format.' });
  }
});

// Generate dish image via DALL-E 3
app.post('/api/generate-image', async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required.' });
  try {
    const response = await client.images.generate({
      model: 'dall-e-3',
      prompt: `Professional food photography of "${title}". ${description || ''}. Cinematic lighting, shallow depth of field, on a dark slate surface, garnished beautifully, styled like a Michelin-star restaurant. Ultra-realistic, appetizing, warm tones.`,
      n: 1,
      size: '1792x1024',
      quality: 'standard',
    });
    res.json({ url: response.data[0].url });
  } catch (err) {
    console.error('Image gen error:', err.message);
    res.status(500).json({ error: 'Failed to generate image.' });
  }
});

// ---------- start ----------
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Recipe API running on http://localhost:${PORT}`));
}

module.exports = app;
