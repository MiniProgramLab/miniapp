import type { Dialect, Token } from './types';

/** 样式标识符的常用字符，支持中文等非 ASCII 名称。 */
const nameCharacter = /[\w\-\u0080-\uffff]/;

/** 保留字符串和符号位置，跳过注释以及无法静态计算的插值。 */
export function tokenize(text: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let url = false;
  while (index < text.length) {
    const start = index;
    const character = text[index]!;
    if (/\s/.test(character)) { index++; continue; }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (!url && (dialect === 'scss' || dialect === 'less') && text.startsWith('//', index)) {
      const end = text.indexOf('\n', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      index++;
      while (index < text.length && text[index] !== character) {
        if (text[index] === '\\') index++;
        index++;
      }
      const end = index;
      if (index < text.length) index++;
      tokens.push({ kind: 'string', value: text.slice(start + 1, end), start, end: index });
      continue;
    }
    if (/[#$@]/.test(character) && text[index + 1] === '{') {
      let depth = 1;
      index += 2;
      while (index < text.length && depth) {
        if (text[index] === '{') depth++;
        if (text[index] === '}') depth--;
        index++;
      }
      tokens.push({ kind: 'string', value: '', start, end: index });
      continue;
    }
    if (nameCharacter.test(character) || /[$@]/.test(character) && nameCharacter.test(text[index + 1] ?? '')) {
      index++;
      while (index < text.length && nameCharacter.test(text[index]!)) index++;
      tokens.push({ kind: 'word', value: text.slice(start, index), start, end: index });
      continue;
    }
    if (character === '(' && tokens.at(-1)?.value.toLowerCase() === 'url') url = true;
    if (character === ')') url = false;
    tokens.push({ kind: 'punctuation', value: character, start, end: ++index });
  }
  return tokens;
}
