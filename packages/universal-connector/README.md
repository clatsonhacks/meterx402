# @meterx402/universal-connector

🌐 **Universal AI Connector** - Connect MeterX402 to ANY LLM platform

Works with: **Claude** | **ChatGPT** | **Gemini** | **Grok** | **Perplexity** | **Any LLM**

## What is this?

A single connector that makes MeterX402's pay-per-use API marketplace available to ALL major LLM platforms. Instead of building separate plugins for each platform, this provides a unified REST API that works everywhere.

## Quick Start

### 1. Start the connector

```bash
npx @meterx402/universal-connector
```

This starts a local server on `http://localhost:3402` that any LLM can call.

### 2. Configure your LLM

Choose your platform:

<details>
<summary><b>💬 ChatGPT (Custom GPT)</b></summary>

1. Go to https://chat.openai.com/gpts/editor
2. Create new GPT
3. In "Configure" → "Actions":
   - Import schema: `http://localhost:3402/openapi.json`
   - Or paste the OpenAPI spec

Your GPT can now:
```
User: "Find weather services on MeterX402"
GPT: [Calls listServices with capability=weather_forecast]

User: "Get weather for London"
GPT: [Calls callService and shows result with payment receipt]
```

</details>

<details>
<summary><b>🤖 Claude (MCP)</b></summary>

Use the dedicated MCP server for best integration:

```bash
npm install -g @meterx402/mcp-server
```

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "meterx402": {
      "command": "meterx402-mcp"
    }
  }
}
```

Or use the universal connector via HTTP:
```json
{
  "mcpServers": {
    "meterx402": {
      "command": "npx",
      "args": ["@meterx402/mcp-server"]
    }
  }
}
```

</details>

<details>
<summary><b>✨ Gemini (Google AI Studio)</b></summary>

1. Go to https://makersuite.google.com/
2. Create new Function Calling app
3. Add functions using OpenAPI spec from `http://localhost:3402/openapi.json`

Or use directly in code:
```python
import google.generativeai as genai

tools = [
    {
        "function_declarations": [{
            "name": "list_meterx402_services",
            "description": "List pay-per-use services",
            "parameters": {
                "type": "object",
                "properties": {
                    "capability": {"type": "string"}
                }
            }
        }]
    }
]

model = genai.GenerativeModel('gemini-pro', tools=tools)
```

</details>

<details>
<summary><b>𝕏 Grok (via API)</b></summary>

Use function calling with Grok API:

```javascript
const response = await fetch('https://api.x.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${XAI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'grok-beta',
    messages: [{ role: 'user', content: 'Find weather services' }],
    tools: [{
      type: 'function',
      function: {
        name: 'list_meterx402_services',
        description: 'List MeterX402 services',
        parameters: { /* from OpenAPI */ }
      }
    }],
    tool_choice: 'auto'
  })
});
```

</details>

<details>
<summary><b>🔍 Perplexity</b></summary>

Use with Perplexity API's function calling:

```python
import requests

response = requests.post('https://api.perplexity.ai/chat/completions',
    headers={'Authorization': f'Bearer {PERPLEXITY_API_KEY}'},
    json={
        'model': 'pplx-7b-online',
        'messages': [{'role': 'user', 'content': 'Find APIs'}],
        'tools': [
            {
                'type': 'function',
                'function': {
                    'name': 'list_services',
                    'url': 'http://localhost:3402/services'
                }
            }
        ]
    }
)
```

</details>

<details>
<summary><b>🦙 Ollama / LangChain / Any Framework</b></summary>

Use as a standard REST API or LangChain tool:

```python
from langchain.tools import Tool

def list_meterx402_services(capability: str = None):
    url = f"http://localhost:3402/services"
    if capability:
        url += f"?capability={capability}"
    return requests.get(url).json()

tool = Tool(
    name="MeterX402Services",
    func=list_meterx402_services,
    description="List pay-per-use API services on MeterX402"
)
```

</details>

## API Endpoints

### `GET /services`
List available services

**Query Parameters:**
- `capability` - Filter by capability (e.g., `weather_forecast`, `text_generation`)
- `q` - Search query
- `maxPrice` - Maximum price
- `minReputation` - Minimum reputation score (0-100)

**Example:**
```bash
curl "http://localhost:3402/services?capability=weather_forecast"
```

### `GET /services/:id`
Get service details

**Example:**
```bash
curl "http://localhost:3402/services/weather-openmeteo"
```

### `POST /call`
Call a service

**Body:**
```json
{
  "service_id": "weather-openmeteo",
  "method": "GET",
  "path": "/?latitude=51.5&longitude=-0.1&current_weather=true",
  "max_price": 0.1
}
```

**Response:**
```json
{
  "success": true,
  "data": { "temperature": 15.2, "weathercode": 1 },
  "receipt": {
    "amount": "0.0096",
    "currency": "HBAR",
    "units": 48,
    "unit_type": "rows",
    "transaction_id": "0.0.12345@1234567890.123456789"
  }
}
```

### `GET /openapi.json`
Get OpenAPI specification

## Environment Variables

```bash
HUB_URL=http://localhost:4021    # MeterX402 hub
PORT=3402                          # Connector port
```

## Production Deployment

### Deploy to Cloud

```bash
# Fly.io
fly launch
fly deploy

# Railway
railway up

# Vercel/Netlify
# Use serverless function wrapper
```

### Docker

```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3402
CMD ["npm", "start"]
```

## How It Works

```
┌─────────────┐
│   ChatGPT   │────┐
└─────────────┘    │
┌─────────────┐    │    ┌──────────────────┐    ┌─────────────┐
│   Gemini    │────┼────│  Universal       │────│  MeterX402  │
└─────────────┘    │    │  Connector       │    │  Hub        │
┌─────────────┐    │    │  :3402           │    │  :4021      │
│    Grok     │────┘    └──────────────────┘    └─────────────┘
└─────────────┘              REST API                 Pay-per-use
                         (OpenAPI 3.1)              Services
```

1. **LLM makes standard HTTP call** - Each platform calls the same REST API
2. **Connector translates to MeterX402** - Unified interface to the hub
3. **Service executes & meters** - Actual work is measured
4. **Payment settles on Hedera** - Exact price paid via x402
5. **Receipt returned to LLM** - Verification proof included

## Advantages

✅ **One connector, all LLMs** - No separate plugins
✅ **Standard REST/OpenAPI** - Works anywhere
✅ **Easy to deploy** - Single Node.js process
✅ **Framework agnostic** - LangChain, direct API, custom code
✅ **Self-hosted** - Full control over your instance

## Cost

- **Connector**: Free (open source)
- **Service calls**: Pay-per-use (typically 0.001-0.1 HBAR per call)
- **Hosting**: Your choice (local, cloud, serverless)

## Links

- **Hub**: https://meterx402.com
- **GitHub**: https://github.com/clatsonhacks/meterx402
- **MCP Version**: https://npmjs.com/package/@meterx402/mcp-server

## License

MIT
