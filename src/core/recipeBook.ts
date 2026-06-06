/**
 * The v0 deterministic recipe book. Quantities are normalized to grams for a
 * 4-serving dinner. Ingredient `name`s are canonical nouns chosen to match
 * typical flyer item names via stem-subset matching (docs/DECISIONS.md D6).
 */
import type { Recipe } from './types.js';

export const RECIPE_BOOK: Recipe[] = [
  {
    dish: 'butter chicken',
    servings: 4,
    ingredients: [
      { name: 'chicken', qtyGrams: 600, category: 'protein', substitutes: ['chicken thighs', 'chicken breast'] },
      { name: 'butter', qtyGrams: 60, category: 'dairy', substitutes: ['margarine'] },
      { name: 'onion', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'ginger', qtyGrams: 15, category: 'produce', substitutes: [] },
      { name: 'tomato', qtyGrams: 400, category: 'produce', substitutes: ['crushed tomatoes', 'tomato sauce'] },
      { name: 'cream', qtyGrams: 200, category: 'dairy', substitutes: ['whipping cream', 'heavy cream'] },
      { name: 'garam masala', qtyGrams: 10, category: 'spice', substitutes: ['curry powder'] },
      { name: 'rice', qtyGrams: 300, category: 'grain', substitutes: ['basmati rice'] },
    ],
  },
  {
    dish: 'spaghetti bolognese',
    servings: 4,
    ingredients: [
      { name: 'spaghetti', qtyGrams: 400, category: 'grain', substitutes: ['pasta'] },
      { name: 'beef', qtyGrams: 500, category: 'protein', substitutes: ['ground beef'] },
      { name: 'onion', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'tomato', qtyGrams: 400, category: 'produce', substitutes: ['crushed tomatoes', 'tomato sauce'] },
      { name: 'carrot', qtyGrams: 120, category: 'produce', substitutes: [] },
      { name: 'parmesan', qtyGrams: 60, category: 'dairy', substitutes: ['parmigiano'] },
    ],
  },
  {
    dish: 'beef tacos',
    servings: 4,
    ingredients: [
      { name: 'beef', qtyGrams: 500, category: 'protein', substitutes: ['ground beef'] },
      { name: 'tortilla', qtyGrams: 300, category: 'bakery', substitutes: ['tortillas'] },
      { name: 'onion', qtyGrams: 120, category: 'produce', substitutes: [] },
      { name: 'cheese', qtyGrams: 150, category: 'dairy', substitutes: ['cheddar'] },
      { name: 'lettuce', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'tomato', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'salsa', qtyGrams: 250, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'chicken caesar salad',
    servings: 4,
    ingredients: [
      { name: 'chicken', qtyGrams: 400, category: 'protein', substitutes: ['chicken breast'] },
      { name: 'lettuce', qtyGrams: 300, category: 'produce', substitutes: ['romaine'] },
      { name: 'parmesan', qtyGrams: 60, category: 'dairy', substitutes: ['parmigiano'] },
      { name: 'bread', qtyGrams: 100, category: 'bakery', substitutes: ['croutons'] },
      { name: 'lemon', qtyGrams: 60, category: 'produce', substitutes: [] },
    ],
  },
  {
    dish: 'vegetable stir fry',
    servings: 4,
    ingredients: [
      { name: 'broccoli', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'carrot', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 200, category: 'produce', substitutes: ['peppers'] },
      { name: 'onion', qtyGrams: 120, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'soy sauce', qtyGrams: 60, category: 'pantry', substitutes: [] },
      { name: 'rice', qtyGrams: 300, category: 'grain', substitutes: ['basmati rice'] },
    ],
  },
  {
    dish: 'margherita pizza',
    servings: 4,
    ingredients: [
      { name: 'flour', qtyGrams: 400, category: 'pantry', substitutes: ['pizza dough'] },
      { name: 'mozzarella', qtyGrams: 250, category: 'dairy', substitutes: ['cheese'] },
      { name: 'tomato', qtyGrams: 300, category: 'produce', substitutes: ['tomato sauce'] },
      { name: 'basil', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'grilled cheese',
    servings: 2,
    ingredients: [
      { name: 'bread', qtyGrams: 160, category: 'bakery', substitutes: [] },
      { name: 'cheese', qtyGrams: 120, category: 'dairy', substitutes: ['cheddar'] },
      { name: 'butter', qtyGrams: 40, category: 'dairy', substitutes: ['margarine'] },
    ],
  },
  {
    dish: 'tomato soup',
    servings: 4,
    ingredients: [
      { name: 'tomato', qtyGrams: 800, category: 'produce', substitutes: ['crushed tomatoes'] },
      { name: 'onion', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 15, category: 'produce', substitutes: [] },
      { name: 'cream', qtyGrams: 120, category: 'dairy', substitutes: ['whipping cream'] },
      { name: 'butter', qtyGrams: 40, category: 'dairy', substitutes: [] },
      { name: 'basil', qtyGrams: 15, category: 'produce', substitutes: [] },
    ],
  },
  {
    dish: 'pancakes',
    servings: 4,
    ingredients: [
      { name: 'flour', qtyGrams: 300, category: 'pantry', substitutes: [] },
      { name: 'milk', qtyGrams: 500, category: 'dairy', substitutes: [] },
      { name: 'egg', qtyGrams: 120, category: 'protein', substitutes: ['eggs'] },
      { name: 'butter', qtyGrams: 50, category: 'dairy', substitutes: [] },
      { name: 'sugar', qtyGrams: 50, category: 'pantry', substitutes: [] },
      { name: 'baking powder', qtyGrams: 15, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'guacamole',
    servings: 4,
    ingredients: [
      { name: 'avocado', qtyGrams: 400, category: 'produce', substitutes: ['avocados'] },
      { name: 'lime', qtyGrams: 60, category: 'produce', substitutes: [] },
      { name: 'onion', qtyGrams: 80, category: 'produce', substitutes: [] },
      { name: 'tomato', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'cilantro', qtyGrams: 20, category: 'produce', substitutes: ['coriander'] },
    ],
  },
  {
    dish: 'omelette',
    servings: 2,
    ingredients: [
      { name: 'egg', qtyGrams: 240, category: 'protein', substitutes: ['eggs'] },
      { name: 'cheese', qtyGrams: 80, category: 'dairy', substitutes: ['cheddar'] },
      { name: 'butter', qtyGrams: 20, category: 'dairy', substitutes: [] },
      { name: 'milk', qtyGrams: 60, category: 'dairy', substitutes: [] },
      { name: 'onion', qtyGrams: 60, category: 'produce', substitutes: [] },
    ],
  },
  {
    dish: 'chicken curry',
    servings: 4,
    ingredients: [
      { name: 'chicken', qtyGrams: 600, category: 'protein', substitutes: ['chicken thighs'] },
      { name: 'onion', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'ginger', qtyGrams: 15, category: 'produce', substitutes: [] },
      { name: 'curry powder', qtyGrams: 20, category: 'spice', substitutes: ['garam masala'] },
      { name: 'tomato', qtyGrams: 300, category: 'produce', substitutes: ['crushed tomatoes'] },
      { name: 'rice', qtyGrams: 300, category: 'grain', substitutes: ['basmati rice'] },
    ],
  },
];
