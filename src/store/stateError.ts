/** Stable typed refusals shared by bindings and partition validation. */
export class StateRefusal extends Error {
  constructor(
    readonly code: "outside-grants" | "unsupported" | "malformed" | "identity" | "conflict" | "no-partition-home" | "idempotency",
    message: string,
    readonly conflict: { incumbent_id: string; reason: string } | null = null,
  ) {
    super(message);
    this.name = "StateRefusal";
  }
}

