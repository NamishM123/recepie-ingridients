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

// ---------- community feed ----------

const communityFeed = [
  {
    id: 'seed-1', title: 'Garlic Butter Salmon with Spinach',
    author: 'Mike Chen', avatar: '👨‍🍳',
    cuisine_style: 'Mediterranean', dietary_goal_match: 'High Protein ✓',
    difficulty: 'Beginner', prep_time: '5 min', cook_time: '15 min', servings: 2,
    ingredients: [
      { amount: '400g', name: 'salmon fillet' }, { amount: '3 tbsp', name: 'butter' },
      { amount: '4 cloves', name: 'garlic' }, { amount: '2 cups', name: 'spinach' },
    ],
    steps: [
      { instruction: 'Season salmon with salt and black pepper on both sides.', utensil: 'cutting board' },
      { instruction: 'Melt butter in pan over medium-high heat. Add minced garlic and sauté 1 min.', utensil: 'cast iron pan' },
      { instruction: 'Sear salmon 4 min per side until golden and cooked through.', utensil: 'cast iron pan' },
      { instruction: 'Add spinach around the salmon and wilt for 1 min. Serve immediately.', utensil: 'cast iron pan' },
    ],
    nutrition: { calories: 485, protein: 44, carbohydrates: 5, fat: 32, fiber: 2, sugar: 1, sodium: 420, macro_summary: 'High protein, low carb — ideal for fat loss or muscle building.' },
    plating_tip: 'Place salmon skin-side up over wilted spinach, drizzle the garlic butter on top.',
    missing_optional: [], likes: 47, postedAt: Date.now() - 86400000 * 1,
  },
  {
    id: 'seed-2', title: 'Spicy Thai Chicken Stir Fry',
    author: 'Sarah K.', avatar: '👩‍🍳',
    cuisine_style: 'Thai', dietary_goal_match: 'Balanced ✓',
    difficulty: 'Intermediate', prep_time: '10 min', cook_time: '12 min', servings: 3,
    ingredients: [
      { amount: '500g', name: 'chicken breast' }, { amount: '2', name: 'bell peppers' },
      { amount: '1 head', name: 'broccoli' }, { amount: '3 tbsp', name: 'soy sauce' },
      { amount: '1 tsp', name: 'chili flakes' }, { amount: '2 cloves', name: 'garlic' },
    ],
    steps: [
      { instruction: 'Slice chicken breast into thin strips.', utensil: 'knife & board' },
      { instruction: 'Heat wok on high. Add oil, then chicken — stir fry 5 min until golden.', utensil: 'wok' },
      { instruction: 'Add garlic, bell peppers, and broccoli. Toss 3 min.', utensil: 'wok' },
      { instruction: 'Pour in soy sauce and chili flakes. Toss 1 more min on high heat.', utensil: 'wok' },
    ],
    nutrition: { calories: 390, protein: 48, carbohydrates: 22, fat: 9, fiber: 5, sugar: 6, sodium: 890, macro_summary: 'High protein with moderate carbs from vegetables.' },
    plating_tip: 'Serve over steamed rice with a wedge of lime.',
    missing_optional: [{ name: 'lime', reason: 'adds brightness' }], likes: 31, postedAt: Date.now() - 86400000 * 2,
  },
  {
    id: 'seed-3', title: 'Creamy Mushroom Pasta',
    author: 'Luigi M.', avatar: '🧑‍🍳',
    cuisine_style: 'Italian', dietary_goal_match: 'Balanced ✓',
    difficulty: 'Beginner', prep_time: '5 min', cook_time: '20 min', servings: 2,
    ingredients: [
      { amount: '250g', name: 'pasta' }, { amount: '300g', name: 'mushrooms' },
      { amount: '200ml', name: 'heavy cream' }, { amount: '4 cloves', name: 'garlic' },
      { amount: '40g', name: 'parmesan' },
    ],
    steps: [
      { instruction: 'Cook pasta al dente. Reserve 1 cup pasta water before draining.', utensil: 'pot' },
      { instruction: 'Sauté garlic in olive oil 1 min, add sliced mushrooms. Cook until golden, ~8 min.', utensil: 'pan' },
      { instruction: 'Pour in cream, reduce 3 min. Add pasta and a splash of pasta water. Toss.', utensil: 'pan' },
      { instruction: 'Grate parmesan over, toss to melt. Season with black pepper.', utensil: 'pan' },
    ],
    nutrition: { calories: 620, protein: 22, carbohydrates: 68, fat: 28, fiber: 4, sugar: 5, sodium: 380, macro_summary: 'Balanced comfort meal with good protein from parmesan.' },
    plating_tip: 'Finish with fresh cracked pepper, extra parmesan, and a drizzle of olive oil.',
    missing_optional: [], likes: 58, postedAt: Date.now() - 86400000 * 3,
  },
  {
    id: 'seed-4', title: 'Mexican Beef & Rice Bowls',
    author: 'Carlos R.', avatar: '👨‍🍳',
    cuisine_style: 'Mexican', dietary_goal_match: 'Muscle Gain ✓',
    difficulty: 'Beginner', prep_time: '5 min', cook_time: '20 min', servings: 3,
    ingredients: [
      { amount: '500g', name: 'ground beef' }, { amount: '1 cup', name: 'white rice' },
      { amount: '2', name: 'tomatoes' }, { amount: '1 tsp', name: 'cumin' },
      { amount: '1 tsp', name: 'paprika' }, { amount: '1', name: 'onion' },
    ],
    steps: [
      { instruction: 'Cook rice according to package. Dice onion and tomatoes.', utensil: 'pot' },
      { instruction: 'Brown ground beef with diced onion over medium heat, ~8 min. Drain excess fat.', utensil: 'pan' },
      { instruction: 'Add cumin and paprika, stir 1 min. Mix in tomatoes, cook 3 min.', utensil: 'pan' },
      { instruction: 'Serve beef mixture over rice.', utensil: 'bowl' },
    ],
    nutrition: { calories: 580, protein: 45, carbohydrates: 52, fat: 18, fiber: 3, sugar: 4, sodium: 480, macro_summary: 'High protein, high carb — ideal for muscle building and recovery.' },
    plating_tip: 'Layer rice then beef, top with fresh diced tomato and a squeeze of lime.',
    missing_optional: [{ name: 'lime', reason: 'brightens the bowl' }], likes: 24, postedAt: Date.now() - 86400000 * 4,
  },
  {
    id: 'seed-5', title: 'Golden Egg Fried Rice',
    author: 'Mei L.', avatar: '👩‍🍳',
    cuisine_style: 'Asian-Fusion', dietary_goal_match: 'Balanced ✓',
    difficulty: 'Beginner', prep_time: '5 min', cook_time: '15 min', servings: 2,
    ingredients: [
      { amount: '2 cups', name: 'cooked rice' }, { amount: '3', name: 'eggs' },
      { amount: '1 cup', name: 'peas' }, { amount: '2', name: 'carrots' },
      { amount: '3 tbsp', name: 'soy sauce' }, { amount: '2 cloves', name: 'garlic' },
    ],
    steps: [
      { instruction: 'Dice carrots. Heat wok on high with oil.', utensil: 'wok' },
      { instruction: 'Add garlic, carrots and peas — stir fry 3 min.', utensil: 'wok' },
      { instruction: 'Push veg to side, crack eggs in — scramble, then mix everything.', utensil: 'wok' },
      { instruction: 'Add rice, break any clumps. Season with soy sauce. Toss on high 3 min.', utensil: 'wok' },
    ],
    nutrition: { calories: 440, protein: 18, carbohydrates: 72, fat: 10, fiber: 5, sugar: 5, sodium: 820, macro_summary: 'Carb-rich with good protein from eggs.' },
    plating_tip: 'Serve in a bowl topped with sesame seeds and sliced spring onions.',
    missing_optional: [], likes: 39, postedAt: Date.now() - 86400000 * 5,
  },
];

app.get('/api/feed', (_req, res) => {
  res.json(communityFeed.slice().sort((a, b) => b.postedAt - a.postedAt));
});

app.post('/api/share', (req, res) => {
  const { recipe, author, avatar } = req.body;
  if (!recipe?.title) return res.status(400).json({ error: 'Recipe data required.' });
  const post = {
    ...recipe,
    id: 'post-' + Date.now(),
    author: (author || 'Anonymous Chef').slice(0, 40),
    avatar: avatar || '🍳',
    likes: 0,
    postedAt: Date.now(),
  };
  communityFeed.unshift(post);
  res.json(post);
});

app.post('/api/feed/:id/like', (req, res) => {
  const post = communityFeed.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  post.likes = (post.likes || 0) + 1;
  res.json({ likes: post.likes });
});

// ---------- start ----------
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Recipe API running on http://localhost:${PORT}`));
}

module.exports = app;
