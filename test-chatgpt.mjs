// Test MeterX402 connector with ChatGPT function calling
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const CONNECTOR_URL = 'http://localhost:3402';

// Define tools based on our OpenAPI spec
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_meterx402_services',
      description: 'List available pay-per-use services on MeterX402. Browse services by capability, price, and reputation.',
      parameters: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            description: 'Filter by capability (e.g., weather_forecast, text_generation, llm_inference)'
          },
          q: {
            type: 'string',
            description: 'Search query'
          },
          maxPrice: {
            type: 'number',
            description: 'Maximum price filter'
          },
          minReputation: {
            type: 'number',
            description: 'Minimum reputation score (0-100)'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'call_meterx402_service',
      description: 'Call a pay-per-use service on MeterX402 and pay for actual usage',
      parameters: {
        type: 'object',
        required: ['service_id'],
        properties: {
          service_id: {
            type: 'string',
            description: 'Service identifier from list_meterx402_services'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST'],
            description: 'HTTP method',
            default: 'GET'
          },
          path: {
            type: 'string',
            description: 'API path and query string'
          },
          request_body: {
            type: 'string',
            description: 'Request body for POST requests (JSON string)'
          },
          max_units: {
            type: 'number',
            description: 'Cap the work (e.g., max tokens, max rows)'
          },
          max_price: {
            type: 'number',
            description: 'Maximum price in HBAR'
          }
        }
      }
    }
  }
];

// Handle function calls
async function handleFunctionCall(name, args) {
  console.log(`\n📞 Function call: ${name}`);
  console.log(`   Args: ${JSON.stringify(args, null, 2)}`);

  if (name === 'list_meterx402_services') {
    const params = new URLSearchParams();
    if (args.capability) params.set('capability', args.capability);
    if (args.q) params.set('q', args.q);
    if (args.maxPrice) params.set('maxPrice', args.maxPrice.toString());
    if (args.minReputation) params.set('minReputation', args.minReputation.toString());

    const url = `${CONNECTOR_URL}/services?${params}`;
    const response = await fetch(url);
    const data = await response.json();

    console.log(`   ✅ Found ${data.services.length} services`);
    return JSON.stringify(data);
  }

  if (name === 'call_meterx402_service') {
    const response = await fetch(`${CONNECTOR_URL}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    const data = await response.json();

    console.log(`   ✅ Call completed: ${data.success ? 'success' : 'failed'}`);
    if (data.receipt) {
      console.log(`   💰 Paid: ${data.receipt.amount} ${data.receipt.currency}`);
    }
    return JSON.stringify(data);
  }

  return JSON.stringify({ error: 'Unknown function' });
}

// Run conversation
async function testConversation() {
  console.log('🤖 Testing MeterX402 with ChatGPT\n');

  const messages = [
    {
      role: 'user',
      content: 'Find LLM text generation services on MeterX402 with reputation above 80'
    }
  ];

  console.log(`👤 User: ${messages[0].content}\n`);

  let response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: messages,
    tools: tools,
    tool_choice: 'auto'
  });

  let assistantMessage = response.choices[0].message;

  // Handle function calls
  while (assistantMessage.tool_calls) {
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await handleFunctionCall(toolCall.function.name, args);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result
      });
    }

    // Get next response
    response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: messages,
      tools: tools,
      tool_choice: 'auto'
    });

    assistantMessage = response.choices[0].message;
  }

  console.log(`\n🤖 ChatGPT: ${assistantMessage.content}\n`);
  console.log('✅ Test completed!');
}

// Check API key
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Error: OPENAI_API_KEY environment variable not set');
  console.error('   Set it with: export OPENAI_API_KEY=sk-...');
  process.exit(1);
}

testConversation().catch(console.error);
