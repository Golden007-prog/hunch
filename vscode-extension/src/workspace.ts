import { isAbsolute, relative, resolve, sep } from "node:path";

function contains(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Select the workspace folder that owns an active document. Longest matching
 * roots win for nested folders; an outside document keeps VS Code's first-folder
 * fallback so extension commands remain available in an unusual editor state. */
export function workspaceRootForFile(folders: readonly string[], activeFile?: string): string | undefined {
  if (activeFile) {
    const file = resolve(activeFile);
    const matches = folders.filter((folder) => contains(resolve(folder), file));
    if (matches.length) return matches.sort((a, b) => resolve(b).length - resolve(a).length)[0];
  }
  return folders[0];
}
