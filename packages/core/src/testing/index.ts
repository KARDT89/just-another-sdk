/**
 * Test helpers — `just-another-sdk/testing`.
 *
 * Shipped as part of the package on purpose: testing an agent should not require
 * hand-rolling an HTTP mock. Import these in your own test suite to assert on
 * agent behaviour offline and deterministically.
 */

export {
  mockProvider,
  type MockProvider,
  type MockProviderOptions,
  type MockToolCall,
  type MockTurn,
} from './mock-provider.js'

export { collectEvents, type EventCollector } from './event-collector.js'
