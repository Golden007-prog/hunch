/**
 * Deterministic text scan for Kubernetes manifest cross-resource references —
 * NOT a tree-sitter walk. Confirmed directly (not assumed): parsing a realistic
 * templated Deployment with this repo's own tree-sitter-yaml bundle showed a
 * same-line templated scalar (`name: {{ include "x" . }}`) parses cleanly, but
 * a block-form injection on its own line (`labels:\n  {{- include ... }}` — the
 * pattern real charts use for metadata.labels and spec.selector) collapses the
 * WHOLE REST OF THE DOCUMENT'S error recovery into a flat, unstructured ERROR
 * node. Real charts place such an injection early (right after metadata.name),
 * so it would poison parsing for every field-path this module needs further
 * down the same document. parseSource() (parse.ts) also never exposes its
 * tree-sitter tree to callers at all -- helm.ts's own text-scan precedent
 * exists for the same reason.
 *
 * This is a line-oriented, indentation-tracking scanner (not flat regex, unlike
 * helm.ts's `{{ }}`-action scan) because K8s field-paths are nested block
 * structure (`spec.template.spec.containers[].env[].valueFrom.secretKeyRef.name`)
 * that a flat scan can't reconstruct. It never interprets `{{ }}` as YAML syntax
 * at all -- a `{{ ... }}` on a line's value side is just that line's raw value
 * text, same-line or block-form alike -- so it is immune to the exact failure
 * mode that broke tree-sitter.
 */

export type ManifestNameRef =
  | { form: "literal"; value: string; atByte: number; endByte: number }
  | { form: "template"; sourceText: string; atByte: number; endByte: number };

export interface K8sReferenceCandidate {
  /** Fixed literal for most kinds ("ConfigMap", "Secret", "PersistentVolumeClaim",
   *  "Service"); for an ownerReferences entry, the reference's OWN `kind` field
   *  value (data-dependent, not statically known). */
  refKind: string;
  name: ManifestNameRef;
}

export type ManifestLabelMap = Record<string, string>;

export interface K8sResourceDoc {
  kind: string;
  name: ManifestNameRef;
  startByte: number;
  endByte: number;
}

export interface K8sManifestDocument {
  resource: K8sResourceDoc | null;
  references: K8sReferenceCandidate[];
  selector: ManifestLabelMap | null;
  labels: ManifestLabelMap | null;
}

// ReplicaSet is included alongside the pod-spec-embedding/networking kinds
// specifically because it's the dominant real-world bearer of
// ownerReferences (Deployment -> ReplicaSet -> Pod is the common chain) --
// without it, the single most common ownerReferences case would be silently
// dropped by the allowlist gate below, despite Goal 2 explicitly scoping
// "any resource -> its owner" as in scope. Still a well-known core/apps kind,
// not a CRD -- consistent with the allowlist's own rationale, not an exception to it.
const ALLOWED_KINDS = new Set([
  "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "ReplicaSet",
  "Service", "ConfigMap", "Secret", "PersistentVolumeClaim", "Ingress", "HTTPRoute",
]);

interface FieldPathEntry {
  /** Concrete path with real sequence indices, e.g. "spec.containers[0].env[1].value". */
  path: string;
  /** path's containing segment (everything but this entry's own key) -- e.g.
   *  "spec.selector" for a "spec.selector.app.kubernetes.io/instance" entry.
   *  Computed structurally from the frame stack, NOT by string-splitting
   *  `path` on ".": a Kubernetes label key legitimately contains dots
   *  (`app.kubernetes.io/instance` is the `helm create` default), which is
   *  indistinguishable from path nesting once joined into one string. Callers
   *  that need "is this a direct child of prefix X" must compare parentPath,
   *  never re-derive a key by slicing path. */
  parentPath: string;
  /** This entry's own raw key exactly as written, dots/slashes included. */
  key: string;
  value: ManifestNameRef;
}

/** Normalize a concrete path's sequence indices to "[]" for table matching. */
export function wildcardPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

interface StackFrame {
  indent: number;
  key: string;
  isSeq: boolean;
  hasValue: boolean;
  nextIndex?: number;
}

// `\r?` before `$`: without it, a CRLF-terminated line (the Git-for-Windows
// `core.autocrlf=true` default -- every .yaml file in a Windows checkout) never
// matches at all, since JS `.` never matches `\r` and `$` (no /m flag) only
// matches at the true end of the string. That silently zeroes out this whole
// module's output on any Windows clone, with no error. `.*?` (lazy, not `.*`
// greedy) so `\r?` gets first claim on a trailing `\r` instead of the value
// capture swallowing it.
const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z0-9_.\/-]+):[ \t]*(.*?)\r?$/;
// A line that is ENTIRELY a `{{ ... }}` template action (no `key:` prefix at
// all) -- e.g. a block-form injection appearing as a SIBLING after other
// literal keys under the same mapping (`app: my-app` then, on its own later
// line, `{{- include "mychart.selectorLabels" . | nindent 4 }}`). This never
// matches KEY_LINE (there's no colon-terminated key), so without explicit
// handling it's silently invisible to the scanner -- neither contributing a
// value nor marking its container as unresolved, which lets a literal-looking
// map that's actually partially templated pass as fully literal.
const BARE_TEMPLATE_LINE = /^(\s*)(-\s+)?(\{\{[\s\S]*)$/;

/** Strip a trailing YAML comment: `#` only opens one at the start of the
 *  value or after whitespace, and never inside a quoted scalar -- so
 *  `key: "a # b"` keeps its `#` and `key: {{ .x | default "#fff" }}` keeps
 *  its Sprig default intact, but `key: my-config  # app settings` drops the
 *  comment. Without this, a comment silently becomes part of the value text:
 *  it never matches the same resource's uncommented name elsewhere, so the
 *  reference quietly resolves to nothing instead of erroring -- the worst
 *  failure mode for a "no match -> no edge, never guess" design, since it's
 *  indistinguishable from correctly declining to guess. */
function stripTrailingComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    // A quote only OPENS a quoted scalar at the value's start or after
    // whitespace -- mirrors the # rule below, and keeps a Sprig
    // `default "#fff"` working (its " follows a space) while an apostrophe
    // mid-word (`it's-fine`) no longer opens a phantom quote that would
    // swallow a real trailing comment whole.
    if ((ch === '"' || ch === "'") && (i === 0 || /\s/.test(raw[i - 1]!))) { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
  }
  return raw;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/** Line-oriented indentation-stack scan. Handles BOTH real-world YAML list
 *  styles: sequence items at the SAME indent as their parent key
 *  (`containers:\n- name: app`) and at a DEEPER indent (`env:\n  - name: X`) --
 *  both occur in real manifests. A value-less key frame is converted to a
 *  sequence frame IN PLACE (not popped) the first time a `-` line arrives at or
 *  below its own indent; a sequence frame is only ever closed by a
 *  shallower-indent line, never by an equal-indent one (equal-indent means
 *  "next item"). */
function scanFieldPaths(text: string, baseByte: number): { entries: FieldPathEntry[]; unresolvedContainers: Set<string> } {
  const entries: FieldPathEntry[] = [];
  // A container (mapping) this scanner could not fully account for -- either
  // an explicit {{ }} template injection, OR a line shape KEY_LINE doesn't
  // recognize at all (a quoted key, a YAML merge key `<<:`, ...). Both get the
  // SAME treatment: a dropped/unrecognized key would make a selector/labels
  // map strictly MORE permissive (fewer real constraints), which risks a
  // false-positive edge -- the failure mode this whole module exists to
  // avoid. Silently ignoring what the scanner can't parse is not safe here;
  // "I can't tell" must read as "unresolved," the same as a real template.
  const unresolvedContainers = new Set<string>();
  const stack: StackFrame[] = [];
  let byteOffset = baseByte;

  const popToForListItem = (dashIndent: number): void => {
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.indent <= dashIndent) {
        if (!top.isSeq && !top.hasValue) top.isSeq = true; // convert in place, first time only
        return; // either already/now a seq frame at or above this indent -- reuse it
      }
      stack.pop();
    }
  };
  const popOrdinary = (indent: number): void => {
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
  };
  // Pops to a line's context (same rule an ordinary/list-item key line would
  // use) WITHOUT pushing a frame -- the line has no key of its own -- then
  // marks whatever container it now sits inside as unresolved. Covers both a
  // bare `{{ }}` injection and any other line KEY_LINE doesn't match.
  const markUnresolvedContainer = (dashIndent: number, listMarker: string | undefined): void => {
    if (listMarker) popToForListItem(dashIndent); else popOrdinary(dashIndent);
    unresolvedContainers.add(stack.map((f) => f.key).filter(Boolean).join(".").replace(/\.\[/g, "["));
  };

  for (const line of text.split("\n")) {
    const lineStartByte = byteOffset;
    byteOffset += line.length + 1; // +1 for the \n split() consumed

    const bareTemplate = BARE_TEMPLATE_LINE.exec(line);
    if (bareTemplate) {
      const [, bIndentStr, bListMarker] = bareTemplate;
      markUnresolvedContainer(bIndentStr!.length, bListMarker);
      continue;
    }

    const m = KEY_LINE.exec(line);
    if (!m) {
      // Any other non-blank, non-comment line is a shape this scanner can't
      // account for at all (a quoted key, a merge key, ...) -- see
      // unresolvedContainers' own comment above for why this can't be a
      // silent skip.
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        markUnresolvedContainer(line.length - line.trimStart().length, undefined);
      }
      continue;
    }
    const [, indentStr, listMarker, key, rawValue] = m;
    const dashIndent = indentStr!.length;
    const itemIndent = dashIndent + (listMarker?.length ?? 0);

    if (listMarker) {
      popToForListItem(dashIndent);
      let top = stack[stack.length - 1];
      if (!top || !top.isSeq) {
        top = { indent: dashIndent, key: "", isSeq: true, hasValue: false, nextIndex: 0 };
        stack.push(top);
      }
      const idx = top.nextIndex ?? 0;
      top.nextIndex = idx + 1;
      // Pushed at itemIndent - 1 (strictly between the seq frame's indent and
      // its children's indent) so a sibling key within this item pops back to
      // (but never past) this frame.
      stack.push({ indent: itemIndent - 1, key: `[${idx}]`, isSeq: false, hasValue: false });
    } else {
      popOrdinary(dashIndent);
    }

    const value = stripTrailingComment(rawValue!).trim();
    const parentPath = stack.map((f) => f.key).filter(Boolean).join(".").replace(/\.\[/g, "[");
    stack.push({ indent: itemIndent, key: key!, isSeq: false, hasValue: value.length > 0 });
    const path = stack.map((f) => f.key).filter(Boolean).join(".").replace(/\.\[/g, "[");

    if (value.length > 0) {
      const colonIdx = line.indexOf(":", dashIndent);
      const valueStartInLine = line.indexOf(value, colonIdx);
      const atByte = lineStartByte + valueStartInLine;
      const endByte = atByte + value.length;
      // A value like `prefix-{{ .Values.x }}` (template text NOT at the very
      // start) is classified "literal" here, not "template" -- deliberately
      // narrow, matching only the common `name: {{ ... }}` whole-value case.
      // Matching still stays correct either way: both a literal/literal and a
      // template/template comparison require the two sides' raw text to be
      // byte-identical (nameKeyText's L:/T: prefixes in indexer.ts), so a
      // "prefix-{{ x }}" value only ever matches another identical
      // "prefix-{{ x }}" value, never a bare "{{ x }}" -- just via the
      // "literal" bucket instead of the "template" one.
      entries.push({
        path,
        parentPath,
        key: key!,
        value: value.startsWith("{{")
          ? { form: "template", sourceText: value, atByte, endByte }
          : { form: "literal", value: stripQuotes(value), atByte, endByte },
      });
    }
    // A value-less key (e.g. `selector:`) needs no bookkeeping of its own
    // here: whatever follows it (a real nested mapping, a `{{ }}` block
    // injection, or an unrecognized line) is handled uniformly by the
    // BARE_TEMPLATE_LINE / "unrecognized line" branches above on ITS OWN
    // line, since that line's own popToForListItem/popOrdinary call pops
    // back to (but never past) this key's frame -- verified equivalent to a
    // prior explicit next-line lookahead by mutation testing before removal.
  }
  return { entries, unresolvedContainers };
}

function findEntry(entries: FieldPathEntry[], path: string): FieldPathEntry | undefined {
  return entries.find((e) => e.path === path);
}

interface FieldPathSpec {
  /** Wildcarded path, e.g. "spec.template.spec.containers[].env[].valueFrom.secretKeyRef.name". */
  path: string;
  refKind: string;
}

/** Where a kind's pod spec lives -- factored once so container/volume field
 *  paths below aren't hand-duplicated per kind. */
const POD_SPEC_PATH_BY_KIND: Record<string, string> = {
  Pod: "spec",
  Deployment: "spec.template.spec",
  StatefulSet: "spec.template.spec",
  DaemonSet: "spec.template.spec",
  Job: "spec.template.spec",
  CronJob: "spec.jobTemplate.spec.template.spec",
  // ReplicaSet embeds a pod spec the same shape as Deployment -- it's
  // allowlisted primarily as the dominant ownerReferences bearer (see
  // ALLOWED_KINDS above), but a hand-written ReplicaSet's own env/volume
  // references and pod-template labels are real and worth extracting too,
  // not silently dropped just because it's a secondary use case.
  ReplicaSet: "spec.template.spec",
};

const CONTAINER_REF_SUFFIXES: Array<{ suffix: string; refKind: string }> = [
  { suffix: "envFrom[].configMapRef.name", refKind: "ConfigMap" },
  { suffix: "envFrom[].secretRef.name", refKind: "Secret" },
  { suffix: "env[].valueFrom.configMapKeyRef.name", refKind: "ConfigMap" },
  { suffix: "env[].valueFrom.secretKeyRef.name", refKind: "Secret" },
];

// volumeClaimTemplates is deliberately excluded: on a StatefulSet it's a
// TEMPLATE the controller uses to create its own PVCs, not a reference to a
// separately-authored PersistentVolumeClaim resource elsewhere in the repo.
// Only volumes[].persistentVolumeClaim.claimName is a real reference.
const VOLUME_REF_SUFFIXES: Array<{ suffix: string; refKind: string }> = [
  { suffix: "volumes[].configMap.name", refKind: "ConfigMap" },
  { suffix: "volumes[].secret.secretName", refKind: "Secret" },
  { suffix: "volumes[].persistentVolumeClaim.claimName", refKind: "PersistentVolumeClaim" },
];

function fieldSpecsForKind(kind: string): FieldPathSpec[] {
  const specs: FieldPathSpec[] = [];
  const podSpecPath = POD_SPEC_PATH_BY_KIND[kind];
  if (podSpecPath) {
    for (const containerList of ["containers[]", "initContainers[]"]) {
      for (const { suffix, refKind } of CONTAINER_REF_SUFFIXES) specs.push({ path: `${podSpecPath}.${containerList}.${suffix}`, refKind });
    }
    for (const { suffix, refKind } of VOLUME_REF_SUFFIXES) specs.push({ path: `${podSpecPath}.${suffix}`, refKind });
  }
  if (kind === "Ingress") {
    specs.push({ path: "spec.rules[].http.paths[].backend.service.name", refKind: "Service" });
    specs.push({ path: "spec.defaultBackend.service.name", refKind: "Service" });
  }
  if (kind === "HTTPRoute") specs.push({ path: "spec.rules[].backendRefs[].name", refKind: "Service" });
  return specs;
}

function extractFieldReferences(kind: string, entries: FieldPathEntry[]): K8sReferenceCandidate[] {
  const specs = fieldSpecsForKind(kind);
  const out: K8sReferenceCandidate[] = [];
  for (const e of entries) {
    const wp = wildcardPath(e.path);
    const spec = specs.find((s) => s.path === wp);
    if (spec) out.push({ refKind: spec.refKind, name: e.value });
  }
  return out;
}

/** ownerReferences' target kind is DATA (a sibling `.kind` field), not a fixed
 *  literal like every other refKind here -- this pairs each ownerReferences[N]
 *  list element's `.name` with its OWN `.kind` by concrete index, so two owner
 *  entries never get cross-paired. Not expressible via FieldPathSpec's
 *  single-fixed-refKind model, so it's a dedicated pass over the concrete
 *  (non-wildcarded) entries. */
function extractOwnerReferenceCandidates(entries: FieldPathEntry[]): K8sReferenceCandidate[] {
  const byIndex = new Map<string, { name?: FieldPathEntry; kind?: FieldPathEntry }>();
  for (const e of entries) {
    const m = /^metadata\.ownerReferences(\[\d+\])\.(name|kind)$/.exec(e.path);
    if (!m) continue;
    const slot = byIndex.get(m[1]!) ?? {};
    slot[m[2] as "name" | "kind"] = e;
    byIndex.set(m[1]!, slot);
  }
  const out: K8sReferenceCandidate[] = [];
  for (const { name, kind } of byIndex.values()) {
    if (!name || !kind || kind.value.form !== "literal") continue; // an owner's kind must be a literal to type the reference at all
    out.push({ refKind: kind.value.value, name: name.value });
  }
  return out;
}

const LABELS_PATH_BY_KIND: Record<string, string> = {
  Deployment: "spec.template.metadata.labels",
  StatefulSet: "spec.template.metadata.labels",
  DaemonSet: "spec.template.metadata.labels",
  Job: "spec.template.metadata.labels",
  CronJob: "spec.jobTemplate.spec.template.metadata.labels",
  Pod: "metadata.labels",
  ReplicaSet: "spec.template.metadata.labels",
};

/** A literal label map at `prefix.<key>` for each direct child leaf. Returns
 *  null (not an empty map) when: the prefix itself is a block-form template
 *  injection (no literal keys exist to read at all), no direct-child leaf
 *  exists, or any direct-child leaf is itself templated -- a partially-literal
 *  map is still unusable for subset-match without evaluating the templated
 *  half, so the whole map is treated as unresolved. */
function extractLiteralLabelMap(prefix: string, entries: FieldPathEntry[], unresolvedContainers: Set<string>): ManifestLabelMap | null {
  if (unresolvedContainers.has(prefix)) return null;
  const map: ManifestLabelMap = {};
  let found = false;
  for (const e of entries) {
    // Match on parentPath, never by slicing e.path on the prefix length: a
    // Kubernetes label key legitimately contains dots (app.kubernetes.io/
    // instance is the `helm create` default), which is indistinguishable
    // from nesting once folded into one dot-joined path string. parentPath
    // is computed structurally from the frame stack, so it's exact -- no
    // guessing by counting dots in what's left after the prefix.
    if (e.parentPath !== prefix) continue;
    if (e.value.form !== "template") { map[e.key] = e.value.value; found = true; }
    else return null; // any templated label value makes the whole map unusable for subset matching
  }
  return found ? map : null;
}

function buildDocument(text: string, docStartByte: number, entries: FieldPathEntry[], unresolvedContainers: Set<string>): K8sManifestDocument {
  const kindEntry = findEntry(entries, "kind");
  const kind = kindEntry?.value.form === "literal" ? kindEntry.value.value : null;
  if (!kind || !ALLOWED_KINDS.has(kind)) return { resource: null, references: [], selector: null, labels: null };

  const nameEntry = findEntry(entries, "metadata.name");
  const resource: K8sResourceDoc | null = nameEntry
    ? { kind, name: nameEntry.value, startByte: docStartByte, endByte: docStartByte + text.length }
    : null;

  const references = [...extractFieldReferences(kind, entries), ...extractOwnerReferenceCandidates(entries)];
  const selector = kind === "Service" ? extractLiteralLabelMap("spec.selector", entries, unresolvedContainers) : null;
  const labelsPath = LABELS_PATH_BY_KIND[kind];
  const labels = labelsPath ? extractLiteralLabelMap(labelsPath, entries, unresolvedContainers) : null;
  return { resource, references, selector, labels };
}

const DOC_SEPARATOR = /^---[ \t]*\r?$/m;

export function extractK8sManifest(source: string): K8sManifestDocument[] {
  const docs: K8sManifestDocument[] = [];
  const boundaries: number[] = [];
  for (const m of source.matchAll(new RegExp(DOC_SEPARATOR, "gm"))) boundaries.push(m.index!, m.index! + m[0].length);
  const starts = [0, ...boundaries.filter((_, i) => i % 2 === 1)];
  const ends = [...boundaries.filter((_, i) => i % 2 === 0), source.length];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = ends[i]!;
    const text = source.slice(start, end);
    const { entries, unresolvedContainers } = scanFieldPaths(text, start);
    docs.push(buildDocument(text, start, entries, unresolvedContainers));
  }
  return docs;
}
