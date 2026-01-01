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
		return new Response('Not Found', { status: 404 });

	},

};

async function handleChatRequest(request, env) {
	let messagedata = await request.json();

	const { agentRole, messages, image_base64 } = messagedata;

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


	let response;
	if (image_base64) {
		// If an image is provided, use the Responses API which supports image inputs.
		// Convert chat messages into the Responses API input format, then append the image.
		const input = (messages || []).map(m => ({
			role: m.role,
			content: [{ type: "input_text", text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
		}));

		input.push({
			role: "user",
			content: [{ type: "input_image", image_base64 }]
		});

		response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model,
				input
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return new Response(`OpenAI API error: ${errorText}`, { status: response.status });
		}

		const data = await response.json();
		// Try common places where text output may be found in the Responses API reply.
		const reply =
			data.output_text ||
			(Array.isArray(data.output) && data.output.map(o => {
				if (typeof o === 'string') return o;
				if (o?.content) return o.content.map(c => c.text || '').join('');
				return '';
			}).join('\n')) ||
			JSON.stringify(data);

		const dataToReturn = { reply };
		return new Response(JSON.stringify(dataToReturn), { status: 200, headers: { 'Content-Type': 'application/json' } });
	} else {
		// No image: use the Chat Completions endpoint as before.
		response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: model,
				messages: messages
			}),
		});
	}

	if (!response.ok) {
		const errorText = await response.text();
		return new Response(`OpenAI API error: ${errorText}`, { status: response.status });
	}

	const data = await response.json();
	const reply = data.choices[0].message.content;

	const dataToReturn = {
		reply: reply,
	};
	return new Response(JSON.stringify(dataToReturn), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handleComputerRequest(request, env) {
	const body = await request.json();
	const {
  	  	goal,
  	  	screenshotBase64,   // Optional
  	  	displayWidth = 1024, //default value
  	  	displayHeight = 768, //default value	
  	  	environment = "browser"
  	} = body;

	if (!goal) {
		return new Response('Goal is required.', { status: 400 });
	}

	let inputContent = [{type:"input_text", text:goal}];
	if (screenshotBase64) {
		// use Responses content type for images
		inputContent.push({type:"input_image", image_base64:screenshotBase64});
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