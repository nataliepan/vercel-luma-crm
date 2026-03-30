import { createAnthropic } from '@ai-sdk/anthropic'

// Why createAnthropic with explicit baseURL: the default @ai-sdk/anthropic v3
// provider hits https://api.anthropic.com/messages (missing /v1/ prefix) and
// returns 404. Setting baseURL explicitly fixes this.
//
// Why a shared module: all AI features (schema mapping, NL search, segments,
// outreach, hallucination check) use the same provider config. One place to
// change model, base URL, or API key.
export const anthropic = createAnthropic({
  baseURL: 'https://api.anthropic.com/v1',
  apiKey: process.env.ANTHROPIC_API_KEY,
})
