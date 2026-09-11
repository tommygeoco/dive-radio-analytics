import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const functions = html.slice(html.indexOf('function feedbackSource('), html.indexOf('/* ================= drilldown modal'));
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function render(audience) {
  const element = { style: {}, innerHTML: '', querySelectorAll: () => [] };
  const episode = { ep: 9, slug: 'episode-nine', audience };
  const ctx = vm.createContext({ esc, state: {}, EPS: [episode], NEWEST: episode, document: { getElementById: () => element } });
  vm.runInContext(functions + '\nbuildAudiencePreview();', ctx);
  return element;
}
test('new episode with no approved rows visibly reports pending capture instead of disappearing or claiming zero sentiment', () => {
  const element = render({ count: 0, positiveCount: 0, negativeCount: 0, featured: [], notices: ['More captured comments are still being processed.'] });
  assert.equal(element.style.display, '');
  assert.match(element.innerHTML, /still being processed/);
  assert.doesNotMatch(element.innerHTML, /0 positive comments|0 with criticism|Read all 0/);
});
test('visible quote preserves escaped source text and offers the complete feedback list', () => {
  const element = render({ count: 2, positiveCount: 2, negativeCount: 0, notices: [], featured: [{ text: '<img src=x onerror=alert(1)> Best episode', author: '@viewer', source: 'x', url: 'https://x.com/i/status/123' }] });
  assert.match(element.innerHTML, /Read all 2 comments/);
  assert.match(element.innerHTML, /&lt;img/); assert.doesNotMatch(element.innerHTML, /<img/);
  assert.match(element.innerHTML, /https:\/\/x.com\/i\/status\/123/);
});
