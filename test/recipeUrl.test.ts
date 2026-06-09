import { describe, it, expect } from 'vitest';
import { extractJsonLdRecipe, htmlToText } from '../src/integrations/recipeUrl.js';

const ldBlock = (json: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body>...</body></html>`;

describe('extractJsonLdRecipe', () => {
  it('pulls ingredients, name, and numeric yield from a Recipe node', () => {
    const r = extractJsonLdRecipe(
      ldBlock({
        '@type': 'Recipe',
        name: 'Black Bean Tacos',
        recipeYield: '4 servings',
        recipeIngredient: ['2 cups black beans, drained', '8 corn tortillas', '1 avocado'],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.name).toBe('Black Bean Tacos');
    expect(r!.yield).toBe(4);
    expect(r!.lines).toHaveLength(3);
  });

  it('finds the Recipe inside an @graph array', () => {
    const r = extractJsonLdRecipe(
      ldBlock({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebPage', name: 'A blog post' },
          { '@type': ['Recipe', 'NewsArticle'], name: 'Soup', recipeIngredient: ['1 onion', '2 carrots'] },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.name).toBe('Soup');
    expect(r!.lines).toEqual(['1 onion', '2 carrots']);
  });

  it('returns null when there is no Recipe node', () => {
    expect(extractJsonLdRecipe(ldBlock({ '@type': 'WebPage', name: 'Not a recipe' }))).toBeNull();
  });

  it('returns null when a Recipe has no ingredient lines', () => {
    expect(extractJsonLdRecipe(ldBlock({ '@type': 'Recipe', name: 'Empty' }))).toBeNull();
  });

  it('skips malformed JSON-LD blocks without throwing', () => {
    const html = '<script type="application/ld+json">{ not json }</script>';
    expect(extractJsonLdRecipe(html)).toBeNull();
  });

  it('returns null when there is no JSON-LD at all', () => {
    expect(extractJsonLdRecipe('<html><body>just a page</body></html>')).toBeNull();
  });
});

describe('htmlToText', () => {
  it('strips scripts, styles, and tags and collapses whitespace', () => {
    const html =
      '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>' +
      '<body><h1>Title</h1>\n\n<p>Two   spaces</p></body></html>';
    const text = htmlToText(html);
    expect(text).not.toMatch(/alert|color:red|</);
    expect(text).toContain('Title');
    expect(text).toContain('Two spaces');
  });

  it('caps very long pages', () => {
    const huge = '<p>' + 'x'.repeat(500_000) + '</p>';
    expect(htmlToText(huge).length).toBeLessThanOrEqual(100_000);
  });
});
