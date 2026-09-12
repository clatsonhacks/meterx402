// Create the MeterX402 service-credit token (HTS) with a protocol fee that the
// NETWORK collects, and set up the accounts that will use it.
//
//   npx tsx scripts/new-token.ts [--fee 2] [--supply 1000000] [--fund 1000]
//
// Why a token at all: prices in HBAR move with HBAR. A service credit is a
// stable unit of account for metering, and it is the honest answer to the
// volatility gap in our own "where this goes next".
//
// Why a CUSTOM FEE: the protocol's cut is expressed once, in the token's fee
// schedule, and consensus applies it to every transfer of that token forever.
// There is no fee-collection code anywhere in this repo, no contract, and no
// way for a seller to route around it — the ledger does it. The fee is
// INCLUSIVE (assessed out of the transferred amount), so the buyer signs and
// pays exactly the quoted price and the seller nets the remainder. Anything
// else would mean the buyer signing one number and losing another.
//
// The fee collector is the operator account (the "protocol treasury"), and
// allCollectorsAreExempt keeps funding transfers from taxing themselves.

import { loadEnv } from "../src/env.ts";
import { parseHederaKey } from "../src/hedera.ts";

loadEnv();

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const DECIMALS = 6;
const unit = (n: number) => BigInt(Math.round(n * 10 ** DECIMALS));

async function main() {
  const {
    AccountCreateTransaction, AccountId, Client, CustomFractionalFee, FeeAssessmentMethod, Hbar,
    PrivateKey, TokenAssociateTransaction, TokenCreateTransaction, TokenType, TransferTransaction,
  } = await import("@hiero-ledger/sdk");

  const operatorId = process.env.HEDERA_ACCOUNT_ID;
  const operatorRaw = process.env.HEDERA_PRIVATE_KEY;
  if (!operatorId || !operatorRaw) throw new Error("HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required (they pay for and own the token)");
  const operatorKey = parseHederaKey(operatorRaw);
  const client = Client.forTestnet().setOperator(AccountId.fromString(operatorId), operatorKey);

  const feePercent = Number(flag("fee", "2"));
  const supply = Number(flag("supply", "1000000"));
  const fund = Number(flag("fund", "1000"));

  // ── 1. the token, with the protocol fee in its fee schedule ────────────
  const fee = new CustomFractionalFee()
    .setNumerator(Math.round(feePercent * 100))
    .setDenominator(10_000)
    .setFeeCollectorAccountId(AccountId.fromString(operatorId))
    .setAssessmentMethod(FeeAssessmentMethod.Inclusive)
    .setAllCollectorsAreExempt(true);

  console.log(`creating MXC with a ${feePercent}% inclusive fee to ${operatorId}…`);
  const create = await new TokenCreateTransaction()
    .setTokenName("MeterX402 Credit")
    .setTokenSymbol("MXC")
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(DECIMALS)
    .setInitialSupply(Number(unit(supply)))
    .setTreasuryAccountId(AccountId.fromString(operatorId))
    .setSupplyKey(operatorKey)
    .setCustomFees([fee])
    .execute(client);
  const tokenId = (await create.getReceipt(client)).tokenId!.toString();
  console.log(`✓ token ${tokenId}  https://hashscan.io/testnet/token/${tokenId}`);

  // ── 2. a seller account for the HTS lane ───────────────────────────────
  // The gateway holds no settlement key, but SOMEONE has to associate the
  // payout account with the token once, or Hedera rejects the transfer (and
  // x402's preflight says pay_to_not_associated before it even tries). We
  // create the account here, associate it in the same breath, and then throw
  // the key away: nothing later needs it.
  const sellerKey = PrivateKey.generateECDSA();
  const sellerTx = await new AccountCreateTransaction()
    .setKeyWithoutAlias(sellerKey.publicKey)
    .setInitialBalance(new Hbar(1))
    .execute(client);
  const sellerId = (await sellerTx.getReceipt(client)).accountId!.toString();
  await (await (await new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(sellerId))
    .setTokenIds([tokenId])
    .freezeWith(client)
    .sign(sellerKey)).execute(client)).getReceipt(client);
  console.log(`✓ seller ${sellerId} created and associated (its key is discarded)`);

  // ── 3. the buyer: associate, then fund with credits ────────────────────
  const buyerId = process.env.BUYER_ACCOUNT_ID;
  const buyerRaw = process.env.BUYER_PRIVATE_KEY;
  if (buyerId && buyerRaw) {
    const buyerKey = parseHederaKey(buyerRaw);
    try {
      await (await (await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(buyerId))
        .setTokenIds([tokenId])
        .freezeWith(client)
        .sign(buyerKey)).execute(client)).getReceipt(client);
      console.log(`✓ buyer ${buyerId} associated`);
    } catch (e) {
      console.log(`… buyer association: ${String(e).split("\n")[0]}`);
    }
    // treasury → buyer. The collector is exempt, so this funding is untaxed.
    await (await new TransferTransaction()
      .addTokenTransfer(tokenId, AccountId.fromString(operatorId), -Number(unit(fund)))
      .addTokenTransfer(tokenId, AccountId.fromString(buyerId), Number(unit(fund)))
      .execute(client)).getReceipt(client);
    console.log(`✓ funded buyer with ${fund} MXC`);
  } else {
    console.log("… no BUYER_ACCOUNT_ID/BUYER_PRIVATE_KEY: skipping buyer setup");
  }

  console.log(`
Add to .env:

  MX_TOKEN_ID=${tokenId}
  MX_TOKEN_SELLER=${sellerId}

Then sell an API in credits instead of HBAR:

  npx tsx src/cli.ts https://api.open-meteo.com/v1/forecast \\
    --wallet ${sellerId} --asset ${tokenId} --rate 0.01 --port 4097

Every settlement moves MXC, and consensus routes ${feePercent}% of it to ${operatorId}
without this repo containing a line of fee-collection code.`);
  client.close();
}

main().catch((e) => { console.error(String(e?.message ?? e).split("\n")[0]); process.exit(1); });
