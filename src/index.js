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
		model = 'openai/gpt-5.2';
	} else if (agentRole === 'interpreter') {
		model = 'openai/gpt-4.1-mini';
	} else if (agentRole === 'reader') {
		model = 'openai/gpt-5-mini';
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

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		body: JSON.stringify({ model, messages: messagesPayload, response_format: { type: "json_object" } }),
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

	const { messages, imageUrl } = await request.json();

	if (!messages) {
		return new Response('messages are required.', { status: 400 });
	}
	if (!Array.isArray(messages)) {
		return new Response('messages must be an array.', { status: 400 });
	}

	const model = "openai/gpt-5.4";

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

	const tools = [
		{
			type: "function",
			function: {
				name: "click",
				description: "Click on a specific element in the UI.",
				parameters: {
					type: "object",
					properties: {
						x: { type: "string", description: "The column no of the element to click." },
						y: { type: "string", description: "The row no of the element to click." },
						click_count: { type: "string", description: "The number of times to click. Can be 1 for a single click, 2 for a double click, etc." },
						explanation: { type: "string", description: "one tiny sentence describing what you just clicked." },
					},
					required: ["x", "y"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "type",
				description: "Input text into a specific field in the UI.",
				parameters: {
					type: "object",
					properties: {
						text: { type: "string", description: "The text to input." },
						explanation: { type: "string", description: "one tiny sentence describing what you just typed." },
					},
					required: [ "text"]
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
					},
					required: ["url"]
				}
			}
		},
		{
			type: "function",
			function: {
				name: "scroll",
				description: "Scroll to a specific part of the page.",
				parameters: {
					type: "object",
					properties: {
						x: { type: "string", description: "The column no to anchor the scrolling to." },
						y: { type: "string", description: "The row no to anchor the scrolling to." },
						delta_x: { type: "string", description: "The no of columns to scroll by. Can be positive or negative. Horizontal scrolling is not used much." },
						delta_y: { type: "string", description: "The no of rows to scroll by. Can be positive or negative." },
						explanation: { type: "string", description: "one tiny sentence describing why you are scrolling there." },
					},
					required: ["x", "y", "delta_y"]
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
		}
	];

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.OpenRouter_API_KEY}`,
		},
		body: JSON.stringify({ model, messages: messagesPayload, tools, response_format: { type: "json_object" } }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(JSON.stringify({ error: `OpenRouter error: ${errorText}` }), { 
			status: response.status,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const data = await response.json();

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
	}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}