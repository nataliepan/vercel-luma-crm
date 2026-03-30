import { createAnthropic } from '@ai-sdk/anthropic'

// Why createAnthropic with explicit baseURL: the default @ai-sdk/anthropic v3
// provider hits https://api.anthropic.com/messages (missing /v1/ prefix) and
// returns 404. Setting baseURL explicitly fixes this.
//
// Why a function not a module-level constant: process.env.ANTHROPIC_API_KEY
// may not be available at module load time (Next.js loads .env.local after
// module evaluation, and tests inject env vars in setupFiles). A function
// ensures the key is read when the AI call actually happens.
//
// Why a shared module: all AI features use the same provider config.
// One place to change model, base URL, or API key.
export function anthropic(model: string) {
  const provider = createAnthropic({
    baseURL: 'https://api.anthropic.com/v1',
    apiKey: process.env.ANTHROPIC_API_KEY,
  })
  return provider(model)
}
