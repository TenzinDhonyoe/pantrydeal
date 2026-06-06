/**
 * DRAFT vetted prediabetes recipe library. Every recipe here is constructed from
 * ingredients in the nutrition table and is checked, in tests, to pass
 * validateRecipe() against the DRAFT targets. That is "vetted by construction in
 * code"; a credentialed dietician must still sign off the clinical content before
 * any patient sees it (docs/DECISIONS.md D15, design doc Part 4). Quantities are
 * grams for 4 servings unless noted.
 */
import type { Recipe } from './types.js';

export const PREDIABETES_RECIPES: Recipe[] = [
  {
    dish: 'Chicken & barley bowl',
    servings: 4,
    ingredients: [
      { name: 'chicken', qtyGrams: 500, category: 'protein', substitutes: ['turkey'] },
      { name: 'barley', qtyGrams: 600, category: 'grain', substitutes: ['brown rice'] },
      { name: 'broccoli', qtyGrams: 400, category: 'produce', substitutes: ['cauliflower'] },
      { name: 'carrot', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Salmon, quinoa & spinach',
    servings: 4,
    ingredients: [
      { name: 'salmon', qtyGrams: 480, category: 'protein', substitutes: [] },
      { name: 'quinoa', qtyGrams: 600, category: 'grain', substitutes: ['brown rice'] },
      { name: 'chickpeas', qtyGrams: 200, category: 'protein', substitutes: ['lentils'] },
      { name: 'spinach', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Turkey & black bean tacos',
    servings: 4,
    ingredients: [
      { name: 'turkey', qtyGrams: 400, category: 'protein', substitutes: ['chicken'] },
      { name: 'black beans', qtyGrams: 400, category: 'protein', substitutes: ['lentils'] },
      { name: 'whole wheat tortilla', qtyGrams: 200, category: 'bakery', substitutes: [] },
      { name: 'tomato', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'onion', qtyGrams: 120, category: 'produce', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 160, category: 'produce', substitutes: [] },
      { name: 'avocado', qtyGrams: 200, category: 'produce', substitutes: [] },
    ],
  },
  {
    dish: 'Tofu vegetable stir-fry with brown rice',
    servings: 4,
    ingredients: [
      { name: 'tofu', qtyGrams: 700, category: 'protein', substitutes: [] },
      { name: 'brown rice', qtyGrams: 600, category: 'grain', substitutes: [] },
      { name: 'broccoli', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'carrot', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'onion', qtyGrams: 120, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Lean beef & vegetable quinoa bowl',
    servings: 4,
    ingredients: [
      { name: 'beef', qtyGrams: 500, category: 'protein', substitutes: [] },
      { name: 'quinoa', qtyGrams: 500, category: 'grain', substitutes: [] },
      { name: 'green beans', qtyGrams: 400, category: 'produce', substitutes: [] },
      { name: 'mushroom', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'onion', qtyGrams: 120, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Shrimp & vegetable stir-fry with brown rice',
    servings: 4,
    ingredients: [
      { name: 'shrimp', qtyGrams: 480, category: 'protein', substitutes: [] },
      { name: 'brown rice', qtyGrams: 500, category: 'grain', substitutes: [] },
      { name: 'broccoli', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'peas', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Chicken, kale & barley',
    servings: 4,
    ingredients: [
      { name: 'chicken', qtyGrams: 500, category: 'protein', substitutes: [] },
      { name: 'barley', qtyGrams: 500, category: 'grain', substitutes: [] },
      { name: 'kale', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'carrot', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Lentil & mushroom vegetable stew',
    servings: 4,
    ingredients: [
      { name: 'lentils', qtyGrams: 700, category: 'protein', substitutes: [] },
      { name: 'canned tomatoes', qtyGrams: 400, category: 'pantry', substitutes: [] },
      { name: 'carrot', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'onion', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'mushroom', qtyGrams: 300, category: 'produce', substitutes: [] },
      { name: 'garlic', qtyGrams: 20, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Tofu & edamame rice bowl',
    servings: 4,
    ingredients: [
      { name: 'tofu', qtyGrams: 700, category: 'protein', substitutes: [] },
      { name: 'edamame', qtyGrams: 300, category: 'protein', substitutes: [] },
      { name: 'brown rice', qtyGrams: 500, category: 'grain', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'carrot', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Salmon, cauliflower & quinoa',
    servings: 4,
    ingredients: [
      { name: 'salmon', qtyGrams: 480, category: 'protein', substitutes: [] },
      { name: 'quinoa', qtyGrams: 500, category: 'grain', substitutes: [] },
      { name: 'cauliflower', qtyGrams: 400, category: 'produce', substitutes: [] },
      { name: 'chickpeas', qtyGrams: 200, category: 'protein', substitutes: [] },
      { name: 'spinach', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Turkey & black bean chili',
    servings: 4,
    ingredients: [
      { name: 'turkey', qtyGrams: 400, category: 'protein', substitutes: [] },
      { name: 'black beans', qtyGrams: 400, category: 'protein', substitutes: [] },
      { name: 'canned tomatoes', qtyGrams: 400, category: 'pantry', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'onion', qtyGrams: 150, category: 'produce', substitutes: [] },
      { name: 'chili powder', qtyGrams: 20, category: 'spice', substitutes: [] },
      { name: 'olive oil', qtyGrams: 30, category: 'pantry', substitutes: [] },
    ],
  },
  {
    dish: 'Egg & black bean veggie scramble',
    servings: 4,
    ingredients: [
      { name: 'egg', qtyGrams: 480, category: 'protein', substitutes: [] },
      { name: 'black beans', qtyGrams: 300, category: 'protein', substitutes: [] },
      { name: 'cottage cheese', qtyGrams: 200, category: 'dairy', substitutes: [] },
      { name: 'spinach', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'bell pepper', qtyGrams: 200, category: 'produce', substitutes: [] },
      { name: 'whole wheat tortilla', qtyGrams: 200, category: 'bakery', substitutes: [] },
      { name: 'onion', qtyGrams: 120, category: 'produce', substitutes: [] },
    ],
  },
];
