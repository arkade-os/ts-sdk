export class SolverUnavailable extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SolverUnavailable";
    }
}

export class SolverResponseInvalid extends SolverUnavailable {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SolverResponseInvalid";
    }
}
