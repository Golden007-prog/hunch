/** Parse JSON with the comments and trailing commas accepted by VS Code JSONC.
 * String-aware scanning keeps comment-looking text and commas inside strings
 * untouched. Callers still validate the returned shape for their own contract. */
export function parseJsonc(raw: string): unknown {
  let withoutComments = "";
  let inString = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const next = raw[index + 1];
    if (inString) {
      withoutComments += char;
      if (char === "\\") {
        withoutComments += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      withoutComments += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    withoutComments += char;
  }

  let normalized = "";
  inString = false;
  let escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index]!;
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < withoutComments.length && /\s/.test(withoutComments[cursor]!)) cursor += 1;
      if (withoutComments[cursor] === "}" || withoutComments[cursor] === "]") continue;
    }
    normalized += char;
  }
  return JSON.parse(normalized) as unknown;
}
