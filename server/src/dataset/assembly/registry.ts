import type {
  FamilyAssemblerCapability,
  FamilyAssemblerHandler,
  FamilyAssemblyInput,
} from "./types.js";

export class FamilyAssemblerRegistry {
  readonly #handlers = new Map<string, FamilyAssemblerHandler>();

  constructor(initial: readonly FamilyAssemblerHandler[] = []) {
    for (const handler of initial) this.register(handler);
  }

  register(handler: FamilyAssemblerHandler): void {
    if (handler.familyId.trim() === "" || handler.handlerId.trim() === "") {
      throw new Error("family assembler IDs must not be blank");
    }
    if (this.#handlers.has(handler.familyId)) {
      throw new Error(`family assembler '${handler.familyId}' is already registered`);
    }
    this.#handlers.set(handler.familyId, handler);
  }

  has(familyId: string): boolean {
    return this.#handlers.has(familyId);
  }

  get(familyId: string): FamilyAssemblerHandler {
    const handler = this.#handlers.get(familyId);
    if (handler === undefined) {
      throw new Error(`dataset family '${familyId}' has no assembler handler`);
    }
    return handler;
  }

  createCapability(familyId: string): FamilyAssemblerCapability {
    const handler = this.get(familyId);
    return Object.freeze({
      familyId: handler.familyId,
      handlerId: handler.handlerId,
      assemble: (input: FamilyAssemblyInput) => {
        if (input.datasetFamily !== handler.familyId) {
          throw new Error(`assembler capability '${handler.familyId}' received a different family`);
        }
        const candidate = handler.assemble(input);
        if (candidate.dataset_family !== handler.familyId) {
          throw new Error(`assembler '${handler.handlerId}' returned a different family`);
        }
        return candidate;
      },
    });
  }

  list(): string[] {
    return [...this.#handlers.keys()].sort();
  }
}
