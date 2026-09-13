/**
 * Tracks an asynchronous view load against the workspace root that started it.
 * A dynamic workspace can change while the CLI is running; an old result must
 * never become the contents of the newly selected repository.
 */
export interface RootLoadTicket {
  readonly root: string | undefined;
  readonly generation: number;
}

export class RootLoadFence {
  private generation = 0;

  begin(root: string | undefined): RootLoadTicket {
    return { root, generation: ++this.generation };
  }

  isCurrent(ticket: RootLoadTicket, root: string | undefined): boolean {
    return ticket.generation === this.generation && ticket.root === root;
  }
}
