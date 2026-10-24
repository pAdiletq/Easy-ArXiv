import assert from 'node:assert/strict';
import test from 'node:test';
import {arxivPDFSource, classifySelection, isLocalPreview, normalizeSelection} from '../extensions/formula-lens/selection.js';

const SOURCE = 'https://arxiv.org/pdf/1706.03762';
const EQUATION = 'Attention(Q, K, V) = softmax(QKᵀ / √dₖ)V';

test('recognizes the complete scaled attention equation with real PDF glyph and fraction-bar variants', () => {
  for (const text of [EQUATION, 'Attention(Q, K, V ) = softmax( QKT\n√d k\n) V (1)',
    'Attention(Q,K,V)=softmax(QK^T/sqrt(d_k))V',
    'Attention(Q,K,V)=softmax(QK^{T}/√d_{k})V (1)',
    '𝑨ttention(𝑄, 𝐾, 𝑉) = softmax(𝑄𝐾⊤ / √𝑑ₖ)𝑉',
    '\u200bAttention\u00ad(Q, K, V)=softmax(QKᵀ/⎷dₖ)V']) {
    const result = classifySelection(text, '1706.03762v7');
    assert.equal(result?.formula, 'scaled-attention', text);
    assert.equal(result.paperId, '1706.03762');
  }
});

test('a word, nearby paragraph, changed operand, different denominator, or other paper cannot open this model', () => {
  for (const text of ['softmax', 'Attention', 'QKT / √dk',
    'Attention(Q,K,V)=softmax(QKT/dk)V', 'Attention(Q,K,V)=softmax(QKT/√dv)V',
    'Attention(Q,K,V)=softmax(QKT/2)V', 'Attention(Q,K,V)=softmax(QK/√dk)V',
    'Attention(Q,K,V)=softmax(QKT/√dk)K', 'Attention(K,Q,V)=softmax(QKT/√dk)V',
    'We define ' + EQUATION, EQUATION + ' and discuss the model.',
    'Attention(Q,K,V)=softmax(QKT*√dk)V', EQUATION + ' (2)']) {
    assert.equal(classifySelection(text, '1706.03762'), null, text);
  }
  for (const id of ['2006.11239', '1706.03762v0', SOURCE, '1706.03762.evil', null]) {
    assert.equal(classifySelection(EQUATION, id), null);
  }
  for (const text of [null, {}, '', 'x'.repeat(2001)]) assert.equal(normalizeSelection(text), '');
});

test('only strict original HTTPS arXiv PDF locations are accepted and their exact addresses are preserved', () => {
  for (const originalUrl of [SOURCE, SOURCE + 'v7', SOURCE + '.pdf', SOURCE + '#page=4',
    'https://arxiv.org/pdf/hep-th/9901001v2.pdf', 'https://arxiv.org/pdf/math.GT/0309136',
    'https://arxiv.org/pdf/cond-mat.dis-nn/0301001']) {
    assert.equal(arxivPDFSource(originalUrl)?.originalUrl, originalUrl);
  }
  assert.equal(arxivPDFSource(SOURCE + 'v7').paperId, '1706.03762');
  for (const url of ['http://arxiv.org/pdf/1706.03762', 'https://arxiv.org.evil.test/pdf/1706.03762',
    'https://user@arxiv.org/pdf/1706.03762', 'https://arxiv.org:444/pdf/1706.03762',
    SOURCE + '?download=1', SOURCE + '?', SOURCE + 'v0', SOURCE + '/',
    'https://arxiv.org/abs/1706.03762', 'https://arxiv.org/pdf/../1706.03762',
    'https://arxiv.org/pdf/%31%37%30%36.03762', 'file:///tmp/paper.pdf',
    'https://www.arxiv.org/pdf/1706.03762', 'https://arxiv.org/pd\nf/1706.03762',
    'https://arxiv.org\\pdf\\1706.03762']) assert.equal(arxivPDFSource(url), null, url);
});

test('preview requires the exact explicit loopback HTTP viewer flag', () => {
  assert.equal(isLocalPreview('http://127.0.0.1:5055/local/sidepanel.html?preview=1'), true);
  for (const url of ['http://localhost:5055/sidepanel.html?preview=1', 'https://127.0.0.1/sidepanel.html?preview=1',
    'http://127.0.0.1:5055/sidepanel.html', 'http://127.0.0.1:5055/sidepanel.html?preview=true',
    'http://127.0.0.1:5055/options.html?preview=1', 'https://arxiv.org/pdf/1706.03762?preview=1',
    'chrome-extension://test/sidepanel.html?preview=1', 'http://127.0.0.1.evil.test/sidepanel.html?preview=1',
    'http://127.0.0.1:5055/viewer.html?preview=1']) {
    assert.equal(isLocalPreview(url), false, url);
  }
});
