import { test } from "node:test";
import assert from "node:assert/strict";
import { extractK8sManifest } from "../src/extractors/k8sManifest.js";

test("a literal Deployment's kind and metadata.name are detected as its resource identity", () => {
  const src = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\n`;
  const [doc] = extractK8sManifest(src);
  assert.ok(doc);
  assert.equal(doc!.resource?.kind, "Deployment");
  assert.deepEqual(doc!.resource?.name, { form: "literal", value: "my-app", atByte: src.indexOf("my-app"), endByte: src.indexOf("my-app") + "my-app".length });
});

test("a same-line templated metadata.name is classified as a template form with the raw source text", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ include "chart.fullname" . }}\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.name.form, "template");
  assert.equal((doc!.resource!.name as { sourceText: string }).sourceText, `{{ include "chart.fullname" . }}`);
});

test("a kind outside the fixed allowlist produces no resource and no candidates", () => {
  const src = `apiVersion: example.com/v1\nkind: MyCustomResource\nmetadata:\n  name: whatever\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource, null);
  assert.deepEqual(doc!.references, []);
});

test("multi-document files (--- separated) produce one entry per document with correct byte offsets", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm-one\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: sec-one\n`;
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 2);
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
  assert.equal(docs[1]!.resource?.kind, "Secret");
  assert.ok(docs[1]!.resource!.startByte >= src.indexOf("---"));
});

test("quoted literal names have their quotes stripped", () => {
  const src = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: "my-config"\n`;
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.name.form, "literal");
  assert.equal((doc!.resource!.name as { value: string }).value, "my-config");
});

test("a block-form templated value does not corrupt later structure in the same document", () => {
  const src = [
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `metadata:`,
    `  name: my-app`,
    `  labels:`,
    `    {{- include "chart.labels" . | nindent 4 }}`,
    `spec:`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `      - name: app`,
    `        env:`,
    `          - name: X`,
    `            valueFrom:`,
    `              secretKeyRef:`,
    `                name: my-secret`,
    `                key: k`,
    ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.resource?.kind, "Deployment");
  assert.equal((doc!.resource!.name as { value: string }).value, "my-app");
});

// Task 2

test("a Deployment's env[].valueFrom.secretKeyRef.name produces a Secret reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        env:`, `          - name: X`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: my-secret`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.ok(ref, "Secret reference candidate found");
  assert.equal((ref!.name as { value: string }).value, "my-secret");
});

test("a Deployment's envFrom[].configMapRef.name produces a ConfigMap reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`, `          - configMapRef:`, `              name: my-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "ConfigMap");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-config");
});

test("a Pod's (not Deployment-wrapped) volumes[].secret.secretName produces a Secret reference candidate", () => {
  const src = [
    `apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`,
    `spec:`, `  containers:`, `  - name: app`, `  volumes:`,
    `  - name: data`, `    secret:`, `      secretName: my-secret`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-secret");
});

test("a same-line templated secretKeyRef.name is captured as a template-form reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        env:`, `          - name: X`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: {{ include "chart.secretName" . }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.equal(ref!.name.form, "template");
  assert.equal((ref!.name as { sourceText: string }).sourceText, `{{ include "chart.secretName" . }}`);
});

test("a block-injected label above the container spec does not prevent env references from being found (the exact tree-sitter failure case)", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `  labels:`, `    {{- include "chart.labels" . | nindent 4 }}`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        env:`, `          - name: X`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: my-secret`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Secret");
  assert.ok(ref, "reference found despite an earlier block-form template injection in the same document");
  assert.equal((ref!.name as { value: string }).value, "my-secret");
});

test("two containers each produce their own independent reference candidates", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`,
    `      - name: app`, `        env:`, `          - name: A`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: secret-a`,
    `      - name: sidecar`, `        env:`, `          - name: B`, `            valueFrom:`,
    `              secretKeyRef:`, `                name: secret-b`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const names = doc!.references.filter((r) => r.refKind === "Secret").map((r) => (r.name as { value: string }).value).sort();
  assert.deepEqual(names, ["secret-a", "secret-b"]);
});

// Task 3

test("volumes[].persistentVolumeClaim.claimName produces a PersistentVolumeClaim reference candidate", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `      volumes:`, `      - name: data`, `        persistentVolumeClaim:`,
    `          claimName: my-pvc`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "PersistentVolumeClaim");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-pvc");
});

test("metadata.ownerReferences produces a reference candidate whose refKind is the owner's OWN kind field, not a fixed literal", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: ReplicaSet`, `metadata:`, `  name: my-app-abc123`,
    `  ownerReferences:`, `  - apiVersion: apps/v1`, `    kind: Deployment`,
    `    name: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Deployment");
  assert.ok(ref, "owner reference candidate found, keyed by the owner's kind field");
  assert.equal((ref!.name as { value: string }).value, "my-app");
});

test("two ownerReferences entries each pair their OWN name with their OWN kind (no cross-pairing)", () => {
  const src = [
    `apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`,
    `  ownerReferences:`,
    `  - apiVersion: apps/v1`, `    kind: ReplicaSet`, `    name: owner-one`,
    `  - apiVersion: batch/v1`, `    kind: Job`, `    name: owner-two`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const byKind = new Map(doc!.references.map((r) => [r.refKind, (r.name as { value: string }).value]));
  assert.equal(byKind.get("ReplicaSet"), "owner-one");
  assert.equal(byKind.get("Job"), "owner-two");
});

test("Ingress backend.service.name produces a Service reference candidate", () => {
  const src = [
    `apiVersion: networking.k8s.io/v1`, `kind: Ingress`, `metadata:`, `  name: my-ingress`,
    `spec:`, `  rules:`, `  - http:`, `      paths:`, `      - backend:`,
    `          service:`, `            name: my-service`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Service");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-service");
});

test("HTTPRoute backendRefs[].name produces a Service reference candidate", () => {
  const src = [
    `apiVersion: gateway.networking.k8s.io/v1`, `kind: HTTPRoute`, `metadata:`, `  name: my-route`,
    `spec:`, `  rules:`, `  - backendRefs:`, `    - name: my-service`, `      port: 80`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "Service");
  assert.ok(ref);
  assert.equal((ref!.name as { value: string }).value, "my-service");
});

// Task 4

test("a Service's literal spec.selector is extracted as a label map", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    app: my-app`, `    tier: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.selector, { app: "my-app", tier: "web" });
});

test("a Deployment's literal spec.template.metadata.labels is extracted as a label map", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        app: my-app`, `        tier: web`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app", tier: "web" });
});

test("a Service's block-form templated selector ({{ include ... }} block) is left null, not guessed at", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    {{- include "chart.selectorLabels" . | nindent 4 }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null);
});

test("a Deployment's block-form templated pod-template labels is left null", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        {{- include "chart.labels" . | nindent 8 }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.labels, null);
});

test("a Pod's own metadata.labels (not wrapped in a template spec) is extracted directly", () => {
  const src = [`apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`, `  labels:`, `    app: my-app`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app" });
});

test("a ConfigMap (no selector/labels concept in scope) has null selector and null labels", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null);
  assert.equal(doc!.labels, null);
});

// Comment-stripping fix

test("an inline YAML comment after a value is stripped, not folded into the value", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config  # app settings`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { value: string }).value, "my-config");
});

test("a ConfigMap name with a trailing comment still resolves against a Deployment's uncommented reference to it", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`, `          - configMapRef:`, `              name: my-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "ConfigMap");
  assert.equal((ref!.name as { value: string }).value, "my-config");

  const configMapSrc = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config  # app settings`, ``].join("\n");
  const [configMapDoc] = extractK8sManifest(configMapSrc);
  // Both sides normalize to the same literal value -- the comment never
  // leaks into either side's identity, so a downstream (scope, kind, name)
  // resolver would see them as the same candidate.
  assert.equal((configMapDoc!.resource!.name as { value: string }).value, (ref!.name as { value: string }).value);
});

test("a quoted value's own # character is NOT treated as a comment opener", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: "my-config#not-a-comment"`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { value: string }).value, "my-config#not-a-comment");
});

test("a Sprig default inside a template expression ({{ .x | default \"#fff\" }}) keeps its # intact", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: {{ .Values.color | default "#fff" }}`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { sourceText: string }).sourceText, `{{ .Values.color | default "#fff" }}`);
});

test("a value-less key with only a trailing comment on its own line is still treated as opening a nested block, not an inline value", () => {
  // kind: Pod, not ConfigMap -- Pod is the kind LABELS_PATH_BY_KIND extracts
  // metadata.labels for; a ConfigMap has no labels concept in this scanner.
  const src = [`apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`, `  labels:  # no literal labels here`, `    app: my-app`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app" });
});

// Edge cases identified during review

test("a file starting with a leading --- separator produces a harmless empty leading document, not an off-by-one on the real ones", () => {
  const src = `---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm-one\n`;
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 2, "leading --- splits off one empty document ahead of the real one");
  assert.equal(docs[0]!.resource, null, "the empty leading document has no resource");
  assert.equal(docs[1]!.resource?.kind, "ConfigMap");
});

test("a flow-style selector (selector: {app: my-app}) is conservatively left unresolved, not walked as a literal map", () => {
  const src = [`apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`, `spec:`, `  selector: {app: my-app}`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "flow-style collections aren't walked by this scanner -- conservative miss, not a guess");
});

test("a ConfigMap's data: block scalar containing manifest-looking YAML text does not produce phantom nested resources", () => {
  const src = [
    `apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: my-config`,
    `data:`, `  embedded.yaml: |`, `    kind: Deployment`, `    metadata:`, `      name: not-a-real-resource`, ``,
  ].join("\n");
  const docs = extractK8sManifest(src);
  assert.equal(docs.length, 1, "the block-scalar body is not split into a second document");
  assert.equal(docs[0]!.resource?.kind, "ConfigMap");
  assert.equal((docs[0]!.resource!.name as { value: string }).value, "my-config");
});

// Dotted label keys (found on re-review): a Kubernetes label key legitimately
// contains dots (app.kubernetes.io/instance is the `helm create` default),
// which is indistinguishable from path nesting once folded into one
// dot-joined string -- FieldPathEntry.parentPath/key must be tracked
// structurally, never re-derived by slicing/counting dots in the joined path.

test("an all-dotted selector (the helm create default convention) is extracted, not silently dropped", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`,
    `    app.kubernetes.io/name: my-app`,
    `    app.kubernetes.io/instance: prod`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.selector, { "app.kubernetes.io/name": "my-app", "app.kubernetes.io/instance": "prod" });
});

test("a mixed selector whose dotted key differs from the workload's does NOT subset-match on the plain-key remainder alone", () => {
  // Regression for the exact false positive found on re-review: both sides
  // used to collapse to {app: my-app} (the dotted key silently dropped),
  // which made a real mismatch (prod vs staging) look like a match.
  const selectorSrc = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    app: my-app`, `    app.kubernetes.io/instance: prod`, ``,
  ].join("\n");
  const labelsSrc = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        app: my-app`, `        app.kubernetes.io/instance: staging`, ``,
  ].join("\n");
  const selector = extractK8sManifest(selectorSrc)[0]!.selector!;
  const labels = extractK8sManifest(labelsSrc)[0]!.labels!;
  assert.deepEqual(selector, { app: "my-app", "app.kubernetes.io/instance": "prod" });
  assert.deepEqual(labels, { app: "my-app", "app.kubernetes.io/instance": "staging" });
  // The values genuinely differ -- a real subset check must reject this.
  const isSubset = Object.entries(selector).every(([k, v]) => labels[k] === v);
  assert.equal(isSubset, false, "differing app.kubernetes.io/instance values must NOT read as a match");
});

test("a label key containing both a dot and a slash round-trips into the map with its key intact", () => {
  const src = [
    `apiVersion: v1`, `kind: Pod`, `metadata:`, `  name: my-pod`,
    `  labels:`, `    app.kubernetes.io/name: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { "app.kubernetes.io/name": "my-app" });
});

test("a block-form template injection appearing as a LATER sibling after literal keys taints the whole map, not just a lookahead from the opening key", () => {
  // Regression: the opening `selector:` key already has a literal first
  // child (`app: my-app`), so the value-less-key-then-{{-on-next-line
  // lookahead never fires for THIS key -- the injection lands as a sibling
  // several lines later, which must still be caught.
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    app: my-app`,
    `    {{- include "mychart.selectorLabels" . | nindent 4 }}`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "partially-templated map (literal siblings + a later injection) must not read as fully literal");
});

// Comment-stripping quote hardening (found on re-review)

test("an apostrophe mid-word does not open a phantom quote that swallows a real trailing comment", () => {
  const src = [`apiVersion: v1`, `kind: ConfigMap`, `metadata:`, `  name: it's-fine  # a real comment`, ``].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal((doc!.resource!.name as { value: string }).value, "it's-fine");
});

// CRLF line endings (found on third review pass): `core.autocrlf=true` is the
// Git-for-Windows default, so every .yaml file in a Windows checkout is
// CRLF-terminated -- confirmed this silently zeroed out the whole module's
// output before the KEY_LINE regex fix (JS `.` never matches `\r`, and `$`
// without /m only matches at true end-of-string).

test("a CRLF-terminated manifest is scanned identically to its LF equivalent", () => {
  const lf = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        envFrom:\n        - configMapRef:\n            name: my-config\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const [lfDoc] = extractK8sManifest(lf);
  const [crlfDoc] = extractK8sManifest(crlf);
  assert.equal(crlfDoc!.resource?.kind, "Deployment");
  assert.equal((crlfDoc!.resource!.name as { value: string }).value, (lfDoc!.resource!.name as { value: string }).value);
  assert.equal(crlfDoc!.references.length, lfDoc!.references.length);
  assert.equal((crlfDoc!.references[0]!.name as { value: string }).value, "my-config");
});

test("a CRLF-terminated Service selector and workload labels are extracted the same as LF", () => {
  const lf = `apiVersion: v1\nkind: Service\nmetadata:\n  name: my-service\nspec:\n  selector:\n    app: my-app\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const [doc] = extractK8sManifest(crlf);
  assert.deepEqual(doc!.selector, { app: "my-app" });
});

// Unrecognized line shapes (found on third review pass): a line the scanner
// can't parse at all (a quoted key, a YAML merge key) must taint its
// container as unresolved, not silently vanish -- a dropped key makes a
// selector/labels map strictly MORE permissive, which risks a false-positive
// edge on real, untemplated YAML.

test("a quoted label key is left unresolved (null), not silently dropped from the map", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `spec:`, `  selector:`, `    "app.kubernetes.io/name": mychart`, `    app.kubernetes.io/instance: rel-a`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.selector, null, "a quoted key the scanner can't parse must taint the whole map, not vanish silently");
});

test("a YAML merge key (<<: *anchor) is left unresolved (null), not silently dropped from the map", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: my-app`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`,
    `        <<: *commonLabels`, `        app: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.equal(doc!.labels, null);
});

test("an unresolved-line taint at one nesting level does not affect an unrelated sibling container", () => {
  const src = [
    `apiVersion: v1`, `kind: Service`, `metadata:`, `  name: my-service`,
    `  "weird-quoted-key": value`, // unresolved, taints metadata (irrelevant to selector)
    `spec:`, `  selector:`, `    app: my-app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.selector, { app: "my-app" }, "an unresolved line under metadata must not taint spec.selector");
});

// ReplicaSet full wiring (found on third review pass): ReplicaSet was
// allowlisted only for its role as the dominant ownerReferences bearer, but
// left out of the pod-spec/labels tables, silently dropping its OWN
// container references and pod-template labels.

test("a hand-written ReplicaSet's own envFrom/volumes references are extracted, not silently dropped", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: ReplicaSet`, `metadata:`, `  name: my-rs`,
    `spec:`, `  template:`, `    spec:`, `      containers:`, `      - name: app`,
    `        envFrom:`, `        - configMapRef:`, `            name: my-config`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  const ref = doc!.references.find((r) => r.refKind === "ConfigMap");
  assert.ok(ref, "ReplicaSet's own container references must be extracted, same as any other pod-spec-embedding kind");
});

test("a ReplicaSet's pod-template labels are extracted for Phase 2 matching", () => {
  const src = [
    `apiVersion: apps/v1`, `kind: ReplicaSet`, `metadata:`, `  name: my-rs`,
    `spec:`, `  template:`, `    metadata:`, `      labels:`, `        app: my-app`,
    `    spec:`, `      containers:`, `      - name: app`, ``,
  ].join("\n");
  const [doc] = extractK8sManifest(src);
  assert.deepEqual(doc!.labels, { app: "my-app" });
});
