# Testing MeterX402 with Claude

This demonstrates how Claude (or any LLM) can discover and use pay-per-use APIs through the MeterX402 connector.

## 🎯 How It Works

1. **Claude asks user:** "Find LLM text generation services on MeterX402"
2. **Claude calls tool:** `list_meterx402_services` with `capability=text_generation`
3. **Connector returns:** List of available LLM services with prices and reputation
4. **Claude shows user:** The services found, with prices per 1000 tokens
5. **User picks one:** "Use the Groq LLM to write a haiku"
6. **Claude calls tool:** `call_meterx402_service` with the request
7. **Service executes:** Generates the haiku and meters token usage
8. **Claude receives:** The haiku + payment receipt showing exact cost
9. **Claude tells user:** Here's your haiku, and you paid 0.0023 HBAR for 127 tokens

## 🔧 Example Conversation Flow

```
User: Find LLM services on MeterX402

Claude: Let me search for LLM text generation services.
        [calls list_meterx402_services with capability="text_generation"]

Claude: I found 1 LLM service:

        📝 Open-source LLM (gpt-oss-20b on Groq)
        Price: 0.01 HBAR per 1000 tokens
        Capabilities: text_generation
        Reputation: Not yet rated

        This means if you generate a 100-token response, you'd pay
        0.001 HBAR (about $0.000035 USD).

        Would you like to use it?

User: Yes, write me a haiku about blockchain payments

Claude: [calls call_meterx402_service with the prompt]

        Here's your haiku:

        "Tokens flow like streams
        Metered drops, precise and fair
        Pay for what you use"

        💰 Payment Receipt:
        - Service: Groq LLM
        - Tokens used: 23
        - Price: 0.00023 HBAR ($0.000008 USD)
        - Transaction ID: 0.0.12345@1234567890.123456789
        - Verified on Hedera testnet
```

## 🚀 Testing Options

### Option 1: Test with Claude API (Recommended)

If you have an Anthropic API key:

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Make sure connector and hub are running
# Terminal 1: npm start (hub on :4021)
# Terminal 2: cd packages/universal-connector && npm start (connector on :3402)

# Run the test
node test-claude.mjs
```

### Option 2: Test with Claude Code (Current Session)

You're already using Claude Code! The MCP tools are built-in. Try:

```
"Find weather services on MeterX402"
"Get the weather for London"
```

### Option 3: Test via curl (Manual)

```bash
# List services
curl -s 'http://localhost:3402/services?capability=text_generation' | jq

# Call a service
curl -s -X POST http://localhost:3402/call \
  -H 'Content-Type: application/json' \
  -d '{
    "service_id": "llm",
    "method": "POST",
    "path": "/",
    "request_body": "{\"prompt\":\"Hello world\",\"max_tokens\":20}",
    "max_price": 0.05
  }' | jq
```

## 🌐 Testing with Other LLMs

The same connector works with all LLMs:

### ChatGPT Custom GPT
- URL: https://chat.openai.com/gpts/editor
- OpenAPI: Use `openapi-ngrok.json` with ngrok URL
- Status: ✅ Ready to test

### Gemini (Google AI Studio)
- URL: https://makersuite.google.com/
- Import: OpenAPI spec from connector
- Functions: list_meterx402_services, call_meterx402_service

### Grok (via API)
```javascript
const response = await fetch('https://api.x.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${XAI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'grok-beta',
    messages: [{ role: 'user', content: 'Find APIs on MeterX402' }],
    tools: [/* tools from openapi-ngrok.json */]
  })
});
```

### Perplexity
```python
import requests

response = requests.post('https://api.perplexity.ai/chat/completions',
  headers={'Authorization': f'Bearer {PERPLEXITY_API_KEY}'},
  json={
    'model': 'pplx-7b-online',
    'messages': [{'role': 'user', 'content': 'Find weather APIs'}],
    'tools': [/* from OpenAPI spec */]
  }
)
```

## 📊 What Makes This Universal?

1. **One API, All LLMs**: Every platform uses the same HTTP endpoints
2. **Standard OpenAPI**: No custom protocols, just REST + OpenAPI 3.1
3. **Framework Agnostic**: Works with LangChain, direct API calls, custom code
4. **Self-Hosted**: Run locally or deploy to cloud
5. **Zero Lock-In**: Switch LLM platforms without changing your API setup

## 🎁 Benefits for AI Agents

- **Autonomous Discovery**: Agents find services by capability, not hardcoded URLs
- **Budget Control**: Set max_price per call to prevent runaway costs
- **Verifiable Payments**: Every receipt includes Hedera transaction proof
- **Reputation Scoring**: Agents choose services based on settlement history
- **Streaming Support**: Pay as tokens arrive, cancel anytime

## 🔐 Current Setup

- **Hub**: http://localhost:4021 (service registry + payment settlement)
- **Connector**: http://localhost:3402 (universal REST API for all LLMs)
- **ngrok**: https://nondisbursed-displeasureably-miles.ngrok-free.dev (public HTTPS)
- **OpenAPI**: Available at /openapi.json on both localhost and ngrok

## 📝 Next Steps

1. **Test with Claude API**: Run `test-claude.mjs` if you have API key
2. **Test with ChatGPT**: Use Custom GPT with ngrok URL
3. **Deploy to Cloud**: Host connector publicly for permanent access
4. **Add More Services**: Deploy your own APIs with `npm run demo`
5. **Production Ready**: Switch from testnet to mainnet for real payments
