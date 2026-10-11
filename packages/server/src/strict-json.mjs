/** Reject ambiguous JSON before JSON.parse can discard duplicate fields. */
export function parseStrictJson(text) {
  let position = 0, nodes = 0;
  const invalid = () => { throw new Error('Invalid JSON'); };
  const whitespace = () => { while (/[\t\n\r ]/.test(text[position] ?? '\0')) position++; };
  const string = () => {
    if (text[position] !== '"') invalid();
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '"') return JSON.parse(text.slice(start, position));
      if (char === '\\') position++;
    }
    invalid();
  };
  const value = depth => {
    if (++nodes > 1000 || depth > 10) invalid();
    whitespace();
    const char = text[position];
    if (char === '{' || char === '[') {
      const object = char === '{', closing = object ? '}' : ']';
      const keys = new Set(); position++; whitespace();
      if (text[position] === closing) { position++; return; }
      while (position < text.length) {
        if (object) {
          whitespace(); const key = string();
          if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
          keys.add(key); whitespace(); if (text[position++] !== ':') invalid();
        }
        value(depth + 1); whitespace();
        if (text[position] === closing) { position++; return; }
        if (text[position++] !== ',') invalid();
      }
      invalid();
    }
    if (char === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(position));
    if (!match) invalid(); position += match[0].length;
  };
  value(0); whitespace(); if (position !== text.length) invalid();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return parsed;
}
