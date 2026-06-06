/**
 * ClaudeRecipeParser — LIVE recipe parser over the Anthropic Messages API.
 * Reads ANTHROPIC_API_KEY from the environment (docs/DECISIONS.md D8). Turns an
 * open-ended dinner request into a structured Recipe. Never exercised by tests;
 * the deterministic StaticRecipeParser is the tested default.
 */
import type { Recipe, RecipeParser } from '../core/types.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = `You convert a free-text dinner request into a structured grocery recipe.
Respond with ONLY a JSON object matching:
{
  "dish": string,
  "servings": number,
  "ingredients": [
    { "name": string, "qtyGrams": number, "category": "protein"|"produce"|"dairy"|"pantry"|"spice"|"grain"|"bakery"|"other", "substitutes": string[] }
  ]
}
Use canonical, singular ingredient nouns (e.g. "chicken", "tomato", "olive oil").
Normalize every quantity to grams for the given servings (assume 4 if unspecified).`;

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface ClaudeRecipeOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class ClaudeRecipeParser implements RecipeParser {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeRecipeOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set (required for --live recipe parsing).');
    }
    this.apiKey = apiKey;
    this.model = options.model ?? MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async parse(dinner: string): Promise<Recipe> {
    const res = await this.fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: dinner }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic request failed (${res.status}).`);
    }
    const body = (await res.json()) as AnthropicResponse;
    const text = body.content.find((c) => c.type === 'text')?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(json) as Recipe;
  }
}
