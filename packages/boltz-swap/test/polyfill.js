const { EventSource } = require("eventsource");
globalThis.EventSource = EventSource;

// Mock console.log
global.console = {
    ...console,
    log: vi.fn(),
};
