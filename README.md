# indus-backend

A Cloudflare Worker that sits between the Indus client and [OpenRouter](https://openrouter.ai). It exposes a small HTTP API, maps each agent role to a model, and forwards requests to OpenRouter's chat completions endpoint.

- Runtime: Cloudflare Workers (`wrangler`)
- Upstream: `https://openrouter.ai/api/v1/chat/completions`
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

| Method | Path        | Purpose                                              |
| ------ | ----------- | ---------------------------------------------------- |
| GET    | `/health`   | Liveness check, returns `I am alive!`                |
| POST   | `/chat`     | Role-based chat (JSON reply, or SSE for `conversant`) |
| POST   | `/agent`    | Single-step browser agent with tool calling          |
| POST   | `/computer` | Computer-use request (see [Known issues](#known-issues)) |

Anything else returns `404 Not Found`. Upstream failures are passed through as `{ "error": "OpenRouter error: ..." }` with the upstream status code.

### `POST /chat`

Request body:

```json
{
  "agentRole": "planner",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "imageUrl": "https://... or data:image/..."
}
```

- `agentRole` (required): one of the roles below. `dispatcher` takes a different body, see [Dispatcher](#dispatcher-jev).
- `messages` (required, except for `dispatcher`): array of `{ role, content }`. Non-string `content` is JSON-stringified.
- `imageUrl` (optional): appended as a final user message containing the image.

Response (all roles except `conversant` and `dispatcher`):

```json
{ "reply": "model output" }
```

All non-streaming roles request `response_format: { "type": "json_object" }`, so your prompt should ask the model for JSON.

#### Roles and models

| Role          | Model                                  | Notes                       |
| ------------- | -------------------------------------- | --------------------------- |
| `planner`     | `~openai/gpt-sol-latest`               | Rolling alias, always newest Sol |
| `supervisor`  | `~openai/gpt-sol-latest`               |                             |
| `interpreter` | `~openai/gpt-mini-latest`              |                             |
| `reader`      | `~openai/gpt-mini-latest`              |                             |
| `dispatcher`  | `~typesafe/jev-latest`                 | Not an LLM, see [Dispatcher](#dispatcher-jev) |
| `conversant`  | `~anthropic/claude-sonnet-latest:online` | Streaming, web search enabled |

Models prefixed with `~` are OpenRouter "latest" aliases, so they track new releases without code changes. An unknown role returns `400 Invalid role specified.`

#### Dispatcher (Jev)

`dispatcher` uses [Jev](https://openrouter.ai/docs/guides/community/jev), TypeSafe's structured decision model. It is not a chat model: it takes application state plus typed questions and returns typed answers with probabilities, never prose. It is fast and cheap (input tokens only, 32k context), which makes it suited to routing and classification. The worker calls OpenRouter's Decisions API (`POST /api/alpha/decisions`) with model `~typesafe/jev-latest`, not chat completions.

The request body is different from the other roles. There is no `messages` or `imageUrl`:

```json
{
  "agentRole": "dispatcher",
  "state": {
    "customer_tier": "enterprise",
    "ticket": "Checkout shows a blank screen after I click Pay."
  },
  "questions": {
    "is_bug": {
      "type": "noul",
      "instructions": "Is the customer reporting a software defect?",
      "criteria": { "true": "Broken behavior.", "false": "A question or feature request." }
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": { "payments": "Checkout and billing.", "frontend": "Rendering issues." }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this ticket?",
      "criteria": ["Can wait", "Fix this week", "Blocking revenue"]
    }
  }
}
```

Question types:

| Type     | Asks                         | `criteria`                  | Answer                                              |
| -------- | ---------------------------- | --------------------------- | --------------------------------------------------- |
| `choice` | Which one of these options?  | object of option to meaning | `choice`, `confidence`, `probabilities`             |
| `noul`   | Does this condition hold?    | `{ "true": ..., "false": ... }` | `noul` (probability of yes)                     |
| `score`  | Where on an ordered scale?   | array of levels, low to high | `score`, `confidence`, `probabilities`, `legend`   |

Response:

```json
{
  "answers": {
    "is_bug": { "type": "noul", "noul": 0.96 },
    "team": { "type": "choice", "choice": "payments", "confidence": 0.67, "probabilities": { "payments": 0.78, "frontend": 0.22 } },
    "urgency": { "type": "score", "score": 1.99, "confidence": 0.99, "probabilities": { "0": 0, "1": 0, "2": 1 }, "legend": { "0": "Can wait", "1": "Fix this week", "2": "Blocking revenue" } }
  },
  "model": "typesafe/jev-1.13-20260917",
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.00002 }
}
```

`state` must be an object and `questions` a non-empty object, otherwise the worker returns `400`. Jev returns no reasoning or explanation. The Decisions API is an `alpha` endpoint, so its shape may change.

#### Streaming (`conversant`)

`conversant` returns `text/event-stream`. Each event carries one text delta, and the stream ends with `[DONE]`:

```
data: {"delta":"Hel"}

data: {"delta":"lo"}

data: [DONE]
```

Example client:

```js
const res = await fetch(`${BASE}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentRole: 'conversant', messages }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const events = buf.split('\n\n');
  buf = events.pop();
  for (const e of events) {
    const data = e.replace(/^data: /, '');
    if (data === '[DONE]') return;
    process(JSON.parse(data).delta);
  }
}
```

### `POST /agent`

Runs one step of the browser agent with `~openai/gpt-terra-latest`. The model may answer with text, a tool call, or both.

Request body:

```json
{
  "messages": [ { "role": "user", "content": "..." } ],
  "imageUrl": "optional screenshot"
}
```

Response:

```json
{
  "reply": "text from the model",
  "tool": { "name": "click", "arguments": "{\"x\":\"12\",\"y\":\"4\"}" }
}
```

`tool` is `null` when no tool was called. Only the first tool call is returned, and `arguments` is the raw JSON string from the model.

Available tools: `click`, `type`, `keypress`, `navigate`, `scroll`, `wait`, `warn`, `final_answer`. Their schemas live in `handleAgentRequest` in [src/index.js](src/index.js).

### `POST /computer`

```json
{
  "goal": "string",
  "imageUrl": "optional",
  "displayWidth": 1024,
  "displayHeight": 768,
  "environment": "browser"
}
```

Returns the upstream `output` (or the full response if there is none).

## Limits

The worker does not impose any limit on message count, message length or output length. It sets no `max_tokens` and does no truncation. The effective limits are the model's own context window and output cap, plus Cloudflare's request body size limit for your plan.

## Known issues

- `/computer` uses the model id `computer-use-preview`, which is not in OpenRouter's model catalog, so this endpoint will likely fail upstream.

## Testing

`test/index.spec.js` is still the default Wrangler template and expects `Hello World!` from `/`, which the worker no longer returns. Update it before relying on `npm test`.
