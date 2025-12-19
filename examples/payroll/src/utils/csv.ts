import type { CsvParseResult, PayrollRecipient } from "../types";

/**
 * Parse CSV content with Address,Amount format
 * Supports optional header row and various separators
 */
export function parseCsv(content: string): CsvParseResult {
    const errors: string[] = [];
    const recipients: Omit<PayrollRecipient, "id">[] = [];

    const lines = content
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "");

    if (lines.length === 0) {
        return { recipients: [], errors: ["Empty CSV content"] };
    }

    // Check if first line is a header
    const firstLine = lines[0].toLowerCase();
    const startIndex =
        firstLine.includes("address") || firstLine.includes("amount") ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        const lineNumber = i + 1;

        // Support comma, semicolon, or tab as separators
        const parts = line.split(/[,;\t]/).map((p) => p.trim());

        if (parts.length < 2) {
            errors.push(
                `Line ${lineNumber}: Invalid format, expected "Address,Amount"`
            );
            continue;
        }

        const [address, amountStr, name] = parts;

        // Validate address (basic check for Ark addresses)
        if (!address || address.length < 10) {
            errors.push(`Line ${lineNumber}: Invalid address "${address}"`);
            continue;
        }

        // Parse and validate amount
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) {
            errors.push(`Line ${lineNumber}: Invalid amount "${amountStr}"`);
            continue;
        }

        // Convert to satoshis if needed (assume BTC if has decimal point with significant digits)
        const amountSats =
            amountStr.includes(".") && parseFloat(amountStr) < 1
                ? Math.round(amount * 100_000_000)
                : Math.round(amount);

        recipients.push({
            address,
            amount: amountSats,
            name: name || undefined,
        });
    }

    return { recipients, errors };
}

/**
 * Generate CSV content from recipients
 */
export function generateCsv(recipients: PayrollRecipient[]): string {
    const header = "Address,Amount,Name";
    const rows = recipients.map(
        (r) => `${r.address},${r.amount},${r.name || ""}`
    );
    return [header, ...rows].join("\n");
}

/**
 * Format satoshis to BTC string
 */
export function formatSats(sats: number): string {
    return (sats / 100_000_000).toFixed(8);
}

/**
 * Format satoshis to display string with unit
 */
export function formatAmount(sats: number): string {
    if (sats >= 100_000_000) {
        return `${(sats / 100_000_000).toFixed(4)} BTC`;
    } else if (sats >= 100_000) {
        return `${(sats / 100_000).toFixed(2)} mBTC`;
    } else {
        return `${sats.toLocaleString()} sats`;
    }
}
