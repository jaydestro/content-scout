// Locks in renderer parsing + style-preset resolution + shiftColor's
// expanded hex handling. Run as part of the standard `npm test` suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseThumbnails,
  resolveStyle,
  shiftColor,
  STYLE_PRESETS,
} from '../../render-thumbnails/index.js';

const SAMPLE = `
Some intro prose.

**Thumbnail spec:**
- Style: branded
- Style notes: warm tones, conference vibe
- Background: #0F2540
- Headline: Build multi-agent apps
- Subtext: With Cosmos DB
- Accent: #50E3C2
- Save path: social-posts/images/test/sample.png

More prose after.
`;

test('parseThumbnails extracts the Style and Style notes keys', () => {
  const blocks = parseThumbnails(SAMPLE);
  assert.equal(blocks.length, 1);
  const props = blocks[0];
  assert.equal(props.style, 'branded');
  assert.equal(props['style notes'], 'warm tones, conference vibe');
  assert.equal(props.background, '#0F2540');
  assert.equal(props.headline, 'Build multi-agent apps');
});

test('resolveStyle falls back to minimal for unknown / auto values', () => {
  // resolveStyle returns a fresh object that may carry extra metadata
  // (e.g. a `name` field). Assert by the resolved preset name + a couple
  // of marker fields rather than reference / structural identity.
  assert.equal(resolveStyle('minimal').name, 'minimal');
  assert.equal(resolveStyle('branded').name, 'branded');
  assert.equal(resolveStyle('auto').name, 'minimal');
  assert.equal(resolveStyle('').name, 'minimal');
  assert.equal(resolveStyle(undefined).name, 'minimal');
  // Sanity: the resolved preset still carries the canonical fields.
  const branded = resolveStyle('branded');
  assert.equal(branded.layout, STYLE_PRESETS.branded.layout);
  assert.equal(branded.backgroundStyle, STYLE_PRESETS.branded.backgroundStyle);
});

test('shiftColor handles 3-, 6-, and 8-digit hex inputs', () => {
  // 6-digit baseline.
  const lighter6 = shiftColor('#0F2540', 0.5);
  assert.match(lighter6, /^#[0-9a-fA-F]{6}$/);
  assert.notEqual(lighter6.toLowerCase(), '#0f2540');

  // 3-digit short form should be expanded and shifted, not returned as-is.
  const lighter3 = shiftColor('#fff', -0.25);
  assert.match(lighter3, /^#[0-9a-fA-F]{6}$/);
  assert.notEqual(lighter3.toLowerCase(), '#ffffff');

  // 8-digit (with alpha) should drop alpha and shift.
  const lighter8 = shiftColor('#0F2540ff', 0.5);
  assert.match(lighter8, /^#[0-9a-fA-F]{6}$/);
  assert.equal(lighter8.toLowerCase(), lighter6.toLowerCase());

  // Garbage input returns unchanged so callers can fall back gracefully.
  assert.equal(shiftColor('not-a-color', 0.5), 'not-a-color');
});
