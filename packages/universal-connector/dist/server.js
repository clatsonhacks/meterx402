// packages/universal-connector/src/server.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
var app = new Hono();
app.use("/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"]
}));
var HUB_URL = process.env.HUB_URL || "http://localhost:4021";
app.get("/health", (c) => c.json({ status: "ok", service: "meterx402-connector" }));
app.get("/services", async (c) => {
  const capability = c.req.query("capability");
  const query = c.req.query("q");
  const maxPrice = c.req.query("maxPrice");
  const minReputation = c.req.query("minReputation");
  const params = new URLSearchParams();
  if (capability) params.set("capability", capability);
  if (query) params.set("q", query);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (minReputation) params.set("minReputation", minReputation);
  const response = await fetch(`${HUB_URL}/registry/services?${params}`);
  const data = await response.json();
  return c.json({
    services: data.services.map((s) => ({
      id: s.service_id,
      name: s.descriptor.name,
      description: s.descriptor.description,
      capabilities: s.descriptor.capabilities,
      price: {
        amount: s.price.rate,
        currency: s.price.currency,
        unit: s.price.unit,
        per: s.price.per,
        typical_call: s.price.typical_call
      },
      reputation: s.reputation.score,
      interfaces: s.descriptor.interfaces
    }))
  });
});
app.get("/services/:id", async (c) => {
  const id = c.req.param("id");
  const response = await fetch(`${HUB_URL}/registry/services/${encodeURIComponent(id)}`);
  if (!response.ok) {
    return c.json({ error: `Service ${id} not found` }, 404);
  }
  return c.json(await response.json());
});
app.post("/call", async (c) => {
  const body = await c.req.json();
  const { service_id, method = "GET", path, request_body, max_units, max_price } = body;
  if (!service_id) {
    return c.json({ error: "service_id is required" }, 400);
  }
  const callPayload = {
    method,
    path,
    body: request_body,
    maxUnits: max_units,
    maxPrice: max_price
  };
  void callPayload;
  return c.json({
    success: false,
    error: "Paying needs your own testnet wallet. Run `npx mx402 connector` with BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY set: it serves this API (with /quote, /pay and /call) and signs with your key, inside your budget."
  }, 501);
});
app.get("/openapi.json", async (c) => {
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "MeterX402 Connector",
      version: "0.1.0",
      description: "Universal API connector for pay-per-use services on MeterX402"
    },
    servers: [
      { url: "http://localhost:3402", description: "Local development" },
      { url: "https://connector.meterx402.com", description: "Production" }
    ],
    paths: {
      "/services": {
        get: {
          summary: "List available services",
          description: "Browse pay-per-use services by capability, price, and reputation",
          operationId: "listServices",
          parameters: [
            {
              name: "capability",
              in: "query",
              schema: { type: "string" },
              description: "Filter by capability (e.g., weather_forecast, text_generation)"
            },
            {
              name: "q",
              in: "query",
              schema: { type: "string" },
              description: "Search query"
            },
            {
              name: "maxPrice",
              in: "query",
              schema: { type: "number" },
              description: "Maximum price filter"
            },
            {
              name: "minReputation",
              in: "query",
              schema: { type: "number" },
              description: "Minimum reputation score (0-100)"
            }
          ],
          responses: {
            "200": {
              description: "List of services",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      services: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            description: { type: "string" },
                            capabilities: { type: "array", items: { type: "string" } },
                            price: { type: "object" },
                            reputation: { type: "number" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/call": {
        post: {
          summary: "Call a service",
          description: "Call a pay-per-use service and pay for actual usage",
          operationId: "callService",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["service_id"],
                  properties: {
                    service_id: { type: "string", description: "Service identifier" },
                    method: { type: "string", enum: ["GET", "POST"], default: "GET" },
                    path: { type: "string", description: "API path and query string" },
                    request_body: { type: "string", description: "Request body for POST" },
                    max_units: { type: "number", description: "Cap the work (e.g., max tokens)" },
                    max_price: { type: "number", description: "Maximum price in HBAR" }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Service response with payment receipt",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      data: { type: "object" },
                      receipt: {
                        type: "object",
                        properties: {
                          amount: { type: "string" },
                          currency: { type: "string" },
                          units: { type: "number" },
                          unit_type: { type: "string" },
                          transaction_id: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});
var port = Number(process.env.PORT || 3402);
console.log(`\u{1F310} MeterX402 Universal Connector starting on :${port}`);
console.log(`   Hub: ${HUB_URL}`);
console.log(`   OpenAPI: http://localhost:${port}/openapi.json`);
console.log(`
\u2705 Ready for all LLMs: Claude, ChatGPT, Gemini, Grok, Perplexity`);
serve({
  fetch: app.fetch,
  port
});
//# sourceMappingURL=server.js.map
