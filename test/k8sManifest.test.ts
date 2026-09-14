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
