/**
 * Minimal XML parser to a tree { name, attrs, children, text } (OSS-18).
 * Elements, attributes, self-closing tags, text, CDATA, comments, <?xml ?>,
 * the five predefined entities and numeric character references.
 * No DTD support (errors if met).
 */

export class XmlParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlParseError';
  }
}

function fail(message) {
  throw new XmlParseError(message);
}

const PREDEFINED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  quot: '"',
});

/**
 * Decode XML character and predefined entities in attribute/text content.
 * @param {string} s
 */
export function decodeEntities(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '&') {
      out += ch;
      continue;
    }
    const semi = s.indexOf(';', i + 1);
    if (semi < 0) fail('unterminated entity reference');
    const body = s.slice(i + 1, semi);
    if (!body) fail('empty entity reference');
    if (body[0] === '#') {
      let code;
      if (body[1] === 'x' || body[1] === 'X') {
        code = Number.parseInt(body.slice(2), 16);
      } else {
        code = Number.parseInt(body.slice(1), 10);
      }
      if (!Number.isFinite(code) || code < 0) fail(`bad character reference &${body};`);
      out += String.fromCodePoint(code);
    } else if (Object.prototype.hasOwnProperty.call(PREDEFINED, body)) {
      out += PREDEFINED[body];
    } else {
      fail(`unknown entity &${body};`);
    }
    i = semi;
  }
  return out;
}

function isNameStart(ch) {
  return /[A-Za-z_:]/.test(ch);
}

function isNameChar(ch) {
  return /[A-Za-z0-9._:-]/.test(ch);
}

function skipWs(s, i) {
  while (i < s.length && /[ \t\r\n]/.test(s[i])) i += 1;
  return i;
}

function readName(s, i) {
  if (i >= s.length || !isNameStart(s[i])) fail(`expected name at ${i}`);
  let j = i + 1;
  while (j < s.length && isNameChar(s[j])) j += 1;
  return [s.slice(i, j), j];
}

function readQuoted(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'") fail(`expected quote at ${i}`);
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += 1;
  if (j >= s.length) fail('unterminated attribute value');
  return [decodeEntities(s.slice(i + 1, j)), j + 1];
}

function parseAttrs(s, i) {
  const attrs = {};
  for (;;) {
    i = skipWs(s, i);
    if (i >= s.length || s[i] === '>' || s[i] === '/') break;
    const [name, afterName] = readName(s, i);
    i = skipWs(s, afterName);
    if (s[i] !== '=') fail(`expected = after attribute ${name}`);
    i = skipWs(s, i + 1);
    const [value, afterVal] = readQuoted(s, i);
    attrs[name] = value;
    i = afterVal;
  }
  return [attrs, i];
}

/**
 * @returns {{ name: string, attrs: Record<string,string>, children: object[], text: string }}
 */
export function parseXml(input) {
  if (typeof input !== 'string') fail('expected a string');
  const s = input;
  let i = 0;
  /** @type {object[]} */
  const stack = [];
  /** @type {object|null} */
  let root = null;

  const pushText = (text) => {
    if (!text) return;
    const parent = stack[stack.length - 1];
    if (!parent) return;
    parent.text += text;
    if (text.trim()) {
      parent.children.push({ type: 'text', text });
    }
  };

  i = skipWs(s, i);
  while (i < s.length) {
    if (s[i] !== '<') {
      const next = s.indexOf('<', i);
      const end = next < 0 ? s.length : next;
      const raw = s.slice(i, end);
      pushText(decodeEntities(raw));
      i = end;
      continue;
    }

    // <...
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2);
      if (end < 0) fail('unterminated processing instruction');
      i = end + 2;
      i = skipWs(s, i);
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) fail('unterminated comment');
      i = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end < 0) fail('unterminated CDATA');
      const text = s.slice(i + 9, end);
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.text += text;
        parent.children.push({ type: 'text', text });
      }
      i = end + 3;
      continue;
    }
    if (s.startsWith('<!DOCTYPE', i) || s.startsWith('<!DOCTYPE'.toLowerCase(), i)) {
      fail('DTD not supported');
    }
    if (s.startsWith('<!', i)) {
      // Other declarations (ENTITY etc.) treated as DTD-adjacent
      fail('DTD not supported');
    }

    if (s[i + 1] === '/') {
      // closing tag
      let j = i + 2;
      const [name, afterName] = readName(s, j);
      j = skipWs(s, afterName);
      if (s[j] !== '>') fail(`expected > closing ${name}`);
      j += 1;
      const node = stack.pop();
      if (!node || node.name !== name) {
        fail(`mismatched closing tag </${name}>`);
      }
      if (stack.length === 0) root = node;
      else stack[stack.length - 1].children.push(node);
      i = j;
      continue;
    }

    // opening or self-closing
    let j = i + 1;
    const [name, afterName] = readName(s, j);
    j = afterName;
    const [attrs, afterAttrs] = parseAttrs(s, j);
    j = skipWs(s, afterAttrs);
    let selfClosing = false;
    if (s[j] === '/') {
      selfClosing = true;
      j += 1;
    }
    if (s[j] !== '>') fail(`expected > after <${name}`);
    j += 1;

    const node = { name, attrs, children: [], text: '' };
    if (selfClosing) {
      if (stack.length === 0) {
        if (root) fail('multiple root elements');
        root = node;
      } else {
        stack[stack.length - 1].children.push(node);
      }
    } else {
      stack.push(node);
    }
    i = j;
  }

  if (stack.length) fail(`unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) fail('no root element');
  return root;
}

/** Direct-child elements with the given name. */
export function childrenNamed(node, name) {
  return (node.children || []).filter((c) => c && c.name === name);
}

/** First direct-child element with the given name, or null. */
export function childNamed(node, name) {
  for (const c of node.children || []) {
    if (c && c.name === name) return c;
  }
  return null;
}

/** Trimmed text of a direct child element, or defaultValue. */
export function childText(node, name, defaultValue = null) {
  const el = childNamed(node, name);
  if (!el) return defaultValue;
  return el.text != null ? el.text : defaultValue;
}

/** Depth-first search for an element with the given name. */
export function findDescendant(node, name) {
  if (!node || !node.children) return null;
  for (const c of node.children) {
    if (!c || !c.name) continue;
    if (c.name === name) return c;
    const found = findDescendant(c, name);
    if (found) return found;
  }
  return null;
}
