// Test MeterX402 connector with Claude API
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const CONNECTOR_URL = 'http://localhost:3402';

// Define tools based on our OpenAPI spec
const tools = [
  {
    name: 'list_meterx402_services',
    description: 'List available pay-per-use services on MeterX402. Browse services by capability, price, and reputation. Use this to discover APIs and AI services before calling them.',
    input_schema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Filter by capability (e.g., weather_forecast, text_generation, llm_inference, image_generation)'
        },
        q: {
          type: 'string',
          description: 'Search query to find specific services'
        },
        maxPrice: {
          type: 'number',
          description: 'Maximum price filter in HBAR'
        },
        minReputation: {
          type: 'number',
          description: 'Minimum reputation score (0-100)'
        }
      }
    }
  },
  {
    name: 'call_meterx402_service',
    description: 'Call a pay-per-use service on MeterX402 and pay for actual usage. You will receive the result along with a payment receipt showing the exact metered cost.',
    input_schema: {
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
          description: 'API path and query string (e.g., "/?latitude=51.5&longitude=-0.1")'
        },
        request_body: {
          type: 'string',
          description: 'Request body for POST requests (JSON string)'
        },
        max_units: {
          type: 'number',
          description: 'Cap the work (e.g., max tokens for LLM, max rows for data)'
        },
        max_price: {
          type: 'number',
          description: 'Maximum price in HBAR to prevent overspending'
        }
      }
    }
  }
];

// Handle tool calls
async function handleToolCall(name, input) {
  console.log(`\n🔧 Tool call: ${name}`);
  console.log(`   Input: ${JSON.stringify(input, null, 2)}`);

  if (name === 'list_meterx402_services') {
    const params = new URLSearchParams();
    if (input.capability) params.set('capability', input.capability);
    if (input.q) params.set('q', input.q);
    if (input.maxPrice) params.set('maxPrice', input.maxPrice.toString());
    if (input.minReputation) params.set('minReputation', input.minReputation.toString());

    const url = `${CONNECTOR_URL}/services?${params}`;
    const response = await fetch(url);
    const data = await response.json();

    console.log(`   ✅ Found ${data.services.length} services`);
    return data;
  }

  if (name === 'call_meterx402_service') {
    const response = await fetch(`${CONNECTOR_URL}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const data = await response.json();

    console.log(`   ✅ Call completed: ${data.success ? 'success' : 'failed'}`);
    if (data.receipt) {
      console.log(`   💰 Paid: ${data.receipt.amount} ${data.receipt.currency}`);
    }
    return data;
  }

  return { error: 'Unknown tool' };
}

// Run conversation with Claude
async function testConversation() {
  console.log('🤖 Testing MeterX402 with Claude API\n');

  const messages = [
    {
      role: 'user',
      content: 'Find LLM text generation services on MeterX402 with reputation above 80'
    }
  ];

  console.log(`👤 User: ${messages[0].content}\n`);

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    tools: tools,
    messages: messages
  });

  console.log(`\n💭 Claude (stop_reason: ${response.stop_reason})`);

  // Handle tool use loop
  while (response.stop_reason === 'tool_use') {
    // Add assistant's response to messages
    messages.push({
      role: 'assistant',
      content: response.content
    });

    // Execute all tool calls
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await handleToolCall(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result)
        });
      }
    }

    // Add tool results to messages
    messages.push({
      role: 'user',
      content: toolResults
    });

    // Get next response
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      tools: tools,
      messages: messages
    });

    console.log(`\n💭 Claude (stop_reason: ${response.stop_reason})`);
  }

  // Extract final text response
  const textContent = response.content.find(block => block.type === 'text');
  if (textContent) {
    console.log(`\n🤖 Claude: ${textContent.text}\n`);
  }

  console.log('✅ Test completed!');
}

// Check API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Error: ANTHROPIC_API_KEY environment variable not set');
  console.error('   Set it with: export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

testConversation().catch(console.error);
