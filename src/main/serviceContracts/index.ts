/**
 * Registry of per-service usage contracts. Services without a module get
 * the default accept-everything contract, so the pipeline can program
 * against getServiceContract() unconditionally. See ./types.ts for the
 * contract shape and the hook sequence notes.
 */
import type { ServiceUsageContract } from './types'
import { cursorContract } from './cursorContract'
import { qwenContract } from './qwenContract'
import { chatgptContract } from './chatgptContract'
import { grokContract } from './grokContract'

/** Default contract: no extra rules — every gate accepts, every row passes. */
const defaultContract: ServiceUsageContract = {}

const contracts: Record<string, ServiceUsageContract> = {
  cursor: cursorContract,
  qwen: qwenContract,
  chatgpt: chatgptContract,
  grok: grokContract
}

export function getServiceContract(serviceId: string): ServiceUsageContract {
  return contracts[serviceId] ?? defaultContract
}
