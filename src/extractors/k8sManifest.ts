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

const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z0-9_.\/-]+):[ \t]*(.*)$/;

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
function scanFieldPaths(text: string, baseByte: number): { entries: FieldPathEntry[]; blockTemplated: Set<string> } {
  const entries: FieldPathEntry[] = [];
  const blockTemplated = new Set<string>();
  const stack: StackFrame[] = [];
  let byteOffset = baseByte;
  let pendingBlockKey: { path: string; indent: number } | null = null;

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

  for (const line of text.split("\n")) {
    const lineStartByte = byteOffset;
    byteOffset += line.length + 1; // +1 for the \n split() consumed

    if (pendingBlockKey) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent > pendingBlockKey.indent && trimmed.startsWith("{{")) blockTemplated.add(pendingBlockKey.path);
      }
      pendingBlockKey = null; // only the immediately-following non-blank line decides this
    }

    const m = KEY_LINE.exec(line);
    if (!m) continue;
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

    const value = rawValue!.trim();
    stack.push({ indent: itemIndent, key: key!, isSeq: false, hasValue: value.length > 0 });
    const path = stack.map((f) => f.key).filter(Boolean).join(".").replace(/\.\[/g, "[");

    if (value.length > 0) {
      const colonIdx = line.indexOf(":", dashIndent);
      const valueStartInLine = line.indexOf(value, colonIdx);
      const atByte = lineStartByte + valueStartInLine;
      const endByte = atByte + value.length;
      entries.push({
        path,
        value: value.startsWith("{{")
          ? { form: "template", sourceText: value, atByte, endByte }
          : { form: "literal", value: stripQuotes(value), atByte, endByte },
      });
    } else {
      pendingBlockKey = { path, indent: itemIndent };
    }
  }
  return { entries, blockTemplated };
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
};

/** A literal label map at `prefix.<key>` for each direct child leaf. Returns
 *  null (not an empty map) when: the prefix itself is a block-form template
 *  injection (no literal keys exist to read at all), no direct-child leaf
 *  exists, or any direct-child leaf is itself templated -- a partially-literal
 *  map is still unusable for subset-match without evaluating the templated
 *  half, so the whole map is treated as unresolved. */
function extractLiteralLabelMap(prefix: string, entries: FieldPathEntry[], blockTemplated: Set<string>): ManifestLabelMap | null {
  if (blockTemplated.has(prefix)) return null;
  const map: ManifestLabelMap = {};
  const dotPrefix = `${prefix}.`;
  let found = false;
  for (const e of entries) {
    if (!e.path.startsWith(dotPrefix)) continue;
    const key = e.path.slice(dotPrefix.length);
    if (key.includes(".") || key.includes("[")) continue; // not a direct child leaf -- ignore defensively, K8s labels are always a flat map
    if (e.value.form !== "template") { map[key] = e.value.value; found = true; }
    else return null; // any templated label value makes the whole map unusable for subset matching
  }
  return found ? map : null;
}

function buildDocument(text: string, docStartByte: number, entries: FieldPathEntry[], blockTemplated: Set<string>): K8sManifestDocument {
  const kindEntry = findEntry(entries, "kind");
  const kind = kindEntry?.value.form === "literal" ? kindEntry.value.value : null;
  if (!kind || !ALLOWED_KINDS.has(kind)) return { resource: null, references: [], selector: null, labels: null };

  const nameEntry = findEntry(entries, "metadata.name");
  const resource: K8sResourceDoc | null = nameEntry
    ? { kind, name: nameEntry.value, startByte: docStartByte, endByte: docStartByte + text.length }
    : null;

  const references = [...extractFieldReferences(kind, entries), ...extractOwnerReferenceCandidates(entries)];
  const selector = kind === "Service" ? extractLiteralLabelMap("spec.selector", entries, blockTemplated) : null;
  const labelsPath = LABELS_PATH_BY_KIND[kind];
  const labels = labelsPath ? extractLiteralLabelMap(labelsPath, entries, blockTemplated) : null;
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
    const { entries, blockTemplated } = scanFieldPaths(text, start);
    docs.push(buildDocument(text, start, entries, blockTemplated));
  }
  return docs;
}
