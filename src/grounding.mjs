// Cheap, deterministic grounding check. It is not an LLM judge: it combines
// bag-of-words overlap with a negation/antonym guard so "X is not open source"
// cannot be supported by a passage that says "X is open source".

const NEGATORS = new Set(['khong', 'chua', 'chang', 'not', 'no', 'never', 'without']);

const STOPWORDS = new Set([
  'la', 'va', 'cua', 'co', 'cho', 'mot', 'cac', 'nhung', 'voi', 'trong', 'ngoai', 'thi', 'ma',
  'the', 'and', 'of', 'to', 'in', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'by', 'for', 'on',
  'it', 'this', 'that', 'with', 'as', 'at', 'or', 'from',
]);

const ANTONYM_PAIRS = [
  ['mien phi', 'thu phi'],
  ['ma nguon mo', 'doc quyen'],
  ['open source', 'proprietary'],
  ['free', 'paid'],
];

export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function tokens(text) {
  return fold(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 2);
}

function isNegated(list, index) {
  const from = Math.max(0, index - 4);
  return list.slice(from, index).some((word) => NEGATORS.has(word));
}

function bestLine(draft, answer) {
  const lines = String(answer ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return String(answer ?? '');
  const draftSet = new Set(tokens(draft));
  let best = lines[0];
  let bestHits = -1;
  for (const line of lines) {
    const lineSet = new Set(tokens(line));
    let hits = 0;
    for (const word of draftSet) if (lineSet.has(word)) hits += 1;
    if (hits > bestHits) {
      best = line;
      bestHits = hits;
    }
  }
  return best;
}

export function assessGrounding(draft, answer) {
  const draftTokens = tokens(draft);
  const answerText = String(answer ?? '');
  if (draftTokens.length === 0) {
    return { supported: false, reason: 'no draft supplied', overlap: 0, contradictions: 0 };
  }
  if (!answerText.trim()) {
    return { supported: false, reason: 'no matching documents', overlap: 0, contradictions: 0 };
  }

  const answerBag = new Set(tokens(answerText));
  const content = draftTokens.filter((word) => !NEGATORS.has(word) && !STOPWORDS.has(word));
  const denominator = content.length || draftTokens.length;
  const hits = (content.length ? content : draftTokens).filter((word) => answerBag.has(word)).length;
  const overlap = hits / denominator;

  const line = bestLine(draft, answerText);
  const lineTokens = tokens(line);
  const draftSet = new Set(draftTokens);
  let contradictions = 0;

  for (const word of draftSet) {
    if (NEGATORS.has(word) || STOPWORDS.has(word)) continue;
    const draftIndex = draftTokens.indexOf(word);
    const answerIndex = lineTokens.indexOf(word);
    if (answerIndex < 0) continue;
    if (isNegated(draftTokens, draftIndex) !== isNegated(lineTokens, answerIndex)) contradictions += 1;
  }

  const lineText = ` ${fold(line).replace(/\s+/g, ' ')} `;
  for (const [left, right] of ANTONYM_PAIRS) {
    const draftText = ` ${fold(draft).replace(/\s+/g, ' ')} `;
    const hasLeft = draftText.includes(` ${left} `);
    const hasRight = draftText.includes(` ${right} `);
    if (hasLeft && lineText.includes(` ${right} `) && !lineText.includes(` ${left} `)) contradictions += 1;
    if (hasRight && lineText.includes(` ${left} `) && !lineText.includes(` ${right} `)) contradictions += 1;
  }

  if (contradictions > 0) {
    return { supported: false, reason: `contradicts the source (${contradictions} polarity mismatch)`, overlap, contradictions };
  }
  if (overlap < 0.5) {
    return { supported: false, reason: `insufficient overlap (${Math.round(overlap * 100)}%)`, overlap, contradictions };
  }
  return { supported: true, reason: 'supported by source', overlap, contradictions };
}
