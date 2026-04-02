const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/recipe', async (req, res) => {
  const { ingredients, cuisine, difficulty, diet } = req.body;

  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'No ingredients provided' });
  }

  const prompt = `You are a world-class chef. Given these ingredients: ${ingredients.join(', ')}
Create a ${difficulty} ${cuisine !== 'any' ? cuisine : ''} recipe${diet !== 'none' ? ` that is ${diet}` : ''}.

Respond ONLY with valid JSON, no markdown, no backticks, no preamble. Schema:
{
  "title": "Recipe Name",
  "description": "One evocative sentence describing the dish",
  "prep_time": "X min",
  "cook_time": "X min",
  "servings": "X",
  "ingredients": [{"amount": "X cup", "name": "ingredient"}],
  "steps": ["Step instruction 1", "Step instruction 2"],
  "tip": "One chef's tip or variation (optional, can be empty string)"
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content.map(b => b.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const recipe = JSON.parse(clean);
    res.json(recipe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate recipe' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Recipe API running on http://localhost:${PORT}`));
