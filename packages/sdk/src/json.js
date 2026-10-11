import { RouterSdkError } from './errors.js';

/** Check structure without constructing a second object graph or accepting duplicate keys. */
export function parseJson(text) {
  let position = 0, nodes = 0;
  const fail = () => { throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned invalid or ambiguous JSON.'); };
  const whitespace = () => { while (position < text.length && /[ \t\r\n]/.test(text[position])) position++; };
  const string = () => {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '"') return [start, position];
      if (char === '\\') position++;
    }
    fail();
  };
  function value(depth) {
    if (++nodes > 100000 || depth > 64) fail();
    whitespace();
    const char = text[position];
    if (char === '"') { string(); return; }
    if (char === '{') {
      position++; whitespace();
      if (text[position] === '}') { position++; return; }
      const keys = new Set();
      while (true) {
        whitespace(); if (text[position] !== '"') fail();
        const [start, end] = string();
        let key;
        try { key = JSON.parse(text.slice(start, end)); } catch { fail(); }
        if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        keys.add(key); whitespace();
        if (text[position++] !== ':') fail();
        value(depth + 1); whitespace();
        const endChar = text[position++];
        if (endChar === '}') return;
        if (endChar !== ',') fail();
      }
    }
    if (char === '[') {
      position++; whitespace();
      if (text[position] === ']') { position++; return; }
      while (true) {
        value(depth + 1); whitespace();
        const endChar = text[position++];
        if (endChar === ']') return;
        if (endChar !== ',') fail();
      }
    }
    const start = position;
    while (position < text.length && !/[ \t\r\n,}\]]/.test(text[position])) position++;
    if (start === position) fail();
  }
  value(0); whitespace();
  if (position !== text.length) fail();
  try { return JSON.parse(text); } catch { fail(); }
}
