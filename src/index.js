/**
 * A thin link between the Indus browser and OpenRouter. The browser builds the whole
 * request (prompts, messages, tools, response format, streaming); this Worker only picks
 * the model for the role, adds the API key, and passes OpenRouter's response back as is.
 */

const CHAT_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';
const DECISIONS = 'https://openrouter.ai/api/alpha/decisions';

/** Each role's model, and the OpenRouter endpoint it is sent to. */
const ROLES = {
	planner: { model: 'anthropic/claude-sonnet-5.5', endpoint: CHAT_COMPLETIONS },
	interpreter: { model: '~openai/gpt-mini-latest', endpoint: CHAT_COMPLETIONS },
	reader: { model: '~openai/gpt-mini-latest', endpoint: CHAT_COMPLETIONS },
	supervisor: { model: 'anthropic/claude-sonnet-5.5', endpoint: CHAT_COMPLETIONS },
	conversant: { model: '~anthropic/claude-sonnet-latest:online', endpoint: CHAT_COMPLETIONS },
	titler: { model: 'openai/gpt-oss-120b', endpoint: CHAT_COMPLETIONS },
	agent: { model: 'openai/gpt-6-luna', endpoint: CHAT_COMPLETIONS },
	// Jev, a structured decision model (not an LLM): takes state + typed questions, returns typed answers.
	decider: { model: '~typesafe/jev-latest', endpoint: DECISIONS },
};

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/health') {
			return new Response('I am alive!');
		}
		if (path === '/llm' && request.method === 'POST') {
			return handleLlmRequest(request, env);
		}
		return new Response('Not Found', { status: 404 });
	},
};

async function handleLlmRequest(request, env) {

	{/* format of expected request body:
	{
		"agentRole": "planner" | "supervisor" | "agent" | "conversant" | "titler" | "decider" | ...,
		"payload": { ... }  // the OpenRouter request body, without `model`
	}
	*/}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response('Body must be JSON.', { status: 400 });
	}
	const { agentRole, payload } = body ?? {};

	const role = ROLES[agentRole];
	if (!role) {
		return new Response('Invalid role specified.', { status: 400 });
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return new Response('payload must be an object.', { status: 400 });
	}

	// The model is chosen here, never by the client: drop any fallback list it sent too.
	const { models, ...rest } = payload;

	const upstream = await fetch(role.endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		body: JSON.stringify({ ...rest, model: role.model }),
	});

	// Passed through untouched, streams included.
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
			'Cache-Control': 'no-cache',
		},
	});
}
