// Deterministic entity grounding: pull the specific, checkable entities out of a
// generated document (numbers with units, proper nouns, quoted terms, Latin names,
// timings) and test whether each appears in the source. Also pairs KE claims with
// candidate source passages for the VK verifier.

export interface GroundingResult {
  score: number;
  total: number;
  verified: string[];
  ungrounded: string[];
}

export interface ClaimPassagePair {
  claim: string;
  passages: string[];
  entities: string[];
}

const PAREN_NOISE = /^(?:e\.g|i\.e|etc|see|cf|sic|ibid|emphasis|original|mine|added|p\.|pp\.|page|fig|table|note|circa|approx)/i;

export function extractEntities(text: string): string[] {
  // Strip markdown formatting before entity extraction
  text = text
    .replace(/^#+\s+.*/gm, '')
    .replace(/^[-*]\s+\*\*[^*]+\*\*\s*:/gm, '')
    .replace(/\[Source:[^\]]*]/g, '')
    .replace(/\[Context:[^\]]*]/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^---+$/gm, '');

  const entities = new Set<string>();

  // Numbers with units (broad — covers agriculture, science, engineering, policy, etc.)
  const numberUnits = text.match(/\d[\d,.]*\s*(?:lb|kg|acre|acres|ha|hectare|cm|mm|inch|inches|ft|feet|m|meters?|%|percent|psi|ton|tons|gal|gallons?|bushel|bu|cwt|oz|g|mg|ppm|ppb|days?|weeks?|months?|years?|hr|hours?|min|minutes?|seconds?|km|miles?|mph|kph|dB|Hz|kHz|MHz|GHz|TB|GB|MB|KB|bytes?|units?|fold|sigma|steps?)(?:\/(?:acre|ha|hectare|day|year|hr|hour|week|month|plant|row|ft|m|s|second|min|minute|100\s*lb))?/gi);
  if (numberUnits) numberUnits.forEach(n => entities.add(n.trim()));

  // Standalone percentages
  for (const m of text.matchAll(/\b(\d[\d,.]*\s*%)/g)) entities.add(m[1].trim());

  // Proper nouns: 2+ capitalized words mid-sentence (after lowercase/punctuation)
  for (const m of text.matchAll(/(?<=[a-z,;:)\]"]\s)([A-Z][a-zA-Z'-]+(?:\s+(?:of|the|and|in|for|on|de|von|van|al|el|la|le)\s+)?[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3})/g)) {
    const pn = m[1].trim();
    if (pn.length >= 6) entities.add(pn);
  }

  // Terms in parentheses — technical terms, acronyms, translations, Latin terms
  for (const m of text.matchAll(/\(([^)]{3,60})\)/g)) {
    const term = m[1].trim();
    if (term.length > 3 && !PAREN_NOISE.test(term) && !/^\d+$/.test(term) && !/^\[/.test(term)) {
      entities.add(term);
    }
  }

  // Quoted terms/phrases (definitions, specific concepts)
  for (const m of text.matchAll(/["“]([^"”]{3,60})["”]/g)) {
    const clean = m[1].trim();
    if (clean.length > 3) entities.add(clean);
  }

  // Latin binomial names in parentheses (Genus species)
  const latinInParens = text.match(/\(([A-Z][a-z]{2,}\s+[a-z]{3,}(?:\s+(?:var|subsp|ssp)\.\s+[a-z]+)?)\)/g);
  if (latinInParens) latinInParens.forEach(m => entities.add(m.slice(1, -1)));

  // Latin names with var./subsp.
  const latinWithVariety = text.match(/[A-Z][a-z]{3,}\s+[a-z]{4,}\s+(?:var|subsp|ssp)\.\s+[a-z]+/g);
  if (latinWithVariety) latinWithVariety.forEach(n => entities.add(n));

  // Cultivar names in smart quotes
  const cultivars = text.match(/['‘][A-Z][A-Za-z\s-]+['’]/g);
  if (cultivars) cultivars.forEach(c => entities.add(c.replace(/['‘’]/g, '')));

  // Month-based timings
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December','Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Sept','Oct','Nov','Dec'];
  const monthPattern = new RegExp(`(?:by|before|after|in|during|from|through|until)\\s+(?:early|mid|late)?\\s*(?:${months.join('|')})(?:\\s+\\d{1,2})?`, 'gi');
  const timings = text.match(monthPattern);
  if (timings) timings.forEach(t => entities.add(t.trim()));

  // USDA zones
  const zones = text.match(/Zones?\s+\d+[a-b]?(?:\s*[-–to]+\s*\d+[a-b]?)?/gi);
  if (zones) zones.forEach(z => entities.add(z.trim()));

  return [...entities].filter(e => {
    if (e.length <= 3) return false;
    if (/^\d+\.\s*\w?$/.test(e)) return false;
    if (/^[A-Z][a-z]+\s+[a-z]+$/.test(e) && e.split(/\s+/).some(w => w.length <= 2)) return false;
    if (/^(Procedure|Achieves|Condition|Source|Context|Specific|Further|Expected|Practice|Rule)\b/i.test(e)) return false;
    if (e.includes('**')) return false;
    return true;
  });
}

function fuzzyMatch(entity: string, sourceText: string): boolean {
  const lower = entity.toLowerCase();
  const sourceLower = sourceText.toLowerCase();
  if (sourceLower.includes(lower)) return true;

  const words = lower.split(/\s+/);
  if (words.length >= 2) {
    const matchCount = words.filter(w => w.length > 2 && sourceLower.includes(w)).length;
    if (matchCount >= Math.ceil(words.length * 0.7)) return true;
  }

  return false;
}

export function extractAndVerifyEntities(ke: string, source: string): GroundingResult {
  const entities = extractEntities(ke);
  const verified: string[] = [];
  const ungrounded: string[] = [];

  for (const entity of entities) {
    if (fuzzyMatch(entity, source)) {
      verified.push(entity);
    } else {
      ungrounded.push(entity);
    }
  }

  const total = verified.length + ungrounded.length;
  return {
    score: total > 0 ? verified.length / total : 1,
    total,
    verified,
    ungrounded,
  };
}

function splitIntoClaimSentences(ke: string): string[] {
  const lines = ke.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) return false;
    if (trimmed.length < 25) return false;
    return true;
  });
  return lines.map(l => l.replace(/^[-*•]\s*/, '').trim()).filter(l => l.length > 20);
}

function findTopPassages(claim: string, sourceText: string, topN = 3, contextChars = 400): string[] {
  const claimEntities = extractEntities(claim);

  const sourceLower = sourceText.toLowerCase();
  const radius = contextChars;

  // Find positions of entities in source; fall back to distinctive keywords if no entities
  const entityPositions: number[] = [];
  const anchors = claimEntities.length > 0
    ? claimEntities
    : claim.toLowerCase().split(/\s+/).filter(w => w.length > 6);

  for (const anchor of anchors) {
    const needle = anchor.toLowerCase();
    let idx = sourceLower.indexOf(needle);
    while (idx !== -1) {
      entityPositions.push(idx);
      idx = sourceLower.indexOf(needle, idx + 1);
    }
  }

  if (entityPositions.length === 0) return [];

  const claimWords = claim.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const scored: Array<{ center: number; entityScore: number; wordScore: number }> = [];

  for (const pos of entityPositions) {
    const regionStart = Math.max(0, pos - radius);
    const regionEnd = Math.min(sourceLower.length, pos + radius);
    const region = sourceLower.slice(regionStart, regionEnd);

    let entityScore = 0;
    for (const entity of claimEntities) {
      if (region.includes(entity.toLowerCase())) entityScore++;
    }
    const wordScore = claimWords.filter(w => region.includes(w)).length;

    if (entityScore > 0) {
      const tooClose = scored.some(s => Math.abs(s.center - pos) < radius);
      if (!tooClose) {
        scored.push({ center: pos, entityScore, wordScore });
      } else {
        const existing = scored.find(s => Math.abs(s.center - pos) < radius);
        if (existing && (entityScore > existing.entityScore || (entityScore === existing.entityScore && wordScore > existing.wordScore))) {
          existing.center = pos;
          existing.entityScore = entityScore;
          existing.wordScore = wordScore;
        }
      }
    }
  }

  scored.sort((a, b) => b.entityScore - a.entityScore || b.wordScore - a.wordScore);

  return scored.slice(0, topN).map(s => {
    const start = Math.max(0, s.center - radius);
    const end = Math.min(sourceText.length, s.center + radius);
    return sourceText.slice(start, end);
  });
}

export function buildClaimPassagePairs(ke: string, sourceText: string, maxPairs = 60): ClaimPassagePair[] {
  const claims = splitIntoClaimSentences(ke);
  const pairs: ClaimPassagePair[] = [];

  for (const claim of claims.slice(0, maxPairs)) {
    const entities = extractEntities(claim);
    const passages = findTopPassages(claim, sourceText);
    if (passages.length === 0) continue;
    pairs.push({ claim, passages, entities });
  }

  return pairs;
}
