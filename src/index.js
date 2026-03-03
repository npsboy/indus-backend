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
		"agentRole": "planner" | "interpreter" | "reader",
		"messages": [ { "role": "user" | "system", "content": "..." }, ... ],
		"imageUrl": "..."  // optional
	}
	*/}

	const { agentRole, messages, imageUrl } = await request.json();

	if (!agentRole || !messages) {
		return new Response('agentRole and messages are required.', { status: 400 });
	}
	if (!Array.isArray(messages)) {
		return new Response('messages must be an array.', { status: 400 });
	}

	let model;
	if (agentRole === 'planner') {
		model = 'gpt-5.2';
	} else if (agentRole === 'interpreter') {
		model = 'gpt-4.1-mini';
	} else if (agentRole === 'reader') {
		model = 'gpt-5-mini';
	} else {
		return new Response('Invalid role specified.', { status: 400 });
	}

	const input = messages.map(m => ({
		role: m.role,
		content: [{ type: "input_text", text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
	}));

	if (imageUrl) {
		input.push({
			role: "user",
			content: [{ type: "input_image", image_url: imageUrl }]
		});
	}

	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
		},
		body: JSON.stringify({ model, input }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(`OpenAI API error: ${errorText}`, { status: response.status });
	}

	const data = await response.json();

	let reply = '';
	if (Array.isArray(data.output)) {
		for (const item of data.output) {
			if (item.type === 'message') {
				for (const c of item.content || []) {
					if (c.type === 'output_text') reply += c.text || '';
				}
			}
		}
	}
	if (!reply) reply = data.output_text || (typeof data.content === 'string' ? data.content : '');

	return new Response(JSON.stringify({ reply, _raw: data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

	let inputContent = [{type:"input_text", text:goal}];
	if (imageUrl) {
		// use Responses content type for images
		inputContent.push({type:"input_image", image_url:imageUrl});
	}
	// use the Responses API for tool-enabled requests like Computer Use
	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
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
      		input: [
      		  {
      		    role: "user",
      		    content: inputContent
      		  }
      		],
      		reasoning: {
      		  summary: "concise"
      		},
      		truncation: "auto"
		})
	})

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(`OpenAI API error: ${errorText}`, { status: response.status });
	}

	const data = await response.json();
	// return output if present; otherwise return the full payload
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

	const { messages, imageUrl } = await request.json();

	if (!messages) {
		return new Response('messages are required.', { status: 400 });
	}
	if (!Array.isArray(messages)) {
		return new Response('messages must be an array.', { status: 400 });
	}

	const model = "gpt-5.2";

	const input = messages.map(m => ({
		role: m.role,
		content: [{ type: "input_text", text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
	}));

	if (imageUrl) {
		input.push({
			role: "user",
			content: [{ type: "input_image", image_url: imageUrl }]
		});
	}

	const tools = [
		{
			type: "function",
			name: "click",
			description: "Click on a specific element in the UI.",
			parameters: {
				type: "object",
				properties: {
					x: { type: "string", description: "The column no of the element to click." },
					y: { type: "string", description: "The row no of the element to click." },
					explanation: { type: "string", description: "one tiny sentence describing what you just clicked." },
				},
				required: ["x", "y"]
			}
		},
		{
			type: "function",
			name: "type",
			description: "Input text into a specific field in the UI.",
			parameters: {
				type: "object",
				properties: {
					x: { type: "string", description: "The column label of the field." },
					y: { type: "string", description: "The row label of the field." },
					text: { type: "string", description: "The text to input." },
					explanation: { type: "string", description: "one tiny sentence describing what you just typed." },
				},
				required: ["x", "y", "text"]
			}
		},
		{
			type: "function",
			name: "navigate",
			description: "Navigate to a specific URL.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "The URL to navigate to." },
					explanation: { type: "string", description: "one tiny sentence describing why you are navigating there." },
				},
				required: ["url"]
			}
		},
		{
			type: "function",
			name: "warn",
			description:"detect if the very next step is a sensitive action like login, payments, posting in public and so on and warn the user. Only warn at the last moment possible and only if you absolutely cannot proceed even a step further.",
			parameters: {
				type: "object",
				properties: {
					message: { type: "string", description: "The warning message to show the user." },
				},
				required: ["message"]
			}
		},
		{ 
			type: "function",
			name: "final_answer",
			description: "Conclude the agent execution with a final answer to the user's original query/ task. Use this when you feel you have completed the entire task to a reasonable level.",
			parameters: {
				type: "object",
				properties: {
					answer: { type: "string", description: "The final answer to the user's original question." },
				},
				required: ["answer"]
			}
		}
	];

	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
		},
		body: JSON.stringify({ model, input, tools, text: { format: { type: "json_object" } } }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(`OpenAI API error: ${errorText}`, { status: response.status });
	}

	const data = await response.json();

	let replyText = '';
	let toolCall = null;

	if (Array.isArray(data.output)) {
		for (const item of data.output) {
			if (item.type === 'message') {
				for (const c of item.content || []) {
					if (c.type === 'output_text') replyText += c.text || '';
				}
			}
			if (item.type === 'function_call') {
				toolCall = { name: item.name, arguments: item.arguments };
			}
		}
	}

	// fallbacks for alternate shapes
	if (!replyText) replyText = data.output_text || (typeof data.content === 'string' ? data.content : '');
	if (!toolCall && data.function_call) toolCall = { name: data.function_call.name, arguments: data.function_call.arguments };

	return new Response(JSON.stringify({
		reply: replyText,
		tool: toolCall,
	}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}