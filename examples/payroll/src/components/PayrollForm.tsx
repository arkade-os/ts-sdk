import { useState, useRef } from "react";
import type { PayrollRecipient, PayrollBatch } from "../types";
import { parseCsv, formatAmount } from "../utils/csv";
import { payrollService } from "../services/payroll";

interface RecipientRowProps {
    recipient: Omit<PayrollRecipient, "id"> & { id?: string };
    index: number;
    onUpdate: (
        index: number,
        field: keyof PayrollRecipient,
        value: string | number
    ) => void;
    onRemove: (index: number) => void;
}

function RecipientRow({
    recipient,
    index,
    onUpdate,
    onRemove,
}: RecipientRowProps) {
    return (
        <div className="recipient-row">
            <input
                type="text"
                placeholder="Recipient name (optional)"
                value={recipient.name || ""}
                onChange={(e) => onUpdate(index, "name", e.target.value)}
                className="input-name"
            />
            <input
                type="text"
                placeholder="Arkade address"
                value={recipient.address}
                onChange={(e) => onUpdate(index, "address", e.target.value)}
                className="input-address"
                required
            />
            <input
                type="number"
                placeholder="Amount (sats)"
                value={recipient.amount || ""}
                onChange={(e) =>
                    onUpdate(index, "amount", parseInt(e.target.value) || 0)
                }
                className="input-amount"
                min="1"
                required
            />
            <button
                type="button"
                onClick={() => onRemove(index)}
                className="btn-remove"
                title="Remove"
            >
                -
            </button>
        </div>
    );
}

interface PayrollFormProps {
    onCreated?: (batch: PayrollBatch) => void;
}

export function PayrollForm({ onCreated }: PayrollFormProps) {
    const [name, setName] = useState("");
    const [recipients, setRecipients] = useState<
        (Omit<PayrollRecipient, "id"> & { id?: string })[]
    >([{ address: "", amount: 0 }]);
    const [errors, setErrors] = useState<string[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const totalAmount = recipients.reduce((sum, r) => sum + (r.amount || 0), 0);

    const handleAddRecipient = () => {
        setRecipients([...recipients, { address: "", amount: 0 }]);
    };

    const handleRemoveRecipient = (index: number) => {
        if (recipients.length > 1) {
            setRecipients(recipients.filter((_, i) => i !== index));
        }
    };

    const handleUpdateRecipient = (
        index: number,
        field: keyof PayrollRecipient,
        value: string | number
    ) => {
        const updated = [...recipients];
        updated[index] = { ...updated[index], [field]: value };
        setRecipients(updated);
    };

    const handleCsvImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target?.result as string;
            const result = parseCsv(content);

            if (result.errors.length > 0) {
                setErrors(result.errors);
            } else {
                setErrors([]);
            }

            if (result.recipients.length > 0) {
                setRecipients(result.recipients);
            }
        };
        reader.readAsText(file);

        // Reset file input
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors([]);
        setIsSubmitting(true);

        try {
            // Validate
            const validationErrors: string[] = [];

            if (!name.trim()) {
                validationErrors.push("Payroll name is required");
            }

            const validRecipients = recipients.filter(
                (r) => r.address && r.amount > 0
            );
            if (validRecipients.length === 0) {
                validationErrors.push(
                    "At least one valid recipient is required"
                );
            }

            for (let i = 0; i < recipients.length; i++) {
                const r = recipients[i];
                if (r.address && r.address.length < 10) {
                    validationErrors.push(
                        `Recipient ${i + 1}: Invalid address`
                    );
                }
                if (r.address && (!r.amount || r.amount <= 0)) {
                    validationErrors.push(`Recipient ${i + 1}: Invalid amount`);
                }
            }

            if (validationErrors.length > 0) {
                setErrors(validationErrors);
                return;
            }

            // Create payroll batch
            const batch = payrollService.createPayroll(
                {
                    name: name.trim(),
                    recipients: validRecipients,
                },
                "assistant"
            );

            // Reset form
            setName("");
            setRecipients([{ address: "", amount: 0 }]);

            // Notify parent
            onCreated?.(batch);
        } catch (error) {
            setErrors([
                error instanceof Error
                    ? error.message
                    : "Failed to create payroll",
            ]);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="payroll-form">
            <h2>Create Payroll</h2>
            <p className="description">
                Add recipients manually using the +/- buttons or import from CSV
                (Address,Amount format).
            </p>

            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="payroll-name">Payroll Name</label>
                    <input
                        id="payroll-name"
                        type="text"
                        placeholder="e.g., December 2024 Payroll"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="input-name-full"
                        required
                    />
                </div>

                <div className="form-group">
                    <div className="recipients-header">
                        <label>Recipients</label>
                        <div className="csv-import">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".csv,.txt"
                                onChange={handleCsvImport}
                                id="csv-input"
                                hidden
                            />
                            <label htmlFor="csv-input" className="btn-csv">
                                Import CSV
                            </label>
                        </div>
                    </div>

                    <div className="recipients-list">
                        {recipients.map((recipient, index) => (
                            <RecipientRow
                                key={index}
                                recipient={recipient}
                                index={index}
                                onUpdate={handleUpdateRecipient}
                                onRemove={handleRemoveRecipient}
                            />
                        ))}
                    </div>

                    <button
                        type="button"
                        onClick={handleAddRecipient}
                        className="btn-add"
                    >
                        + Add Recipient
                    </button>
                </div>

                {errors.length > 0 && (
                    <div className="errors">
                        {errors.map((error, i) => (
                            <div key={i} className="error">
                                {error}
                            </div>
                        ))}
                    </div>
                )}

                <div className="form-footer">
                    <div className="total">
                        <span>Total:</span>
                        <strong>{formatAmount(totalAmount)}</strong>
                        <span className="recipient-count">
                            ({recipients.filter((r) => r.address).length}{" "}
                            recipients)
                        </span>
                    </div>

                    <button
                        type="submit"
                        className="btn-submit"
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? "Creating..." : "Create Payroll"}
                    </button>
                </div>
            </form>
        </div>
    );
}
