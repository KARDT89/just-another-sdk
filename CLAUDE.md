# CLAUDE.md — Build Your Own Agent SDK (Sylo-sdk)

## Objective

Build an open-source AI Agent SDK from scratch using TypeScript or JavaScript. Original name inspired by builder's name or identity. Core agent behavior must not be provided by another agent framework. Model APIs, validation libraries, and utilities are allowed.

## Required Developer-Facing Capabilities

- Define an agent
- Provide instructions and a model
- Add tools
- Run an agent loop
- Receive a final result
- Handle failures safely

## 1. Agent Runtime

- Accepts user input
- Sends context and instructions to an LLM
- Detects tool calls
- Executes tools
- Sends tool results back to the model
- Continues until a final answer is produced
- Stops when limits are reached

## 2. Tools

- name, description
- input schema, execution function
- typed result, error handling
- input validation
- asynchronous tools

## 3. Agent Capabilities

Implement as many meaningful capabilities as possible, correctly:

- multi-agent handoffs
- input, output guardrails
- tool guardrails
- memory, sessions
- structured outputs
- streaming, retries
- model provider abstraction
- model fallback

## 4. Memory and Sessions

Support multi-turn conversations. Storage options:

- in-memory, files
- SQLite, Redis
- another database
- custom storage adapters

Separate clearly:

- agent configuration
- current run state
- persistent session state

## 5. Handoffs

- preserve required context
- identify the new agent
- avoid endless handoff loops
- appear in logs or traces

## 6. Guardrails

- reject invalid input, prevent dangerous tool calls
- validate structured output, remove sensitive information
- require approval for risky actions

## 7. Structured Output

- validate the output, return useful validation errors
- retry or repair invalid output if supported
- preserve TypeScript types where possible

## 8. Streaming and Events

Expose runtime events:

- text streamed, tool started
- tool completed, handoff started
- guardrail triggered
- run completed, run failed

Implementation: async iterators, callbacks, event emitters, or streams.

## 9. Tracing and Reliability

Traces should contain:

- run ID, agent name, model calls
- tool calls, handoffs, retries
- errors, timing, token usage
- final output

## 10. Model Providers

Provider abstraction, not tightly coupled to one provider. Support adding:

- OpenAI
- Claude
- Gemini

## Documentation

Host documentation covering:

- Installation
- Quick start, API usage
- Tools, Handoffs
- Guardrails
- Memory and sessions
- Structured output, Streaming
- Tracing, Error handling
- Examples

A developer should be able to use the SDK without reading the source code.

## Product & Pitch

Treat as a developer startup applying to Y Combinator. Explain:

- Who the SDK is for
- What problem it solves
- Why it should exist
- How it differs from existing SDKs
- Why developers should adopt it

Record a video showing your face, demonstrating the product. Post publicly on X, LinkedIn, or Instagram. Highest genuine reach wins the social challenge.

## Submission Instructions

- Public GitHub repository
- Hosted Documentation
- Demo link, if available
- npm package link, if published
- Public social media post

## Evaluation Parameters

Evaluated like a startup investment decision: would $500,000 of the investor's own money go into this SDK and its builder?

| Category                                                                                                                     | Marks |
| ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1. Agent Runtime — original loop, multi-turn execution, tool-call handling, safe stopping, clear final result                | 15    |
| 2. Tools — custom creation, input validation, async execution, typed results, error handling                                 | 10    |
| 3. Handoffs — working delegation, correct context transfer, loop prevention, clear documentation                             | 10    |
| 4. Guardrails — input/output validation, tool safety, controlled failures, approval support                                  | 10    |
| 5. Memory and Sessions — multi-turn state, persistent session support, clean storage abstraction, context management         | 10    |
| 6. Structured Output and Streaming — schema validation, typed output, invalid-output handling, useful runtime events         | 10    |
| 7. Reliability — retries, timeouts, clear errors, loop prevention, safe secret handling                                      | 10    |
| 8. Tracing — tool calls and handoffs visible, timing and errors recorded, useful debugging info                              | 5     |
| 9. Developer Experience — clean API design, strong TypeScript support, sensible defaults, clear error messages, easy setup   | 10    |
| 10. Documentation and Examples — hosted docs, working quick start, at least two examples, clear API reference                | 10    |
| 11. Product Thinking — clear target user, strong differentiation, real problem solved, believable product direction          | 10    |
| 12. Demo and Pitch — student appears in video, product demonstrated clearly, technical decisions explained, pitch convincing | 10    |
