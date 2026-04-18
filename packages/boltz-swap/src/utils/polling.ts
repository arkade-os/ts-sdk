export function poll<T>(
    fn: () => Promise<T>,
    condition: (result: T) => boolean,
    delayMs: number,
    maxAttempts: number
): Promise<T> {
    let attempts = 0;
    return new Promise((resolve, reject) => {
        const executePoll = async () => {
            attempts++;
            try {
                const result = await fn();
                if (condition(result)) {
                    return resolve(result);
                } else if (attempts >= maxAttempts) {
                    return reject(new Error("Polling timed out."));
                } else {
                    setTimeout(executePoll, delayMs);
                }
            } catch (error) {
                if (attempts >= maxAttempts) {
                    return reject(error);
                }
                setTimeout(executePoll, delayMs);
            }
        };
        executePoll();
    });
}
