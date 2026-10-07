export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/health') {
			return new Response('I am alive!');
		}
		if (path === '/chat' && request.method === 'POST') {
			return handleChatRequest(request, env);
		}
		if (path === '/computer' && request.method === 'POST') {
			return handleComputerRequest(request, env);
		}
		if (path === '/agent' && request.method === 'POST') {
			return handleAgentRequest(request, env);
		}
		return new Response('Not Found', { status: 404 });

	},	

};

async function handleChatRequest(request, env) {

	{/* format of expected request body:
	{
		"agentRole": "planner" | "interpreter" | "reader" | "supervisor" | "conversant" | "titler",
		"messages": [ { "role": "user" | "system", "content": "..." }, ... ],
		"imageUrl": "...",  // optional
		"tools": [ ... ]     // optional, overrides the default (label-based) tools
	}
	"dispatcher" is not an LLM and takes a different body, see handleDispatcherRequest.
	*/}

	const { agentRole, messages, imageUrl, state, questions } = await request.json();

	if (agentRole === 'dispatcher') {
		return handleDispatcherRequest(state, questions, env);
	}

	if (!agentRole || !messages) {
		return new Response('agentRole and messages are required.', { status: 400 });
	}
	if (!Array.isArray(messages)) {
		return new Response('messages must be an array.', { status: 400 });
	}

	let model;
	if (agentRole === 'planner') {
		model = 'anthropic/claude-sonnet-5.5';
	} else if (agentRole === 'interpreter') {
		model = '~openai/gpt-mini-latest';
	} else if (agentRole === 'reader') {
		model = '~openai/gpt-mini-latest';
	} else if (agentRole === 'supervisor') {
		model = 'anthropic/claude-sonnet-5.5';
	} else if (agentRole === 'conversant') {
		model = '~anthropic/claude-sonnet-latest:online';
	} else if (agentRole === 'titler') {
		model = 'openai/gpt-oss-120b';
	} else {
		return new Response('Invalid role specified.', { status: 400 });
	}

	const messagesPayload = messages.map(m => ({
		role: m.role,
		content: [{ type: "text", text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
	}));

	if (imageUrl) {
		messagesPayload.push({
			role: "user",
			content: [{ type: "image_url", image_url: { url: imageUrl } }]
		});
	}

	if (agentRole === 'conversant') {
		return handleConversantStreaming(messagesPayload, model, env);
	}

	// Titles are plain text (no JSON mode), and need little thinking, so keep it fast and cheap.
	const requestBody = agentRole === 'titler'
		? { model, messages: messagesPayload, reasoning: { effort: 'low' }, max_tokens: 300 }
		: { model, messages: messagesPayload, response_format: { type: "json_object" } };

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		body: JSON.stringify(requestBody),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(JSON.stringify({ error: `OpenRouter error: ${errorText}` }), {
			status: response.status,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const data = await response.json();

	let reply = '';
	if (data.choices && data.choices.length > 0) {
		reply = data.choices[0].message?.content || '';
	}

	return new Response(JSON.stringify({ reply }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handleDispatcherRequest(state, questions, env) {

	{/* format of expected request body:
	{
		"agentRole": "dispatcher",
		"state": { ... },       // any JSON describing the current situation
		"questions": {          // keyed by name, each one of: choice | noul | score
			"team": { "type": "choice", "instructions": "...", "criteria": { "a": "when a", "b": "when b" } },
			"is_bug": { "type": "noul", "instructions": "...", "criteria": { "true": "...", "false": "..." } },
			"urgency": { "type": "score", "instructions": "...", "criteria": ["low", "mid", "high"] }
		}
	}
	*/}

	if (!state || typeof state !== 'object') {
		return new Response('state must be an object for the dispatcher.', { status: 400 });
	}
	if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
		return new Response('questions must be a non-empty object for the dispatcher.', { status: 400 });
	}

	const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		body: JSON.stringify({ model: '~typesafe/jev-latest', state, questions }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(JSON.stringify({ error: `OpenRouter error: ${errorText}` }), {
			status: response.status,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const data = await response.json();
	return new Response(JSON.stringify({ answers: data.answers, model: data.model, usage: data.usage }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

async function handleConversantStreaming(messagesPayload, model, env) {
	const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		body: JSON.stringify({ model, messages: messagesPayload, stream: true }),
	});

	if (!upstream.ok) {
		const errorText = await upstream.text();
		return new Response(JSON.stringify({ error: `OpenRouter error: ${errorText}` }), {
			status: upstream.status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let buffer = '';

	const { readable, writable } = new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const payload = line.slice(6).trim();
				if (payload === '[DONE]') {
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					continue;
				}
				try {
					const parsed = JSON.parse(payload);
					const delta = parsed.choices?.[0]?.delta?.content;
					if (delta != null) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
					}
				} catch (_) {}
			}
		},
	});

	upstream.body.pipeTo(writable).catch(() => {});

	return new Response(readable, {
		status: 200,
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
		},
	});
}

async function handleComputerRequest(request, env) {

	{/* format of expected request body:
	{
		"goal": "string",                     // required
		"imageUrl": "string",        // optional
		"displayWidth": 1024,                // optional, default 1024
		"displayHeight": 768,                // optional, default 768
		"environment": "browser"             // optional, default "browser"
	}
	*/}


	const body = await request.json();
	const {
  	  	goal,
  	  	imageUrl,   // Optional
  	  	displayWidth = 1024, //default value
  	  	displayHeight = 768, //default value	
  	  	environment = "browser"
  	} = body;

	if (!goal) {
		return new Response('Goal is required.', { status: 400 });
	}

	let messageContent = [{type:"text", text:goal}];
	if (imageUrl) {
		messageContent.push({type:"image_url", image_url: { url: imageUrl }});
	}
	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		body: JSON.stringify({
			model: "computer-use-preview",
      		tools: [
      		  {
      		    type: "computer_use_preview",
      		    display_width: displayWidth,
      		    display_height: displayHeight,
      		    environment
      		  }
      		],
      		messages: [
      		  {
      		    role: "user",
      		    content: messageContent
      		  }
      		]
		})
	})

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(JSON.stringify({ error: `OpenRouter error: ${errorText}` }), { 
			status: response.status,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const data = await response.json();
	const output = data.output ?? data;
	return new Response(JSON.stringify(output), { status: 200, headers: { 'Content-Type': 'application/json' } });

}

async function handleAgentRequest(request, env) {

	{/* format of expected request body:
	{
		"messages": [ { "role": "user" | "system", "content": "..." }, ... ],
		"imageUrl": "..."  // optional
	}
	*/}

	const { messages, imageUrl, tools: clientTools } = await request.json();

	if (!messages) {
		return new Response('messages are required.', { status: 400 });
	}
	if (!Array.isArray(messages)) {
		return new Response('messages must be an array.', { status: 400 });
	}

	const model = "openai/gpt-6-luna";

	const messagesPayload = buildCachedMessages(messages);

	if (imageUrl) {
		messagesPayload.push({
			role: "user",
			content: [{ type: "image_url", image_url: { url: imageUrl } }]
		});
	}

	// Default tools target elements by the numbered labels the browser draws on the
	// screenshot (one per interactive element). Clients can send their own `tools`
	// to override them, e.g. the browser's legacy grid-coordinate tools.
	const defaultTools = [
		{
			type: "function",
			function: {
				name: "click",
				description: "Click an interactive element, identified by the number label drawn on it in the screenshot.",
				parameters: {
					type: "object",
					properties: {
						label: { type: "string", description: "The number label of the element to click, e.g. \"12\"." },
						click_count: { type: "integer", description: "1 for a single click, 2 for a double click. Defaults to 1." },
						explanation: { type: "string", description: "one tiny sentence describing what you just clicked." },
						note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
					},
					required: ["label"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "type",
				description: "Input text into the currently focused field. Click the field first if it is not focused.",
				parameters: {
					type: "object",
					properties: {
						text: { type: "string", description: "The text to input." },
						press_enter: { type: "boolean", description: "Press Enter after typing, e.g. to submit a search. Defaults to false." },
						explanation: { type: "string", description: "one tiny sentence describing what you just typed." },
						note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
					},
					required: ["text"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "keypress",
				description: "Simulate a key press.",
				parameters: {
					type: "object",
					properties: {
						key: { type: "string", description: "The key to press. Use special names for non-character keys, e.g. 'Enter', 'Tab', 'ArrowDown'." },
						explanation: { type: "string", description: "one tiny sentence describing what you just did with the key press." },
						note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
					},
					required: ["key"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "navigate",
				description: "Navigate to a specific URL.",
				parameters: {
					type: "object",
					properties: {
						url: { type: "string", description: "The URL to navigate to. Use an existing tab's url to navigate to it. return \"back\" if you want to go back." },
						new_tab: { type: "boolean", description: "Whether to open the URL in a new tab or not." },
						explanation: { type: "string", description: "one tiny sentence describing why you are navigating there." },
						note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
					},
					required: ["url"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "scroll",
				description: "Scroll the page, or a scrollable element on it.",
				parameters: {
					type: "object",
					properties: {
						direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Which way to scroll." },
						amount: { type: "number", description: "How far to scroll, as a fraction of the screen. 0.5 = half a screen, 1 = a full screen. Defaults to 0.75." },
						label: { type: "string", description: "Optional. Label of an element inside the scrollable area you want to scroll (e.g. a sidebar or list). Omit to scroll the main page." },
						explanation: { type: "string", description: "one tiny sentence describing why you are scrolling there." },
						note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
					},
					required: ["direction"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "wait",
				description: "Wait for a specific ammount of time. Use this if an action is still in progress and you want to avoid interupting it.",
				parameters: {
					type: "object",
					properties: {
						seconds: { type: "integer", description: "The number of seconds to wait." },
						explanation: { type: "string", description: "one tiny sentence describing why you need to wait." },
						note: { type: "string", description: "A short log line saved to your notepad (your memory) as part of this action. Fill it in on nearly every action: what you saw, what you decided and why, what is done, what you already checked (e.g. \"Checked the whole cart: only AAA batteries + Oreos, nothing extra\"). Leave empty only if this step taught you nothing new." },
					},
					required: ["seconds"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "warn",
				description:"detect if the very next step is a sensitive action like login, payments, posting in public and so on and warn the user. Only warn at the last moment possible and only if you absolutely cannot proceed even a step further.",
				parameters: {
					type: "object",
					properties: {
						message: { type: "string", description: "The warning message to show the user." },
					},
					required: ["message"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "write_notes",
				description: "Save something to your notepad (short-term memory). You forget what was on a page once you leave it, so note anything you will need later: information you found, options you are comparing (price, rating) and your current best pick, constraints like minimum quantities, and which steps are done. Your notes are shown back to you in every later step.",
				parameters: {
					type: "object",
					properties: {
						text: { type: "string", description: "The text to save. With mode \"edit\": the new text that takes the place of `find` (an empty string deletes it)." },
						mode: { type: "string", enum: ["append", "replace", "edit"], description: "\"append\" adds to the end of your notes (default). \"edit\" overwrites one part: the exact text given in `find` is replaced by `text` — use it to update a fact, tick off a plan step or delete an outdated line without rewriting everything. \"replace\" overwrites all of your notes, e.g. to tidy up." },
						find: { type: "string", description: "Only for mode \"edit\": the exact text in your notepad to overwrite, copied character for character. Include enough of it to be unique (e.g. a whole line)." },
						explanation: { type: "string", description: "one tiny sentence describing what you are noting down." },
					},
					required: ["text"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "read_notes",
				description: "Read your full notepad. Only needed when your notes are too long to be shown to you automatically.",
				parameters: {
					type: "object",
					properties: {
						explanation: { type: "string", description: "one tiny sentence describing why you are reading your notes." },
					},
					required: []
				}
			}
		},
		{
			type: "function",
			function: {
				name: "get_tips",
				description: "Ask for task-specific tips when you are stuck or looping on something (e.g. topic \"shopping\" when a cart quantity won't go down). The tips are then shown to you in every later step. Unknown topics return the list of available ones.",
				parameters: {
					type: "object",
					properties: {
						topic: { type: "string", description: "The tip topic id, e.g. \"shopping\"." },
						explanation: { type: "string", description: "one tiny sentence describing why you need the tips." },
					},
					required: ["topic"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "change_step_delay",
				description: "Change the wait before each of your steps for the rest of the task. Raise it when the page needs time to react between your actions (e.g. an opponent's move in a board game, slow loading); lower it (0 for none) when no waiting is needed anymore. The screenshot is taken after this wait.",
				parameters: {
					type: "object",
					properties: {
						seconds: { type: "number", description: "Seconds to wait before each step, 0 to 120." },
						reason: { type: "string", description: "Short reason for the new delay." },
						explanation: { type: "string", description: "one tiny sentence describing why you are changing the delay." },
					},
					required: ["seconds"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "final_answer",
				description: "Conclude the agent execution with a final answer to the user's original query/ task. Use this when you feel you have completed the entire task to a reasonable level.",
				parameters: {
					type: "object",
					properties: {
						answer: { type: "string", description: "The final answer for the user, written in plain natural language (Markdown like bullet points is fine): a short summary of what you did and found. Never JSON or any other data format." },
					},
					required: ["answer"]
				}
			}
		}
	];
	const tools = Array.isArray(clientTools) && clientTools.length > 0 ? clientTools : defaultTools;

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		// Every agent step must be a tool call. (JSON mode isn't used here: it made the model
		// write even the user-facing final_answer text as JSON.)
		body: JSON.stringify({ model, messages: messagesPayload, tools, tool_choice: "required" }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(JSON.stringify({ error: `OpenRouter error: ${errorText}` }), { 
			status: response.status,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const data = await response.json();
	const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
	console.log(`agent usage: prompt=${data.usage?.prompt_tokens ?? '?'} cached=${cachedTokens} completion=${data.usage?.completion_tokens ?? '?'}`);

	let replyText = '';
	let toolCall = null;
	const message = data.choices?.[0]?.message;

	if (message) {
		replyText = message.content || '';
		if (message.tool_calls && message.tool_calls.length > 0) {
			const tf = message.tool_calls[0].function;
			if (tf) {
				toolCall = { name: tf.name, arguments: tf.arguments };
			}
		}
	}

	return new Response(JSON.stringify({
		reply: replyText,
		tool: toolCall,
		usage: data.usage ?? null,
	}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Converts client messages to OpenRouter content-part messages, with prompt caching.
 * A message sent with `cache: true` gets an Anthropic `cache_control` breakpoint, so
 * everything up to and including it (tools + that prompt) is cached and reused across
 * steps. Consecutive system messages are merged into one multi-part system message so
 * a static, cached prompt can be followed by per-step system text without busting the cache.
 */
function buildCachedMessages(messages) {
	const out = [];
	for (const m of messages) {
		const part = { type: "text", text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
		if (m.cache) part.cache_control = { type: "ephemeral" };
		const prev = out[out.length - 1];
		if (m.role === 'system' && prev?.role === 'system') {
			prev.content.push(part);
		} else {
			out.push({ role: m.role, content: [part] });
		}
	}
	return out;
}