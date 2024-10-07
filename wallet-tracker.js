import dotenv from 'dotenv';
import fetch from 'node-fetch';
import xlsx from 'xlsx';
dotenv.config();

const ALCHEMY_RPC_URL = `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log("RUNNING CABAL WALLET FINDER");

    const tokenAddress = "tokenAddressHere";

    // Get transaciton history of token address
    const signatureList = await getAllTransactionHistory(tokenAddress);
    signatureList.sort((a, b) => a.slot - b.slot);
    const earlySignatures = signatureList.slice(1, 500);
    const signatureStrings = earlySignatures.map(signatureObj => signatureObj.signature);
    // Get transaction details from Helius API
    const earlySignaturesReadableFormat = await parseTransactions(signatureStrings);
    // Filter transactions e.g. remove sells and buys < 0.8 SOL
    console.log("Early Signatures Readable Format: ", earlySignaturesReadableFormat.length);
    const filteredSignatures = await filterSignatures(earlySignaturesReadableFormat);
    filteredSignatures.sort((a, b) => a.slot - b.slot);
    console.log("Filtered Signatures: ", filteredSignatures.length);
    const uniqueWalletAddresses = getUniqueWalletAddresses(filteredSignatures);
    console.log("Unique Wallet Addresses: ", uniqueWalletAddresses);
    const first100Wallets = uniqueWalletAddresses.slice(0, 100);
    

    const walletPnLs = await getPnLForAllAddresses(first100Wallets);

    await writePnLsToExcel(walletPnLs, `${tokenAddress}.xlsx`);
}

function writePnLsToExcel(data, filename) {
    const validData = data.filter(item => item && item.data);

    const formattedData = validData.map(item => ({
        "Wallet Address": item.data.wallet,
        "Realised PnL USD (7D)": item.data.realized_profit_7d,
        "Realised ROI % (7D)": item.data.pnl_7d * 100,
        "Winrate": item.data.winrate * 100,
        "Realized PnL USD (30D)": item.data.realized_profit_30d,
        "Realise ROI % (30D)": item.data.pnl_30d * 100,
        "Buys 7 Days": item.data.buy_7d,
        "Sells 7 Days": item.data.sell_7d,
        "Buys 30 Days": item.data.buy_30d,
        "Sells 30 Days": item.data.sell_30d,
        "7 Day losses greater than -50%": item.data.pnl_lt_minus_dot5_num,
        "7 Day losses 0% ~ -50%": item.data.pnl_minus_dot5_0x_num,
        "7 Day wins 0% ~ 200%": item.data.pnl_lt_2x_num,
        "7 Day wins 200% ~ 500%": item.data.pnl_2x_5x_num,
        "7 Day wins > 500%":  item.data.pnl_gt_5x_num,
        "Wallet Tags": item.data.tags
    }));

    const worksheet = xlsx.utils.json_to_sheet(formattedData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'PnL Data');

    xlsx.writeFile(workbook, filename);
    console.log(`PnL data saved to ${filename}`);
}

async function getPnLForAllAddresses(addresses) {
    const results = [];
    let count = 0;

    for (const address of addresses) {
        try {
            const result = await getAggregatedTokenPnL(address);
            results.push(result);
            console.log(`Aggregating ${count + 1} / ${addresses.length}`);
            count++;
        } catch (error) {
            console.error(`Error fetching PnL for address ${address}:`, error);
        }
    }

    return results;
}

async function getAggregatedTokenPnL(address) {
    const options = {
        method: 'GET'
    };

    try {
        const response = await fetch(`https://gmgn.ai/defi/quotation/v1/smartmoney/sol/walletNew/${address}`, options);
        if (!response.ok) {
            throw new Error('Network response was not ok' + response.statusText);
        }
        const data = await response.json();

        if (data && data.data) {
            data.data.wallet = address;
        }

        return data;
    } catch (err) {
        console.error(err);
        return null;
    }
}

async function getAllTransactionHistory(tokenAddress) {
    let allSignatures = [];
    let lastSignature;
    const batchSize = 1000;

    while (true) {
        try {
            const response = await fetch(ALCHEMY_RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "getSignaturesForAddress",
                    params: [tokenAddress.toString(), { limit: batchSize, before: lastSignature }]
                })
            });

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                const retryDelay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
                console.log(`Rate limit exceeded. Waiting ${retryDelay} ms before retrying.`);
                await delay(retryDelay);
                continue;
            }

            const { result } = await response.json();
            if (result.length === 0) break;

            allSignatures = allSignatures.concat(result);
            lastSignature = result[result.length - 1].signature;
            console.log("LAST SIGNATURE", lastSignature);
        } catch (error) {
            console.error("Error fetching signatures:", error);
            break;
        }
    }

    return allSignatures;
}

async function parseTransactions(signatures) {
    const BATCH_SIZE = 100;
    let allResults = [];
    const totalSignatures = signatures.length;

    // Function to process each batch
    const fetchBatch = async (batch) => {
        const url = `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions: batch })
            });
            const result = await response.json();
            return result;
        } catch (error) {
            console.error("Error fetching transaction details:", error);
            return [];
        }
    };

    // Process all batches
    for (let i = 0; i < totalSignatures; i += BATCH_SIZE) {
        const batch = signatures.slice(i, i + BATCH_SIZE);
        const batchResults = await fetchBatch(batch);
        allResults = allResults.concat(batchResults);
    }

    return allResults;
}

async function filterSignatures(signatures) {
    return signatures.filter(tx => {
        const feePayer = tx.feePayer;
        const feePayerAccountData = tx.accountData.find(account => account.account === feePayer);

        if (!feePayerAccountData) {
            return false;
        }

        const nativeBalanceChange = Math.abs(feePayerAccountData.nativeBalanceChange) / 1_000_000_000; // Convert to SOL

        // Check if the transaction is a buy or sell
        const isBuy = tx.tokenTransfers.some(transfer => transfer.toUserAccount === feePayer);
        const isSell = tx.tokenTransfers.some(transfer => transfer.fromUserAccount === feePayer);

        // Filter out sells and buys under 0.8 SOL
        if (isBuy && nativeBalanceChange >= 0.4) {
            return true;
        }

        if (isSell) {
            return false;
        }

        return false;
    });
}

function getUniqueWalletAddresses(filteredSignatures) {
    const uniqueAddresses = new Set();
    filteredSignatures.forEach(tx => {
        uniqueAddresses.add(tx.feePayer);
    });
    return Array.from(uniqueAddresses);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
