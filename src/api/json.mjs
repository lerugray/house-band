/** Duplicate-aware JSON parsing for API requests and provider candidates. */

export class JsonSyntaxError extends SyntaxError {
  constructor(message, offset) {
    super(`${message} at byte offset ${offset}`);
    this.name = 'JsonSyntaxError';
    this.offset = offset;
  }
}

export class DuplicateKeyError extends JsonSyntaxError {
  constructor(key, path, offset) {
    super(`duplicate object key ${JSON.stringify(key)} at ${path}`, offset);
    this.name = 'DuplicateKeyError';
    this.key = key;
    this.path = path;
  }
}

function scanner(text) {
  let index = 0;

  function fail(message) {
    throw new JsonSyntaxError(message, Buffer.byteLength(text.slice(0, index), 'utf8'));
  }

  function whitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index++;
  }

  function string() {
    const start = index;
    if (text[index++] !== '"') fail('expected string');
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') {
        const token = text.slice(start, index);
        try {
          return JSON.parse(token);
        } catch {
          fail('invalid JSON string');
        }
      }
      if (char === '\\') {
        const escape = text[index++];
        if (escape === 'u') {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid Unicode escape');
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escape || '')) {
          fail('invalid string escape');
        }
      } else if (char.charCodeAt(0) <= 0x1f) {
        fail('unescaped control character');
      }
    }
    fail('unterminated JSON string');
  }

  function primitive() {
    const rest = text.slice(index);
    const match = rest.match(/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) fail('expected JSON value');
    index += match[0].length;
  }

  function value(path) {
    whitespace();
    if (text[index] === '{') return object(path);
    if (text[index] === '[') return array(path);
    if (text[index] === '"') return void string();
    primitive();
  }

  function object(path) {
    index++;
    whitespace();
    const keys = new Set();
    if (text[index] === '}') {
      index++;
      return;
    }
    while (index < text.length) {
      whitespace();
      const keyOffset = Buffer.byteLength(text.slice(0, index), 'utf8');
      if (text[index] !== '"') fail('expected object key');
      const key = string();
      if (keys.has(key)) throw new DuplicateKeyError(key, path, keyOffset);
      keys.add(key);
      whitespace();
      if (text[index++] !== ':') fail('expected colon after object key');
      value(`${path}.${key}`);
      whitespace();
      if (text[index] === '}') {
        index++;
        return;
      }
      if (text[index++] !== ',') fail('expected comma or closing brace');
    }
    fail('unterminated object');
  }

  function array(path) {
    index++;
    whitespace();
    if (text[index] === ']') {
      index++;
      return;
    }
    let item = 0;
    while (index < text.length) {
      value(`${path}[${item++}]`);
      whitespace();
      if (text[index] === ']') {
        index++;
        return;
      }
      if (text[index++] !== ',') fail('expected comma or closing bracket');
    }
    fail('unterminated array');
  }

  return {
    scan() {
      whitespace();
      value('$');
      whitespace();
      if (index !== text.length) fail('trailing data after JSON value');
    },
  };
}

export function parseJsonNoDuplicates(input) {
  const text = Buffer.isBuffer(input) || input instanceof Uint8Array
    ? new TextDecoder('utf-8', { fatal: true }).decode(input)
    : String(input);
  scanner(text).scan();
  return JSON.parse(text);
}
