export const NODE_TEST_REPORTER_PROTOCOL = "hunch-node-test-reporter-v1";

export const NODE_TEST_REPORTER_SOURCE = `export default async function* hunchReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    yield JSON.stringify({
      protocol: "${NODE_TEST_REPORTER_PROTOCOL}",
      type: event.type,
      name: event.data.name,
      nesting: event.data.nesting,
      skip: event.data.skip ?? null,
      todo: event.data.todo ?? null
    }) + "\\n";
  }
}
`;

export interface NodeTestReporterEvent {
  protocol: typeof NODE_TEST_REPORTER_PROTOCOL;
  type: "test:pass" | "test:fail";
  name: string;
  nesting?: number;
  skip: string | boolean | null;
  todo: string | boolean | null;
}

export function exactNodeTestPattern(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export function nodeTestIsolationFlag(): string {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6)
    ? "--test-isolation=none"
    : "--experimental-test-isolation=none";
}

export function nodeTestReporterEvents(output: string): NodeTestReporterEvent[] {
  const events: NodeTestReporterEvent[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Partial<NodeTestReporterEvent>;
      if (event.protocol !== NODE_TEST_REPORTER_PROTOCOL
        || (event.type !== "test:pass" && event.type !== "test:fail")
        || typeof event.name !== "string") continue;
      events.push({
        protocol: NODE_TEST_REPORTER_PROTOCOL,
        type: event.type,
        name: event.name,
        ...(typeof event.nesting === "number" ? { nesting: event.nesting } : {}),
        skip: event.skip ?? null,
        todo: event.todo ?? null,
      });
    } catch { /* non-protocol output cannot become evidence */ }
  }
  return events;
}
