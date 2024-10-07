import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';

const inputDir = './compareList';
const outputDir = './resultList';
const files = fs.readdirSync(inputDir).filter(file => file.endsWith('.xlsx'));

function countWalletOccurrences(files) {
    const walletCounts = new Map();

    files.forEach(file => {
        const filePath = path.join(inputDir, file);
        const workbook = xlsx.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        data.slice(1).forEach(row => {
            const wallet = row[0];
            if (wallet) {
                if (!walletCounts.has(wallet)) {
                    walletCounts.set(wallet, 0);
                }
                walletCounts.set(wallet, walletCounts.get(wallet) + 1);
            }
        });
    });

    return walletCounts;
}

function writeOutputFiles(walletCounts, totalFiles) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    for (let i = 1; i <= totalFiles; i++) {
        const filteredWallets = Array.from(walletCounts.entries())
            .filter(([_, count]) => count === i)
            .map(([wallet]) => [wallet]);

        const newWorkbook = xlsx.utils.book_new();
        const newSheet = xlsx.utils.aoa_to_sheet([['Wallet']].concat(filteredWallets));
        xlsx.utils.book_append_sheet(newWorkbook, newSheet, `Wallets_${i}_of_${totalFiles}`);

        const outputFile = path.join(outputDir, `${i}OF${totalFiles}Wallets.xlsx`);
        xlsx.writeFile(newWorkbook, outputFile);
        console.log(`Created file: ${outputFile}`);
    }
}

function main() {
    const walletCounts = countWalletOccurrences(files);
    writeOutputFiles(walletCounts, files.length);
}

main();