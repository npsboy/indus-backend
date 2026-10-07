# indus-backend

A Cloudflare Worker that sits between the Indus client and [OpenRouter](https://openrouter.ai). The client builds every request; the worker maps each agent role to a model, adds the API key and passes the request through.

- Runtime: Cloudflare Workers (`wrangler`)
- Upstream: `https://openrouter.ai/api/v1/chat/completions` and `/api/alpha/decisions`
- Entry point: [src/index.js](src/index.js)

## Setup

```bash
npm install
```

Create a `.dev.vars` file for local development (git-ignored):

```
OpenRouter_API_KEY=sk-or-...
```

For production, store the key as a secret:

```bash
npx wrangler secret put OpenRouter_API_KEY
```

## Scripts

| Command          | What it does                      |
| ---------------- | --------------------------------- |
| `npm run dev`    | Run locally with `wrangler dev`   |
| `npm run deploy` | Deploy with `wrangler deploy`     |
| `npm test`       | Run the vitest suite              |

## Endpoints

| Method | Path      | Purpose                                         |
| ------ | --------- | ----------------------------------------------- |
| GET    | `/health` | Liveness check, returns `I am alive!`           |
| POST   | `/llm`    | Forwards a request to OpenRouter for a role     |

Anything else returns `404 Not Found`.

### `POST /llm`

The client builds the whole OpenRouter request (messages, tools, `tool_choice`, `response_format`, `stream`, reasoning, prompt caching). The worker only picks the model for the role, adds the API key and returns OpenRouter's response unchanged: same status, same body, SSE streams included.

```json
{
  "agentRole": "planner",
  "payload": { "messages": [ ... ], "response_format": { "type": "json_object" } }
}
```

`payload` is the OpenRouter request body without `model`. A `model` or `models` field sent by the client is ignored. An unknown role or a missing `payload` returns `400`.

#### Roles and models

| Role          | Model                                    | Upstream                       |
| ------------- | ---------------------------------------- | ------------------------------ |
| `planner`     | `anthropic/claude-sonnet-5.5`            | `/api/v1/chat/completions`     |
| `supervisor`  | `anthropic/claude-sonnet-5.5`            | `/api/v1/chat/completions`     |
| `agent`       | `openai/gpt-6-luna`                      | `/api/v1/chat/completions`     |
| `interpreter` | `~openai/gpt-mini-latest`                | `/api/v1/chat/completions`     |
| `reader`      | `~openai/gpt-mini-latest`                | `/api/v1/chat/completions`     |
| `conversant`  | `~anthropic/claude-sonnet-latest:online` | `/api/v1/chat/completions`     |
| `titler`      | `openai/gpt-oss-120b`                    | `/api/v1/chat/completions`     |
| `dispatcher`  | `~typesafe/jev-latest`                   | `/api/alpha/decisions`         |

Models prefixed with `~` are OpenRouter "latest" aliases. The `dispatcher` is Jev, a structured decision model (not an LLM): its payload is `{ "state": { ... }, "questions": { ... } }` and it returns typed answers.

## Limits

The worker imposes no limits of its own. The effective limits are the model's context window and output cap, plus Cloudflare's request body size limit for your plan.

## Testing

`test/index.spec.js` is still the default Wrangler template and expects `Hello World!` from `/`, which the worker no longer returns. Update it before relying on `npm test`.
