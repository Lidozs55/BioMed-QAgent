/**
 * Compatibility export for the credential approval surface.
 *
 * The implementation is the general durable HIL gate. Keeping this module
 * avoids coupling business tools to Runtime's broader review vocabulary.
 */
export {
  DurableHILGate as DurableApprovalGate,
  type HILGateHandle as ApprovalGateHandle,
} from "./hil-gate.js";
