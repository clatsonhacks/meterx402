# Consumer UX plan

The first UI was accurate, but it spoke the protocol's language: "rows:hourly.time", "0.0001 HBAR
/ row", "A2A · MCP · SDK", "96.2/100", a Try-it form asking for a method and a path, and responses
shown as raw JSON. That works for developers. A consumer should be able to land on the page,
understand it in five seconds, get something useful in thirty, and know exactly what they paid
and why.

## Principles
1. **Say what it does, not how it works.** Use "Weather Forecast · $0.00002 per forecast hour",
   not "weather · rows:hourly.time".
2. **Show money in familiar terms.** Put an approximate dollar amount next to every HBAR amount,
   and phrase tiny totals as "less than a cent".
3. **The spending limit is the product.** Usage pricing is only safe when you control the
   ceiling, so the limit is always visible and set once.
4. **Show results, not payloads.** A forecast is a chart, a chat reply is a chat bubble, and
   transactions are a list. Raw JSON is one click away.
5. **Protocol detail is opt-in.** The lifecycle steps, hashes and interfaces sit behind "What
   happened" and a Developers tab. They are hidden, not removed.
6. **Be honest about testnet.** It's a demo wallet with test HBAR and no real money, so say so
   wherever money appears.

## Ideas, and what this pass builds

| # | Idea | Built now? |
|---|---|---|
| 1 | **Home that explains itself.** A hero ("Pay only for what you use"), one search box, category tiles (Weather, AI, Crypto, Blockchain…), and a dismissible "How it works" strip: find → set a limit → pay for exactly what you get | ✅ |
| 2 | **Friendly service cards.** Category icon, a real title, one line on what it does, the price per human unit with ≈ USD, a trust label (Excellent / Good / New), and a single "Try it" button | ✅ |
| 3 | **Descriptor `title` and `unit_label`.** Services name themselves ("Weather Forecast", "forecast hour") instead of the UI guessing. Optional, backward-compatible protocol fields | ✅ |
| 4 | **Price calculator on every service.** A slider for how much you'd use, the live price, and what a flat-priced API would charge for the same call | ✅ |
| 5 | **Task-shaped "Try it".** AI gets a chat box with example prompts and streaming, weather gets a city picker and day count, Ethereum gets an address box, crypto gets a coin count. Anything else gets a generic request editor | ✅ |
| 6 | **A pay sheet like a checkout.** "Pay 0.0024 HBAR (≈ $0.0005) for 24 forecast hours", with Pay or Cancel. Nothing is charged if you cancel | ✅ |
| 7 | **Auto-pay under my limit.** Opt in once, and any quote within your per-request limit is paid without a prompt | ✅ |
| 8 | **Rendered results.** A temperature chart, a chat bubble, a transaction list, a price table, and auto-tables for any list of records. "Raw response" stays available | ✅ |
| 9 | **Receipt card.** Paid · what for · "Verified: you were charged for exactly what you received" · saved versus flat · a HashScan link. The step timeline sits under "What happened" | ✅ |
| 10 | **Wallet in the top bar.** Balance (≈ USD), account, a testnet label, spending limits (per request, per session) and the auto-pay switch | ✅ |
| 11 | **Activity tab.** Everything you paid for, with totals (spent, uses, saved versus flat), verification and chain links | ✅ |
| 12 | **Developers tab.** The playground and "for AI agents" snippets move out of the consumer path into one place | ✅ |
| 13 | **Sell-your-API wizard (Deployer).** 1 Connect → 2 Price (plain-language unit, editable rate, example costs, versus flat) → 3 Get paid → a success screen with a link to the listing | ✅ |
| 14 | **Earnings in a sentence.** "You've earned 0.068 HBAR (≈ $0.01) from 16 paid uses" above the seller dashboard | ✅ |
| 15 | Toasts, skeleton loading, empty states that say what to do next, a mobile layout, focus states | ✅ |
| 16 | Connect your own wallet (HashPack / WalletConnect) instead of the demo wallet | later |
| 17 | Prepaid balance ("top up once, use any service") on Metered Tabs | later |
| 18 | Favourites, recently used, and "people also used" | later |
| 19 | Human ratings and reviews, allowed only from buyers with a receipt for that service | later |
| 20 | Low-balance and big-spend notifications, and a monthly spending chart | later |
| 21 | Local currency selector and i18n | later |
| 22 | Testnet faucet button for new users | later |

## Notes
- USD comes from a hub endpoint (`/fx`) that caches CoinGecko's HBAR price for 10 minutes.
  Offline, or if CoinGecko is unreachable, the UI shows HBAR only and never guesses.
- Limits and auto-pay are per-browser settings. The server still enforces the hub buyer's
  per-call cap and budget. The UI limit is sent with every payment as `maxPrice`, so a quote above
  it is refused before anything is signed.
- Services that only offer rows or bytes are still fine: the generic Try-it and the auto-table
  renderer cover any JSON API.
