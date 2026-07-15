function quotedRegionEnd(sql: string, start: number, delimiter: "'" | '"' | "`"): number {
  for (let offset = start + 1; offset < sql.length; offset += 1) {
    if (sql[offset] !== delimiter) continue;
    if (sql[offset + 1] === delimiter) {
      offset += 1;
      continue;
    }
    return offset + 1;
  }
  return sql.length;
}

function bracketedRegionEnd(sql: string, start: number): number {
  const end = sql.indexOf("]", start + 1);
  return end < 0 ? sql.length : end + 1;
}

function lineCommentEnd(sql: string, start: number): number {
  for (let offset = start + 2; offset < sql.length; offset += 1) {
    if (sql[offset] === "\n") return offset + 1;
  }
  return sql.length;
}

function blockCommentEnd(sql: string, start: number): number {
  const end = sql.indexOf("*/", start + 2);
  return end < 0 ? sql.length : end + 2;
}

function isSqliteWhitespace(character: string): boolean {
  // Mirrors SQLite's tokenizer, not JavaScript's broader Unicode whitespace set.
  const code = character.charCodeAt(0);
  return code === 0x09
    || code === 0x0a
    || code === 0x0c
    || code === 0x0d
    || code === 0x20;
}

function normalizeSqliteSyntaxCase(character: string): string {
  // SQLite keyword/name folding is ASCII-only; Unicode case folding can merge
  // a valid identifier with a different identifier (for example k and U+212A).
  const code = character.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a
    ? String.fromCharCode(code + 0x20)
    : character;
}

/**
 * Canonicalizes SQLite schema SQL without changing quoted token contents.
 * SQLite may normalize leading/trailing syntax, keyword case, and exterior
 * whitespace in sqlite_schema. String literals remain byte-sensitive because
 * their case and whitespace are part of the enforced schema semantics.
 */
export function normalizeSqliteSchemaSql(value: string): string {
  const normalized: string[] = [];
  let pendingWhitespace = false;
  let lastTokenKind: "syntax" | "quoted" | "comment" | null = null;
  for (let offset = 0; offset < value.length;) {
    const character = value[offset] ?? "";
    if (isSqliteWhitespace(character)) {
      pendingWhitespace = normalized.length > 0;
      offset += 1;
      continue;
    }

    if (pendingWhitespace) {
      normalized.push(" ");
      pendingWhitespace = false;
    }

    if (character === "'" || character === '"' || character === "`") {
      const end = quotedRegionEnd(value, offset, character);
      normalized.push(value.slice(offset, end));
      offset = end;
      lastTokenKind = "quoted";
      continue;
    }
    if (character === "[") {
      const end = bracketedRegionEnd(value, offset);
      normalized.push(value.slice(offset, end));
      offset = end;
      lastTokenKind = "quoted";
      continue;
    }
    if (character === "-" && value[offset + 1] === "-") {
      const end = lineCommentEnd(value, offset);
      normalized.push(value.slice(offset, end));
      offset = end;
      lastTokenKind = "comment";
      continue;
    }
    if (character === "/" && value[offset + 1] === "*") {
      const end = blockCommentEnd(value, offset);
      normalized.push(value.slice(offset, end));
      offset = end;
      lastTokenKind = "comment";
      continue;
    }

    normalized.push(normalizeSqliteSyntaxCase(character));
    offset += 1;
    lastTokenKind = "syntax";
  }
  if (lastTokenKind === "syntax" && normalized.at(-1) === ";") normalized.pop();
  return normalized.join("");
}
