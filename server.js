'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Supabase — optional, app falls back to in-memory if not configured
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const DB = !!supabase;

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
  const cuisinePart = cuisine    && cuisine    !== 'any'  ? ` ${cuisine}`      : '';
  const dietPart    = diet       && diet       !== 'none' ? ` that is ${diet}` : '';
  const diffPart    = difficulty || 'easy';
  const goalPart    = dietary_goal && dietary_goal !== 'balanced'
    ? `The user's primary dietary goal is: ${dietary_goal}. Optimise ingredient quantities, cooking method, and macros around this goal.`
    : 'No specific goal given — aim for a balanced, nutritious meal.';

  const equipLine  = equipment?.length  ? `\nAvailable equipment: ${equipment.join(', ')}.`          : '';
  const seasonLine = seasonings?.length ? `\nAvailable seasonings/spices: ${seasonings.join(', ')}.` : '';
  const pantryLine = pantry?.length     ? `\nPantry staples available: ${pantry.join(', ')}.`        : '';
  const kitchenCtx = (equipLine || seasonLine || pantryLine)
    ? `\n\nKitchen context (ONLY use what is listed — flag anything else as optional):${equipLine}${seasonLine}${pantryLine}`
    : '';

  return {
    system: `You are a world-class personal chef, culinary assistant, and nutrition coach. Generate complete, practical recipes tailored EXACTLY to what the user has available. CRITICAL RULES: (1) ONLY use ingredients the user explicitly listed — do NOT add, substitute, or assume any ingredient not on their list. (2) If an ingredient would improve the dish but wasn't listed, put it in missing_optional — never sneak it into the recipe. (3) Work creatively within the constraint of only what was provided. Always make food feel delicious and premium. Be precise with nutrition estimates.`,
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
    "calories": 520, "protein": 45, "carbohydrates": 38, "fat": 16,
    "fiber": 3, "sugar": 4, "sodium": 780,
    "macro_summary": "High protein, moderate carb — ideal for muscle building."
  }
}`
  };
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function unsplashImage(query) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return null;
  try {
    const q = encodeURIComponent(query + ' food dish');
    const r = await fetch(
      `https://api.unsplash.com/search/photos?query=${q}&orientation=landscape&per_page=1&order_by=relevant`,
      { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } }
    );
    const data = await r.json();
    return data.results?.[0]?.urls?.regular || null;
  } catch { return null; }
}

// ---------- auth middleware ----------

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Login required.' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid session. Please log in again.' });
  req.user = user;
  next();
}

async function optionalAuth(req, _res, next) {
  if (!supabase) return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token);
    req.user = user || null;
  }
  next();
}

// ---------- config (safe public values for frontend) ----------

app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL     || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    hasDb: DB,
  });
});

// ---------- scan routes ----------

app.get('/health', (_req, res) => res.json({ status: 'ok', db: DB }));

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
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Failed to identify ingredients from image.' });
  }
});

app.post('/api/scan-kitchen', async (req, res) => {
  const { image } = req.body;
  if (!image?.startsWith('data:image/')) return res.status(400).json({ error: 'Provide a valid base64 image.' });
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 512,
      messages: [{ role: 'user', content: [
        imagePayload(image),
        { type: 'text', text: 'Identify every piece of cooking equipment visible. Respond ONLY with a JSON array of short lowercase strings. No markdown.' },
      ]}],
    });
    res.json({ equipment: parseJSON(completion.choices[0].message.content || '[]') });
  } catch (err) {
    res.status(500).json({ error: 'Failed to identify kitchen equipment.' });
  }
});

// ---------- recipe generation ----------

app.post('/api/recipe', async (req, res) => {
  const { ingredients, cuisine = 'any', difficulty = 'easy', diet = 'none', dietary_goal = 'balanced', equipment = [], seasonings = [], pantry = [] } = req.body;
  if (!Array.isArray(ingredients) || !ingredients.length)
    return res.status(400).json({ error: 'Provide at least one ingredient.' });

  const { system, user } = buildRecipePrompt({ ingredients, equipment, seasonings, pantry, cuisine, difficulty, diet, dietary_goal });
  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o', max_tokens: 1500,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    res.json(parseJSON(completion.choices[0].message.content || ''));
  } catch (err) {
    console.error('Recipe error:', err.message);
    res.status(502).json({ error: 'Failed to generate recipe.' });
  }
});

// ---------- image generation ----------

app.post('/api/generate-image', async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required.' });

  if (process.env.UNSPLASH_ACCESS_KEY) {
    try {
      const q = encodeURIComponent(title + ' food dish');
      const r = await fetch(
        `https://api.unsplash.com/search/photos?query=${q}&orientation=landscape&per_page=1&order_by=relevant`,
        { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } }
      );
      const data = await r.json();
      if (data.results?.[0]?.urls?.regular)
        return res.json({ url: data.results[0].urls.regular });
    } catch (err) { console.error('Unsplash error:', err.message); }
  }

  try {
    const response = await client.images.generate({
      model: 'dall-e-2',
      prompt: `Professional food photography of ${title}. Appetizing, well-lit, high quality food photo.`,
      n: 1, size: '512x512',
    });
    res.json({ url: response.data[0].url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate image.' });
  }
});

// ---------- hero images ----------

const heroImageCache = [];
const HERO_QUERIES = ['gourmet pasta dinner', 'grilled salmon plated', 'beef steak fine dining', 'colorful vegetable stir fry', 'chicken dish restaurant', 'fresh salad bowl'];

app.get('/api/hero-images', async (_req, res) => {
  if (heroImageCache.length) return res.json(heroImageCache);
  if (!process.env.UNSPLASH_ACCESS_KEY) return res.json([]);
  try {
    const results = await Promise.all(HERO_QUERIES.map(async q => {
      const r = await fetch(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&orientation=landscape&per_page=1&order_by=relevant`,
        { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } }
      );
      const d = await r.json();
      return d.results?.[0]?.urls?.regular || null;
    }));
    const valid = results.filter(Boolean);
    heroImageCache.push(...valid);
    res.json(valid);
  } catch { res.json([]); }
});

// ---------- community feed ----------

// In-memory fallback seed data (used when DB not configured)
const memFeed = [
  { id:'seed-1', title:'Garlic Butter Salmon with Spinach', author:'Mike Chen', avatar:'👨‍🍳', cuisine_style:'Mediterranean', dietary_goal_match:'High Protein ✓', difficulty:'Beginner', prep_time:'5 min', cook_time:'15 min', servings:2, ingredients:[{amount:'400g',name:'salmon fillet'},{amount:'3 tbsp',name:'butter'},{amount:'4 cloves',name:'garlic'},{amount:'2 cups',name:'spinach'}], steps:[{instruction:'Season salmon with salt and black pepper.',utensil:'cutting board'},{instruction:'Melt butter, add garlic, sear salmon 4 min per side.',utensil:'cast iron pan'},{instruction:'Add spinach, wilt 1 min. Serve.',utensil:'cast iron pan'}], nutrition:{calories:485,protein:44,carbohydrates:5,fat:32,fiber:2,sugar:1,sodium:420,macro_summary:'High protein, low carb.'}, plating_tip:'Drizzle garlic butter over salmon on a bed of spinach.', missing_optional:[], likes:47, postedAt:Date.now()-86400000*1 },
  { id:'seed-2', title:'Spicy Thai Chicken Stir Fry', author:'Sarah K.', avatar:'👩‍🍳', cuisine_style:'Thai', dietary_goal_match:'Balanced ✓', difficulty:'Intermediate', prep_time:'10 min', cook_time:'12 min', servings:3, ingredients:[{amount:'500g',name:'chicken breast'},{amount:'2',name:'bell peppers'},{amount:'1 head',name:'broccoli'},{amount:'3 tbsp',name:'soy sauce'}], steps:[{instruction:'Slice chicken.',utensil:'knife'},{instruction:'Stir fry chicken 5 min, add veg and soy sauce.',utensil:'wok'}], nutrition:{calories:390,protein:48,carbohydrates:22,fat:9,fiber:5,sugar:6,sodium:890,macro_summary:'High protein.'}, plating_tip:'Serve over steamed rice with lime.', missing_optional:[{name:'lime',reason:'adds brightness'}], likes:31, postedAt:Date.now()-86400000*2 },
  { id:'seed-3', title:'Creamy Mushroom Pasta', author:'Luigi M.', avatar:'🧑‍🍳', cuisine_style:'Italian', dietary_goal_match:'Balanced ✓', difficulty:'Beginner', prep_time:'5 min', cook_time:'20 min', servings:2, ingredients:[{amount:'250g',name:'pasta'},{amount:'300g',name:'mushrooms'},{amount:'200ml',name:'heavy cream'},{amount:'40g',name:'parmesan'}], steps:[{instruction:'Cook pasta al dente.',utensil:'pot'},{instruction:'Sauté mushrooms, add cream, toss with pasta and parmesan.',utensil:'pan'}], nutrition:{calories:620,protein:22,carbohydrates:68,fat:28,fiber:4,sugar:5,sodium:380,macro_summary:'Balanced.'}, plating_tip:'Finish with cracked pepper and olive oil.', missing_optional:[], likes:58, postedAt:Date.now()-86400000*3 },
  { id:'seed-4', title:'Mexican Beef & Rice Bowls', author:'Carlos R.', avatar:'👨‍🍳', cuisine_style:'Mexican', dietary_goal_match:'Muscle Gain ✓', difficulty:'Beginner', prep_time:'5 min', cook_time:'20 min', servings:3, ingredients:[{amount:'500g',name:'ground beef'},{amount:'1 cup',name:'white rice'},{amount:'2',name:'tomatoes'}], steps:[{instruction:'Cook rice.',utensil:'pot'},{instruction:'Brown beef with cumin and paprika, add tomatoes.',utensil:'pan'}], nutrition:{calories:580,protein:45,carbohydrates:52,fat:18,fiber:3,sugar:4,sodium:480,macro_summary:'High protein and carb.'}, plating_tip:'Layer rice then beef, top with tomato.', missing_optional:[], likes:24, postedAt:Date.now()-86400000*4 },
  { id:'seed-5', title:'Golden Egg Fried Rice', author:'Mei L.', avatar:'👩‍🍳', cuisine_style:'Asian-Fusion', dietary_goal_match:'Balanced ✓', difficulty:'Beginner', prep_time:'5 min', cook_time:'15 min', servings:2, ingredients:[{amount:'2 cups',name:'cooked rice'},{amount:'3',name:'eggs'},{amount:'1 cup',name:'peas'},{amount:'3 tbsp',name:'soy sauce'}], steps:[{instruction:'Stir fry veg, scramble eggs, add rice and soy sauce.',utensil:'wok'}], nutrition:{calories:440,protein:18,carbohydrates:72,fat:10,fiber:5,sugar:5,sodium:820,macro_summary:'Carb-rich with protein from eggs.'}, plating_tip:'Top with sesame seeds.', missing_optional:[], likes:39, postedAt:Date.now()-86400000*5 },
];

// Fetch & cache Unsplash images for feed posts missing one
async function enrichWithImages(posts) {
  await Promise.all(posts.map(async post => {
    if (!post.image_url) {
      const url = await unsplashImage(post.title);
      if (url) {
        post.image_url = url;
        // Persist to DB if available
        if (supabase && post.id && !post.id.startsWith('seed-')) {
          await supabase.from('posts').update({ image_url: url }).eq('id', post.id);
        }
      }
    }
  }));
  return posts;
}

// GET /api/feed
app.get('/api/feed', async (_req, res) => {
  if (!DB) {
    const feed = memFeed.slice().sort((a, b) => b.postedAt - a.postedAt);
    await enrichWithImages(feed);
    return res.json(feed);
  }
  const { data, error } = await supabase.from('posts').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });

  // Seed DB if empty
  if (data.length === 0) {
    for (const s of memFeed) {
      const image_url = await unsplashImage(s.title);
      await supabase.from('posts').insert({
        title: s.title, author: s.author, recipe: s, image_url,
        likes: s.likes, created_at: new Date(s.postedAt).toISOString(),
      });
    }
    const { data: seeded } = await supabase.from('posts').select('*').order('created_at', { ascending: false });
    return res.json(seeded || []);
  }

  await enrichWithImages(data);
  res.json(data);
});

// POST /api/share  (requires auth)
app.post('/api/share', requireAuth, async (req, res) => {
  const { recipe, author } = req.body;
  if (!recipe?.title) return res.status(400).json({ error: 'Recipe data required.' });

  const image_url = recipe.image_url || await unsplashImage(recipe.title);
  const displayName = (author || req.user.user_metadata?.full_name || req.user.email?.split('@')[0] || 'Chef').slice(0, 40);

  if (!DB) {
    const post = { ...recipe, id:'post-'+Date.now(), author:displayName, avatar:'🍳', likes:0, postedAt:Date.now(), image_url };
    memFeed.unshift(post);
    return res.json(post);
  }

  const { data, error } = await supabase.from('posts').insert({
    user_id: req.user.id,
    title: recipe.title,
    author: displayName,
    recipe,
    image_url,
    likes: 0,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/feed/:id/like  (requires auth)
app.post('/api/feed/:id/like', requireAuth, async (req, res) => {
  if (!DB) {
    const post = memFeed.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found.' });
    post.likes = (post.likes || 0) + 1;
    return res.json({ likes: post.likes });
  }

  // Deduplicate via post_likes table
  const { error: dupErr } = await supabase.from('post_likes').insert({ user_id: req.user.id, post_id: req.params.id });
  if (dupErr) return res.status(400).json({ error: 'Already liked.' });

  // Increment
  const { data: current } = await supabase.from('posts').select('likes').eq('id', req.params.id).single();
  const { data, error } = await supabase.from('posts').update({ likes: (current?.likes || 0) + 1 }).eq('id', req.params.id).select('likes').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ likes: data.likes });
});

// ---------- saved recipes ----------

// GET /api/saved  (requires auth)
app.get('/api/saved', requireAuth, async (req, res) => {
  if (!DB) return res.json([]);
  const { data, error } = await supabase.from('saved_recipes').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/saved  (requires auth)
app.post('/api/saved', requireAuth, async (req, res) => {
  const { recipe } = req.body;
  if (!recipe?.title) return res.status(400).json({ error: 'Recipe required.' });
  if (!DB) return res.status(503).json({ error: 'Database not configured.' });

  // Prevent duplicates
  const { data: existing } = await supabase.from('saved_recipes').select('id').eq('user_id', req.user.id).eq('recipe->>title', recipe.title).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Already saved.' });

  const { data, error } = await supabase.from('saved_recipes').insert({ user_id: req.user.id, recipe }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/saved/:id  (requires auth)
app.delete('/api/saved/:id', requireAuth, async (req, res) => {
  if (!DB) return res.json({ success: true });
  const { error } = await supabase.from('saved_recipes').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---------- start ----------
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Recipe API running on http://localhost:${PORT}`));
}

module.exports = app;
